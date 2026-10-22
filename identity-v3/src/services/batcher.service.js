import { randomUUID } from "node:crypto";
import { Transaction } from "ethers";
import { ISSUED_TTL_MS, STAGES } from "../auth/voterStages.js";
import { PHASE, revertOf, unavailable } from "../chain/chain.js";
import { BATCH, UNFINISHED } from "../models/CommitmentBatch.js";
import { CRED, LINKAGE_FIELDS } from "../models/CredentialIssuance.js";
import { AppError } from "../utils/errors.js";
import { EPOCH_SECONDS } from "./credential.service.js";

/** The per-transaction gas cap of the target network (2^24, EIP-7825 / the local Osaka network). */
export const TX_GAS_CAP = 16_777_216n;
/** Margin added to a usable eth_estimateGas result. */
const ESTIMATE_MARGIN_PERCENT = 25n;
/** Per level of the group's Merkle tree: a Poseidon hash (about 30k) plus storage; measured at most about 36k per level above the per-commitment part. */
const GAS_PER_TREE_LEVEL = 40_000n;

const treeDepth = (leaves) => {
  let depth = 0n;
  while (1n << depth < BigInt(leaves)) depth++;
  return depth;
};

/**
 * The PREDICTED gas limit of a batch of `count` commitments into a group that already has `treeSize` members. It is only the first candidate: before anything is
 * signed, `selectGasLimit` validates it (and, if needed, higher limits) by simulating the call.
 *
 * Why not just 150k + 100k per commitment (v3.0.0): the cost of an insertion grows with the depth of the group's Merkle tree (one Poseidon hash and storage per
 * level), so small batches into a grown tree need more than the fixed formula allows. Measured on the local Osaka network (identity-v3
 * test/chain/batch-gas.measure.js): a single commitment needs 206k into an empty tree but up to 391k at depth 12; four commitments into a group of 31 needed
 * 590k against the old 550k; 104 of 170 small batches (1-6 commitments) exceeded the old limit. Batches of 128 need about 10.3M, far under the old 12.95M. The
 * depth term covers every measured batch with a margin (over 274 measured batches of 1-128 commitments into trees of up to 3,072 members, the need was at
 * most 82% of this prediction) and keeps 128 commitments under the cap even at depth 24 (13.9M).
 *
 * Why not eth_estimateGas alone: Hardhat's estimator under Osaka probes about three times the real usage and fails for large batches (every measured batch of
 * 128; batches of 64 still estimated) although the transaction fits; it is used only as an additional hint (see selectGasLimit).
 */
export const batchGasLimit = (count, treeSize = 0) => {
  const limit = 150_000n + 100_000n * BigInt(count) + GAS_PER_TREE_LEVEL * treeDepth(Number(treeSize) + Number(count));
  return limit > TX_GAS_CAP ? TX_GAS_CAP : limit;
};

const GAS_HINT = /out ?of ?gas|gas required exceeds|intrinsic gas too low|not enough gas/i;
const messagesOf = (err) => [err?.shortMessage, err?.message, err?.info?.error?.message, err?.error?.message].filter(Boolean).join(" | ");

/**
 * What a failed simulation of registerCommitmentBatch means:
 *   REVERT          the contract reverted with an error of its ABI (decoded): deterministic, handled per error
 *   UNKNOWN_REVERT  it reverted with data that is not one of its errors: deterministic, never retried as if transient
 *   OUT_OF_GAS      the node said "out of gas" (the local network: "Transaction ran out of gas"), or the call ended with EMPTY revert data ("0x"): try more gas
 *   TRANSIENT       the node could not be asked (timeout, connection, server error), or it answered with a JSON-RPC ERROR OBJECT instead of an execution
 *                   result (rate limit, "header not found", internal error): ethers v6 reports those as a CALL_EXCEPTION with NO data at all, and they say
 *                   nothing about the call itself; try again later. Treating them as out-of-gas would split the cohort and finally cancel voters over an outage.
 */
export function classifySimulationError(err) {
  if (revertOf(err)) return "REVERT";
  if (GAS_HINT.test(messagesOf(err))) return "OUT_OF_GAS";
  if (err?.code === "CALL_EXCEPTION") {
    const data = typeof err.data === "string" ? err.data : null;
    if (data && data !== "0x") return "UNKNOWN_REVERT";
    if (data === "0x") return "OUT_OF_GAS";
  }
  return "TRANSIENT";
}

/**
 * Backoff between attempts while the chain is failing: the first `after - 1` failures are retried at the normal tick, then the wait doubles from `baseMs`
 * up to `maxMs`. Never zero once backing off, never unbounded.
 */
export function retryDelayMs(failures, { after = 3, baseMs = 2000, maxMs = 60_000 } = {}) {
  if (failures < after) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(failures - after, 30));
}

/**
 * Chooses the gas limit to sign, and only one that a simulation of the exact call has just ACCEPTED (bounded: at most four simulations).
 *   1. first candidate: the depth-aware prediction, raised to eth_estimateGas + 25% when the estimate is available and below the cap;
 *   2. while the simulation fails like an out-of-gas call: twice, then four times the candidate, then the cap (the issuer's balance must cover limit x fee,
 *      so the cap is the last resort, not the next step);
 *   3. any other failure stops the ladder at once: a revert is a decision about the cohort, a transient error a reason to try later.
 * `estimate()` and `simulate(gasLimit)` are the chain calls (injected, so the policy can be tested on its own).
 * Returns { ok: true, gasLimit, attempts, predicted, estimate } or { ok: false, kind, error, attempts, predicted, estimate }; kind OUT_OF_GAS means the call failed
 * even at the network's per-transaction cap.
 */
