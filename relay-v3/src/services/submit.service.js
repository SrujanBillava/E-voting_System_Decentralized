import { randomUUID } from "node:crypto";
import { Transaction } from "ethers";
import { PHASE, unavailable } from "../chain/chain.js";
import { IN_FLIGHT, SUBMISSION } from "../models/AnonymousSubmission.js";
import { AppError } from "../utils/errors.js";
import { argsOfCalldata, canonicalPackage } from "./ballotPackage.js";

const LOCK_MS = 60_000;
const S = SUBMISSION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** a test hook raises this to stand for "the process died right here" */
export class SimulatedCrash extends Error {}

/** how a failed simulation or estimate reads to the caller; null when it was not a revert at all (a network problem) */
function classify(revert, err) {
  const name = revert?.name;
  if (name === "WrongPhase") return Number(revert.args[0]) === PHASE.Closed ? [409, "ELECTION_CLOSED", "The election is closed"] : [409, "ELECTION_NOT_OPEN", "The election is not open"];
  const table = {
    UnknownConstituency: [422, "UNKNOWN_CONSTITUENCY", "Unknown constituency"],
    WrongCoordinateCount: [422, "WRONG_COORDINATE_COUNT", "The ciphertext does not have the right number of coordinates for this constituency"],
    WrongSemaphoreDepth: [422, "WRONG_SEMAPHORE_DEPTH", "The membership proof must be declared at depth 20"],
    NullifierOutOfField: [422, "NULLIFIER_OUT_OF_FIELD", "The nullifier is not a field element"],
    NullifierAlreadyUsed: [409, "NULLIFIER_ALREADY_USED", "This nullifier is already recorded"],
    CoordinateOutOfField: [422, "COORDINATE_OUT_OF_FIELD", "A ciphertext coordinate is not a field element"],
    IdentityC1: [422, "IDENTITY_C1", "A ciphertext has an identity C1"],
    InvalidMembershipProof: [422, "INVALID_MEMBERSHIP_PROOF", "The membership proof is not valid"],
    InvalidValidityProof: [422, "INVALID_VALIDITY_PROOF", "The ballot validity proof is not valid"],
  };
  if (name?.startsWith("Semaphore__")) return [422, "INVALID_MEMBERSHIP_PROOF", "The membership proof is not valid (unknown or expired root, or not a member)"];
  if (name && table[name]) return table[name];
  if (err?.code === "CALL_EXCEPTION") return [422, "REJECTED_BY_CONTRACT", "The contract rejected this ballot"];
  return null;
}

/**
 * The anonymous submission pipeline. Its only key is the NULLIFIER.
 *
 *   package -> canonicalise -> (nullifier known? same package: report it; another package: CONFLICT) -> nullifier on-chain? -> contract static simulation
 *           -> persist QUEUED -> sign (persist the EXACT raw transaction) -> broadcast -> receipt -> verify BallotRecorded -> CONFIRMED
 *
 * Crash safety (the V2 principles): one signer queue; the nonce is the PENDING count read inside the queue; the raw transaction is persisted BEFORE broadcast;
 * a restart only ever rebroadcasts the identical bytes; a NEW transaction for the same nullifier exists only after the chain has proved the old one dead
 * (its nonce was spent by another transaction and the nullifier is still unused). Leases (`claimToken`) keep a stale driver from writing over a newer one.
 * Nothing here knows who the voter is: there is no field, parameter or log line that could carry it.
 *
 * `testHooks` (tests only; server.js never passes any) lets a test throw SimulatedCrash at a named point.
 */
