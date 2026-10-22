import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { secretValuesOf } from "../../src/config/env.js";
import { composeIdentity, MODELS } from "../../src/compose.js";
import { createProvider } from "../../src/chain/provider.js";
import { SimulatedCrash } from "../../src/services/batcher.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { closeDb, connectTestDb, resetDb, skipWithoutMongo } from "../helpers/db.js";
import { configFor } from "../helpers/env.js";
import { reads, simulates, startRpcProxy } from "../helpers/rpcProxy.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

// RPC OUTAGES AND SERVICE RESTARTS. The identity service under test talks to the chain ONLY through a fault-injecting JSON-RPC proxy (real ethers error paths);
// the test itself reads and drives the chain directly. Time for the batcher's backoff is a fake clock, so long outages take no real time.
// Before this fix: (1) a simulation the node could not answer was retried 30 times and then given back COUNTING a failure, so a voter could end CANCELLED over an
// outage; a JSON-RPC error object was even read as "out of gas" (split, then counted); (2) the retry counter and the cohort-halving state lived in memory.
const { CredentialIssuance, CommitmentBatch } = MODELS;
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");
const crashAt = (name, when = () => true) => ({ [name]: async (info) => { if (when(info)) throw new SimulatedCrash(`crash at ${name}`); } });
const OLD_LIMIT = 30; // v3.0.0 + the gas fix: maxSimulationRetries
const BACKOFF = { backoffBaseMs: 1000, backoffMaxMs: 8000, alertAfterMs: 20_000, alertEveryMs: 60_000 };

