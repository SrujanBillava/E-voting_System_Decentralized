import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Transaction, makeError } from "ethers";
import mongoose from "mongoose";
import { secretValuesOf } from "../../src/config/env.js";
import { composeIdentity, MODELS } from "../../src/compose.js";
import { SimulatedCrash, TX_GAS_CAP, batchGasLimit } from "../../src/services/batcher.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { closeDb, connectTestDb, resetDb, skipWithoutMongo } from "../helpers/db.js";
import { configFor } from "../helpers/env.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

// Regression tests for the credential-batch gas limit: v3.0.0 signed 150k + 100k per commitment whatever the size of the group's Merkle tree, and treated the
// resulting data-less simulation failure as transient, so a small batch into a grown tree was retried forever and issuance for the constituency stopped.
const { CredentialIssuance, CommitmentBatch } = MODELS;
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");
const RELEASED_LIMIT = (count) => 150_000n + 100_000n * BigInt(count); // the v3.0.0 formula, for the preconditions
const crashAt = (name) => ({ [name]: async () => { throw new SimulatedCrash(`crash at ${name}`); } });

/**
 * A provider whose simulations (eth_call / eth_estimateGas) of registerCommitmentBatch can be made to fail; every other request (reads, sending) is untouched.
 * `fail(kind)` returns the error to throw, or null to pass through.
 */