export async function selectGasLimit({ count, treeSize, estimate, simulate, cap = TX_GAS_CAP }) {
  const predicted = batchGasLimit(count, treeSize) > cap ? cap : batchGasLimit(count, treeSize);
  let estimated = null;
  try {
    const e = BigInt(await estimate());
    if (e > 0n && e <= cap) estimated = e;
  } catch {
    // the estimator is only a hint: under Osaka it fails for large batches, and a revert or an RPC failure shows again in the simulation below
  }
  let first = predicted;
  if (estimated !== null) {
    const padded = estimated + (estimated * ESTIMATE_MARGIN_PERCENT) / 100n;
    if (padded > first) first = padded > cap ? cap : padded;
  }
  const capped = (g) => (g > cap ? cap : g);
  const ladder = [...new Set([first, capped(first * 2n), capped(first * 4n), cap])];
  const attempts = [];
  let last = null;
  for (const gasLimit of ladder) {
    try {
      await simulate(gasLimit);
      attempts.push({ gasLimit, result: "OK" });
      return { ok: true, gasLimit, attempts, predicted, estimate: estimated };
    } catch (err) {
      const kind = classifySimulationError(err);
      attempts.push({ gasLimit, result: kind });
      last = { kind, error: err };
      if (kind !== "OUT_OF_GAS") break;
    }
  }
  return { ok: false, ...last, attempts, predicted, estimate: estimated };
}

const LOCK_MS = 60_000;
const UNSET_LINKAGE = Object.fromEntries(LINKAGE_FIELDS.map((f) => [f, 1]));
/** the operational retry data of a batch, removed when it ends */
const UNSET_FINISHED = { commitments: 1, rawTx: 1, transientFailures: 1 };
const byValue = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** transactions that already exist are reconciled before anything new is signed (a persisted but unbroadcast one holds a nonce the node does not count yet) */
const RESUME_ORDER = { SIGNED: 0, BROADCAST: 0, CONFIRMED: 1, PREPARED: 2 };
/** step outcomes that mean "the chain could not be used for this right now": they keep everything as it is and count towards the backoff */
const FAILED_OUTCOMES = { RETRY: "SIMULATION_UNAVAILABLE", CHAIN_INCONSISTENT: "CHAIN_STATE_INCONSISTENT", HALT: "ISSUER_NOT_AUTHORIZED" };
const codeOf = (err) => (typeof err?.code === "string" ? err.code : typeof err?.name === "string" ? err.name : "ERROR");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** a test hook raises this to stand for "the process died right here" */
export class SimulatedCrash extends Error {}

/**
 * THE EPOCH BATCHER: the only code that puts commitments on-chain.
 *
 * Policy. Reservations are grouped by the epoch (30 s of chain time) they were made in. At the first tick of a LATER epoch, the cohort of one constituency
 * (at most MAX_BATCH, at most the remaining voter cap) is sent as ONE batch, and never more than one batch per constituency per epoch (the contract refuses a
 * second). So the chain shows a set of commitments inserted together, sorted by value, not one insertion per voter at the voter's own moment. A cohort of one
 * is sent only because nobody else reserved in that epoch ("naturally required by the queue").
 *
 * Crash safety (the V2 principles). A batch is a persisted state machine:
 *   PREPARED  reservations claimed (RESERVED -> BATCHED), nothing signed
 *   SIGNED    the exact raw transaction is persisted BEFORE any broadcast
 *   BROADCAST sent (and re-sent, byte for byte, by recovery)
 *   CONFIRMED receipt success + CommitmentBatchRegistered + Semaphore MembersAdded verified against the persisted commitments
 *   FINALIZED every voter record is ISSUED and the linkage data is gone
 * Nonce: the provider's PENDING count, read inside the issuer queue, signed and persisted before the queue is released; no NonceManager. Existing
 * transactions are reconciled before anything new is signed, and nothing is signed while another batch is SIGNED but not known to be broadcast.
 * A restart only ever rebroadcasts the identical bytes; a new transaction is created only for a batch the chain has PROVEN it never registered.
 * After a commitment is on-chain nothing releases, cancels or re-issues its reservation: only `finalize` moves it, to ISSUED.
 *
 * Failures (see simulationFailed and tick):
 *   TEMPORARY      the node cannot be used right now (timeout, refused connection, 5xx, a JSON-RPC error object, a state that contradicts the election's own
 *                  history): EVERYTHING STAYS AS IT IS, however long it lasts and however often the process restarts. Nothing is cancelled and no failure is
 *                  counted against a voter. Attempts back off exponentially (retryDelayMs, from backoffBaseMs to backoffMaxMs); the degraded state is logged on
 *                  every attempt and escalated to an error once it has lasted alertAfterMs (then every alertEveryMs). Issuance resumes by itself.
 *   DETERMINISTIC  the contract (or the gas cap) refuses the cohort: bounded by DURABLE state, so a restart resets nothing. Each voter record counts its own
 *                  failed attempts (`failures`, after maxFailures the record is CANCELLED and the voter may request again), and a cohort that does not fit
 *                  under the per-transaction gas cap is re-formed at half the size, the size being derived from the FAILED(GAS_CAP_EXCEEDED) batch records.
 * The backoff position is in memory on purpose: it decides only WHEN to try again, never what happens to a reservation, and a fresh process should try at once.
 *
 * `testHooks` (tests only; server.js never passes any) lets a test throw SimulatedCrash at a named point to stand for a process death.
 */