describe("identity-v3: RPC outages and service restarts never cancel a pending credential (real chain behind a failing proxy + real MongoDB)", { skip }, () => {
  let world;
  let config;
  let proxy;
  let memory;
  let snap;
  const clock = { t: Date.now() };
  /** a "process": its own provider (through the proxy), its own in-memory state; the database and the chain are shared */
  const processes = [];
  async function startProcess(opts = {}) {
    const provider = createProvider({ rpcUrl: proxy.url, chainId: 31337, timeoutMs: 400 });
    const identity = composeIdentity({
      config,
      logger: memory.logger,
      provider,
      clock: { nowSeconds: async () => (await provider.getBlock("latest")).timestamp }, // the chain's clock, read THROUGH the proxy (it fails in an outage too)
      now: () => clock.t,
      bcryptCost: 4,
      ...opts,
      batch: { ...BACKOFF, ...(opts.batch ?? {}) },
    });
    processes.push(provider);
    return identity;
  }
  /**
   * A restarted process: fresh in-memory state over the same database and chain. The real server starts its batcher only after the preflight has read the
   * chain (while the node is unreachable it waits: see the separate-process test), so the restart reads the chain metadata in a brief window in which the node
   * answers, and the outage (whatever it was) then continues.
   */
  async function restart(opts) {
    const identity = await startProcess(opts);
    const saved = { mode: proxy.state.mode, rule: proxy.state.rule, down: !proxy.listening };
    proxy.heal();
    await proxy.up();
    await identity.chain.init();
    Object.assign(proxy.state, { mode: saved.mode, rule: saved.rule });
    if (saved.down) await proxy.down();
    return identity;
  }
  /** one ATTEMPT: wait (fake time) until the backoff allows it, then tick */
  async function attempt(identity) {
    clock.t += identity.batcher.health().retryInMs + 1;
    return identity.batcher.tick();
  }

  before(async () => {
    await connectTestDb();
    world = await newWorld({ constituencies: { BATCH: { kc: 2, cap: 1000 }, "TN-CHE": { kc: 3, cap: 50 }, "KA-BLR": { kc: 3, cap: 50 } } });
    config = configFor(world);
    proxy = await startRpcProxy(world.url);
  });
  after(async () => {
    await proxy?.stop();
    world?.stop();
    await closeDb();
  });
  beforeEach(async () => {
    snap = await world.snapshot();
    await resetDb();
    proxy.heal();
    await proxy.up();
    memory = createMemoryLogger({ level: "info", secrets: secretValuesOf(config) });
  });
  afterEach(async () => {
    proxy.heal();
    await proxy.up();
    for (const p of processes.splice(0)) p.destroy();
    await world.revert(snap);
  });

  const rnd = () => BigInt("0x" + randomBytes(31).toString("hex"));
  async function reserve(n, code = "BATCH") {
    const now = (await world.provider.getBlock("latest")).timestamp;
    const commitments = Array.from({ length: n }, () => rnd().toString());
    await CredentialIssuance.insertMany(commitments.map((commitment, i) => ({ _id: `r-${randomBytes(6).toString("hex")}`, electionId: world.electionId, voterId: new mongoose.Types.ObjectId(), state: "RESERVED", commitment, constituencyId: world.ids[code], reservedAt: now + i, reservedEpoch: Math.floor(now / 30), failures: 0 })));
    return commitments;
  }
  const sortedBig = (list) => list.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const states = async () => Object.fromEntries((await CredentialIssuance.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
  const failuresCounted = async () => (await CredentialIssuance.find({ failures: { $gt: 0 } })).length;
  const issuerNonce = () => world.provider.getTransactionCount(world.issuer.address, "latest");
  const events = async (code = "BATCH") => world.voteChain.queryFilter(world.voteChain.filters.CommitmentBatchRegistered(world.ids[code]));
  const lines = () => memory.lines.map((l) => JSON.parse(l));
  const logged = (fragment, level) => lines().filter((e) => e.msg.includes(fragment) && (!level || e.level === level));
  const cancellations = () => lines().filter((e) => e.audit && e.action === "CREDENTIAL_CANCELLED");
  const REGISTER = () => world.voteChain.interface.getFunction("registerCommitmentBatch").selector;
  /** every leaf of every group, exactly once, and each reserved commitment exactly once */
  async function assertExactlyOnce(commitments, code = "BATCH") {
    const leaves = await world.groupLeaves(code);
    assert.equal(new Set(leaves.map(String)).size, leaves.length, "no commitment twice in the group");
    for (const c of commitments) assert.equal(leaves.filter((l) => l === BigInt(c)).length, 1, "each commitment exactly once");
  }

  it("THE PATH THAT USED TO CANCEL: the node answers reads but not the batch simulation (timeouts, resets, JSON-RPC errors, rate limits) for longer than the old 30-attempt limit and across a restart; nothing is given back, counted or cancelled, and the cohort is registered as soon as the simulation works", async () => {
    const commitments = await reserve(3);
    await world.nextEpoch();
    let n = 0;
    const kinds = ["rpcerror", "reset", "ratelimit", "503", "rpcerror", "hang"];
    proxy.when((msg) => (simulates(msg, REGISTER()) ? kinds[n++ % kinds.length] : null));
    let identity = await startProcess();
    await identity.chain.init();
    const nonce = await issuerNonce();
    for (let i = 1; i <= OLD_LIMIT + 10; i++) {
      if (i === 20) identity = await restart(); // the durable counter continues across the restart
      const report = await attempt(identity);
      assert.deepEqual([...report.resumed, ...report.formed].map((x) => x.outcome), ["RETRY"], `attempt ${i}`);
    }
    assert.deepEqual(await states(), { BATCHED: 3 }, "every reservation is still in its cohort");
    assert.equal(await failuresCounted(), 0, "no failure was counted against any voter");
    const batch = await CommitmentBatch.findOne({});
    assert.equal(batch.state, "PREPARED");
    assert.equal(batch.transientFailures, OLD_LIMIT + 10, "the attempts are counted on the BATCH record, durably");
    assert.equal(await CommitmentBatch.countDocuments({ state: "FAILED" }), 0);
    assert.equal(cancellations().length, 0);
    assert.equal(await issuerNonce(), nonce, "nothing was signed or sent");
    assert.equal(identity.batcher.health().status, "DEGRADED");
    assert.ok(logged("CREDENTIAL ISSUANCE DEGRADED", "error").length >= 1, "escalated to an error once the outage lasted");

    proxy.heal();
    const report = await attempt(identity);
    assert.equal(report.resumed[0].outcome, "FINALIZED");
    assert.deepEqual(await states(), { ISSUED: 3 });
    await assertExactlyOnce(commitments);
    assert.equal(await issuerNonce(), nonce + 1, "exactly one transaction");
    assert.equal((await CommitmentBatch.findOne({})).transientFailures, undefined, "the retry data is gone with the batch");
    assert.equal(identity.batcher.health().status, "OK");
    assert.equal(logged("credential issuance resumed").length, 1);
  });

  it("FULL OUTAGE across three restarts (refused connections, HTTP 503, JSON-RPC errors on every call) with one cohort PREPARED and another still RESERVED: nothing changes in the database, and after the outage both cohorts are registered exactly once", async () => {
    const a = await reserve(3, "BATCH");
    const b = await reserve(2, "TN-CHE");
    await world.nextEpoch();
    const doomed = await startProcess({ testHooks: crashAt("afterClaim", ({ batchId }) => batchId) });
    await doomed.chain.init();
    await assert.rejects(doomed.batcher.tick(), SimulatedCrash); // the first cohort is claimed (PREPARED), then the process dies
    const before = await states();
    assert.equal(before.BATCHED + before.RESERVED, 5);
    const nonce = await issuerNonce();

    const outages = [() => proxy.down(), () => proxy.set("503"), () => proxy.set("rpcerror")];
    let attempts = 0;
    for (const begin of outages) {
      proxy.heal();
      await proxy.up();
      const identity = await restart(); // restart number 1, 2, 3 ...
      await begin(); // ... and the node fails again, differently each time
      for (let i = 0; i < 15; i++, attempts++) {
        const report = await attempt(identity);
        assert.equal(report.skipped, true);
        assert.equal(report.reason, "CHAIN_UNAVAILABLE");
      }
      assert.equal(identity.batcher.health().status, "DEGRADED");
    }
    assert.ok(attempts > OLD_LIMIT);
    assert.deepEqual(await states(), before, "the database is exactly as the outage found it");
    assert.equal(await failuresCounted(), 0);
    assert.equal(cancellations().length, 0);

    proxy.heal();
    await proxy.up();
    const identity = await restart();
    const report = await identity.batcher.recover();
    assert.deepEqual([...report.resumed, ...report.formed].map((x) => x.outcome).sort(), ["FINALIZED", "FINALIZED"]);
    assert.deepEqual(await states(), { ISSUED: 5 });
    await assertExactlyOnce(a, "BATCH");
    await assertExactlyOnce(b, "TN-CHE");
    assert.equal(await issuerNonce(), nonce + 2, "one transaction per cohort");
  });

  it("A PERSISTENT DETERMINISTIC failure stays bounded ACROSS RESTARTS: the halved cohort size and the per-voter failure counts are durable, so a fresh process never re-tries the impossible full-size batch and every voter is cancelled after exactly maxFailures attempts", async () => {
    await reserve(4);
    await world.nextEpoch();
    // the node executes every registerCommitmentBatch simulation and runs out of gas, at any limit up to the cap: a cohort that can never be registered
    let simulations = 0;
    proxy.when((msg) => (simulates(msg, REGISTER()) ? (msg.method === "eth_call" && simulations++, { error: { code: -32603, message: "Transaction ran out of gas" } }) : null));
    const nonce = await issuerNonce();
    const sizes = [];
    let ticks = 0;
    while ((await CredentialIssuance.countDocuments({ state: { $in: ["RESERVED", "BATCHED"] } })) > 0) {
      assert.ok(++ticks <= 2 + 4 * 3, "bounded: two splits, then three counted attempts per voter");
      const identity = await restart(); // EVERY attempt in a freshly started process
      const report = await identity.batcher.recover();
      for (const f of report.formed) if (f.batchId) sizes.push((await CommitmentBatch.findById(f.batchId)).count);
    }
    assert.deepEqual(sizes.slice(0, 3), [4, 2, 1], "4 -> 2 -> 1, and never back to a larger size after a restart");
    assert.ok(sizes.slice(2).every((s) => s === 1));
    assert.equal(sizes.length, 2 + 4 * 3);
    assert.deepEqual(await states(), { CANCELLED: 4 });
    assert.equal(await CommitmentBatch.countDocuments({ failureCode: "GAS_CAP_EXCEEDED" }), 2);
    assert.equal(await CommitmentBatch.countDocuments({ failureCode: "SIMULATION_FAILED_AT_CAP" }), 12);
    assert.equal(await issuerNonce(), nonce, "an operation that cannot succeed is never signed");
    assert.ok(simulations <= 14 * 4, `at most four simulations per attempt (${simulations})`);
  });

  it("crash IMMEDIATELY AFTER SIGNING, then an outage through two restarts: recovery sends exactly the persisted bytes, once", async () => {
    const commitments = await reserve(3);
    await world.nextEpoch();
    const doomed = await startProcess({ testHooks: crashAt("afterSign") });
    await doomed.chain.init();
    await assert.rejects(doomed.batcher.tick(), SimulatedCrash);
    const signed = await CommitmentBatch.findOne({ state: "SIGNED" }).select("+rawTx");
    assert.equal(await world.provider.getTransaction(signed.txHash), null, "never broadcast");
    const nonce = await issuerNonce();
    await proxy.down();
    for (let r = 0; r < 2; r++) {
      const identity = await restart();
      for (let i = 0; i < 5; i++) assert.equal((await attempt(identity)).reason, "CHAIN_UNAVAILABLE");
    }
    assert.equal((await CommitmentBatch.findById(signed._id)).state, "SIGNED");
    await proxy.up();
    const identity = await restart();
    assert.equal((await identity.batcher.recover()).resumed[0].outcome, "FINALIZED");
    assert.equal((await events()).at(-1).transactionHash, signed.txHash, "the very transaction that was persisted");
    assert.equal(await issuerNonce(), nonce + 1);
    await assertExactlyOnce(commitments);
    assert.deepEqual(await states(), { ISSUED: 3 });
  });

  it("a persisted but unconfirmed transaction is reconciled BEFORE any other batch is signed: while it cannot be looked up, a due cohort of another constituency waits (no nonce collision, nothing released or counted)", async () => {
    const a = await reserve(3, "BATCH");
    await world.nextEpoch();
    const doomed = await startProcess({ testHooks: crashAt("afterSign") });
    await doomed.chain.init();
    await assert.rejects(doomed.batcher.tick(), SimulatedCrash);
    const signed = await CommitmentBatch.findOne({ state: "SIGNED" });
    const b = await reserve(2, "TN-CHE");
    await world.nextEpoch();
    const nonce = await issuerNonce();
    // the node answers everything except questions about the persisted transaction
    proxy.when((msg) => (msg?.method?.startsWith("eth_getTransaction") && JSON.stringify(msg.params).includes(signed.txHash.slice(2)) ? "reset" : null));
    let identity = await restart();
    const blocked = await identity.batcher.tick();
    assert.deepEqual(blocked.resumed.map((x) => x.outcome), ["ERROR:CHAIN_UNAVAILABLE"]);
    assert.deepEqual(blocked.formed.map((x) => x.outcome), ["WAIT_INFLIGHT"], "the other cohort does not take the persisted transaction's nonce");
    assert.equal(await issuerNonce(), nonce, "nothing was sent");
    proxy.heal();
    identity = await restart();
    const report = await identity.batcher.recover();
    assert.deepEqual(report.resumed.map((x) => x.outcome), ["FINALIZED", "FINALIZED"], "the persisted transaction first, then the waiting cohort");
    assert.equal((await events("BATCH"))[0].transactionHash, signed.txHash);
    const second = await world.provider.getTransaction((await events("TN-CHE"))[0].transactionHash);
    assert.equal(second.nonce, signed.nonce + 1, "the next nonce, not the persisted one's");
    assert.equal(await CommitmentBatch.countDocuments({ state: "FAILED" }), 0, "nothing had to be released");
    assert.deepEqual(await states(), { ISSUED: 5 });
    await assertExactlyOnce(a, "BATCH");
    await assertExactlyOnce(b, "TN-CHE");
  });

  it("crash AFTER BROADCASTING, before confirmation, and the node unreachable for the next two restarts: recovery finds the mined receipt and issues exactly once (no second transaction)", async () => {
    const commitments = await reserve(3);
    await world.nextEpoch();
    const doomed = await startProcess({ testHooks: crashAt("afterBroadcast") });
    await doomed.chain.init();
    await assert.rejects(doomed.batcher.tick(), SimulatedCrash);
    assert.equal((await CommitmentBatch.findOne({})).state, "SIGNED", "the database never learned that it was sent");
    const nonce = await issuerNonce();
    proxy.set("hang");
    for (let r = 0; r < 2; r++) {
      const identity = await restart();
      for (let i = 0; i < 3; i++) assert.equal((await attempt(identity)).reason, "CHAIN_UNAVAILABLE");
    }
    proxy.heal();
    const identity = await restart();
    assert.equal((await identity.batcher.recover()).resumed[0].outcome, "FINALIZED");
    assert.equal(await issuerNonce(), nonce, "no second transaction");
    assert.equal((await events()).length, 1);
    await assertExactlyOnce(commitments);
    assert.deepEqual(await states(), { ISSUED: 3 });
  });

  it("A TRANSACTION THAT SUCCEEDED WHILE THE SERVICE WAS DISCONNECTED: the broadcast reached the node but its answer was lost, and every lookup failed; after a restart in the outage and reconnection, the mined batch is found and finalized, exactly once", async () => {
    const commitments = await reserve(3);
    await world.nextEpoch();
    let delivered = false;
    proxy.when((msg) => {
      if (delivered) return "reset";
      if (msg?.method === "eth_sendRawTransaction") {
        delivered = true;
        return "forward-drop"; // the node gets it (and mines it), the service never hears back, and from now on nothing answers
      }
      return null;
    });
    const nonce = await issuerNonce();
    let identity = await startProcess();
    await identity.chain.init();
    const report = await identity.batcher.tick();
    assert.deepEqual(report.formed, [{ status: "ERROR", error: "CHAIN_UNAVAILABLE" }]);
    const batch = await CommitmentBatch.findOne({});
    assert.equal(batch.state, "SIGNED", "as far as the service knows, nothing was sent");
    assert.equal(await issuerNonce(), nonce + 1, "but the chain mined it");
    await assertExactlyOnce(commitments);
    identity = await restart(); // a restart, and the node is still unusable
    for (let i = 0; i < 4; i++) assert.equal((await attempt(identity)).reason, "CHAIN_UNAVAILABLE");
    proxy.heal();
    identity = await restart();
    assert.equal((await identity.batcher.recover()).resumed[0].outcome, "FINALIZED");
    assert.equal(await issuerNonce(), nonce + 1, "never a second transaction");
    assert.equal((await events()).length, 1);
    assert.equal((await events())[0].transactionHash, batch.txHash);
    await assertExactlyOnce(commitments);
    assert.deepEqual(await states(), { ISSUED: 3 });
  });

  it("ELECTION CLOSURE DURING AN OUTAGE: cohorts that never reached the chain are cancelled under the issuance rules, loudly and audited; nothing is sent late, no deadline moves; issuance does not resume", async () => {
    await reserve(3, "BATCH");
    await reserve(2, "TN-CHE");
    await world.nextEpoch();
    const doomed = await startProcess({ testHooks: crashAt("afterClaim") });
    await doomed.chain.init();
    await assert.rejects(doomed.batcher.tick(), SimulatedCrash);
    const nonce = await issuerNonce();
    await proxy.down();
    const identity = await restart();
    assert.equal((await identity.batcher.recover()).reason, "CHAIN_UNAVAILABLE", "the startup recovery clears the dead process's lease, then finds the node unusable");
    for (let i = 0; i < 5; i++) assert.equal((await attempt(identity)).reason, "CHAIN_UNAVAILABLE");
    await (await world.voteChain.closeIssuance()).wait(); // the owner closes issuance while the identity service cannot see the chain
    const closedAt = await world.voteChain.issuanceClosedAt();
    for (let i = 0; i < 5; i++) assert.equal((await attempt(identity)).reason, "CHAIN_UNAVAILABLE");
    assert.equal(cancellations().length, 0, "nothing is decided while the chain cannot be read");
    await proxy.up();
    const report = await attempt(identity);
    assert.deepEqual([...report.resumed.map((x) => x.outcome), ...report.formed.map((x) => x.status)].sort(), ["ABANDONED", "CLOSED"]);
    assert.deepEqual(await states(), { CANCELLED: 5 });
    assert.equal(await issuerNonce(), nonce, "nothing was sent after the cutoff");
    assert.deepEqual(await world.groupLeaves("BATCH"), []);
    assert.equal(await world.voteChain.issuanceClosedAt(), closedAt, "the deadline is the owner's, untouched");
    const audited = cancellations();
    assert.deepEqual(audited.map((a) => a.reason).sort(), ["ISSUANCE_CLOSED", "ISSUANCE_CLOSED"]);
    assert.deepEqual(audited.map((a) => a.count).sort(), [2, 3]);
    assert.equal(logged("cancelled because credential issuance is closed", "error").length, 2, "operator-visible");
    assert.equal(identity.batcher.health().status, "OK", "the chain answered; closure is not an outage");
  });

  it("closure during an outage, but the cohort's transaction REACHED THE CHAIN BEFORE THE CUTOFF: it is delivered (registered in time), while a cohort that never reached the chain is cancelled", async () => {
    const early = await reserve(3, "BATCH");
    await world.nextEpoch();
    let delivered = false;
    proxy.when((msg) => {
      if (delivered) return "reset";
      if (msg?.method === "eth_sendRawTransaction") {
        delivered = true;
        return "forward-drop";
      }
      return null;
    });
    let identity = await startProcess();
    await identity.chain.init();
    await identity.batcher.tick();
    await assertExactlyOnce(early, "BATCH");
    await reserve(2, "TN-CHE");
    await world.nextEpoch();
    await (await world.voteChain.closeIssuance()).wait();
    proxy.heal();
    identity = await restart();
    const report = await identity.batcher.recover();
    assert.deepEqual(report.resumed.map((x) => x.outcome), ["FINALIZED"]);
    assert.deepEqual(report.formed.map((x) => x.status), ["CLOSED"]);
    assert.deepEqual(await states(), { ISSUED: 3, CANCELLED: 2 });
    await assertExactlyOnce(early, "BATCH");
    assert.deepEqual(await world.groupLeaves("TN-CHE"), []);
  });

  it("a LAGGING OR WRONG NODE that reports the Setup phase, or an unknown constituency, never cancels anybody: the batcher waits (and says so) until the node is consistent again", async () => {
    const commitments = await reserve(2);
    await world.nextEpoch();
    const phase = world.voteChain.interface.getFunction("phase").selector;
    const getConstituency = world.voteChain.interface.getFunction("getConstituency").selector;
    const zero = "0x" + "0".repeat(64);
    let identity = await startProcess();
    await identity.chain.init();
    proxy.when((msg) => (reads(msg, phase) ? { result: zero } : null)); // "the election is in Setup"
    assert.deepEqual((await attempt(identity)).formed.map((f) => f.status), ["CHAIN_INCONSISTENT"]);
    const unknown = world.voteChain.interface.encodeErrorResult("UnknownConstituency", [world.ids.BATCH]);
    proxy.when((msg) => (reads(msg, getConstituency) ? { error: { code: 3, message: "execution reverted", data: unknown } } : null));
    assert.deepEqual((await attempt(identity)).formed.map((f) => f.status), ["CHAIN_INCONSISTENT"]);
    assert.deepEqual(await states(), { RESERVED: 2 });
    assert.equal(cancellations().length, 0);
    assert.equal(logged("contradicts this election's history", "error").length, 2);
    proxy.heal();
    identity = await restart();
    assert.equal((await attempt(identity)).formed[0].outcome, "FINALIZED");
    await assertExactlyOnce(commitments);
  });

  it("BACKOFF: during an outage the batcher does not hammer the node (no request at all while backing off, the wait doubles up to its cap), the state is observable, and it resumes by itself", async () => {
    const commitments = await reserve(2);
    await world.nextEpoch();
    const identity = await startProcess();
    await identity.chain.init();
    proxy.set("reset");
    for (let i = 1; i <= 3; i++) assert.equal((await identity.batcher.tick()).reason, "CHAIN_UNAVAILABLE", `tick ${i}: the first failures are retried at the normal tick`);
    const requests = proxy.state.requests;
    for (let i = 0; i < 50; i++) assert.equal((await identity.batcher.tick()).reason, "BACKOFF");
    assert.equal(proxy.state.requests, requests, "not a single request to the node while backing off");
    const waits = [];
    for (let i = 0; i < 6; i++) {
      waits.push(identity.batcher.health().retryInMs);
      await attempt(identity);
    }
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000, 8000], "doubling, capped");
    const health = identity.batcher.health();
    assert.equal(health.status, "DEGRADED");
    assert.equal(health.consecutiveFailures, 9);
    assert.equal(health.lastError, "ECONNRESET");
    assert.ok(logged("waiting for the blockchain node", "warn").length >= 3);
    assert.ok(logged("CREDENTIAL ISSUANCE DEGRADED", "error").length >= 1);
    proxy.heal();
    const report = await attempt(identity);
    assert.equal(report.formed[0].outcome, "FINALIZED");
    assert.equal(identity.batcher.health().status, "OK");
    assert.equal(identity.batcher.health().retryInMs, 0);
    await assertExactlyOnce(commitments);
  });
});
