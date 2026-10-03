import { randomUUID } from "node:crypto";
import { Transaction, getAddress } from "ethers";
import { AUTHORIZATION_TTL_MS, STAGES, STAGE_TTL_MS } from "../auth/voterStages.js";
import { buildBallotAuthorization, signBallotAuthorization } from "../chain/eip712.js";
import { canonicalConstituencyCode, constituencyIdOf } from "../chain/ids.js";
import { TICKET_STATUS } from "../models/VoteTicket.js";
import { AppError } from "../utils/errors.js";

const LOCK_MS = 60_000;
const DEADLINE_MARGIN_MS = 30_000; // an authorization with less than this left is not signed
const QUEUE_MARGIN_MS = 15_000; // re-checked inside the relayer queue, right before signing the transaction
const S = TICKET_STATUS;
const IN_FLIGHT = [S.SUBMITTING, S.SUBMITTED];

const REVERTS = {
  WrongPhase: [409, "ELECTION_NOT_OPEN", "The election is not open"],
  AuthorizationExpired: [409, "AUTHORIZATION_EXPIRED", "The authorization expired; please try again"],
};
const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");
const reconciliation = () => new AppError(409, "RECONCILIATION_REQUIRED", "This vote needs manual reconciliation; please contact an election official");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * AUTH_ISSUED -> (sign EIP-712 on the server) -> relayer castVote -> SUBMITTED, with crash-safe recovery.
 *
 * Safety layers, all required: (1) atomic Mongo state changes on the single VoteTicket, fenced by a per-claim token so a
 * stale request can never write over a newer one, (2) one relayer queue so nonces are never raced, (3) the contract's
 * nullifier. The signature, the raw transaction and the candidate are never returned by the API or logged (the candidate and the transaction do reach the public chain in plaintext).
 * The candidate ALWAYS comes from the stored ticket.
 *
 * Nonce handling: the provider's PENDING transaction count, read inside the relayer queue immediately before signing, and
 * the signed transaction is persisted and broadcast before the queue is released. No NonceManager is used.
 *
 * Deadlines are based on max(server clock, latest block time) so a chain running ahead of the server cannot make a
 * signature expire early; a transaction is only treated as dead once the CHAIN's own clock has passed its deadline.
 *
 * `now` drives locks and deadlines (injectable); `waitNow` drives only the receipt-wait timeouts.
 */