export function createBatchManager({
  CredentialIssuance,
  CommitmentBatch,
  VoterSession,
  FaceChallenge,
  chain,
  queue,
  audit,
  logger,
  now = Date.now,
  maxBatch = 128,
  receiptTimeoutMs = 5000,
  pollMs = 50,
  maxFailures = 3,
  backoffAfter = 3,
  backoffBaseMs = 2000,
  backoffMaxMs = 60_000,
  alertAfterMs = 60_000,
  alertEveryMs = 5 * 60_000,
  testHooks = null,
}) {
  const { provider, contract, issuer } = chain;
  const electionId = () => chain.deployment.electionId;
  const hook = async (name, info) => testHooks?.[name]?.(info);
  const SELECT = "+rawTx";
  const log = (fields, msg) => logger.info({ batcher: true, ...fields }, msg);

  // ------------------------------------------------------------------------------------------------ health and backoff (in memory: timing only)

  const health = { failures: 0, since: null, nextAttemptAt: 0, lastError: null, lastAlertAt: null };

  /** operational counts only (no voter, no commitment) */
  async function pendingCounts() {
    const [reserved, batched] = await Promise.all([CredentialIssuance.countDocuments({ electionId: electionId(), state: CRED.RESERVED }), CredentialIssuance.countDocuments({ electionId: electionId(), state: CRED.BATCHED })]);
    return { pendingReserved: reserved, pendingBatched: batched };
  }

  /** One attempt failed for a temporary reason: wait longer before the next one, and say so (an error once the outage has lasted alertAfterMs). */
  async function noteFailure(code, where) {
    const t = now();
    health.failures++;
    health.since ??= t;
    health.lastError = code;
    const delay = retryDelayMs(health.failures, { after: backoffAfter, baseMs: backoffBaseMs, maxMs: backoffMaxMs });
    health.nextAttemptAt = t + delay;
    const fields = { batcher: true, issuance: "DEGRADED", where, error: code, consecutiveFailures: health.failures, outageMs: t - health.since, retryInMs: delay, ...(await pendingCounts().catch(() => ({}))) };
    if (t - health.since >= alertAfterMs && (health.lastAlertAt === null || t - health.lastAlertAt >= alertEveryMs)) {
      health.lastAlertAt = t;
      logger.error(fields, "CREDENTIAL ISSUANCE DEGRADED: the blockchain node has not been usable for a while; pending credential requests are kept (nothing is cancelled) and issuance resumes by itself when it answers");
    } else {
      logger.warn(fields, "credential issuance is waiting for the blockchain node (temporary failure); pending requests are kept, retrying with backoff");
    }
  }

  function noteHealthy() {
    if (health.failures === 0) return;
    logger.warn({ batcher: true, issuance: "RECOVERED", outageMs: now() - health.since, failedAttempts: health.failures }, "the blockchain node answers again: credential issuance resumed");
    Object.assign(health, { failures: 0, since: null, nextAttemptAt: 0, lastError: null, lastAlertAt: null });
  }

  /**
   * The node reports a state that this election has provably left behind: pending reservations exist only after the election opened (phases never go back),
   * and constituencies are fixed in Setup. That is a lagging, resynchronising or wrong node, not a decision about anybody's credential: nothing is cancelled.
   */
  function inconsistent(fields, what) {
    logger.error({ batcher: true, ...fields }, `the blockchain node reports ${what}, which contradicts this election's history (credential requests exist only after the election opened, and constituencies never disappear): probably a lagging or wrong node; nothing is cancelled, retrying later`);
    return "CHAIN_INCONSISTENT";
  }

  /** Cancellations because issuance closed are the election's rule, not an accident: make them loud (the audit trail records them too). */
  function reportClosed(count, fields) {
    if (count > 0) logger.error({ batcher: true, ...fields, cancelled: count }, "pending credential requests were cancelled because credential issuance is closed: they never reached the chain and the contract no longer accepts them (no credential is issued late and no deadline is changed)");
  }

  /** The cohort size for a constituency: MAX_BATCH, or half the smallest cohort that did not fit under the per-transaction gas cap (durable: survives restarts). */
  async function cohortLimitOf(constituencyId) {
    const smallest = await CommitmentBatch.findOne({ electionId: electionId(), constituencyId, state: BATCH.FAILED, failureCode: "GAS_CAP_EXCEEDED" }).sort({ count: 1 }).select("count");
    return smallest ? Math.max(1, Math.floor(smallest.count / 2)) : maxBatch;
  }

  // ------------------------------------------------------------------------------------------------ small helpers

  const registeredAmong = async (commitments) => {
    const flags = await Promise.all(commitments.map((c) => chain.commitmentRegistered(c)));
    return commitments.filter((_, i) => flags[i]);
  };

  /** Reservations (still pending, never ISSUED) -> CANCELLED, with all linkage data removed. */
  async function cancel(filter, reason) {
    const res = await CredentialIssuance.updateMany({ electionId: electionId(), ...filter }, { $set: { state: CRED.CANCELLED }, $unset: UNSET_LINKAGE });
    if (res.modifiedCount > 0) audit.record({ action: "CREDENTIAL_CANCELLED", result: "failure", meta: { reason, count: res.modifiedCount } });
    return res.modifiedCount;
  }

  /** The commitments a batch is carrying are exactly the BATCHED records pointing at it (PREPARED only: nothing is signed yet). */
  async function syncMembership(batch) {
    const members = await CredentialIssuance.find({ batchId: batch._id, state: CRED.BATCHED }).select("commitment");
    const commitments = members.map((m) => BigInt(m.commitment)).sort(byValue).map(String);
    if (commitments.length === 0) {
      await CommitmentBatch.deleteOne({ _id: batch._id, state: BATCH.PREPARED });
      return null;
    }
    if (commitments.length !== batch.count || commitments.some((c, i) => c !== batch.commitments[i])) {
      await CommitmentBatch.updateOne({ _id: batch._id, state: BATCH.PREPARED }, { $set: { commitments, count: commitments.length } });
      return CommitmentBatch.findById(batch._id).select(SELECT);
    }
    return batch;
  }

  /**
   * Give a PREPARED batch up (nothing was signed): its reservations go back to RESERVED (or to CANCELLED for `offenders`), and the batch record is removed
   * or kept as FAILED. Never used once a transaction exists.
   */
  async function giveUp(batch, { offenders = [], countFailure = false, keep = false, code = null } = {}) {
    if (offenders.length > 0) await cancel({ batchId: batch._id, state: CRED.BATCHED, commitment: { $in: offenders.map(String) } }, "COMMITMENT_REJECTED");
    await CredentialIssuance.updateMany({ batchId: batch._id, state: CRED.BATCHED }, { $set: { state: CRED.RESERVED }, $unset: { batchId: 1 }, ...(countFailure ? { $inc: { failures: 1 } } : {}) });
    if (countFailure) await cancel({ constituencyId: batch.constituencyId, state: CRED.RESERVED, failures: { $gte: maxFailures } }, "BATCH_FAILED_REPEATEDLY");
    if (keep) await CommitmentBatch.updateOne({ _id: batch._id }, { $set: { state: BATCH.FAILED, failureCode: code }, $unset: UNSET_FINISHED });
    else await CommitmentBatch.deleteOne({ _id: batch._id });
  }
  /** Every reservation of a PREPARED batch is cancelled (the election/issuance is closed): they can never be issued. */
  async function abandon(batch, code) {
    const count = await cancel({ batchId: batch._id, state: CRED.BATCHED }, code);
    await CommitmentBatch.updateOne({ _id: batch._id }, { $set: { state: BATCH.FAILED, failureCode: code }, $unset: UNSET_FINISHED });
    reportClosed(count, { batchId: batch._id, constituencyId: batch.constituencyId, reason: code });
  }

  async function waitForReceipt(txHash, timeoutMs = receiptTimeoutMs) {
    const stop = Date.now() + timeoutMs;
    for (;;) {
      let receipt;
      try {
        receipt = await provider.getTransactionReceipt(txHash);
      } catch {
        throw unavailable();
      }
      if (receipt) return receipt;
      if (Date.now() >= stop) return null;
      await sleep(pollMs);
    }
  }

  /** Broadcast the EXACT persisted raw transaction. A thrown error is ambiguous, so look the hash up before deciding. */
  async function broadcast({ rawTx, txHash }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await provider.broadcastTransaction(rawTx);
        return;
      } catch {
        try {
          if ((await provider.getTransaction(txHash)) || (await provider.getTransactionReceipt(txHash))) return; // it did arrive
        } catch {
          // RPC still down; try once more
        }
      }
    }
    throw unavailable(); // txHash and rawTx stay persisted: the next tick rebroadcasts the same bytes
  }

  // ------------------------------------------------------------------------------------------------ forming

  /** One cohort of one constituency -> a PREPARED batch -> signed and sent. Returns what happened (for tests and logs). */
  async function formBatch(constituencyId) {
    const eid = electionId();
    const st = await chain.readIssuanceState(constituencyId);
    if (!st.constituency) return { status: inconsistent({ constituencyId }, "an unknown constituency") };
    if (st.phase === PHASE.Setup) return { status: inconsistent({ constituencyId }, "the Setup phase") };
    if (st.phase !== PHASE.Open || !st.issuanceOpen) {
      const count = await cancel({ constituencyId, state: CRED.RESERVED }, "ISSUANCE_CLOSED"); // they never reached the chain and now never can
      reportClosed(count, { constituencyId, reason: "ISSUANCE_CLOSED", phase: st.phase, issuanceOpen: st.issuanceOpen });
      return { status: "CLOSED" };
    }
    const epoch = Math.floor((await chain.clock.nowSeconds()) / EPOCH_SECONDS);
    const last = await CommitmentBatch.findOne({ electionId: eid, constituencyId, state: { $in: [BATCH.CONFIRMED, BATCH.FINALIZED] } }).sort({ epoch: -1 }).select("epoch");
    if (last && last.epoch >= epoch) return { status: "WAIT_EPOCH" }; // one batch per constituency per epoch

    const remaining = st.constituency.registeredVoters - st.constituency.issued;
    if (remaining <= 0) {
      await cancel({ constituencyId, state: CRED.RESERVED }, "CAP_REACHED");
      return { status: "CAP" };
    }
    let due = await CredentialIssuance.find({ electionId: eid, constituencyId, state: CRED.RESERVED, reservedEpoch: { $lt: epoch } })
      .sort({ reservedAt: 1, _id: 1 })
      .limit(Math.min(maxBatch, remaining, await cohortLimitOf(constituencyId)))
      .select("commitment");
    if (due.length === 0) return { status: "NOTHING_DUE" };

    // A commitment somebody else already registered would revert the WHOLE cohort: refuse it before anything is signed.
    const taken = new Set(await registeredAmong(due.map((d) => d.commitment)));
    if (taken.size > 0) {
      await cancel({ _id: { $in: due.filter((d) => taken.has(d.commitment)).map((d) => d._id) }, state: CRED.RESERVED }, "COMMITMENT_REGISTERED");
      due = due.filter((d) => !taken.has(d.commitment));
      if (due.length === 0) return { status: "NOTHING_DUE" };
    }

    const batchId = randomUUID();
    const claimToken = randomUUID();
    const commitments = due.map((d) => BigInt(d.commitment)).sort(byValue).map(String);
    await CommitmentBatch.create({ _id: batchId, electionId: eid, constituencyId, state: BATCH.PREPARED, commitments, count: commitments.length, startBlock: await provider.getBlockNumber(), claimToken, lockUntil: new Date(now() + LOCK_MS) });
    await hook("afterBatchRecord", { batchId });
    await CredentialIssuance.updateMany({ _id: { $in: due.map((d) => d._id) }, state: CRED.RESERVED }, { $set: { state: CRED.BATCHED, batchId } }); // signAndSend re-reads the members, so a record cancelled meanwhile just drops out
    await hook("afterClaim", { batchId });
    if (due.length === remaining) await cancel({ constituencyId, state: CRED.RESERVED }, "CAP_REACHED"); // this cohort fills the cap: whoever is left can never be issued
    const batch = await CommitmentBatch.findById(batchId).select(SELECT);
    let outcome;
    try {
      outcome = await advance(batch);
    } finally {
      // the lease taken at creation is only for THIS pass: a batch that is still unfinished must be resumable by the very next tick
      await CommitmentBatch.updateOne({ _id: batchId, claimToken }, { $set: { lockUntil: null } }).catch(() => {});
    }
    return { status: "FORMED", batchId, outcome };
  }

  // ------------------------------------------------------------------------------------------------ signing and sending

  async function signAndSend(preparedBatch) {
    let batch = await syncMembership(preparedBatch);
    if (!batch) return "EMPTY";
    const st = await chain.readIssuanceState(batch.constituencyId);
    if (!st.constituency) return inconsistent({ batchId: batch._id, constituencyId: batch.constituencyId }, "an unknown constituency"); // the batch stays PREPARED
    if (st.phase === PHASE.Setup) return inconsistent({ batchId: batch._id, constituencyId: batch.constituencyId }, "the Setup phase");
    if (st.phase !== PHASE.Open || !st.issuanceOpen) {
      await abandon(batch, "ISSUANCE_CLOSED");
      return "ABANDONED";
    }
    if (st.constituency.issued + batch.count > st.constituency.registeredVoters) {
      await giveUp(batch); // the cohort is re-formed with the right size on the next tick
      return "RELEASED";
    }
    const offenders = await registeredAmong(batch.commitments);
    if (offenders.length > 0) {
      await giveUp(batch, { offenders });
      return "RELEASED";
    }

    const commitments = batch.commitments.map(BigInt);
    // The gas limit to sign: predicted from the batch size AND the group's current size (st.constituency.issued = its members), validated by simulating the
    // exact call before anything is signed (see selectGasLimit). Nothing below is signed with a limit the simulation did not accept.
    const register = contract.connect(issuer).registerCommitmentBatch;
    const choice = await selectGasLimit({
      count: batch.count,
      treeSize: st.constituency.issued,
      estimate: () => register.estimateGas(batch.constituencyId, commitments),
      simulate: (gasLimit) => register.staticCall(batch.constituencyId, commitments, { gasLimit }),
    });
    if (!choice.ok) return simulationFailed(batch, choice, st.constituency.issued);
    const gasLimit = choice.gasLimit;
    if (choice.attempts.length > 1) {
      logger.warn({ batcher: true, batchId: batch._id, count: batch.count, treeSize: st.constituency.issued, predicted: String(choice.predicted), estimate: choice.estimate === null ? null : String(choice.estimate), gasLimit: String(gasLimit), attempts: choice.attempts.map((a) => `${a.gasLimit}:${a.result}`) }, "commitment batch needed more gas than predicted; a higher, simulated limit is used");
    }

    const sent = await queue.run(async () => {
      // Another batch's transaction is persisted but not known to have reached the node (a crash or an outage between persisting and broadcasting): its nonce
      // is not in the node's pending count yet, so signing now could take that very nonce and make the persisted transaction unminable. Reconcile it first.
      if (await CommitmentBatch.exists({ electionId: electionId(), state: BATCH.SIGNED, _id: { $ne: batch._id } })) return null;
      const address = chain.addresses.issuer;
      const data = chain.abi.voteChain.encodeFunctionData("registerCommitmentBatch", [batch.constituencyId, commitments]);
      let signed;
      try {
        const nonce = await provider.getTransactionCount(address, "pending");
        const fees = await provider.getFeeData();
        const request = { type: 2, chainId: chain.deployment.chainId, nonce, to: chain.deployment.contractAddress, data, value: 0n, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
        const rawTx = await issuer.signTransaction(request);
        signed = { rawTx, txHash: Transaction.from(rawTx).hash, nonce };
      } catch {
        throw unavailable();
      }
      // PERSIST BEFORE BROADCASTING, guarded by the lease: only the current holder can persist, so there is at most one transaction per batch.
      const saved = await CommitmentBatch.updateOne({ _id: batch._id, state: BATCH.PREPARED, claimToken: batch.claimToken }, { $set: { state: BATCH.SIGNED, rawTx: signed.rawTx, txHash: signed.txHash, nonce: signed.nonce, gasLimit: gasLimit.toString() } });
      if (saved.modifiedCount !== 1) throw new AppError(409, "BATCH_IN_PROGRESS", "Another driver owns this batch");
      await hook("afterSign", { batchId: batch._id, txHash: signed.txHash });
      await broadcast(signed);
      await hook("afterBroadcast", { batchId: batch._id, txHash: signed.txHash });
      await CommitmentBatch.updateOne({ _id: batch._id, state: BATCH.SIGNED }, { $set: { state: BATCH.BROADCAST } });
      return signed;
    });
    if (!sent) {
      log({ batchId: batch._id, constituencyId: batch.constituencyId }, "commitment batch waits: another batch's persisted transaction must be reconciled first");
      return "WAIT_INFLIGHT";
    }
    log({ batchId: batch._id, constituencyId: batch.constituencyId, count: batch.count, txHash: sent.txHash, gasLimit: String(gasLimit) }, "commitment batch broadcast");
    return confirmWait({ ...batch.toObject(), ...sent });
  }

  /**
   * What the simulations said, as a decision about the cohort. Nothing is signed yet, so every choice here is reversible:
   *   TRANSIENT       the node could not be asked (or answered with an error object instead of a result): the batch STAYS PREPARED with every reservation,
   *                   however often this happens. Nothing is given back, cancelled or counted against a voter; the attempt is counted on the BATCH record
   *                   (durable, for diagnosis) and the tick backs off. The next attempt re-checks everything (phase, cap, membership, gas) from scratch.
   *   OUT_OF_GAS      the call failed even at the per-transaction gas cap: a cohort of several is given back and re-formed at half the size (the FAILED
   *                   GAS_CAP_EXCEEDED record is what remembers that size across restarts); a single commitment that cannot be registered at the cap is a
   *                   deterministic failure, counted on its voter record (durable), never retried as if transient
   *   UNKNOWN_REVERT  a revert that is not one of the contract's errors: deterministic, counted like any other unexpected revert
   *   REVERT          the contract's own error, decided as before (a revert that contradicts the election's history is treated as a node problem)
   */
  async function simulationFailed(batch, choice, treeSize) {
    const diagnostics = { batcher: true, batchId: batch._id, constituencyId: batch.constituencyId, count: batch.count, treeSize, predicted: String(choice.predicted), estimate: choice.estimate === null ? null : String(choice.estimate), attempts: choice.attempts.map((a) => `${a.gasLimit}:${a.result}`), err: choice.error };
    if (choice.kind === "TRANSIENT") {
      const counted = await CommitmentBatch.findOneAndUpdate({ _id: batch._id, state: BATCH.PREPARED }, { $inc: { transientFailures: 1 } }, { returnDocument: "after" }).select("transientFailures");
      logger.warn({ ...diagnostics, batchTransientFailures: counted?.transientFailures ?? null }, "batch simulation could not be completed (the node did not answer); retrying later");
      return "RETRY";
    }
    if (choice.kind === "OUT_OF_GAS") {
      if (batch.count > 1) {
        const smaller = Math.max(1, Math.floor(batch.count / 2));
        await giveUp(batch, { keep: true, code: "GAS_CAP_EXCEEDED" }); // the kept record (count, code) is what sets the next cohort size
        logger.error({ ...diagnostics, nextCohortSize: smaller }, "the batch could not be simulated successfully even at the per-transaction gas cap; it was given back and the cohort is re-formed at half the size");
        return "SPLIT";
      }
      await giveUp(batch, { countFailure: true, keep: true, code: "SIMULATION_FAILED_AT_CAP" });
      logger.error(diagnostics, "a single commitment could not be registered even at the per-transaction gas cap: deterministic failure, counted (not retried as transient)");
      return "RELEASED";
    }
    if (choice.kind === "UNKNOWN_REVERT") {
      await giveUp(batch, { countFailure: true, keep: true, code: "UNKNOWN_REVERT" });
      logger.error(diagnostics, "batch simulation reverted with an unrecognised error; the cohort was given back (failure counted)");
      return "RELEASED";
    }
    const revert = revertOf(choice.error);
    switch (revert.name) {
      case "BatchAlreadyThisEpoch":
        await giveUp(batch); // wait for the next epoch; the reservations are untouched
        return "WAIT_EPOCH";
      case "WrongPhase":
        if (Number(revert.args[0]) === PHASE.Setup) return inconsistent({ batchId: batch._id, constituencyId: batch.constituencyId }, "the Setup phase");
        await abandon(batch, revert.name);
        return "ABANDONED";
      case "IssuanceNotOpen":
        await abandon(batch, revert.name);
        return "ABANDONED";
      case "UnknownConstituency":
        return inconsistent({ batchId: batch._id, constituencyId: batch.constituencyId }, "an unknown constituency");
      case "IssuedCapExceeded":
        await giveUp(batch);
        return "RELEASED";
      case "DuplicateCommitment":
        await giveUp(batch, { offenders: [revert.args[0]] });
        return "RELEASED";
      case "InvalidCommitment":
        await giveUp(batch, { offenders: [batch.commitments[Number(revert.args[0])]] });
        return "RELEASED";
      case "NotIssuer":
        logger.error({ batcher: true, batchId: batch._id }, "this service's key is not the contract's issuer: batching is halted until that is fixed");
        return "HALT"; // reservations stay as they are; an operator fixes the configuration
      default:
        await giveUp(batch, { countFailure: true });
        return "RELEASED";
    }
  }

  // ------------------------------------------------------------------------------------------------ confirming

  async function confirmWait(batch) {
    const receipt = await waitForReceipt(batch.txHash);
    return receipt ? settle(batch, receipt) : "PENDING";
  }

  /** The receipt is the evidence: success, the contract's CommitmentBatchRegistered, and Semaphore's MembersAdded carrying EXACTLY the persisted commitments. */
  async function evidenceOf(batch, receipt, groupId) {
    const contractAddress = chain.deployment.contractAddress.toLowerCase();
    const semaphoreAddress = (await chain.semaphore.getAddress()).toLowerCase();
    let registered = null;
    let added = null;
    for (const entry of receipt.logs) {
      const from = entry.address.toLowerCase();
      try {
        if (from === contractAddress) {
          const parsed = chain.abi.voteChain.parseLog(entry);
          if (parsed?.name === "CommitmentBatchRegistered") registered = parsed.args;
        } else if (from === semaphoreAddress) {
          const parsed = chain.abi.semaphore.parseLog(entry);
          if (parsed?.name === "MembersAdded") added = parsed.args;
        }
      } catch {
        // not one of ours
      }
    }
    if (!registered || !added) return null;
    const members = [...added.identityCommitments].map(String);
    const ok =
      registered.constituencyId.toLowerCase() === batch.constituencyId &&
      Number(registered.count) === batch.count &&
      BigInt(added.groupId) === BigInt(groupId) &&
      members.length === batch.commitments.length &&
      members.every((m, i) => m === batch.commitments[i]) &&
      BigInt(added.startIndex) === BigInt(registered.firstIndex) &&
      BigInt(added.merkleTreeRoot) === BigInt(registered.merkleTreeRoot);
    return ok ? { epoch: Number(registered.epoch), firstIndex: Number(registered.firstIndex), issuedTotal: Number(registered.issuedTotal), merkleRoot: String(registered.merkleTreeRoot), blockNumber: receipt.blockNumber, txHash: receipt.hash } : null;
  }

  async function settle(batch, receipt) {
    if (receipt.status !== 1) return failReverted(batch);
    const required = chain.confirmations ?? 1;
    if (required > 1) {
      let head;
      try {
        head = await provider.getBlockNumber();
      } catch {
        throw unavailable();
      }
      if (head - receipt.blockNumber + 1 < required) return "WAITING";
    }
    const st = await chain.readIssuanceState(batch.constituencyId);
    const evidence = st.constituency ? await evidenceOf(batch, receipt, st.constituency.groupId) : null;
    if (!evidence) {
      // A successful transaction without the expected evidence is not something to guess about: stop, keep every reservation as it is, tell a human.
      await CommitmentBatch.updateOne({ _id: batch._id, state: { $in: [BATCH.SIGNED, BATCH.BROADCAST, BATCH.PREPARED] } }, { $set: { state: BATCH.RECONCILE_REQUIRED, txHash: receipt.hash, failureCode: "EVIDENCE_MISSING" } });
      logger.error({ batcher: true, batchId: batch._id, txHash: receipt.hash }, "a mined batch lacks the expected events: RECONCILIATION REQUIRED (nothing is released or issued automatically)");
      return "RECONCILE_REQUIRED";
    }
    const confirmed = await CommitmentBatch.updateOne(
      { _id: batch._id, state: { $in: [BATCH.PREPARED, BATCH.SIGNED, BATCH.BROADCAST] } },
      { $set: { state: BATCH.CONFIRMED, txHash: evidence.txHash, epoch: evidence.epoch, firstIndex: evidence.firstIndex, issuedTotal: evidence.issuedTotal, merkleRoot: evidence.merkleRoot, blockNumber: evidence.blockNumber } },
    );
    if (confirmed.modifiedCount === 1) log({ batchId: batch._id, constituencyId: batch.constituencyId, count: batch.count, txHash: evidence.txHash, epoch: evidence.epoch }, "commitment batch confirmed");
    await hook("afterConfirmed", { batchId: batch._id });
    return finalize(await CommitmentBatch.findById(batch._id).select(SELECT));
  }

  /** The transaction REVERTED: the chain registered nothing. Safe to give the cohort back (and to drop whoever somebody else registered meanwhile). */
  async function failReverted(batch) {
    const offenders = await registeredAmong(batch.commitments);
    await giveUp(batch, { offenders, countFailure: true, keep: true, code: "TX_REVERTED" });
    logger.warn({ batcher: true, batchId: batch._id, txHash: batch.txHash }, "commitment batch reverted; its reservations were released");
    return "REVERTED";
  }

  /**
   * CONFIRMED -> FINALIZED. Idempotent and crash-safe: each voter record moves BATCHED -> ISSUED in one atomic update that removes the linkage data, and the
   * batch is FINALIZED only when no record points at it any more. A restart simply continues with the records that are still BATCHED.
   */
  async function finalize(batch) {
    if (!batch || batch.state !== BATCH.CONFIRMED) return batch?.state ?? "GONE";
    const records = await CredentialIssuance.find({ batchId: batch._id, state: CRED.BATCHED }).select("voterId");
    let index = 0;
    for (const record of records) {
      await hook("duringFinalize", { batchId: batch._id, index: index++ });
      const done = await CredentialIssuance.findOneAndUpdate({ _id: record._id, state: CRED.BATCHED, batchId: batch._id }, { $set: { state: CRED.ISSUED }, $unset: UNSET_LINKAGE });
      if (done) {
        await VoterSession.updateMany({ voterId: record.voterId, active: true, stage: STAGES.COMMITMENT_PENDING }, { $set: { stage: STAGES.CREDENTIAL_ISSUED, stageExpiresAt: new Date(now() + ISSUED_TTL_MS) } });
        // the face step of this voter is over for good: its challenge row (voter id + timestamps) must not outlive the issuance
        await FaceChallenge.deleteMany({ voterId: record.voterId });
      }
    }
    const left = await CredentialIssuance.countDocuments({ batchId: batch._id, state: CRED.BATCHED });
    if (left === 0) {
      await CommitmentBatch.updateOne({ _id: batch._id, state: BATCH.CONFIRMED }, { $set: { state: BATCH.FINALIZED }, $unset: { ...UNSET_FINISHED, claimToken: 1, lockUntil: 1 } });
      audit.record({ action: "CREDENTIALS_ISSUED", result: "success", meta: { count: records.length } });
      return "FINALIZED";
    }
    return "FINALIZING";
  }

  // ------------------------------------------------------------------------------------------------ recovery

  /** The batch may already be mined under another transaction (a lost hash, a replaced transaction): look for EXACTLY its commitments in the group's events. */
  async function findMinedBatch(batch) {
    const st = await chain.readIssuanceState(batch.constituencyId);
    if (!st.constituency) return null;
    let logs;
    try {
      logs = await chain.semaphore.queryFilter(chain.semaphore.filters.MembersAdded(st.constituency.groupId), batch.startBlock ?? 0, "latest");
    } catch {
      throw unavailable();
    }
    const hit = logs.find((l) => {
      const members = [...l.args.identityCommitments].map(String);
      return members.length === batch.commitments.length && members.every((m, i) => m === batch.commitments[i]);
    });
    return hit ? hit.transactionHash : null;
  }

  /** SIGNED / BROADCAST: find out what became of the persisted transaction. */
  async function reconcile(batch) {
    let receipt;
    let tx;
    try {
      receipt = await provider.getTransactionReceipt(batch.txHash);
      tx = receipt ? null : await provider.getTransaction(batch.txHash);
    } catch {
      throw unavailable();
    }
    if (receipt) return settle(batch, receipt);
    if (tx) {
      await CommitmentBatch.updateOne({ _id: batch._id, state: BATCH.SIGNED }, { $set: { state: BATCH.BROADCAST } });
      return confirmWait(batch); // known to the node and pending: wait
    }
    // Unknown to the node. First: was the cohort mined by some other transaction after all?
    const minedBy = await findMinedBatch(batch);
    if (minedBy) {
      const mined = await provider.getTransactionReceipt(minedBy);
      if (mined) return settle({ ...batch.toObject(), txHash: minedBy }, mined);
    }
    let latestNonce;
    try {
      latestNonce = await provider.getTransactionCount(chain.addresses.issuer, "latest");
    } catch {
      throw unavailable();
    }
    if (latestNonce > batch.nonce) {
      // The nonce was spent by another transaction and our commitments are not in the group: this transaction can never be mined. The chain has PROVEN
      // the cohort was never registered, so (and only so) it goes back to the queue; whoever registered one of its commitments meanwhile is dropped.
      const offenders = await registeredAmong(batch.commitments);
      await giveUp(batch, { offenders, countFailure: true, keep: true, code: "NONCE_CONSUMED" });
      logger.warn({ batcher: true, batchId: batch._id }, "commitment batch can never be mined (its nonce was used by another transaction); its reservations were released");
      return "RELEASED";
    }
    await queue.run(() => broadcast({ rawTx: batch.rawTx, txHash: batch.txHash })); // identical bytes: safe to repeat
    await CommitmentBatch.updateOne({ _id: batch._id, state: BATCH.SIGNED }, { $set: { state: BATCH.BROADCAST } });
    return confirmWait(batch);
  }

  async function advance(batch) {
    if (!batch) return "GONE";
    switch (batch.state) {
      case BATCH.PREPARED:
        return signAndSend(batch);
      case BATCH.SIGNED:
      case BATCH.BROADCAST:
        return reconcile(batch);
      case BATCH.CONFIRMED:
        return finalize(batch);
      default:
        return batch.state;
    }
  }

  /** Take the batch's lease (a stale driver cannot write over a newer one), drive it one step, release the lease. */
  async function resume(batch) {
    const t = now();
    const leased = await CommitmentBatch.findOneAndUpdate({ _id: batch._id, state: batch.state, $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date(t) } }] }, { $set: { claimToken: randomUUID(), lockUntil: new Date(t + LOCK_MS) } }, { returnDocument: "after" }).select(SELECT);
    if (!leased) return "LOCKED";
    try {
      return await advance(leased);
    } finally {
      await CommitmentBatch.updateOne({ _id: leased._id, claimToken: leased.claimToken }, { $set: { lockUntil: null } }).catch(() => {});
    }
  }

  let running = false;
  return {
    /**
     * One pass: continue every unfinished batch (this is also the restart recovery), then form new cohorts. Safe to call at any time and from a timer;
     * overlapping calls are ignored.
     */
    async tick() {
      if (running) return { skipped: true };
      running = true;
      const report = { resumed: [], formed: [] };
      try {
        await this.sweepSessions().catch((err) => logger.warn({ batcher: true, err }, "session sweep failed"));
        // While the chain is failing, attempts are spaced out (retryDelayMs) instead of hitting the node on every timer tick.
        if (now() < health.nextAttemptAt) return { ...report, skipped: true, reason: "BACKOFF", retryInMs: health.nextAttemptAt - now() };
        // One cheap request first: when the node does not answer at all, nothing else is attempted (and nothing is changed) in this pass.
        try {
          await provider.getBlockNumber();
        } catch (err) {
          await noteFailure(codeOf(err), "probe");
          return { ...report, skipped: true, reason: "CHAIN_UNAVAILABLE" };
        }
        // One failing batch must not stop the others; the step is simply retried on a later tick. Only a simulated crash escapes.
        let failed = null;
        const guarded = async (info, fn) => {
          try {
            return await fn();
          } catch (err) {
            if (err instanceof SimulatedCrash) throw err;
            failed ??= codeOf(err);
            logger.warn({ batcher: true, ...info, err }, "batch step failed; it will be retried");
            return { error: codeOf(err) };
          }
        };
        const open = (await CommitmentBatch.find({ electionId: electionId(), state: { $in: UNFINISHED } }).select(SELECT)).sort((a, b) => (RESUME_ORDER[a.state] ?? 3) - (RESUME_ORDER[b.state] ?? 3));
        for (const batch of open) {
          if (batch.state === BATCH.RECONCILE_REQUIRED) continue; // a human decides
          const outcome = await guarded({ batchId: batch._id }, () => resume(batch));
          if (typeof outcome === "string" && FAILED_OUTCOMES[outcome]) failed ??= FAILED_OUTCOMES[outcome];
          report.resumed.push({ state: batch.state, outcome: typeof outcome === "string" ? outcome : `ERROR:${outcome.error}` });
        }
        const constituencies = await CredentialIssuance.distinct("constituencyId", { electionId: electionId(), state: CRED.RESERVED });
        for (const constituencyId of constituencies) {
          if (await CommitmentBatch.exists({ electionId: electionId(), constituencyId, state: { $in: UNFINISHED } })) continue; // one unfinished batch per constituency
          const formed = await guarded({ constituencyId }, () => formBatch(constituencyId));
          const code = FAILED_OUTCOMES[formed.status] ?? FAILED_OUTCOMES[formed.outcome];
          if (code) failed ??= code;
          report.formed.push(formed.error ? { status: "ERROR", error: formed.error } : formed);
        }
        if (failed) await noteFailure(failed, "batch");
        else noteHealthy();
        return report;
      } finally {
        running = false;
      }
    },

    /** The issuance health as this process sees it (operational only: nothing voter-linked). */
    health() {
      const t = now();
      return { status: health.failures > 0 ? "DEGRADED" : "OK", consecutiveFailures: health.failures, outageMs: health.since === null ? 0 : t - health.since, retryInMs: Math.max(0, health.nextAttemptAt - t), lastError: health.lastError };
    },

    /**
     * Housekeeping that is also data minimisation: a session past its stage or absolute expiry is DELETED now, not left to a TTL index that may fire an hour
     * later. In particular a session left in the terminal stage (the voter never fetched the result) carries `stageExpiresAt`, which encodes the moment of
     * issuance: it must not linger. Face-challenge rows follow their session's absolute expiry.
     */
    async sweepSessions() {
      const t = new Date(now());
      const sessions = await VoterSession.deleteMany({ $or: [{ stageExpiresAt: { $lte: t } }, { absoluteExpiresAt: { $lte: t } }] });
      const challenges = await FaceChallenge.deleteMany({ purgeAt: { $lte: t } });
      return { sessions: sessions.deletedCount, challenges: challenges.deletedCount };
    },

    /**
     * Startup recovery. One backend instance is assumed (as in V2), so any lease left by a process that died is stale: clear them, then continue every
     * unfinished batch exactly where it stopped (rebroadcast the persisted bytes, verify a mined receipt, finish the voter records).
     */
    async recover() {
      await CommitmentBatch.updateMany({ electionId: electionId(), state: { $in: UNFINISHED } }, { $set: { lockUntil: null } });
      return this.tick();
    },

    /** Operational counts (nothing voter-linked) for health output. */
    async stats() {
      const rows = await CommitmentBatch.aggregate([{ $match: { electionId: electionId() } }, { $group: { _id: "$state", n: { $sum: 1 } } }]);
      return Object.fromEntries(rows.map((r) => [r._id, r.n]));
    },
  };
}
