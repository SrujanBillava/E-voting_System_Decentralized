import { canonicalConstituencyCode, constituencyIdOf } from "../chain/ids.js";
import { deriveNullifier } from "../chain/nullifier.js";
import { AUTHORIZATION_TTL_MS, STAGES } from "../auth/voterStages.js";
import { TICKET_STATUS } from "../models/VoteTicket.js";
import { AppError } from "../utils/errors.js";
import { readConstituencyById } from "./chainConfig.js";

const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");
export const CANDIDATE_ID_PATTERN = /^[1-9][0-9]{0,17}$/;

/**
 * ELIGIBLE -> AUTH_ISSUED. The voter confirms ONE candidate; the server stores it on the VoteTicket and nothing signed
 * leaves the server. Signing and submission happen later, in cast.service. Identity (uid, nullifier, constituency) is
 * always derived server-side.
 */
export function createAuthorizationService({ Voter, VoteTicket, authService, chain, nullifierSecret, audit, now = Date.now }) {
  const rec = (action, result, ctx, meta) => audit.record({ action, result, requestId: ctx.requestId, ip: ctx.ip, meta });
  const dto = (ticket) => ({ ticketId: String(ticket._id), stage: STAGES.AUTH_ISSUED, expiresAt: ticket.authorizationExpiresAt });

  async function loadCandidate(candidateId, constituencyId) {
    let candidate;
    try {
      candidate = await chain.contract.getCandidate(candidateId);
    } catch (err) {
      if (err?.revert?.name === "InvalidCandidate") throw new AppError(422, "INVALID_CANDIDATE", "That candidate does not exist");
      throw unavailable();
    }
    if (candidate[1] !== constituencyId) throw new AppError(422, "CANDIDATE_NOT_IN_CONSTITUENCY", "That candidate is not on your ballot");
  }

  return {
    async authorize(principal, { candidateId: candidateText }, ctx) {
      if (typeof candidateText !== "string" || !CANDIDATE_ID_PATTERN.test(candidateText)) throw new AppError(400, "VALIDATION_FAILED", "Invalid request: candidateId");
      const candidateId = BigInt(candidateText);
      const voter = await Voter.findById(principal.voterDbId).select("+uid");
      if (!voter || voter.status !== "ACTIVE") throw new AppError(403, "VOTER_SUSPENDED", "This voter account is not active");

      const code = canonicalConstituencyCode(voter.constituencyCode);
      const constituency = code ? await readConstituencyById(chain, constituencyIdOf(code)) : null;
      if (!constituency) {
        await rec("VOTE_AUTHORIZATION_REJECTED", "failure", ctx, { voterId: voter.voterId, reason: "constituency_not_configured" });
        throw new AppError(409, "CONSTITUENCY_NOT_CONFIGURED", "Your constituency is not configured for this election");
      }
      try {
        await loadCandidate(candidateId, constituency.id);
      } catch (err) {
        await rec("VOTE_AUTHORIZATION_REJECTED", "failure", ctx, { voterId: voter.voterId, reason: err.code ?? "chain" });
        throw err;
      }

      const electionId = chain.deployment.electionId;
      const nullifier = deriveNullifier({ secret: nullifierSecret, electionId, voterUid: voter.uid });
      let used;
      try {
        used = await chain.contract.nullifierUsed(nullifier); // re-checked here even though eligibility checked it
      } catch {
        throw unavailable();
      }
      if (used) {
        await rec("VOTE_AUTHORIZATION_REJECTED", "failure", ctx, { voterId: voter.voterId, reason: "already_voted" });
        throw new AppError(409, "ALREADY_VOTED", "A ballot has already been cast for this voter in this election");
      }

      const t = now();
      const expiresAt = new Date(t + AUTHORIZATION_TTL_MS);
      const candidateKey = String(candidateId);
      const filter = { electionId, voterId: voter._id };

      let ticket;
      let created = false;
      try {
        ticket = await VoteTicket.create({ ...filter, constituencyCode: constituency.code, constituencyId: constituency.id, nullifier, candidateId: candidateKey, authorizationExpiresAt: expiresAt });
        created = true;
      } catch (err) {
        if (err?.code !== 11000) throw err;
        ticket = await VoteTicket.findOne(filter).select("+candidateId");
      }

      if (!created) {
        // An existing ticket. Same candidate is idempotent. An attempt that never reached the chain (expired, unsubmitted) or whose
        // transaction REVERTED may start over. Anything else must not silently change the confirmed choice or destroy evidence.
        const reusable = (tk) => (tk.status === TICKET_STATUS.FAILED && tk.failureCode === "TX_REVERTED") || (tk.status === TICKET_STATUS.AUTH_ISSUED && tk.authorizationExpiresAt.getTime() <= t);
        if (reusable(ticket)) {
          const reset = await VoteTicket.findOneAndUpdate(
            { _id: ticket._id, $or: [{ status: TICKET_STATUS.FAILED, failureCode: "TX_REVERTED" }, { status: TICKET_STATUS.AUTH_ISSUED, authorizationExpiresAt: { $lte: new Date(t) } }] },
            // constituency is refreshed too: the candidate above was validated against the voter's CURRENT constituency
            { $set: { status: TICKET_STATUS.AUTH_ISSUED, candidateId: candidateKey, constituencyCode: constituency.code, constituencyId: constituency.id, nullifier, authorizationExpiresAt: expiresAt, idempotencyKey: null, lockUntil: null, claimToken: null, failureCode: null, txHash: null, lastTxHash: null, nonce: null, authDeadline: null, rawTx: null } },
            { returnDocument: "after" },
          );
          if (reset) {
            ticket = reset;
            created = true;
          } else {
            ticket = await VoteTicket.findOne(filter).select("+candidateId"); // lost the race: judge the winner's ticket below
          }
        }
        if (!created && (ticket.candidateId !== candidateKey || ticket.status !== TICKET_STATUS.AUTH_ISSUED)) {
          await rec("VOTE_AUTHORIZATION_REJECTED", "failure", ctx, { voterId: voter.voterId, reason: "already_issued" });
          throw new AppError(409, "AUTHORIZATION_ALREADY_ISSUED", "An authorization has already been issued for this vote");
        }
      }

      // Session stage: ELIGIBLE -> AUTH_ISSUED (atomic). A lost race is fine if the winner already got us there.
      if (principal.stage === STAGES.ELIGIBLE) {
        const won = await authService.transitionStage({ sessionId: principal.sessionId, from: STAGES.ELIGIBLE, to: STAGES.AUTH_ISSUED, expiresAt: ticket.authorizationExpiresAt });
        if (!won) {
          const current = await authService.currentStage(principal.sessionId);
          if (current?.stage !== STAGES.AUTH_ISSUED) throw new AppError(409, "STAGE_REQUIRED", "This step is not available in your current stage");
        }
      }
      if (created) await rec("VOTE_AUTHORIZATION_ISSUED", "success", ctx, { voterId: voter.voterId });
      return dto(ticket);
    },
  };
}
