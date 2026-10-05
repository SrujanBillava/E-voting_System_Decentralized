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
/**
 * EXPLICIT gas limit, never an estimate: Hardhat's eth_estimateGas under Osaka probes about three times the real usage and fails for batches of roughly 100+
 * commitments although the transaction itself fits. Measured (smart-contract-v3/results/gas.json): 206k for 1, 10.1M for 128, i.e. under 85k per commitment plus
 * a fixed part. 150k + 100k per commitment covers that with a margin (a deeper tree adds about 6%) and stays under the cap for the frozen MAX_BATCH of 128.
 */
export const batchGasLimit = (count) => {
  const limit = 150_000n + 100_000n * BigInt(count);
  return limit > TX_GAS_CAP ? TX_GAS_CAP : limit;
};

const LOCK_MS = 60_000;
const UNSET_LINKAGE = Object.fromEntries(LINKAGE_FIELDS.map((f) => [f, 1]));
const byValue = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
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
 * Nonce: the provider's PENDING count, read inside the issuer queue, signed and persisted before the queue is released; no NonceManager.
 * A restart only ever rebroadcasts the identical bytes; a new transaction is created only for a batch the chain has PROVEN it never registered.
 * After a commitment is on-chain nothing releases, cancels or re-issues its reservation: only `finalize` moves it, to ISSUED.
 *
 * `testHooks` (tests only; server.js never passes any) lets a test throw SimulatedCrash at a named point to stand for a process death.
 */
export function createBatchManager({ CredentialIssuance, CommitmentBatch, VoterSession, FaceChallenge, chain, queue, audit, logger, now = Date.now, maxBatch = 128, receiptTimeoutMs = 5000, pollMs = 50, maxFailures = 3, testHooks = null }) {
  const { provider, contract, issuer } = chain;
  const electionId = () => chain.deployment.electionId;
  const hook = async (name, info) => testHooks?.[name]?.(info);
  const SELECT = "+rawTx";
  const log = (fields, msg) => logger.info({ batcher: true, ...fields }, msg);

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
    if (keep) await CommitmentBatch.updateOne({ _id: batch._id }, { $set: { state: BATCH.FAILED, failureCode: code }, $unset: { commitments: 1, rawTx: 1 } });
    else await CommitmentBatch.deleteOne({ _id: batch._id });
  }
  /** Every reservation of a PREPARED batch is cancelled (the election/issuance is closed, the constituency is gone): they can never be issued. */
  async function abandon(batch, code) {
    await cancel({ batchId: batch._id, state: CRED.BATCHED }, code);
    await CommitmentBatch.updateOne({ _id: batch._id }, { $set: { state: BATCH.FAILED, failureCode: code }, $unset: { commitments: 1, rawTx: 1 } });
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
    if (!st.constituency) {
      await cancel({ constituencyId, state: CRED.RESERVED }, "CONSTITUENCY_UNKNOWN");
      return { status: "NONE" };
    }
    if (st.phase !== PHASE.Open || !st.issuanceOpen) {
      await cancel({ constituencyId, state: CRED.RESERVED }, "ISSUANCE_CLOSED"); // they never reached the chain and now never can
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
      .limit(Math.min(maxBatch, remaining))
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
    if (!st.constituency) {
      await abandon(batch, "CONSTITUENCY_UNKNOWN");
      return "ABANDONED";
    }
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
    const gasLimit = batchGasLimit(batch.count);
    try {
      await contract.connect(issuer).registerCommitmentBatch.staticCall(batch.constituencyId, commitments, { gasLimit });
    } catch (err) {
      return simulationFailed(batch, err);
    }

    const sent = await queue.run(async () => {
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
    log({ batchId: batch._id, constituencyId: batch.constituencyId, count: batch.count, txHash: sent.txHash }, "commitment batch broadcast");
    return confirmWait({ ...batch.toObject(), ...sent });
  }

  /** What the contract's own simulation said, as a decision about the cohort. Nothing is signed yet, so every choice here is reversible. */
  async function simulationFailed(batch, err) {
    const revert = revertOf(err);
    if (!revert) {
      logger.warn({ batcher: true, batchId: batch._id, err }, "batch simulation could not be completed; retrying later");
      return "RETRY";
    }
    switch (revert.name) {
      case "BatchAlreadyThisEpoch":
        await giveUp(batch); // wait for the next epoch; the reservations are untouched
        return "WAIT_EPOCH";
      case "WrongPhase":
      case "IssuanceNotOpen":
      case "UnknownConstituency":
        await abandon(batch, revert.name);
        return "ABANDONED";
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
      await CommitmentBatch.updateOne({ _id: batch._id, state: BATCH.CONFIRMED }, { $set: { state: BATCH.FINALIZED }, $unset: { commitments: 1, rawTx: 1, claimToken: 1, lockUntil: 1 } });
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
      await this.sweepSessions().catch((err) => logger.warn({ batcher: true, err }, "session sweep failed"));
      // One failing batch (an unreachable node, say) must not stop the others; the step is simply retried on the next tick. Only a simulated crash escapes.
      const guarded = async (info, fn) => {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof SimulatedCrash) throw err;
          logger.warn({ batcher: true, ...info, err }, "batch step failed; it will be retried");
          return { error: err?.code ?? err?.name ?? "ERROR" };
        }
      };
      try {
        const open = await CommitmentBatch.find({ electionId: electionId(), state: { $in: UNFINISHED } }).select(SELECT);
        for (const batch of open) {
          if (batch.state === BATCH.RECONCILE_REQUIRED) continue; // a human decides
          const outcome = await guarded({ batchId: batch._id }, () => resume(batch));
          report.resumed.push({ state: batch.state, outcome: typeof outcome === "string" ? outcome : `ERROR:${outcome.error}` });
        }
        const constituencies = await CredentialIssuance.distinct("constituencyId", { electionId: electionId(), state: CRED.RESERVED });
        for (const constituencyId of constituencies) {
          if (await CommitmentBatch.exists({ electionId: electionId(), constituencyId, state: { $in: UNFINISHED } })) continue; // one unfinished batch per constituency
          const formed = await guarded({ constituencyId }, () => formBatch(constituencyId));
          report.formed.push(formed.error ? { status: "ERROR", error: formed.error } : formed);
        }
        return report;
      } finally {
        running = false;
      }
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