function interceptRegister(provider, selector, fail) {
  const state = { calls: 0, estimates: 0 };
  const isRegister = (tx) => typeof tx?.data === "string" && tx.data.startsWith(selector);
  const proxy = new Proxy(provider, {
    get(target, prop) {
      if (prop === "call" || prop === "estimateGas") {
        return async (tx) => {
          if (isRegister(tx)) {
            if (prop === "call") state.calls++;
            else state.estimates++;
            const err = fail(prop, tx);
            if (err) throw err;
          }
          return target[prop](tx);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { provider: proxy, state };
}
const timeoutError = () => makeError("request timeout", "TIMEOUT", { operation: "call" });
const dataless = (tx) => makeError("execution reverted (no data present; likely require(false) occurred", "CALL_EXCEPTION", { action: "call", data: "0x", reason: null, transaction: tx, invocation: null, revert: null });

describe("identity-v3: credential batch gas limit (real chain + real MongoDB)", { skip }, () => {
  let world;
  let config;
  let identity;
  let memory;
  let snap;
  const buildIdentity = (opts = {}) =>
    composeIdentity({ config, logger: memory.logger, provider: world.provider, clock: world.clock, bcryptCost: 4, rateLimits: { login: { windowMs: 60_000, limit: 10_000 }, face: { windowMs: 60_000, limit: 10_000 } }, ...opts });

  before(async () => {
    await connectTestDb();
    world = await newWorld({ constituencies: { BATCH: { kc: 2, cap: 5000 }, "KA-BLR": { kc: 3, cap: 50 } } });
    config = configFor(world);
  });
  after(async () => {
    world?.stop();
    await closeDb();
  });
  beforeEach(async () => {
    snap = await world.snapshot();
    await resetDb();
    memory = createMemoryLogger({ level: "info", secrets: secretValuesOf(config) });
    identity = buildIdentity();
    await identity.chain.init();
  });
  afterEach(async () => {
    await world.revert(snap);
  });

  const rnd = () => BigInt("0x" + randomBytes(31).toString("hex"));
  async function reserve(n, { code = "BATCH" } = {}) {
    const now = await world.clock.nowSeconds();
    const commitments = Array.from({ length: n }, () => rnd().toString());
    await CredentialIssuance.insertMany(commitments.map((commitment, i) => ({ _id: `r-${randomBytes(6).toString("hex")}`, electionId: world.electionId, voterId: new mongoose.Types.ObjectId(), state: "RESERVED", commitment, constituencyId: world.ids[code], reservedAt: now + i, reservedEpoch: Math.floor(now / 30), failures: 0 })));
    return commitments;
  }
  /** grows the group out of band (the issuer account, a generous explicit limit), one commitment per epoch: the construction that stalled v3.0.0 */
  async function growBySingles(n, code = "BATCH") {
    const vc = world.voteChain.connect(world.issuer);
    for (let i = 0; i < n; i++) {
      await world.nextEpoch();
      await (await vc.registerCommitmentBatch(world.ids[code], [rnd()], { gasLimit: 2_000_000n })).wait();
    }
  }
  const sortedBig = (list) => list.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const states = async () => Object.fromEntries((await CredentialIssuance.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
  const issuerNonce = () => world.provider.getTransactionCount(world.issuer.address, "latest");
  const events = async (code = "BATCH") => world.voteChain.queryFilter(world.voteChain.filters.CommitmentBatchRegistered(world.ids[code]));
  const logged = (msg) => memory.lines.map((l) => JSON.parse(l)).filter((e) => e.msg === msg);
  const selector = () => world.voteChain.interface.getFunction("registerCommitmentBatch").selector;
  /** does the released v3.0.0 limit fail for these commitments right now? (eth_call with exactly that limit) */
  async function releasedLimitFails(commitments) {
    try {
      await world.voteChain.connect(world.issuer).registerCommitmentBatch.staticCall(world.ids.BATCH, sortedBig(commitments), { gasLimit: RELEASED_LIMIT(commitments.length) });
      return false;
    } catch (err) {
      assert.equal(err.code, "CALL_EXCEPTION");
      assert.equal(err.revert, null, "the v3.0.0 failure mode: a call exception WITHOUT revert data");
      return true;
    }
  }

  it("a single commitment into a new tree: signed with a simulated limit that covers its use", async () => {
    await reserve(1);
    await world.nextEpoch();
    assert.equal((await identity.batcher.tick()).formed[0].outcome, "FINALIZED");
    const batch = await CommitmentBatch.findOne({});
    const tx = await world.provider.getTransaction(batch.txHash);
    const receipt = await world.provider.getTransactionReceipt(batch.txHash);
    assert.equal(tx.gasLimit, BigInt(batch.gasLimit), "the persisted limit is the signed limit");
    assert.ok(receipt.gasUsed <= tx.gasLimit);
    assert.deepEqual(await states(), { ISSUED: 1 });
  });

  it("FOUR COMMITMENTS AT THE TREE STATE THAT STALLED v3.0.0 (group of 31 grown by single commitments): registered in one pass, no retry loop", async () => {
    await growBySingles(31);
    const commitments = await reserve(4);
    await world.nextEpoch();
    assert.ok(await releasedLimitFails(commitments), "precondition: the v3.0.0 limit (550,000) is too low here");
    const report = await identity.batcher.tick();
    assert.equal(report.formed[0].outcome, "FINALIZED");
    const batch = await CommitmentBatch.findOne({});
    assert.ok(BigInt(batch.gasLimit) > RELEASED_LIMIT(4));
    assert.equal(logged("batch simulation could not be completed (the node did not answer); retrying later").length, 0);
    assert.deepEqual((await world.groupLeaves("BATCH")).slice(31), sortedBig(commitments));
    assert.deepEqual(await states(), { ISSUED: 4 });
  });

  it("crash right after signing at that state: the raw transaction persisted BEFORE broadcast carries the validated limit, and recovery sends exactly those bytes once", async () => {
    await growBySingles(31);
    const commitments = await reserve(4);
    await world.nextEpoch();
    const doomed = buildIdentity({ testHooks: crashAt("afterSign") });
    await doomed.chain.init();
    await assert.rejects(doomed.batcher.tick(), SimulatedCrash);
    const signed = await CommitmentBatch.findOne({ state: "SIGNED" }).select("+rawTx");
    assert.equal(Transaction.from(signed.rawTx).gasLimit, BigInt(signed.gasLimit), "the signed bytes carry the persisted limit");
    assert.ok(BigInt(signed.gasLimit) > RELEASED_LIMIT(4));
    const nonce = await issuerNonce();
    const fresh = buildIdentity();
    await fresh.chain.init();
    assert.equal((await fresh.batcher.recover()).resumed[0].outcome, "FINALIZED");
    assert.equal((await events()).at(-1).transactionHash, signed.txHash, "the very transaction that was persisted");
    assert.equal(await issuerNonce(), nonce + 1);
    assert.deepEqual((await world.groupLeaves("BATCH")).slice(31), sortedBig(commitments));
    assert.deepEqual(await states(), { ISSUED: 4 });
  });

  it("a batch left PREPARED at that state (as v3.0.0 left it, retrying forever) is completed by the fixed batcher after a restart", async () => {
    await growBySingles(31);
    const commitments = await reserve(4);
    await world.nextEpoch();
    const doomed = buildIdentity({ testHooks: crashAt("afterClaim") });
    await doomed.chain.init();
    await assert.rejects(doomed.batcher.tick(), SimulatedCrash);
    assert.deepEqual(await states(), { BATCHED: 4 });
    assert.ok(await releasedLimitFails(commitments));
    const fresh = buildIdentity();
    await fresh.chain.init();
    assert.equal((await fresh.batcher.recover()).resumed[0].outcome, "FINALIZED");
    assert.deepEqual(await states(), { ISSUED: 4 });
    assert.equal((await events()).length, 32);
  });

  it("GROWING TREE: 170 small batches (1-6 commitments), one per epoch, through the batcher: every batch finalizes in one pass, every commitment exactly once", async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const all = [];
    let releasedWouldFail = 0;
    for (let b = 0; b < 170; b++) {
      const commitments = await reserve(1 + Math.floor(rand() * 6));
      await world.nextEpoch();
      if (await releasedLimitFails(commitments)) releasedWouldFail++;
      const report = await identity.batcher.tick();
      assert.deepEqual(report.formed.map((f) => f.outcome), ["FINALIZED"], `batch ${b} (${commitments.length} commitments into ${all.length})`);
      all.push(...sortedBig(commitments));
    }
    assert.ok(releasedWouldFail > 50, `the v3.0.0 limit would have failed for many of these batches (${releasedWouldFail} of 170)`);
    const leaves = await world.groupLeaves("BATCH");
    assert.deepEqual(leaves, all, "the group holds exactly the reserved commitments, in batch order");
    assert.equal(new Set(leaves.map(String)).size, leaves.length, "no commitment twice");
    assert.equal((await events()).length, 170, "one transaction per batch");
    assert.deepEqual(await states(), { ISSUED: all.length });
    assert.equal(await CommitmentBatch.countDocuments({ state: { $ne: "FINALIZED" } }), 0, "nothing stuck, nothing failed");
    for (const b of await CommitmentBatch.find({})) {
      const receipt = await world.provider.getTransactionReceipt(b.txHash);
      assert.ok(receipt.gasUsed <= BigInt(b.gasLimit) && BigInt(b.gasLimit) <= TX_GAS_CAP);
    }
  });

  it("mixed batch sizes across epochs, including MAX_BATCH = 128 (where eth_estimateGas fails): each finalizes in one pass within the cap", async () => {
    const sizes = [1, 128, 3, 64, 2, 128, 1, 16, 5, 128, 4, 32, 6, 128];
    let total = 0;
    for (const n of sizes) {
      await reserve(n);
      await world.nextEpoch();
      const report = await identity.batcher.tick();
      assert.deepEqual(report.formed.map((f) => f.outcome), ["FINALIZED"], `${n} commitments into ${total}`);
      const batch = await CommitmentBatch.findOne({ count: n, firstIndex: total });
      const limit = BigInt(batch.gasLimit);
      assert.ok(limit <= TX_GAS_CAP);
      if (n === 128) assert.equal(limit, batchGasLimit(128, total), "the estimator fails for 128: the depth-aware prediction is used, validated by simulation");
      total += n;
    }
    assert.equal((await world.groupLeaves("BATCH")).length, total);
    assert.deepEqual(await states(), { ISSUED: total });
  });

  it("a GENUINE contract revert is still decoded and handled as before, never escalated as a gas problem", async () => {
    await reserve(3);
    await world.nextEpoch();
    await (await world.voteChain.connect(world.issuer).registerCommitmentBatch(world.ids.BATCH, [rnd()])).wait(); // out of band: this epoch already has a batch
    const report = await identity.batcher.tick();
    assert.equal(report.formed[0].outcome, "WAIT_EPOCH", "BatchAlreadyThisEpoch, decoded");
    assert.equal(logged("commitment batch needed more gas than predicted; a higher, simulated limit is used").length, 0);
    assert.deepEqual(await states(), { RESERVED: 3 });
    await world.nextEpoch();
    assert.equal((await identity.batcher.tick()).formed[0].outcome, "FINALIZED");
    assert.deepEqual(await states(), { ISSUED: 3 });
  });

  it("RPC timeouts while simulating: the batch stays PREPARED, nothing is signed or sent, and the next tick completes it", async () => {
    await reserve(2);
    await world.nextEpoch();
    let failures = 2;
    const wrapped = interceptRegister(world.provider, selector(), () => (failures > 0 ? (failures--, timeoutError()) : null));
    const timing = buildIdentity({ provider: wrapped.provider });
    await timing.chain.init();
    const nonce = await issuerNonce();
    const first = await timing.batcher.tick();
    assert.equal(first.formed[0].outcome, "RETRY");
    assert.equal((await CommitmentBatch.findOne({})).state, "PREPARED");
    assert.deepEqual(await states(), { BATCHED: 2 });
    assert.equal(await issuerNonce(), nonce, "nothing was sent");
    assert.equal(logged("batch simulation could not be completed (the node did not answer); retrying later").length, 1);
    assert.equal((await timing.batcher.tick()).resumed[0].outcome, "FINALIZED");
    assert.deepEqual(await states(), { ISSUED: 2 });
  });

  // This test used to assert the OPPOSITE (given back and counted after 30 timeouts, CANCELLED after maxFailures): that cancelled voters over an outage. Now an
  // unanswered simulation keeps the cohort intact however long it lasts, still sends nothing, backs off, and completes when the node answers.
  it("PERSISTENT simulation timeouts never cancel anybody: the cohort is kept through more than the old 30 attempts (nothing given back, counted or sent), and it completes once the node answers", async () => {
    await reserve(2);
    await world.nextEpoch();
    let down = true;
    const wrapped = interceptRegister(world.provider, selector(), () => (down ? timeoutError() : null));
    let t = Date.now();
    const stuck = buildIdentity({ provider: wrapped.provider, now: () => t, batch: { maxFailures: 2 } });
    await stuck.chain.init();
    const nonce = await issuerNonce();
    for (let i = 1; i <= 40; i++) {
      t += stuck.batcher.health().retryInMs + 1; // the backoff, in fake time
      const r = await stuck.batcher.tick();
      assert.deepEqual([...r.resumed, ...r.formed].map((x) => x.outcome), ["RETRY"], `attempt ${i}`);
    }
    assert.deepEqual(await states(), { BATCHED: 2 });
    assert.equal(await CredentialIssuance.countDocuments({ failures: { $gt: 0 } }), 0, "no failure counted against a voter");
    assert.equal(await CommitmentBatch.countDocuments({ state: "FAILED" }), 0);
    assert.equal((await CommitmentBatch.findOne({})).transientFailures, 40, "counted on the batch record instead (durable, diagnosis only)");
    assert.equal(await issuerNonce(), nonce, "nothing was ever signed or sent");
    assert.equal(logged("batch simulation could not be completed (the node did not answer); retrying later").length, 40);
    assert.equal(stuck.batcher.health().status, "DEGRADED");
    down = false;
    t += stuck.batcher.health().retryInMs + 1;
    assert.equal((await stuck.batcher.tick()).resumed[0].outcome, "FINALIZED");
    assert.deepEqual(await states(), { ISSUED: 2 });
    assert.equal(stuck.batcher.health().status, "OK");
  });

  it("a call that fails WITHOUT revert data even at the per-transaction cap: a cohort of several is halved, a single commitment is a counted deterministic failure; the loop ends", async () => {
    await reserve(4);
    await world.nextEpoch();
    const wrapped = interceptRegister(world.provider, selector(), (kind, tx) => (kind === "call" ? dataless(tx) : null));
    const impossible = buildIdentity({ provider: wrapped.provider, batch: { maxFailures: 2 } });
    await impossible.chain.init();
    const nonce = await issuerNonce();
    const outcomes = [];
    let ticks = 0;
    while ((await CredentialIssuance.countDocuments({ state: { $in: ["RESERVED", "BATCHED"] } })) > 0) {
      assert.ok(++ticks <= 20, "the loop must end");
      const r = await impossible.batcher.tick();
      outcomes.push(...r.resumed.map((x) => x.outcome), ...r.formed.map((x) => x.outcome));
    }
    assert.deepEqual(outcomes.slice(0, 2), ["SPLIT", "SPLIT"], "4 -> 2 -> 1");
    assert.deepEqual(await states(), { CANCELLED: 4 });
    assert.ok(await CommitmentBatch.exists({ failureCode: "GAS_CAP_EXCEEDED" }));
    assert.ok(await CommitmentBatch.exists({ failureCode: "SIMULATION_FAILED_AT_CAP" }));
    assert.equal(await issuerNonce(), nonce, "an operation that cannot succeed is never signed");
    for (const call of [wrapped.state.calls]) assert.ok(call <= 4 * 2 + 4 * 2 * 4, `bounded number of simulations (${call})`);
  });
});
