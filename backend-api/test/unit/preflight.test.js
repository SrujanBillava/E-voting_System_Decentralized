import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "ethers";
import { runPreflight } from "../../src/chain/preflight.js";
import { hardhatAccount } from "../helpers/env.js";

// Offline: fake provider/contract. These tests are about the preflight's own logic (dependency
// skipping, status aggregation, error hygiene). The real-chain behaviour is in test/chain/.
const signers = { addresses: { owner: hardhatAccount(0).address, authority: hardhatAccount(1).address, relayer: hardhatAccount(2).address } };
const deployment = { chainId: 31337, contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", electionId: "0x" + "11".repeat(32) };
const okMongo = { ping: async () => {} };
const byName = (report, name) => report.checks.find((c) => c.name === name);

describe("preflight (offline logic)", () => {
  it("when the RPC is down: rpc fails, every dependent check is reported as not checked, nothing throws", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED https://rpc.example/KEY123456"), { code: "ECONNREFUSED" });
    const provider = { getBlockNumber: async () => { throw err; } };
    const report = await runPreflight({ deployment, provider, contract: {}, signers, mongo: okMongo, deep: true });
    assert.equal(report.ok, false);
    assert.equal(byName(report, "rpc.connectivity").status, "fail");
    for (const name of ["chain.id", "contract.bytecode", "contract.electionId", "eip712.digest", "relayer.balance", "election.config"]) {
      assert.equal(byName(report, name).status, "fail", name);
      assert.match(byName(report, name).message, /not checked/);
    }
    assert.equal(byName(report, "mongo.connectivity").status, "pass");
    assert.equal(byName(report, "signers.distinct").status, "pass");
  });

  it("check messages never contain raw error text (could hold URLs or credentials)", async () => {
    const provider = { getBlockNumber: async () => { throw Object.assign(new Error("failed https://user:pw@rpc.example/KEY123456"), { code: "SERVER_ERROR" }); } };
    const report = await runPreflight({ deployment, provider, contract: {}, signers, mongo: { ping: async () => { throw new Error("mongodb://u:secretpw@h"); } }, deep: false });
    const text = JSON.stringify(report);
    assert.ok(!text.includes("KEY123456") && !text.includes("secretpw") && !text.includes("user:pw"));
    assert.match(byName(report, "mongo.connectivity").message, /check failed/);
    assert.match(byName(report, "rpc.connectivity").message, /SERVER_ERROR/);
  });

  it("a wrong chain id stops contract reads from happening on the wrong network", async () => {
    let contractTouched = false;
    const provider = {
      getBlockNumber: async () => 7,
      send: async () => "0x1", // mainnet
      getCode: async () => { contractTouched = true; return "0x1234"; },
    };
    const report = await runPreflight({ deployment, provider, contract: new Proxy({}, { get() { contractTouched = true; return () => {}; } }), signers, mongo: okMongo, deep: true });
    assert.equal(byName(report, "chain.id").status, "fail");
    assert.deepEqual(byName(report, "chain.id").details, { expected: 31337, actual: 1 });
    assert.equal(contractTouched, false);
    assert.equal(report.ok, false);
  });

  it("no bytecode at the address fails bytecode and skips the contract reads", async () => {
    const provider = { getBlockNumber: async () => 1, send: async () => "0x7a69", getCode: async () => "0x" };
    const report = await runPreflight({ deployment, provider, contract: {}, signers, mongo: okMongo, deep: false });
    assert.equal(byName(report, "contract.bytecode").status, "fail");
    assert.match(byName(report, "contract.electionId").message, /not checked/);
  });

  it("Mongo down alone makes the report not ok but the chain checks still run", async () => {
    const provider = { getBlockNumber: async () => 1, send: async () => "0x7a69", getCode: async () => "0x" };
    const report = await runPreflight({ deployment, provider, contract: {}, signers, mongo: { ping: async () => { throw new Error("down"); } }, deep: false });
    assert.equal(byName(report, "mongo.connectivity").status, "fail");
    assert.equal(byName(report, "chain.id").status, "pass");
  });

  it("duplicate signer identities fail the distinct check", async () => {
    const dup = { addresses: { owner: Wallet.createRandom().address, authority: hardhatAccount(1).address, relayer: hardhatAccount(1).address } };
    const provider = { getBlockNumber: async () => 1, send: async () => "0x7a69", getCode: async () => "0x" };
    const report = await runPreflight({ deployment, provider, contract: {}, signers: dup, mongo: okMongo, deep: false });
    assert.equal(byName(report, "signers.distinct").status, "fail");
    assert.equal(report.ok, false);
  });

  it("report has the documented shape", async () => {
    const provider = { getBlockNumber: async () => 1, send: async () => "0x7a69", getCode: async () => "0x" };
    const report = await runPreflight({ deployment, provider, contract: {}, signers, mongo: okMongo, deep: false });
    assert.deepEqual(Object.keys(report).sort(), ["checkedAt", "checks", "ok", "status"]);
    for (const c of report.checks) assert.ok(["pass", "warn", "fail"].includes(c.status));
  });
});