export function createCastService({ Voter, VoteTicket, authService, chain, relayerQueue, audit, now = Date.now, waitNow = Date.now, receiptTimeoutMs = 30_000, pollMs = 100 }) {
  const relayer = chain.signers.relayer;
  const rec = (action, result, ctx, meta, txHash) => audit.record({ action, result, requestId: ctx?.requestId ?? null, ip: ctx?.ip ?? null, txHash: txHash ?? null, meta });
  const view = (t) => ({ stage: STAGES.SUBMITTED, state: t.status, txHash: t.txHash ?? null });
  const SELECT = "+rawTx +candidateId +nullifier +constituencyId";
  const fresh = (id) => VoteTicket.findById(id).select(SELECT);

  const ensureSubmitted = async (principal) => {
    if (principal?.stage === STAGES.AUTH_ISSUED) {
      await authService.transitionStage({ sessionId: principal.sessionId, from: STAGES.AUTH_ISSUED, to: STAGES.SUBMITTED, expiresAt: new Date(now() + STAGE_TTL_MS[STAGES.SUBMITTED]) });
    }
  };
  const markSubmitted = (ticket) => VoteTicket.updateOne({ _id: ticket._id, txHash: ticket.txHash, status: S.SUBMITTING }, { $set: { status: S.SUBMITTED, lockUntil: null } });
  const unlock = (ticket) => VoteTicket.updateOne({ _id: ticket._id, claimToken: ticket.claimToken, status: { $in: IN_FLIGHT } }, { $set: { lockUntil: null } });

  /** Back to retryable, but only for the request that still owns the claim and only if no transaction was ever persisted. */
  async function release(ticket) {
    await VoteTicket.updateOne({ _id: ticket._id, status: S.SUBMITTING, txHash: null, claimToken: ticket.claimToken }, { $set: { status: S.AUTH_ISSUED, lockUntil: null } });
  }
  /** Terminal failure. Never overwrites CONFIRMED, and only applies to the transaction this request is reasoning about. */
  async function fail(ticket, failureCode, ctx, error) {
    const res = await VoteTicket.updateOne({ _id: ticket._id, txHash: ticket.txHash ?? null, status: { $in: IN_FLIGHT } }, { $set: { status: S.FAILED, failureCode, lockUntil: null, rawTx: null } });
    if (res.modifiedCount === 1) await rec("VOTE_SUBMISSION_FAILED", "failure", ctx, { reason: failureCode }, ticket.txHash);
    return error;
  }

  /** The receipt is the evidence: success status, a BallotCast matching the ticket, and the nullifier consumed (read at the receipt's block). */
  async function verifyReceipt(ticket, receipt, ctx) {
    const contractAddress = chain.deployment.contractAddress.toLowerCase();
    if (receipt.status !== 1) {
      let used;
      try { used = await chain.contract.nullifierUsed(ticket.nullifier); } catch { throw unavailable(); }
      throw await fail(ticket, used ? "RECONCILIATION_REQUIRED" : "TX_REVERTED", ctx, used ? reconciliation() : new AppError(502, "TX_REVERTED", "The vote transaction was reverted"));
    }
    // Not final before the configured number of confirmations: the ticket stays SUBMITTED and a later call completes it.
    const required = chain.confirmations ?? 1;
    if (required > 1) {
      let head;
      try { head = await chain.provider.getBlockNumber(); } catch { throw unavailable(); }
      if (head - receipt.blockNumber + 1 < required) {
        await markSubmitted(ticket);
        return { ...(ticket.toObject?.() ?? ticket), status: S.SUBMITTED };
      }
    }
    const event = receipt.logs
      .filter((l) => l.address.toLowerCase() === contractAddress)
      .map((l) => { try { return chain.contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p?.name === "BallotCast");
    let ok = Boolean(event) && event.args.nullifier === ticket.nullifier && event.args.constituencyId === ticket.constituencyId && event.args.candidateId === BigInt(ticket.candidateId);
    if (ok) {
      try {
        const at = { blockTag: receipt.blockNumber };
        ok = (await chain.contract.nullifierUsed(ticket.nullifier, at)) && (await chain.contract.ballotIndexOf(ticket.nullifier, at)) === event.args.ballotIndex;
      } catch { throw unavailable(); }
    }
    if (!ok) throw await fail(ticket, "RECONCILIATION_REQUIRED", ctx, reconciliation());
    // FAILED -> CONFIRMED is allowed for the SAME transaction: a false reconciliation alarm heals once the evidence is visible.
    const done = await VoteTicket.findOneAndUpdate({ _id: ticket._id, txHash: ticket.txHash, status: { $ne: S.CONFIRMED } }, { $set: { status: S.CONFIRMED, confirmedAt: new Date(now()), lockUntil: null, rawTx: null, failureCode: null } }, { returnDocument: "after" }).select(SELECT);
    if (!done) return fresh(ticket._id); // somebody else already confirmed it
    await rec("VOTE_CONFIRMED", "success", ctx, {}, ticket.txHash);
    return done;
  }

  async function waitForReceipt(txHash, timeoutMs = receiptTimeoutMs) {
    const stop = waitNow() + timeoutMs;
    for (;;) {
      let receipt;
      try { receipt = await chain.provider.getTransactionReceipt(txHash); } catch { throw unavailable(); }
      if (receipt) return receipt;
      if (waitNow() >= stop) return null;
      await sleep(pollMs);
    }
  }
  /** One wait for the receipt, then verify. Without a receipt the (still SUBMITTED) ticket is returned. */
  async function confirm(ticket, ctx, timeoutMs) {
    const receipt = await waitForReceipt(ticket.txHash, timeoutMs);
    return receipt ? verifyReceipt(ticket, receipt, ctx) : ticket;
  }

  /** Broadcast the EXACT persisted raw transaction. A thrown error is ambiguous, so look the hash up before deciding. */
  async function broadcast(ticket) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await chain.provider.broadcastTransaction(ticket.rawTx);
        return;
      } catch {
        try {
          if ((await chain.provider.getTransaction(ticket.txHash)) || (await chain.provider.getTransactionReceipt(ticket.txHash))) return; // it did arrive
        } catch { /* RPC still down; retry once */ }
      }
    }
    throw unavailable(); // txHash/rawTx stay persisted: reconcile (or the recovery sweep) rebroadcasts the same bytes
  }

  /** The nullifier is used and our discarded transaction is what used it, with exactly the ticket's choice: it is a confirmed vote. */
  async function confirmFromDiscardedTx(ticket, ctx) {
    let logs;
    try { logs = await chain.contract.queryFilter(chain.contract.filters.BallotCast(ticket.nullifier), 0, "latest"); } catch { throw unavailable(); }
    const log = logs.find((l) => l.transactionHash === ticket.lastTxHash);
    if (!log || log.args.constituencyId !== ticket.constituencyId || log.args.candidateId !== BigInt(ticket.candidateId)) return null;
    const done = await VoteTicket.findOneAndUpdate({ _id: ticket._id, status: { $in: [S.SUBMITTING, S.FAILED] }, txHash: null, lastTxHash: ticket.lastTxHash }, { $set: { status: S.CONFIRMED, txHash: ticket.lastTxHash, confirmedAt: new Date(now()), lockUntil: null, rawTx: null, failureCode: null } }, { returnDocument: "after" }).select(SELECT);
    if (done) await rec("VOTE_CONFIRMED", "success", ctx, {}, ticket.lastTxHash);
    return done;
  }

  /** A FAILED ticket may be a false alarm (lagging RPC): look at the evidence again. Returns the healed ticket, or null. */
  async function heal(ticket, ctx) {
    if (ticket.failureCode !== "RECONCILIATION_REQUIRED") return null;
    if (!ticket.txHash && ticket.lastTxHash) return confirmFromDiscardedTx(ticket, ctx); // the discarded transaction did mine after all
    if (ticket.txHash) {
      let receipt = null;
      try { receipt = await chain.provider.getTransactionReceipt(ticket.txHash); } catch { /* keep the alarm */ }
      if (receipt) return verifyReceipt(ticket, receipt, ctx);
    }
    return null;
  }
  const failedError = (ticket) => (ticket.failureCode === "RECONCILIATION_REQUIRED" ? reconciliation() : new AppError(409, ticket.failureCode ?? "VOTE_FAILED", "This vote attempt failed"));

  /** Fresh submission by the holder of the SUBMITTING claim. Anything failing before the broadcast leaves the voter retryable. */
  async function submitFresh(ticket, principal, ctx, voter) {
    await rec("VOTE_SUBMISSION_STARTED", "success", ctx, {});
    const abort = async (error, reason) => {
      await release(ticket);
      await rec("VOTE_SUBMISSION_FAILED", "failure", ctx, { reason });
      return error;
    };
    let message;
    let signature;
    let deadline;
    let deadlineMs;
    try {
      if (getAddress(await chain.contract.relayer()) !== chain.signers.addresses.relayer) throw await abort(new AppError(503, "CONFIGURATION_ERROR", "The relayer is not configured correctly"), "relayer_mismatch");
      const code = canonicalConstituencyCode(voter.constituencyCode);
      if (!code || constituencyIdOf(code) !== ticket.constituencyId) throw await abort(new AppError(409, "CONSTITUENCY_NOT_CONFIGURED", "Your constituency changed; please start again"), "constituency_changed");
      const candidate = await chain.contract.getCandidate(BigInt(ticket.candidateId));
      if (candidate[1] !== ticket.constituencyId) throw await abort(new AppError(422, "CANDIDATE_NOT_IN_CONSTITUENCY", "That candidate is not on your ballot"), "candidate_constituency");
      if (await chain.contract.nullifierUsed(ticket.nullifier)) {
        // Used. Success is claimed ONLY if the BallotCast that consumed it came from the transaction this ticket itself discarded
        // earlier as "unknown" (a lagging RPC) and matches the confirmed choice. Anything else needs a human.
        const healed = ticket.lastTxHash ? await confirmFromDiscardedTx(ticket, ctx) : null;
        if (healed) return healed;
        throw await fail(ticket, "RECONCILIATION_REQUIRED", ctx, reconciliation());
      }
      const head = await chain.provider.getBlock("latest");
      const headMs = head.timestamp * 1000;
      const skew = Math.max(0, headMs - now()); // a chain running ahead of this server
      const base = Math.max(now(), headMs);
      deadlineMs = Math.min(base + AUTHORIZATION_TTL_MS, ticket.authorizationExpiresAt.getTime() + skew);
      if (deadlineMs - base < DEADLINE_MARGIN_MS) throw await abort(new AppError(409, "AUTHORIZATION_EXPIRED", "The authorization expired; please try again"), "expired");
      deadline = BigInt(Math.floor(deadlineMs / 1000));
      message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: ticket.constituencyId, nullifier: ticket.nullifier, candidateId: BigInt(ticket.candidateId), relayer: chain.signers.addresses.relayer, deadline });
      signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
      await chain.contract.connect(relayer).castVote.staticCall(message.constituencyId, message.nullifier, message.candidateId, message.deadline, signature);
    } catch (err) {
      if (err instanceof AppError) throw err;
      const name = err?.revert?.name;
      if (name === "NullifierAlreadyUsed") {
        const healed = ticket.lastTxHash ? await confirmFromDiscardedTx(ticket, ctx) : null;
        if (healed) return healed;
        throw await fail(ticket, "RECONCILIATION_REQUIRED", ctx, reconciliation());
      }
      const mapped = REVERTS[name];
      throw await abort(mapped ? new AppError(...mapped) : name ? new AppError(502, "AUTHORIZATION_REJECTED", "The vote could not be authorized") : unavailable(), name ?? "chain");
    }

    // Everything below runs in the relayer queue: nonce -> sign -> PERSIST -> broadcast.
    const persisted = await relayerQueue.run(async () => {
      if (deadlineMs - now() < QUEUE_MARGIN_MS) throw await abort(new AppError(409, "AUTHORIZATION_EXPIRED", "The authorization expired; please try again"), "expired_in_queue");
      let signed;
      try {
        const address = chain.signers.addresses.relayer;
        const data = chain.contract.interface.encodeFunctionData("castVote", [message.constituencyId, message.nullifier, message.candidateId, message.deadline, signature]);
        const nonce = await chain.provider.getTransactionCount(address, "pending");
        const fees = await chain.provider.getFeeData();
        const estimate = await chain.provider.estimateGas({ from: address, to: chain.deployment.contractAddress, data });
        const request = { type: 2, chainId: chain.deployment.chainId, nonce, to: chain.deployment.contractAddress, data, value: 0n, gasLimit: (estimate * 12n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
        const rawTx = await relayer.signTransaction(request);
        signed = { rawTx, txHash: Transaction.from(rawTx).hash, nonce };
      } catch {
        throw await abort(unavailable(), "tx_build");
      }
      // Persist BEFORE broadcasting, so a crash right after the broadcast still leaves the hash on record. The claim token
      // fences stale requests: only the current owner of the claim can persist (and so only one transaction per epoch).
      const saved = await VoteTicket.updateOne({ _id: ticket._id, status: S.SUBMITTING, txHash: null, claimToken: ticket.claimToken }, { $set: { ...signed, authDeadline: Number(deadline) } });
      if (saved.modifiedCount !== 1) throw new AppError(409, "CAST_IN_PROGRESS", "Another request is processing this vote");
      const withTx = { _id: ticket._id, claimToken: ticket.claimToken, nullifier: ticket.nullifier, constituencyId: ticket.constituencyId, candidateId: ticket.candidateId, ...signed, authDeadline: Number(deadline), status: S.SUBMITTING };
      try {
        await broadcast(withTx);
      } catch (err) {
        await VoteTicket.updateOne({ _id: ticket._id, claimToken: ticket.claimToken, status: S.SUBMITTING }, { $set: { lockUntil: new Date(now()) } }); // free the slot for an immediate retry
        throw err;
      }
      return withTx;
    });

    await markSubmitted(persisted);
    await ensureSubmitted(principal);
    await rec("VOTE_SUBMITTED", "success", ctx, {}, persisted.txHash);
    return confirm({ ...persisted, status: S.SUBMITTED }, ctx);
  }

  /** Recover a ticket that already has transaction evidence. Returns the ticket, or null if it was reset and may be retried. */
  async function reconcile(ticket, principal, ctx, timeoutMs) {
    let receipt;
    let tx;
    try {
      receipt = await chain.provider.getTransactionReceipt(ticket.txHash);
      tx = receipt ? null : await chain.provider.getTransaction(ticket.txHash);
    } catch {
      throw unavailable();
    }
    if (receipt) {
      await ensureSubmitted(principal);
      return verifyReceipt(ticket, receipt, ctx);
    }
    if (tx) {
      await markSubmitted(ticket);
      await ensureSubmitted(principal);
      return confirm({ ...ticket.toObject?.() ?? ticket, status: S.SUBMITTED }, ctx, timeoutMs);
    }
    // Unknown to the node.
    let used;
    let latestNonce;
    let head;
    let closed;
    try {
      closed = Number(await chain.contract.phase()) === 2;
      used = await chain.contract.nullifierUsed(ticket.nullifier);
      latestNonce = await chain.provider.getTransactionCount(chain.signers.addresses.relayer, "latest");
      head = await chain.provider.getBlock("latest");
    } catch {
      throw unavailable();
    }
    if (used) {
      let ours;
      try { ours = (await chain.contract.queryFilter(chain.contract.filters.BallotCast(ticket.nullifier), 0, "latest")).some((l) => l.transactionHash === ticket.txHash); } catch { throw unavailable(); }
      if (ours) { // our transaction mined; only the receipt lookup is lagging. Keep it SUBMITTED, a later call verifies it.
        await markSubmitted(ticket);
        await ensureSubmitted(principal);
        return { ...(ticket.toObject?.() ?? ticket), status: S.SUBMITTED };
      }
      throw await fail(ticket, "RECONCILIATION_REQUIRED", ctx, reconciliation()); // consumed, but by a transaction we do not know
    }
    // The chain's own clock decides: block timestamps only grow, so once the head is past the deadline the old transaction can never succeed.
    const deadlinePassed = ticket.authDeadline !== null && head.timestamp > ticket.authDeadline;
    if (latestNonce > ticket.nonce || deadlinePassed || closed) { // closed: rebroadcasting could only produce a revert
      const reset = await VoteTicket.updateOne({ _id: ticket._id, txHash: ticket.txHash, status: { $in: IN_FLIGHT } }, { $set: { status: S.AUTH_ISSUED, lockUntil: null, lastTxHash: ticket.txHash, txHash: null, nonce: null, rawTx: null, authDeadline: null, claimToken: null, authorizationExpiresAt: new Date(now() + AUTHORIZATION_TTL_MS) } });
      void reset;
      return null;
    }
    await relayerQueue.run(() => broadcast(ticket)); // identical bytes: safe to repeat
    await markSubmitted(ticket);
    await ensureSubmitted(principal);
    await rec("VOTE_SUBMITTED", "success", ctx, {}, ticket.txHash);
    return confirm({ ...(ticket.toObject?.() ?? ticket), status: S.SUBMITTED }, ctx, timeoutMs);
  }

  /** Reconcile, and always free the takeover lock afterwards (even on error) so the voter is not blocked for LOCK_MS. */
  async function reconcileLocked(ticket, principal, ctx, timeoutMs) {
    try {
      return await reconcile(ticket, principal, ctx, timeoutMs);
    } finally {
      await unlock(ticket).catch(() => {});
    }
  }

  async function settle(ticketId, timeoutMs = receiptTimeoutMs) {
    const stop = waitNow() + timeoutMs;
    for (;;) {
      const t = await fresh(ticketId);
      if (t.status !== S.SUBMITTING || waitNow() >= stop) return t;
      await sleep(pollMs);
    }
  }

  const takeoverOf = (ticket, t) =>
    VoteTicket.findOneAndUpdate(
      { _id: ticket._id, status: ticket.status, $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date(t) } }] },
      { $set: { lockUntil: new Date(t + LOCK_MS), claimToken: randomUUID() } },
      { returnDocument: "after" },
    ).select(SELECT);

  return {
    /** @returns {{ http: number, body: object }} */
    async cast(principal, { idempotencyKey }, ctx) {
      const voter = await Voter.findById(principal.voterDbId);
      if (!voter || voter.status !== "ACTIVE") throw new AppError(403, "VOTER_SUSPENDED", "This voter account is not active");
      let ticket = await VoteTicket.findOne({ electionId: chain.deployment.electionId, voterId: voter._id }).select(SELECT);
      if (!ticket) throw new AppError(409, "STAGE_REQUIRED", "No authorization has been issued");

      for (let pass = 0; pass < 4; pass++) {
        const t = now();
        if (ticket.status === S.CONFIRMED) {
          await ensureSubmitted(principal);
          return { http: 200, body: view(ticket) };
        }
        if (ticket.status === S.FAILED) {
          const healed = await heal(ticket, ctx);
          if (healed) { ticket = healed; continue; }
          throw failedError(ticket);
        }

        if (ticket.status === S.AUTH_ISSUED) {
          const claimed = await VoteTicket.findOneAndUpdate(
            { _id: ticket._id, status: S.AUTH_ISSUED, authorizationExpiresAt: { $gt: new Date(t) } },
            { $set: { status: S.SUBMITTING, lockUntil: new Date(t + LOCK_MS), claimToken: randomUUID(), idempotencyKey: ticket.idempotencyKey ?? idempotencyKey }, $inc: { submissionAttempts: 1 } },
            { returnDocument: "after" },
          ).select(SELECT);
          if (!claimed) {
            ticket = await fresh(ticket._id);
            if (ticket.status === S.AUTH_ISSUED) throw new AppError(409, "AUTHORIZATION_EXPIRED", "The authorization expired; please try again");
            continue;
          }
          ticket = await submitFresh(claimed, principal, ctx, voter);
          if (ticket.status === S.SUBMITTED) return { http: 202, body: view(ticket) }; // broadcast, receipt not seen yet
          continue;
        }

        if (ticket.status === S.SUBMITTING && ticket.lockUntil && ticket.lockUntil.getTime() > t) {
          ticket = await settle(ticket._id); // another request is working: report the canonical result
          if (ticket.status === S.SUBMITTING) return { http: 202, body: { stage: STAGES.AUTH_ISSUED, state: S.SUBMITTING, txHash: ticket.txHash ?? null } };
          continue;
        }

        // SUBMITTED, or SUBMITTING whose holder died (lock expired): take over atomically, then recover.
        const takeover = await takeoverOf(ticket, t);
        if (!takeover) { ticket = await settle(ticket._id); continue; }
        if (takeover.txHash) {
          const result = await reconcileLocked(takeover, principal, ctx);
          ticket = result ?? (await fresh(ticket._id));
          if (ticket.status === S.SUBMITTED) return { http: 202, body: view(ticket) };
          continue;
        }
        // SUBMITTING with no persisted transaction: nothing was ever broadcast, so starting over is safe.
        ticket = await submitFresh(takeover, principal, ctx, voter);
        if (ticket.status === S.SUBMITTED) return { http: 202, body: view(ticket) };
      }
      return { http: 202, body: view(ticket) };
    },

    /**
     * Recovery-only view of the voter's ticket: learns what became of a vote that already reached (or may have reached) the chain.
     * It NEVER signs or broadcasts a new vote, so it is safe in any election phase. Works with an atomic takeover like cast().
     * `state`: NONE | NOT_SUBMITTED | PENDING | CONFIRMED | NOT_RECORDED (a lost transaction was reset, nothing is on-chain).
     */
    async resolve(principal, ctx, { waitMs = 3000 } = {}) {
      let ticket = await VoteTicket.findOne({ electionId: chain.deployment.electionId, voterId: principal.voterDbId }).select(SELECT);
      if (!ticket) return { state: "NONE", ticket: null };
      for (let pass = 0; pass < 4; pass++) {
        const t = now();
        if (ticket.status === S.CONFIRMED) {
          await ensureSubmitted(principal);
          return { state: "CONFIRMED", ticket };
        }
        if (ticket.status === S.FAILED) {
          const healed = await heal(ticket, ctx);
          if (healed) { ticket = healed; continue; }
          throw failedError(ticket);
        }
        if (ticket.status === S.AUTH_ISSUED) {
          if (!(ticket.lastTxHash && !ticket.txHash && ticket.submissionAttempts > 0)) return { state: "NOT_SUBMITTED", ticket };
          // A reset ticket is reported as "not recorded" only if the nullifier is really unused: a lagging node may have hidden a mined ballot.
          let used;
          try { used = await chain.contract.nullifierUsed(ticket.nullifier); } catch { throw unavailable(); }
          if (!used) return { state: "NOT_RECORDED", ticket };
          const healed = await confirmFromDiscardedTx(ticket, ctx);
          if (healed) { ticket = healed; continue; }
          throw reconciliation();
        }
        if (ticket.status === S.SUBMITTING && ticket.lockUntil && ticket.lockUntil.getTime() > t) {
          ticket = await settle(ticket._id, waitMs); // another request is working
          if (ticket.status === S.SUBMITTING) return { state: "PENDING", ticket };
          continue;
        }
        const takeover = await takeoverOf(ticket, t);
        if (!takeover) { ticket = await settle(ticket._id, waitMs); continue; }
        if (!takeover.txHash) { // claimed but never persisted a transaction: nothing was broadcast
          await VoteTicket.updateOne({ _id: takeover._id, status: S.SUBMITTING, txHash: null, claimToken: takeover.claimToken }, { $set: { status: S.AUTH_ISSUED, lockUntil: null } });
          return { state: "NOT_SUBMITTED", ticket: await fresh(ticket._id) };
        }
        const result = await reconcileLocked(takeover, principal, ctx, waitMs);
        ticket = result ?? (await fresh(ticket._id));
        if (!result) return { state: "NOT_RECORDED", ticket }; // reset: the transaction is gone and the ticket is back to AUTH_ISSUED
        if (ticket.status === S.SUBMITTED) return { state: "PENDING", ticket };
      }
      return { state: "PENDING", ticket };
    },

    /**
     * Session-independent recovery: finishes tickets whose voter can no longer ask (session expired, backend restarted,
     * election closed). Run once at startup and periodically. Safe to run concurrently with requests (it takes the same
     * atomic takeover) and only touches tickets idle for `minAgeMs`.
     */
    async recoverPending({ minAgeMs = 30_000, limit = 25 } = {}) {
      const t = now();
      const idleBefore = new Date(Date.now() - minAgeMs);
      const stuck = await VoteTicket.find({ status: { $in: IN_FLIGHT }, updatedAt: { $lte: idleBefore }, $or: [{ lockUntil: null }, { lockUntil: { $lte: new Date(t) } }] }).select(SELECT).limit(limit);
      let handled = 0;
      for (const candidate of stuck) {
        const takeover = await takeoverOf(candidate, t);
        if (!takeover) continue;
        try {
          if (takeover.txHash) await reconcile(takeover, null, {});
          else await VoteTicket.updateOne({ _id: takeover._id, status: S.SUBMITTING, txHash: null, claimToken: takeover.claimToken }, { $set: { status: S.AUTH_ISSUED, lockUntil: null } }); // nothing was ever broadcast
          handled++;
        } catch { /* leave it for the next sweep */ } finally {
          await unlock(takeover).catch(() => {});
        }
      }
      return handled;
    },
  };
}
