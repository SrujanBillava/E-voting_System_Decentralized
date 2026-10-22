import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeError } from "ethers";
import { TX_GAS_CAP, batchGasLimit, classifySimulationError, selectGasLimit } from "../../src/services/batcher.service.js";

// The errors a simulation can end with, shaped like ethers v6 reports them.
const noData = () => makeError("execution reverted (no data present; likely require(false) occurred", "CALL_EXCEPTION", { action: "call", data: "0x", reason: null, transaction: {}, invocation: null, revert: null });
const decoded = (name, args = []) => Object.assign(makeError(`execution reverted: ${name}`, "CALL_EXCEPTION", { action: "call", data: "0x12345678", reason: null, transaction: {}, invocation: null, revert: { name, signature: `${name}()`, args } }));
const unknownRevert = () => makeError("execution reverted (unknown custom error)", "CALL_EXCEPTION", { action: "call", data: "0xdeadbeef00000000", reason: null, transaction: {}, invocation: null, revert: null });
const timeout = () => makeError("request timeout", "TIMEOUT", { operation: "call" });
const network = () => makeError("could not detect network", "NETWORK_ERROR", { event: "noNetwork" });
const serverOutOfGas = () => makeError("could not coalesce error", "UNKNOWN_ERROR", { error: { message: "out of gas" } });

/** a simulated chain: the call succeeds iff gasLimit >= need; `fail(gasLimit)` may throw instead */
function fakeChain({ need, estimate = null, fail = null }) {
  const calls = [];
  return {
    calls,
    estimate: async () => {
      if (estimate instanceof Error) throw estimate;
      if (estimate === null) throw makeError("transaction gas limit (30412035) is greater than the cap (16777216)", "UNKNOWN_ERROR", {});
      return estimate;
    },
    simulate: async (gasLimit) => {
      calls.push(gasLimit);
      if (fail) {
        const err = fail(gasLimit);
        if (err) throw err;
      }
      if (gasLimit < need) throw noData();
    },
  };
}