export function createSubmitService({ AnonymousSubmission, chain, queue, logger, now = Date.now, receiptTimeoutMs = 20_000, pollMs = 100, testHooks = null }) {
  const { provider, contract, relayer } = chain;
  const hook = async (name, info) => testHooks?.[name]?.(info);
  const SELECT = "+rawTx +calldata";
  const fresh = (id) => AnonymousSubmission.findById(id).select(SELECT);
  const reply = (http, body) => ({ http, body });
  const view = (doc) => ({
    state: doc.state,
    nullifier: doc.nullifier,
    ...(doc.txHash ? { txHash: doc.txHash } : {}),
    ...(doc.state === S.CONFIRMED ? { blockNumber: doc.blockNumber, ballotIndex: doc.ballotIndex } : {}),
    ...(doc.state === S.FAILED ? { failureCode: doc.failureCode } : {}),
  });
  const rejection = (err) => classify(chain.decodeRevert(err), err);
  const touch = () => ({ touchedAt: now() });
  /** a chain call failed for a reason that is not a contract revert: say why in the log (scrubbed), answer 503 */
  const down = (err, where) => {
    logger.warn({ submission: true, where, err }, "a chain call failed");
    return unavailable();
  };

  // ------------------------------------------------------------------------------------------------ chain evidence

  /** The BallotRecorded event of a nullifier (anybody's transaction), or null. */
  async function recordedEvent(nullifier) {
    let logs;
    try {
      logs = await contract.queryFilter(contract.filters.BallotRecorded(null, BigInt(nullifier)), 0, "latest");
    } catch {
      throw unavailable();
    }
    return logs[0] ?? null;
  }
  const sameBallot = (log, constituencyId, coords) => log.args.constituencyId.toLowerCase() === constituencyId && [...log.args.coords].length === coords.length && [...log.args.coords].every((c, i) => BigInt(c) === coords[i]);

  async function markConfirmed(doc, { txHash, blockNumber, ballotIndex }) {
    const done = await AnonymousSubmission.findOneAndUpdate(
      { _id: doc._id, state: { $ne: S.CONFIRMED } },
      { $set: { state: S.CONFIRMED, txHash, blockNumber: Number(blockNumber), ballotIndex: Number(ballotIndex), rawTx: null, lockUntil: null, failureCode: null, ...touch() } },
      { returnDocument: "after" },
    ).select(SELECT);
    if (done) logger.info({ submission: true, state: S.CONFIRMED, txHash }, "ballot confirmed");
    return done ?? fresh(doc._id);
  }
  async function markFailed(doc, failureCode) {
    const done = await AnonymousSubmission.findOneAndUpdate({ _id: doc._id, state: { $in: [...IN_FLIGHT] } }, { $set: { state: S.FAILED, failureCode, rawTx: null, lockUntil: null, ...touch() } }, { returnDocument: "after" }).select(SELECT);
    if (done) logger.warn({ submission: true, state: S.FAILED, failureCode }, "ballot submission failed");
    return done ?? fresh(doc._id);
  }

  /** The nullifier is recorded on-chain. If it is THIS ballot (same constituency, same ciphertext), the submission is confirmed whoever sent it. */
  async function adoptRecorded(doc) {
    const log = await recordedEvent(doc.nullifier);
    if (!log) return null;
    const { constituencyId, coords } = argsOfCalldata(doc.calldata, chain.abi.voteChain);
    if (!sameBallot(log, constituencyId, coords)) return markFailed(doc, "NULLIFIER_USED_BY_ANOTHER_BALLOT");
    return markConfirmed(doc, { txHash: log.transactionHash, blockNumber: log.blockNumber, ballotIndex: log.args.ballotIndex });
  }

  /** The receipt is the evidence: success, a BallotRecorded matching the package exactly, and the nullifier consumed at the receipt's block. */
  async function verifyReceipt(doc, receipt) {
    if (receipt.status !== 1) {
      if (await chain.nullifierUsed(doc.nullifier)) return (await adoptRecorded(doc)) ?? markFailed(doc, "RECONCILIATION_REQUIRED");
      return markFailed(doc, "TX_REVERTED");
    }
    const required = chain.confirmations ?? 1;
    if (required > 1) {
      let head;
      try {
        head = await provider.getBlockNumber();
      } catch {
        throw unavailable();
      }
      if (head - receipt.blockNumber + 1 < required) return doc; // not final yet: stays as it is
    }
    const { constituencyId, coords } = argsOfCalldata(doc.calldata, chain.abi.voteChain);
    const address = chain.deployment.contractAddress.toLowerCase();
    let event = null;
    for (const entry of receipt.logs) {
      if (entry.address.toLowerCase() !== address) continue;
      try {
        const parsed = chain.abi.voteChain.parseLog(entry);
        if (parsed?.name === "BallotRecorded") event = parsed;
      } catch {
        // not ours
      }
    }
    let ok = Boolean(event) && String(event.args.nullifier) === doc.nullifier && sameBallot({ args: event.args }, constituencyId, coords);
    if (ok) {
      try {
        const expected = await contract.ballotHashOf(constituencyId, coords);
        ok = BigInt(event.args.ballotHash) === BigInt(expected) && (await chain.nullifierUsed(doc.nullifier, { blockTag: receipt.blockNumber }));
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw unavailable();
      }
    }
    if (!ok) return markFailed(doc, "EVENT_MISSING"); // a successful transaction without the expected BallotRecorded: never reported as confirmed
    return markConfirmed(doc, { txHash: receipt.hash, blockNumber: receipt.blockNumber, ballotIndex: event.args.ballotIndex });
  }

  async function waitForReceipt(txHash, timeoutMs) {
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
  async function confirm(doc, timeoutMs) {
    const receipt = await waitForReceipt(doc.txHash, timeoutMs);
    return receipt ? verifyReceipt(doc, receipt) : doc;
  }

  /** Broadcast the EXACT persisted raw transaction. A thrown error is ambiguous, so look the hash up before deciding. */
  async function broadcast(doc) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await provider.broadcastTransaction(doc.rawTx);
        return;
      } catch {
        try {
          if ((await provider.getTransaction(doc.txHash)) || (await provider.getTransactionReceipt(doc.txHash))) return;
        } catch {
          // RPC still down
        }
      }
    }
    throw unavailable(); // rawTx and txHash stay persisted: the next attempt rebroadcasts the same bytes
  }

  // ------------------------------------------------------------------------------------------------ driving one submission

  const lease = (doc, states) =>
    AnonymousSubmission.findOneAndUpdate(
      { _id: doc._id, state: { $in: states }, $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date(now()) } }] },
      { $set: { lockUntil: new Date(now() + LOCK_MS), claimToken: randomUUID(), ...touch() } },
      { returnDocument: "after" },
    ).select(SELECT);
  const unlock = (doc) => AnonymousSubmission.updateOne({ _id: doc._id, claimToken: doc.claimToken }, { $set: { lockUntil: null } }).catch(() => {});

  /** QUEUED -> SIGNED -> BROADCAST (-> CONFIRMED when the receipt is seen). The lease is held. */
  async function signAndSend(doc, waitMs) {
    // Simulate AGAIN right before signing: this may be a recovered submission, and the world may have changed since the precheck.
    try {
      await contract.connect(relayer).submitBallot.staticCall(...argsOfCalldata(doc.calldata, chain.abi.voteChain).args);
    } catch (err) {
      const why = rejection(err);
      if (!why) throw down(err, "re-simulation");
      if (why[1] === "NULLIFIER_ALREADY_USED") return (await adoptRecorded(doc)) ?? markFailed(doc, why[1]);
      return markFailed(doc, why[1]);
    }
    const sent = await queue.run(async () => {
      let signed;
      try {
        const address = chain.addresses.relayer;
        const nonce = await provider.getTransactionCount(address, "pending");
        const fees = await provider.getFeeData();
        const estimate = await provider.estimateGas({ from: address, to: chain.deployment.contractAddress, data: doc.calldata });
        const request = { type: 2, chainId: chain.deployment.chainId, nonce, to: chain.deployment.contractAddress, data: doc.calldata, value: 0n, gasLimit: (estimate * 12n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
        const rawTx = await relayer.signTransaction(request);
        signed = { rawTx, txHash: Transaction.from(rawTx).hash, nonce };
      } catch (err) {
        if (rejection(err)) return { rejected: err };
        throw down(err, "sign");
      }
      // PERSIST BEFORE BROADCASTING, guarded by the lease.
      const saved = await AnonymousSubmission.updateOne({ _id: doc._id, state: S.QUEUED, claimToken: doc.claimToken }, { $set: { state: S.SIGNED, ...signed, ...touch() } });
      if (saved.modifiedCount !== 1) throw new AppError(409, "SUBMISSION_IN_PROGRESS", "Another request is processing this ballot");
      await hook("afterSign", { txHash: signed.txHash });
      const persisted = { ...signed, _id: doc._id };
      await broadcast(persisted);
      await hook("afterBroadcast", { txHash: signed.txHash });
      await AnonymousSubmission.updateOne({ _id: doc._id, state: S.SIGNED }, { $set: { state: S.BROADCAST, ...touch() } });
      return signed;
    });
    if (sent.rejected) return markFailed(doc, rejection(sent.rejected)[1]);
    return confirm({ ...doc.toObject(), state: S.BROADCAST, calldata: doc.calldata, ...sent }, waitMs);
  }

  /** SIGNED / BROADCAST: find out what became of the persisted transaction. The lease is held. */
  async function reconcile(doc, waitMs) {
    let receipt;
    let tx;
    try {
      receipt = await provider.getTransactionReceipt(doc.txHash);
      tx = receipt ? null : await provider.getTransaction(doc.txHash);
    } catch {
      throw unavailable();
    }
    if (receipt) return verifyReceipt(doc, receipt);
    if (tx) {
      await AnonymousSubmission.updateOne({ _id: doc._id, state: S.SIGNED }, { $set: { state: S.BROADCAST, ...touch() } });
      return confirm(doc, waitMs);
    }
    // Unknown to the node. The ballot may be recorded already (any transaction of anybody's carrying THIS ballot counts).
    if (await chain.nullifierUsed(doc.nullifier)) return (await adoptRecorded(doc)) ?? markFailed(doc, "NULLIFIER_USED_BY_ANOTHER_BALLOT");
    let latestNonce;
    try {
      latestNonce = await provider.getTransactionCount(chain.addresses.relayer, "latest");
    } catch {
      throw unavailable();
    }
    if (latestNonce > doc.nonce) {
      // The nonce is spent by another transaction and the nullifier is still unused: the persisted transaction can never be mined. Only now may a NEW one exist.
      await AnonymousSubmission.updateOne({ _id: doc._id, txHash: doc.txHash, state: { $in: [S.SIGNED, S.BROADCAST] } }, { $set: { state: S.QUEUED, lastTxHash: doc.txHash, txHash: null, nonce: null, rawTx: null, ...touch() } });
      return fresh(doc._id);
    }
    await queue.run(() => broadcast(doc)); // identical bytes: safe to repeat
    await AnonymousSubmission.updateOne({ _id: doc._id, state: S.SIGNED }, { $set: { state: S.BROADCAST, ...touch() } });
    return confirm(doc, waitMs);
  }

  /** A FAILED submission may be tried again by an identical request: it is put back to QUEUED (the re-simulation before signing decides if it can succeed). */
  async function requeue(doc) {
    if (await chain.nullifierUsed(doc.nullifier)) return (await adoptRecorded(doc)) ?? doc;
    const res = await AnonymousSubmission.updateOne({ _id: doc._id, state: S.FAILED }, { $set: { state: S.QUEUED, failureCode: null, lastTxHash: doc.txHash ?? doc.lastTxHash ?? null, txHash: null, nonce: null, rawTx: null, ...touch() } });
    return res.modifiedCount === 1 ? fresh(doc._id) : fresh(doc._id);
  }

  /** Waits (bounded) for whoever holds the lease to finish, then reports the canonical state. */
  async function settle(id, waitMs) {
    const stop = Date.now() + waitMs;
    for (;;) {
      const doc = await fresh(id);
      if (!IN_FLIGHT.includes(doc.state) || Date.now() >= stop) return doc;
      await sleep(pollMs);
    }
  }

  /**
   * Drives one submission as far as it can go. `retryFailed` is true only for an identical request FROM A CALLER (it asks again, explicitly): background
   * recovery and status reads report a FAILED submission as it is and never resend it on their own.
   */
  async function drive(start, { waitMs = receiptTimeoutMs, retryFailed = true } = {}) {
    let doc = start;
    for (let pass = 0; pass < 5; pass++) {
      if (doc.state === S.CONFIRMED) return reply(200, view(doc));
      if (doc.state === S.FAILED && !retryFailed) return reply(200, view(doc));
      if (doc.state === S.FAILED) {
        const retried = await requeue(doc);
        if (retried.state === S.FAILED) throw new AppError(422, retried.failureCode ?? "SUBMISSION_FAILED", "This ballot submission failed");
        doc = retried;
        continue;
      }
      const leased = await lease(doc, [doc.state]);
      if (!leased) {
        doc = await settle(doc._id, waitMs);
        if (IN_FLIGHT.includes(doc.state)) return reply(202, view(doc));
        continue;
      }
      try {
        doc = leased.state === S.QUEUED ? await signAndSend(leased, waitMs) : await reconcile(leased, waitMs);
      } finally {
        await unlock(leased);
      }
      if (IN_FLIGHT.includes(doc.state)) return reply(202, view(doc));
    }
    return reply(202, view(doc));
  }

  // ------------------------------------------------------------------------------------------------ the public operations

  return {
    /** @returns {{ http: number, body: object }} */
    async submit(body) {
      const pkg = canonicalPackage(body, chain.abi.voteChain);

      const existing = await AnonymousSubmission.findOne({ nullifier: pkg.nullifier }).select(SELECT);
      if (existing) {
        if (existing.packageHash !== pkg.packageHash) throw new AppError(409, "NULLIFIER_CONFLICT", "A different ballot was already submitted with this nullifier");
        return drive(existing);
      }

      // PRECHECK, before any gas is spent: the constituency, the phase, the coordinate count, the nullifier, then the contract's own static simulation.
      const constituency = await chain.readConstituency(pkg.constituencyId);
      if (!constituency) throw new AppError(422, "UNKNOWN_CONSTITUENCY", "Unknown constituency");
      const phase = await chain.readPhase();
      if (phase !== PHASE.Open) throw new AppError(409, phase === PHASE.Closed ? "ELECTION_CLOSED" : "ELECTION_NOT_OPEN", phase === PHASE.Closed ? "The election is closed" : "The election is not open");
      if (pkg.coords.length !== constituency.candidateCount * 4) throw new AppError(422, "WRONG_COORDINATE_COUNT", "The ciphertext does not have the right number of coordinates for this constituency");

      if (await chain.nullifierUsed(pkg.nullifier)) {
        // Already recorded on-chain. The same ballot (same constituency, same ciphertext) is simply reported as recorded; any other is a conflict.
        const log = await recordedEvent(pkg.nullifier);
        if (!log || !sameBallot(log, pkg.constituencyId, pkg.coords)) throw new AppError(409, "NULLIFIER_ALREADY_USED", "This nullifier is already recorded for another ballot");
        const doc = await AnonymousSubmission.create({ _id: randomUUID(), nullifier: pkg.nullifier, constituencyId: pkg.constituencyId, packageHash: pkg.packageHash, calldata: pkg.calldata, state: S.CONFIRMED, txHash: log.transactionHash, blockNumber: log.blockNumber, ballotIndex: Number(log.args.ballotIndex), ...touch() }).catch((err) => {
          if (err?.code !== 11000) throw err;
          return null;
        });
        return reply(200, view(doc ?? (await AnonymousSubmission.findOne({ nullifier: pkg.nullifier }))));
      }
      try {
        await contract.connect(relayer).submitBallot.staticCall(...pkg.args);
      } catch (err) {
        const why = rejection(err);
        if (!why) throw down(err, "simulation");
        throw new AppError(why[0], why[1], why[2]);
      }

      let doc;
      try {
        doc = await AnonymousSubmission.create({ _id: randomUUID(), nullifier: pkg.nullifier, constituencyId: pkg.constituencyId, packageHash: pkg.packageHash, calldata: pkg.calldata, state: S.QUEUED, ...touch() });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const winner = await AnonymousSubmission.findOne({ nullifier: pkg.nullifier }).select(SELECT);
        if (winner.packageHash !== pkg.packageHash) throw new AppError(409, "NULLIFIER_CONFLICT", "A different ballot was already submitted with this nullifier");
        return drive(winner);
      }
      return drive(await fresh(doc._id));
    },

    /** The status of a nullifier. Read-mostly: an in-flight submission with a persisted transaction is reconciled (never signed here). */
    async status(nullifier) {
      if (typeof nullifier !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(nullifier)) throw new AppError(400, "VALIDATION_FAILED", "Invalid request: nullifier");
      const doc = await AnonymousSubmission.findOne({ nullifier }).select(SELECT);
      if (!doc) {
        if (!(await chain.nullifierUsed(nullifier))) throw new AppError(404, "NOT_FOUND", "No submission with this nullifier");
        const log = await recordedEvent(nullifier);
        return reply(200, { state: S.CONFIRMED, nullifier, txHash: log.transactionHash, blockNumber: log.blockNumber, ballotIndex: Number(log.args.ballotIndex) });
      }
      if (doc.state === S.SIGNED || doc.state === S.BROADCAST) {
        const out = await drive(doc, { waitMs: 0, retryFailed: false });
        return reply(200, out.body);
      }
      return reply(200, view(doc));
    },

    /**
     * Finishes submissions whose caller can no longer ask (a restart, a closed browser): continues every one that is idle. Safe next to live requests (same leases).
     * `minAgeMs: 0` is for startup, `recover()`.
     */
    async recoverPending({ minAgeMs = 30_000, limit = 25 } = {}) {
      const idle = await AnonymousSubmission.find({ state: { $in: [...IN_FLIGHT] }, touchedAt: { $lte: now() - minAgeMs } }).select(SELECT).limit(limit);
      let handled = 0;
      for (const doc of idle) {
        try {
          await drive(doc, { waitMs: 0, retryFailed: false });
          handled++;
        } catch (err) {
          if (err instanceof SimulatedCrash) throw err;
          logger.warn({ submission: true, err }, "recovery of a submission failed; it will be retried");
        }
      }
      return handled;
    },

    /** Startup recovery: one instance is assumed, so every lease is stale; clear them and continue everything exactly where it stopped. */
    async recover() {
      await AnonymousSubmission.updateMany({ state: { $in: [...IN_FLIGHT] } }, { $set: { lockUntil: null } });
      return this.recoverPending({ minAgeMs: 0, limit: 1000 });
    },
  };
}
