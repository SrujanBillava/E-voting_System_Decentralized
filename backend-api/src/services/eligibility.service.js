import { canonicalConstituencyCode, constituencyIdOf } from "../chain/ids.js";
import { deriveNullifier } from "../chain/nullifier.js";
import { readCandidateIds } from "../chain/contract.js";
import { STAGES, STAGE_TTL_MS } from "../auth/voterStages.js";
import { AppError } from "../utils/errors.js";
import { readConstituencyById } from "./chainConfig.js";

const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");

/**
 * FACE_VERIFIED -> ELIGIBLE and the constituency-bound ballot. Everything is derived server-side from the
 * voter's Mongo record and the contract: the client supplies no uid, nullifier, constituency or status.
 * Chain failures fail CLOSED (nothing is assumed, nothing transitions).
 */
export function createEligibilityService({ Voter, authService, chain, nullifierSecret, audit, receiptService, now = Date.now }) {
  const rec = (action, result, ctx, meta) => audit.record({ action, result, requestId: ctx.requestId, ip: ctx.ip, meta });

  async function loadVoterAndConstituency(principal, ctx, { withUid = false } = {}) {
    const voter = await Voter.findById(principal.voterDbId).select(withUid ? "+uid" : "");
    if (!voter || voter.status !== "ACTIVE") throw new AppError(403, "VOTER_SUSPENDED", "This voter account is not active");
    const code = canonicalConstituencyCode(voter.constituencyCode);
    const constituency = code ? await readConstituencyById(chain, constituencyIdOf(code)) : null;
    if (!constituency) {
      await rec("CONSTITUENCY_CONFIGURATION_MISMATCH", "failure", ctx, { voterId: voter.voterId, constituencyCode: String(voter.constituencyCode).slice(0, 40) });
      throw new AppError(409, "CONSTITUENCY_NOT_CONFIGURED", "Your constituency is not configured for this election");
    }
    return { voter, constituency };
  }

  return {
    async check(principal, ctx) {
      const { voter, constituency } = await loadVoterAndConstituency(principal, ctx, { withUid: true });
      const electionId = chain.deployment.electionId;
      const nullifier = deriveNullifier({ secret: nullifierSecret, electionId, voterUid: voter.uid });
      let used;
      try {
        used = await chain.contract.nullifierUsed(nullifier);
      } catch {
        throw unavailable();
      }
      if (used) {
        await rec("VOTER_ALREADY_VOTED", "failure", ctx, { voterId: voter.voterId, constituencyCode: constituency.code });
        // If this server holds the voter's own confirmed ticket and the chain evidence verifies, the receipt can be reached;
        // otherwise it is a plain ALREADY_VOTED (no ownership of an arbitrary transaction is ever claimed).
        const receiptAvailable = receiptService ? await receiptService.recoverAlreadyVoted(principal, ctx) : false;
        throw new AppError(409, "ALREADY_VOTED", "A ballot has already been cast for this voter in this election", { details: receiptAvailable ? { receiptAvailable, stage: STAGES.COMPLETED } : { receiptAvailable } });
      }

      if (receiptService && (await receiptService.voteInFlight(principal))) {
        throw new AppError(409, "VOTE_IN_FLIGHT", "Your vote has been submitted and is being confirmed; please check again shortly", { details: { voteInFlight: true } });
      }

      let stageExpiresAt = principal.stageExpiresAt;
      if (principal.stage === STAGES.FACE_VERIFIED) {
        const expiresAt = new Date(now() + STAGE_TTL_MS[STAGES.ELIGIBLE]);
        const won = await authService.transitionStage({ sessionId: principal.sessionId, from: STAGES.FACE_VERIFIED, to: STAGES.ELIGIBLE, expiresAt });
        if (won) {
          stageExpiresAt = expiresAt;
          await rec("VOTER_ELIGIBILITY_CONFIRMED", "success", ctx, { voterId: voter.voterId, constituencyCode: constituency.code });
        } else {
          // Lost a race: fine if the winner already made the session ELIGIBLE, otherwise the stage moved on.
          const current = await authService.currentStage(principal.sessionId);
          if (current?.stage !== STAGES.ELIGIBLE) throw new AppError(409, "STAGE_REQUIRED", "This step is not available in your current stage");
          stageExpiresAt = current.stageExpiresAt;
        }
      }
      return { eligible: true, stage: STAGES.ELIGIBLE, stageExpiresAt, electionId, constituency: { code: constituency.code, name: constituency.name } };
    },

    async ballot(principal, ctx) {
      const { voter, constituency } = await loadVoterAndConstituency(principal, ctx);
      let candidates;
      try {
        const ids = await readCandidateIds(chain.contract, constituency.id);
        candidates = await Promise.all(ids.map(async (id) => ({ candidateId: String(id), name: (await chain.contract.getCandidate(id))[0] })));
      } catch {
        throw unavailable();
      }
      if (candidates.length === 0) throw new AppError(409, "BALLOT_UNAVAILABLE", "No candidates are configured for your constituency");
      await rec("BALLOT_VIEWED", "success", ctx, { voterId: voter.voterId, constituencyCode: constituency.code });
      return { electionId: chain.deployment.electionId, constituency: { code: constituency.code, name: constituency.name }, candidates };
    },
  };
}
