import { randomUUID } from "node:crypto";
import { STAGES, STAGE_TTL_MS } from "../auth/voterStages.js";
import { assertIssuing } from "../chain/chain.js";
import { canonicalConstituencyCode, constituencyIdOf, parseCommitment } from "../chain/ids.js";
import { CRED, PENDING_STATES } from "../models/CredentialIssuance.js";
import { AppError } from "../utils/errors.js";

/** The contract's frozen epoch length (asserted in the startup preflight). Reservations are grouped into cohorts of one epoch. */
export const EPOCH_SECONDS = 30;

/**
 * ELIGIBLE and the credential itself. Everything is derived server-side from the voter's registry record and the contract: the client supplies ONLY its
 * public Semaphore identity commitment. It chooses neither its constituency nor anything else; it never sends (and this service never sees) the private
 * Semaphore identity.
 *
 *   FACE_VERIFIED --check--> ELIGIBLE --request(commitment)--> COMMITMENT_PENDING --(batcher confirms on-chain)--> CREDENTIAL_ISSUED (terminal, session ends)
 *
 * The reservation is ATOMIC: the unique (electionId, voterId) index lets exactly one request win, whatever the concurrency.
 */
export function createCredentialService({ Voter, CredentialIssuance, authService, chain, audit, now = Date.now }) {
  const electionId = () => chain.deployment.electionId;

  async function loadVoter(principal) {
    const voter = await Voter.findById(principal.voterDbId);
    if (!voter || voter.status !== "ACTIVE") throw new AppError(403, "VOTER_SUSPENDED", "This voter account is not active");
    return voter;
  }

  /** The voter's OWN constituency (registry) and the chain's view of it. The caller never names one. */
  async function resolveConstituency(voter) {
    const code = canonicalConstituencyCode(voter.constituencyCode);
    const id = code ? constituencyIdOf(code) : null;
    const state = id ? await chain.readIssuanceState(id) : null;
    if (!state?.constituency) throw new AppError(409, "CONSTITUENCY_NOT_CONFIGURED", "Your constituency is not configured for this election");
    return { code, id, state };
  }

  const pendingCount = (constituencyId) => CredentialIssuance.countDocuments({ electionId: electionId(), constituencyId, state: { $in: PENDING_STATES } });
  const capacityLeft = async (id, state) => state.constituency.registeredVoters - state.constituency.issued - (await pendingCount(id));

  const toStageExpiry = (stage) => new Date(now() + STAGE_TTL_MS[stage]);

  return {
    /** FACE_VERIFIED -> ELIGIBLE */
    async checkEligibility(principal, ctx) {
      const voter = await loadVoter(principal);
      const { code, id, state } = await resolveConstituency(voter);
      assertIssuing(state);
      const record = await CredentialIssuance.findOne({ electionId: electionId(), voterId: voter._id }).select("state");
      if (record?.state === CRED.ISSUED) throw new AppError(409, "CREDENTIAL_ALREADY_ISSUED", "A credential has already been issued to this voter for this election");
      if (record && PENDING_STATES.includes(record.state)) throw new AppError(409, "CREDENTIAL_IN_PROGRESS", "A credential is being issued to this voter");
      if ((await capacityLeft(id, state)) <= 0) throw new AppError(409, "CONSTITUENCY_CAP_REACHED", "No more credentials can be issued for your constituency");

      let stageExpiresAt = principal.stageExpiresAt;
      if (principal.stage === STAGES.FACE_VERIFIED) {
        const expiresAt = toStageExpiry(STAGES.ELIGIBLE);
        const won = await authService.transitionStage({ sessionId: principal.sessionId, from: STAGES.FACE_VERIFIED, to: STAGES.ELIGIBLE, expiresAt });
        if (won) {
          stageExpiresAt = expiresAt;
          audit.record({ action: "VOTER_ELIGIBILITY_CONFIRMED", result: "success", requestId: ctx.requestId, sessionRef: principal.sessionRef });
        } else {
          const current = await authService.currentStage(principal.sessionId);
          if (current?.stage !== STAGES.ELIGIBLE) throw new AppError(409, "STAGE_REQUIRED", "This step is not available in your current stage");
          stageExpiresAt = current.stageExpiresAt;
        }
      }
      return { eligible: true, stage: STAGES.ELIGIBLE, stageExpiresAt, constituency: { code, name: state.constituency.name } };
    },

    /**
     * ELIGIBLE -> COMMITMENT_PENDING: reserve ONE credential for this voter with this public commitment. The commitment is not issued yet: the batcher inserts
     * it into the constituency's Semaphore group in the next epoch cohort and only then does the voter's record become ISSUED.
     */
    async request(principal, { commitment }, ctx) {
      const c = parseCommitment(commitment);
      if (c === null) throw new AppError(400, "VALIDATION_FAILED", "Invalid request: commitment");
      const voter = await loadVoter(principal);
      const { id, state } = await resolveConstituency(voter);
      assertIssuing(state);
      const eid = electionId();
      const pending = { http: 202, body: { state: "PENDING" } };

      const existing = await CredentialIssuance.findOne({ electionId: eid, voterId: voter._id });
      if (existing?.state === CRED.ISSUED) throw new AppError(409, "CREDENTIAL_ALREADY_ISSUED", "A credential has already been issued to this voter for this election");
      if (existing && PENDING_STATES.includes(existing.state)) {
        if (existing.commitment === c.toString()) return pending; // the same request again: idempotent
        throw new AppError(409, "CREDENTIAL_ALREADY_RESERVED", "This voter already has a credential request");
      }
      if (await chain.commitmentRegistered(c)) throw new AppError(409, "COMMITMENT_ALREADY_REGISTERED", "That commitment is already registered");
      if ((await capacityLeft(id, state)) <= 0) throw new AppError(409, "CONSTITUENCY_CAP_REACHED", "No more credentials can be issued for your constituency");

      const reservedAt = await chain.clock.nowSeconds();
      const fields = { commitment: c.toString(), constituencyId: id, reservedAt, reservedEpoch: Math.floor(reservedAt / EPOCH_SECONDS), failures: 0 };
      try {
        if (existing?.state === CRED.CANCELLED) {
          // a failed reservation (it never reached the chain) is retried on the SAME record: the unique index still allows only one
          const revived = await CredentialIssuance.findOneAndUpdate({ _id: existing._id, state: CRED.CANCELLED }, { $set: { state: CRED.RESERVED, ...fields } });
          if (!revived) throw new AppError(409, "CREDENTIAL_IN_PROGRESS", "A credential request is already in progress");
        } else {
          await CredentialIssuance.create({ _id: randomUUID(), electionId: eid, voterId: voter._id, state: CRED.RESERVED, ...fields });
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err?.code !== 11000) throw err;
        // Two unique indexes can collide. If this voter's record now exists, a parallel request of the same voter won; otherwise another voter holds the commitment.
        const winner = await CredentialIssuance.findOne({ electionId: eid, voterId: voter._id });
        if (winner && winner.state !== CRED.CANCELLED) {
          if (winner.state === CRED.ISSUED) throw new AppError(409, "CREDENTIAL_ALREADY_ISSUED", "A credential has already been issued to this voter for this election");
          if (winner.commitment === c.toString()) return pending;
          throw new AppError(409, "CREDENTIAL_ALREADY_RESERVED", "This voter already has a credential request");
        }
        throw new AppError(409, "COMMITMENT_ALREADY_RESERVED", "That commitment is already reserved");
      }

      if (principal.stage === STAGES.ELIGIBLE) {
        await authService.transitionStage({ sessionId: principal.sessionId, from: STAGES.ELIGIBLE, to: STAGES.COMMITMENT_PENDING, expiresAt: toStageExpiry(STAGES.COMMITMENT_PENDING) });
      }
      audit.record({ action: "CREDENTIAL_RESERVED", result: "success", requestId: ctx.requestId, sessionRef: principal.sessionRef });
      return pending;
    },

    /**
     * The voter polls here. PENDING while the reservation waits for its epoch cohort and the chain; when the record is ISSUED the result (public group data only)
     * is delivered ONCE, the identity session is deleted and the cookie is cleared (`terminate: true`). CANCELLED ends the session too: a failed reservation
     * never reached the chain, so the voter may log in again and request again.
     */
    async status(principal) {
      const voter = await loadVoter(principal);
      const record = await CredentialIssuance.findOne({ electionId: electionId(), voterId: voter._id }).select("state");
      if (!record) throw new AppError(409, "STAGE_REQUIRED", "No credential has been requested");
      if (PENDING_STATES.includes(record.state)) return { http: 200, body: { state: "PENDING" }, terminate: false };
      if (record.state === CRED.CANCELLED) {
        await authService.terminate(principal.sessionId);
        return { http: 409, error: new AppError(409, "CREDENTIAL_CANCELLED", "The credential request could not be completed; please log in and try again"), terminate: true };
      }
      // ISSUED: describe the PUBLIC group the commitment is now part of. Nothing here is specific to this voter, and nothing is a Merkle witness:
      // the kiosk reads the full public leaf set and verifies its own commitment itself.
      const { code, id, state } = await resolveConstituency(voter);
      const group = await chain.groupInfo(state.constituency.groupId);
      await authService.terminate(principal.sessionId);
      audit.record({ action: "CREDENTIAL_DELIVERED", result: "success", sessionRef: principal.sessionRef });
      return {
        http: 200,
        terminate: true,
        body: {
          state: STAGES.CREDENTIAL_ISSUED,
          constituency: { code, id },
          group: { groupId: group.groupId.toString(), merkleTreeDepth: group.depth, root: group.root.toString(), size: group.size },
        },
      };
    },
  };
}
