import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { createVotingContract } from "../../src/chain/contract.js";
import { createProvider, readRemoteChainId } from "../../src/chain/provider.js";

// A scripted JSON-RPC node on a random local port. It records every request, so these tests can see
// exactly what the provider sends (and does not send).
function stubNode() {
  const state = { chainId: "0x1", balance: "0x1", hang: false, requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      state.requests.push(parsed);
      if (state.hang) return; // never answers
      const answer = (r) => ({ jsonrpc: "2.0", id: r.id, result: { eth_chainId: state.chainId, eth_blockNumber: "0x10", eth_getBalance: state.balance }[r.method] ?? null });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  return {
    state,
    methods: () => state.requests.flat().map((r) => r.method),
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))),
    stop: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("provider (against a scripted local node)", () => {
  const node = stubNode();
  let url;
  before(async () => {
    url = await node.start();
  });
  after(() => node.stop());

  const fresh = (options = {}) => {
    node.state.requests.length = 0;
    node.state.hang = false;
    return createProvider({ rpcUrl: url, chainId: 31337, ...options });
  };

  it("never serves a stale answer: two reads in a row see the node's current state (no response cache)", async () => {
    const provider = fresh();
    try {
      node.state.balance = "0x1";
      assert.equal(await provider.getBalance(ADDRESS), 1n);
      node.state.balance = "0x2"; // changes within the default 250 ms cache window
      assert.equal(await provider.getBalance(ADDRESS), 2n);
      assert.equal(node.methods().filter((m) => m === "eth_getBalance").length, 2);
    } finally {
      provider.destroy();
    }
  });

  it("trusts the configured network instead of asking the node (staticNetwork), and the real chain id is read explicitly", async () => {
    const provider = fresh();
    try {
      node.state.chainId = "0x1"; // the node is NOT chain 31337
      assert.equal(await provider.getBlockNumber(), 16);
      assert.deepEqual(node.methods(), ["eth_blockNumber"], "no automatic network detection");
      assert.equal(await readRemoteChainId(provider), 1n, "the explicit read reports what the node says, not what was configured");
      assert.equal((await provider.getNetwork()).chainId, 31337n);
    } finally {
      provider.destroy();
    }
  });

  it("does not batch: concurrent calls are separate single requests", async () => {
    const provider = fresh();
    try {
      await Promise.all([provider.getBlockNumber(), provider.getBalance(ADDRESS), readRemoteChainId(provider)]);
      assert.equal(node.state.requests.length, 3);
      assert.ok(node.state.requests.every((r) => !Array.isArray(r)));
    } finally {
      provider.destroy();
    }
  });

  it("a node that never answers fails with a timeout after the configured time, not never", async () => {
    const provider = fresh({ timeoutMs: 300 });
    node.state.hang = true;
    const started = Date.now();
    try {
      await assert.rejects(provider.getBlockNumber(), (err) => err.code === "TIMEOUT");
      assert.ok(Date.now() - started < 3000, "timed out promptly");
    } finally {
      provider.destroy();
    }
  });

  it("the default request timeout is 8 seconds and the option is honoured", () => {
    const withDefault = createProvider({ rpcUrl: url, chainId: 31337 });
    const custom = createProvider({ rpcUrl: url, chainId: 31337, timeoutMs: 1234 });
    try {
      assert.equal(withDefault._getConnection().timeout, 8000);
      assert.equal(custom._getConnection().timeout, 1234);
    } finally {
      withDefault.destroy();
      custom.destroy();
    }
  });

  it("the read-only contract cannot send a transaction (no signer), and tries nothing on the network", async () => {
    const provider = fresh();
    try {
      const contract = createVotingContract({ provider, address: ADDRESS });
      await assert.rejects(contract.castVote("0x" + "11".repeat(32), "0x" + "22".repeat(32), 1n, 2n ** 40n, "0x" + "00".repeat(65)), (err) => err.code === "UNSUPPORTED_OPERATION");
      assert.deepEqual(node.state.requests, []);
    } finally {
      provider.destroy();
    }
  });
});
