import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseEther } from "ethers";
import { runPreflight } from "../../src/chain/preflight.js";
import { hardhatAccount } from "../helpers/env.js";
import { assertPristineLocalChain, localServices, readLocalMetadata, revertTo, snapshot } from "../helpers/chain.js";

const okMongo = { ping: async () => {} };
const preflightOf = (s, extra = {}) =>
  runPreflight({ deployment: s.deployment, provider: s.provider, contract: s.contract, signers: s.signers, mongo: okMongo, ...extra });
const byName = (report, name) => report.checks.find((c) => c.name === name);
const failedNames = (report) => report.checks.filter((c) => c.status === "fail").map((c) => c.name);

describe("chain: startup preflight against the real local deployment", () => {
  let s;
  before(async () => {
    s = localServices();
    await assertPristineLocalChain(s);
  });
  after(() => s?.destroy());

  it("passes every check on a healthy deployment", async () => {
    const report = await preflightOf(s);
    assert.deepEqual(failedNames(report), []);
    assert.equal(report.ok, true);
    assert.equal(report.status, "pass", JSON.stringify(report.checks.filter((c) => c.status !== "pass")));
    for (const name of ["mongo.connectivity", "rpc.connectivity", "chain.id", "contract.bytecode", "contract.electionId", "contract.phase", "contract.owner", "contract.authoritySigner", "contract.relayer", "signers.distinct", "eip712.domain", "eip712.typehash", "eip712.digest", "relayer.balance", "election.config"]) {
      assert.equal(byName(report, name)?.status, "pass", name);
    }
  });

  it("reports the facts the admin console will need", async () => {
    const { snapshot: snap } = await preflightOf(s);
    const meta = readLocalMetadata();
    assert.equal(snap.chainId, 31337);
    assert.equal(snap.contractAddress, meta.contractAddress);
    assert.equal(snap.electionId, meta.electionId);
    assert.equal(snap.phase, "Setup");
    assert.equal(snap.owner, hardhatAccount(0).address);
    assert.equal(snap.authoritySigner, hardhatAccount(1).address);
    assert.equal(snap.relayer, hardhatAccount(2).address);
    assert.equal(snap.constituencyCount, 3);
    assert.equal(snap.candidateCount, 18);
    assert.equal(snap.totalBallots, 0);
    assert.ok(snap.latestBlock >= 0);
    assert.equal(BigInt(byName(await preflightOf(s), "relayer.balance").details.balanceWei) > parseEther("1"), true);
  });

  it("the shallow probe used by the public health endpoint skips the enumeration", async () => {
    const report = await preflightOf(s, { deep: false });
    assert.equal(report.ok, true);
    assert.equal(byName(report, "election.config"), undefined);
  });

  it("never sends a transaction (block number does not move)", async () => {
    const before = await s.provider.getBlockNumber();
    await preflightOf(s);
    assert.equal(await s.provider.getBlockNumber(), before);
  });

  it("detects the wrong chain id and refuses to read the contract on that network", async () => {
    const wrong = localServices({ CHAIN_ID: "1" });
    try {
      const report = await preflightOf(wrong);
      assert.equal(report.ok, false);
      const chain = byName(report, "chain.id");
      assert.equal(chain.status, "fail");
      assert.deepEqual(chain.details, { expected: 1, actual: 31337 });
      assert.match(byName(report, "contract.bytecode").message, /not checked/);
      assert.match(byName(report, "contract.owner").message, /not checked/);
    } finally {
      wrong.destroy();
    }
  });

  it("detects an address with no contract code", async () => {
    const wrong = localServices({ VOTING_CONTRACT_ADDRESS: "0x1111111111111111111111111111111111111111" });
    try {
      const report = await preflightOf(wrong);
      assert.equal(report.ok, false);
      assert.equal(byName(report, "contract.bytecode").status, "fail");
      assert.match(byName(report, "contract.bytecode").message, /no contract code/);
      assert.match(byName(report, "contract.electionId").message, /not checked/);
    } finally {
      wrong.destroy();
    }
  });

  it("detects a different election id than configured", async () => {
    const wrong = localServices({ ELECTION_ID: "0x" + "77".repeat(32) });
    try {
      const report = await preflightOf(wrong);
      assert.equal(byName(report, "contract.electionId").status, "fail");
      assert.equal(report.ok, false);
    } finally {
      wrong.destroy();
    }
  });

  it("detects signers that are not the contract's owner / authority / relayer", async () => {
    for (const [env, check] of [
      [{ OWNER_PRIVATE_KEY: hardhatAccount(5).privateKey }, "contract.owner"],
      [{ AUTHORITY_PRIVATE_KEY: hardhatAccount(6).privateKey }, "contract.authoritySigner"],
      [{ RELAYER_PRIVATE_KEY: hardhatAccount(7).privateKey }, "contract.relayer"],
    ]) {
      const wrong = localServices(env);
      try {
        const report = await preflightOf(wrong);
        assert.equal(report.ok, false, check);
        assert.deepEqual(failedNames(report), [check]);
        assert.ok(!JSON.stringify(report).includes(Object.values(env)[0].slice(2)), "report leaked a private key");
      } finally {
        wrong.destroy();
      }
    }
  });

  it("an unreachable RPC fails cleanly and quickly", async () => {
    const down = localServices({ CHAIN_RPC_URL: "http://127.0.0.1:1" }, { rpcTimeoutMs: 1500 });
    try {
      const report = await preflightOf(down);
      assert.equal(report.ok, false);
      assert.equal(byName(report, "rpc.connectivity").status, "fail");
      assert.match(byName(report, "contract.bytecode").message, /not checked/);
    } finally {
      down.destroy();
    }
  });

  it("relayer balance: zero fails, low warns (state restored afterwards)", async () => {
    const snap = await snapshot(s.provider);
    try {
      await s.provider.send("hardhat_setBalance", [s.signers.addresses.relayer, "0x0"]);
      const zero = await preflightOf(s, { deep: false });
      assert.equal(byName(zero, "relayer.balance").status, "fail");
      assert.equal(zero.ok, false);

      await s.provider.send("hardhat_setBalance", [s.signers.addresses.relayer, "0x" + parseEther("0.001").toString(16)]);
      const low = await preflightOf(s, { deep: false });
      assert.equal(byName(low, "relayer.balance").status, "warn");
      assert.equal(low.ok, true);
      assert.equal(low.status, "warn");
    } finally {
      await revertTo(s.provider, snap);
    }
    assert.equal((await preflightOf(s, { deep: false })).status, "pass");
  });

  it("a pending ownership transfer is surfaced as a warning (state restored afterwards)", async () => {
    const snap = await snapshot(s.provider);
    try {
      await (await s.contract.connect(s.signers.owner).transferOwnership(hardhatAccount(9).address)).wait();
      const report = await preflightOf(s, { deep: false });
      assert.equal(byName(report, "contract.owner").status, "warn");
      assert.equal(report.ok, true);
    } finally {
      await revertTo(s.provider, snap);
    }
    assert.equal(await s.contract.pendingOwner(), "0x0000000000000000000000000000000000000000");
  });
});
