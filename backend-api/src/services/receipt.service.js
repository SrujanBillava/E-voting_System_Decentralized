import { COMPLETED_TTL_MS, STAGES } from "../auth/voterStages.js";
import { readBallotEvidence } from "../chain/ballotEvidence.js";
import { deriveNullifier } from "../chain/nullifier.js";
import { AppError } from "../utils/errors.js";

const invalid = () => new AppError(409, "RECEIPT_INVALID", "The recorded ballot could not be verified against the blockchain");
const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");

/**
 * SUBMITTED -> COMPLETED and the voter's receipt, in any election phase (a vote that reached the chain is never lost to a close).
 *
 * The portable `receipt` is derived from the confirmed transaction and its BallotCast event only; it carries no voter identity,
 * nullifier, candidate, signature or raw transaction. `recordedSelection` is a SEPARATE, transient field for the authenticated
 * voter's own confirmation screen: the UI must never put it in a copied, printed or QR receipt. (The candidate is plaintext on the
 * public chain anyway; this API merely does not make it easier to find.)
 *
 * Nothing here trusts the Mongo ticket on its own: the chain evidence must match the ticket AND the nullifier this server derives
 * from the voter's own uid, so an altered ticket cannot hand a voter someone else's transaction.
 */
export function createReceiptService({ Voter, VoteTicket, authService, castService, chain, nullifierSecret, audit, now = Date.now }) {
  const rec = (action, ctx, meta) => audit.record({ action, result: "success", requestId: ctx?.requestId ?? null, ip: ctx?.ip ?? null, meta }); // deliberately no voter id / tx hash / candidate

  /** Returns the verified event data, or null while the ballot is not final yet. Throws when the chain contradicts the ticket. */
  async function verifiedEvidence(voter, ticket) {
    if (!ticket?.txHash) throw invalid();
    const result = await readBallotEvidence(chain, ticket.txHash);
    if (result.status === "NOT_FOUND") throw new AppError(404, "RECEIPT_NOT_FOUND", "The ballot transaction is not on the blockchain");
    if (result.status === "REJECTED") throw invalid();
    if (result.status !== "CONFIRMED") return null; // PENDING / CONFIRMING
    const ev = result.evidence;
    const mine = deriveNullifier({ secret: nullifierSecret, electionId: chain.deployment.electionId, voterUid: voter.uid });
    const matches = ev.nullifier === mine && ev.nullifier === ticket.nullifier && ev.constituencyId === ticket.constituencyId && ev.candidateId === BigInt(ticket.candidateId);
    if (!matches) throw invalid();
    return ev;
  }

  const receiptOf = (ev) => ({
    txHash: ev.txHash,
    blockNumber: ev.blockNumber,
    blockHash: ev.blockHash,
    ballotIndex: ev.ballotIndex,
    contractAddress: ev.contractAddress,
    chainId: ev.chainId,
    electionId: ev.electionId,
    confirmedAt: new Date(ev.blockTimestamp * 1000).toISOString(), // the block's time: identical on every read, verifiable by anyone
    verifyUrl: `/api/v1/public/receipts/${ev.txHash}`,
  });

  async function loadVoter(principal) {
    const voter = await Voter.findById(principal.voterDbId).select("+uid");
    if (!voter || voter.status !== "ACTIVE") throw new AppError(403, "VOTER_SUSPENDED", "This voter account is not active");
    return voter;
  }

  return {
    /** @returns {{ http: number, body: object }} */
    async get(principal, ctx) {
      const voter = await loadVoter(principal);
      const resolved = await castService.resolve(principal, ctx);
      const pending = (ticket) => ({ http: 202, body: { stage: principal.stage, state: "PENDING", txHash: ticket?.txHash ?? null } });
      if (resolved.state === "NONE" || resolved.state === "NOT_SUBMITTED") throw new AppError(409, "STAGE_REQUIRED", "No vote has been submitted");
      if (resolved.state === "NOT_RECORDED") throw new AppError(409, "VOTE_NOT_RECORDED", "Your vote was not recorded on the blockchain");
      if (resolved.state === "PENDING") return pending(resolved.ticket);

      const ev = await verifiedEvidence(voter, resolved.ticket);
      if (!ev) return pending(resolved.ticket);

      let name;
      try {
        name = (await chain.contract.getCandidate(ev.candidateId))[0];
      } catch {
        throw unavailable();
      }

      let stageExpiresAt = principal.stageExpiresAt;
      if (principal.stage !== STAGES.COMPLETED) {
        const expiresAt = new Date(now() + COMPLETED_TTL_MS);
        if (await authService.transitionStage({ sessionId: principal.sessionId, from: STAGES.SUBMITTED, to: STAGES.COMPLETED, expiresAt })) {
          stageExpiresAt = expiresAt;
          await rec("VOTER_RECEIPT_ISSUED", ctx, {});
        } else {
          // Lost a race (a parallel receipt call): fine if the winner already completed the session.
          const current = await authService.currentStage(principal.sessionId);
          if (current?.stage !== STAGES.COMPLETED) throw new AppError(409, "STAGE_REQUIRED", "This step is not available in your current stage");
          stageExpiresAt = current.stageExpiresAt;
        }
      }
      return { http: 200, body: { stage: STAGES.COMPLETED, state: "CONFIRMED", stageExpiresAt, receipt: receiptOf(ev), recordedSelection: { name } } };
    },

    /** True when this voter's vote is on its way to the chain (broadcast, not yet mined): eligibility then says so instead of "eligible". */
    async voteInFlight(principal) {
      const ticket = await VoteTicket.findOne({ electionId: chain.deployment.electionId, voterId: principal.voterDbId }).select("status txHash");
      return Boolean(ticket && ticket.txHash && (ticket.status === "SUBMITTING" || ticket.status === "SUBMITTED"));
    },

    /**
     * Called by eligibility when the voter's nullifier is already consumed. Succeeds only when a local ticket exists AND the chain
     * evidence verifies against it; then the (already face-verified) session is completed so GET /receipt works. Any doubt: false,
     * and the caller answers a plain ALREADY_VOTED. Never throws.
     */
    async recoverAlreadyVoted(principal, ctx) {
      try {
        const voter = await loadVoter(principal);
        // requestId is dropped on purpose: it must not join this voter-identified request to the VOTE_CONFIRMED (tx hash) row resolve() may write.
        const resolved = await castService.resolve(principal, { ip: null, requestId: null }, { waitMs: 1500 });
        if (resolved.state !== "CONFIRMED") return false;
        if (!(await verifiedEvidence(voter, resolved.ticket))) return false;
        if (principal.stage !== STAGES.COMPLETED) {
          if (await authService.recoverToCompleted({ sessionId: principal.sessionId, expiresAt: new Date(now() + COMPLETED_TTL_MS) })) await rec("VOTER_RECEIPT_RECOVERED", ctx, {});
          else if ((await authService.currentStage(principal.sessionId))?.stage !== STAGES.COMPLETED) return false; // the session vanished: promise nothing
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}