describe("credential batch gas limit (identity-v3 batcher)", () => {
  describe("batchGasLimit: the depth-aware prediction", () => {
    it("is the released formula for a first batch and grows with the depth of the group's tree", () => {
      assert.equal(batchGasLimit(1, 0), 250_000n, "one commitment into an empty tree: 150k + 100k, depth 0");
      assert.ok(batchGasLimit(1, 600) > batchGasLimit(1, 30), "the same batch costs more in a deeper tree");
      assert.equal(batchGasLimit(4, 31), 150_000n + 400_000n + 40_000n * 6n, "four into a group of 31 (35 leaves, depth 6)");
      assert.ok(batchGasLimit(4, 31) > 590_037n, "covers the measured 590,037 that stalled issuance under the 550,000 of v3.0.0");
      assert.ok(batchGasLimit(1, 22) > 281_983n, "covers the first measured failure (1 commitment into 22, needed 281,983)");
    });
    it("never exceeds the per-transaction cap, and keeps MAX_BATCH = 128 under it even in a very deep tree", () => {
      assert.equal(batchGasLimit(10_000, 0), TX_GAS_CAP);
      assert.ok(batchGasLimit(128, 2 ** 24) < TX_GAS_CAP, "128 commitments into a group of 16.7 million");
      assert.ok(batchGasLimit(128, 0) < TX_GAS_CAP);
    });
  });

  describe("classifySimulationError", () => {
    it("tells contract reverts, out-of-gas-like failures and node failures apart", () => {
      assert.equal(classifySimulationError(decoded("BatchAlreadyThisEpoch", [5n])), "REVERT");
      assert.equal(classifySimulationError(noData()), "OUT_OF_GAS", "no revert data: what an out-of-gas call looks like on the local network");
      assert.equal(classifySimulationError(serverOutOfGas()), "OUT_OF_GAS", "a node that says so in its message");
      assert.equal(classifySimulationError(unknownRevert()), "UNKNOWN_REVERT", "revert data that is not one of the contract's errors is deterministic");
      assert.equal(classifySimulationError(timeout()), "TRANSIENT");
      assert.equal(classifySimulationError(network()), "TRANSIENT");
      assert.equal(classifySimulationError(new Error("socket hang up")), "TRANSIENT");
    });
  });

  describe("selectGasLimit: only a simulated limit is ever returned", () => {
    it("uses the prediction when the estimate is lower", async () => {
      const chain = fakeChain({ need: 300_000n, estimate: 290_000n });
      const r = await selectGasLimit({ count: 1, treeSize: 0, ...chain });
      assert.equal(r.ok, true);
      assert.equal(r.gasLimit, 362_500n, "estimate + 25% is above the 250k prediction, so it wins");
      assert.deepEqual(chain.calls, [362_500n], "one simulation");
    });
    it("raises the first candidate to the estimate + 25% when that is higher than the prediction", async () => {
      const chain = fakeChain({ need: 1_000_000n, estimate: 1_000_000n });
      const r = await selectGasLimit({ count: 2, treeSize: 10, ...chain });
      assert.equal(r.gasLimit, 1_250_000n);
    });
    it("ignores an estimate above the cap or a failed estimate (Hardhat's estimator for large batches) and uses the prediction", async () => {
      const above = fakeChain({ need: 10_300_000n, estimate: 30_412_035n });
      const r1 = await selectGasLimit({ count: 128, treeSize: 100, ...above });
      assert.equal(r1.ok, true);
      assert.equal(r1.estimate, null);
      assert.equal(r1.gasLimit, batchGasLimit(128, 100));
      const failed = fakeChain({ need: 10_300_000n, estimate: null });
      const r2 = await selectGasLimit({ count: 128, treeSize: 100, ...failed });
      assert.equal(r2.gasLimit, batchGasLimit(128, 100));
      assert.deepEqual(failed.calls, [batchGasLimit(128, 100)]);
    });
    it("escalates on an out-of-gas-like failure (x2, x4, then the cap) and returns the first limit that simulates", async () => {
      const chain = fakeChain({ need: 700_000n, estimate: null });
      const r = await selectGasLimit({ count: 1, treeSize: 0, ...chain });
      assert.equal(r.ok, true);
      assert.equal(r.gasLimit, 1_000_000n, "250k and 500k fail, 1M simulates");
      assert.deepEqual(chain.calls, [250_000n, 500_000n, 1_000_000n]);
      assert.deepEqual(r.attempts.map((a) => a.result), ["OUT_OF_GAS", "OUT_OF_GAS", "OK"]);
    });
    it("reaches the cap only as the last resort", async () => {
      const chain = fakeChain({ need: 5_000_000n, estimate: null });
      const r = await selectGasLimit({ count: 1, treeSize: 0, ...chain });
      assert.equal(r.gasLimit, TX_GAS_CAP);
      assert.deepEqual(chain.calls, [250_000n, 500_000n, 1_000_000n, TX_GAS_CAP]);
    });
    it("bounded: at most four simulations, ending at the cap; a call that fails even at the cap is reported, never retried", async () => {
      const chain = fakeChain({ need: TX_GAS_CAP + 1n, estimate: null });
      const r = await selectGasLimit({ count: 1, treeSize: 0, ...chain });
      assert.equal(r.ok, false);
      assert.equal(r.kind, "OUT_OF_GAS");
      assert.deepEqual(chain.calls, [250_000n, 500_000n, 1_000_000n, TX_GAS_CAP]);
    });
    it("a large first candidate goes straight to the cap without duplicate simulations", async () => {
      const chain = fakeChain({ need: TX_GAS_CAP + 1n, estimate: null });
      const r = await selectGasLimit({ count: 128, treeSize: 0, ...chain });
      assert.deepEqual(chain.calls, [batchGasLimit(128, 0), TX_GAS_CAP]);
      assert.equal(r.kind, "OUT_OF_GAS");
    });
    it("a decoded contract revert stops the ladder at once (no escalation)", async () => {
      const chain = fakeChain({ need: 0n, estimate: null, fail: () => decoded("IssuanceNotOpen") });
      const r = await selectGasLimit({ count: 3, treeSize: 9, ...chain });
      assert.equal(r.ok, false);
      assert.equal(r.kind, "REVERT");
      assert.equal(r.error.revert.name, "IssuanceNotOpen");
      assert.equal(chain.calls.length, 1);
    });
    it("an unknown revert stops the ladder at once", async () => {
      const chain = fakeChain({ need: 0n, estimate: null, fail: () => unknownRevert() });
      const r = await selectGasLimit({ count: 3, treeSize: 9, ...chain });
      assert.equal(r.kind, "UNKNOWN_REVERT");
      assert.equal(chain.calls.length, 1);
    });
    it("an RPC timeout stops the ladder at once and is reported as TRANSIENT (nothing is concluded about gas)", async () => {
      const chain = fakeChain({ need: 0n, estimate: timeout(), fail: () => timeout() });
      const r = await selectGasLimit({ count: 3, treeSize: 9, ...chain });
      assert.equal(r.kind, "TRANSIENT");
      assert.equal(chain.calls.length, 1);
    });
    it("a timeout in the middle of an escalation is TRANSIENT, not a gas verdict", async () => {
      const chain = fakeChain({ need: 900_000n, estimate: null, fail: (g) => (g > 250_000n ? timeout() : null) });
      const r = await selectGasLimit({ count: 1, treeSize: 0, ...chain });
      assert.equal(r.kind, "TRANSIENT");
      assert.deepEqual(chain.calls, [250_000n, 500_000n]);
    });
  });
});
