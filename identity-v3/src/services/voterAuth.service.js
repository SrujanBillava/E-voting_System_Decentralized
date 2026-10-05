import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, STAGE_TTL_MS, STAGES, canTransition } from "../auth/voterStages.js";
import { assertIssuing } from "../chain/chain.js";
import { CRED } from "../models/CredentialIssuance.js";
import { AppError } from "../utils/errors.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const invalid = () => new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Authentication required");

/** V2's voter id format: VC- plus ten characters of an unambiguous alphabet. */
export const VOTER_ID_PATTERN = /^VC-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/;
/** bcrypt only looks at the first 72 BYTES of a password; a longer one is refused instead of being silently truncated. */
const exceedsBcryptLimit = (password) => typeof password === "string" && Buffer.byteLength(password, "utf8") > 72;

export const toSafeVoter = (v) => ({ name: v.name, constituencyCode: v.constituencyCode, faceEnrolled: v.faceEnrolled });
/** a short, non-reversible tag of a session, so the log lines of ONE journey can be read together without naming the voter */
export const sessionRefOf = (sessionId) => sha256(String(sessionId)).slice(0, 10);

/**
 * Voter login + server-side sessions (the V2 design, V3 stages). `now` and `bcryptCost` are injectable for tests.
 *
 * Differences from V2, all on purpose:
 *  - the election must be Open AND commitment issuance must still be open (after closeIssuance nobody can start);
 *  - a voter who already holds (or is receiving) a credential cannot log in again: the session is not created at all;
 *  - a finished session is deleted, never kept as a revoked record;
 *  - audit lines carry a session reference, never a voter id.
 */
export function createVoterAuthService({ Voter, VoterSession, CredentialIssuance, chain, audit, now = Date.now, bcryptCost = 12 }) {
  const dummyHash = bcrypt.hashSync(randomBytes(16).toString("hex"), bcryptCost);
  const electionId = () => chain.deployment.electionId;

  /** The contract is the source of truth: Open and issuing. */
  const requireIssuing = async () => assertIssuing(await chain.readPhaseAndIssuance());

  const expiryOf = (s) => {
    const t = now();
    if (s.absoluteExpiresAt.getTime() <= t) return "absolute";
    if (s.lastActivityAt.getTime() + SESSION_IDLE_MS <= t) return "idle";
    if (s.stageExpiresAt.getTime() <= t) return "stage";
    return null;
  };

  const service = {
    async login({ identifier, password, requestId }) {
      const byVoterId = VOTER_ID_PATTERN.test(identifier.trim().toUpperCase());
      const query = byVoterId ? { voterId: identifier.trim().toUpperCase() } : { email: identifier.trim().toLowerCase() };
      const voter = await Voter.findOne(query).select("+passwordHash");
      const overlong = exceedsBcryptLimit(password);
      const matches = await bcrypt.compare(password, voter?.passwordHash ?? dummyHash); // always run, so timing does not depend on whether the voter exists
      if (!voter || !matches || overlong) {
        audit.record({ action: "VOTER_LOGIN_FAILURE", result: "failure", requestId, meta: { reason: voter ? "bad_password" : "unknown_voter" } });
        throw invalid();
      }
      if (voter.status !== "ACTIVE") {
        audit.record({ action: "VOTER_LOGIN_FAILURE", result: "failure", requestId, meta: { reason: "suspended" } });
        throw new AppError(403, "VOTER_SUSPENDED", "This voter account is suspended");
      }
      await requireIssuing();

      // One credential per voter: refuse BEFORE a session exists. (Said only after the password was right: nobody learns who holds a credential.)
      const record = await CredentialIssuance.findOne({ electionId: electionId(), voterId: voter._id }).select("state");
      if (record?.state === CRED.ISSUED) throw new AppError(409, "CREDENTIAL_ALREADY_ISSUED", "A credential has already been issued to this voter for this election");
      if (record?.state === CRED.RESERVED || record?.state === CRED.BATCHED) throw new AppError(409, "CREDENTIAL_IN_PROGRESS", "A credential is being issued to this voter; please wait for it to complete");

      // Free the slot if this voter's previous session is already dead; a LIVE one blocks login.
      const t = now();
      await VoterSession.deleteMany({ voterId: voter._id, $or: [{ absoluteExpiresAt: { $lte: new Date(t) } }, { lastActivityAt: { $lte: new Date(t - SESSION_IDLE_MS) } }, { stageExpiresAt: { $lte: new Date(t) } }] });

      const token = randomBytes(32).toString("base64url");
      const stageExpiresAt = new Date(t + STAGE_TTL_MS[STAGES.AUTHENTICATED]);
      let session;
      try {
        session = await VoterSession.create({ voterId: voter._id, tokenHash: sha256(token), stage: STAGES.AUTHENTICATED, createdAt: new Date(t), lastActivityAt: new Date(t), absoluteExpiresAt: new Date(t + SESSION_ABSOLUTE_MS), stageExpiresAt });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        audit.record({ action: "VOTER_SESSION_ACTIVE_REJECTED", result: "failure", requestId });
        throw new AppError(409, "SESSION_ACTIVE", "This voter already has an active session");
      }
      audit.record({ action: "VOTER_LOGIN_SUCCESS", result: "success", requestId, sessionRef: sessionRefOf(session._id) });
      return { token, maxAgeMs: SESSION_ABSOLUTE_MS, voter: toSafeVoter(voter), stage: STAGES.AUTHENTICATED, stageExpiresAt, sessionExpiresAt: new Date(t + SESSION_ABSOLUTE_MS) };
    },

    async logout({ token }) {
      if (typeof token !== "string" || token.length < 20) return;
      await VoterSession.deleteOne({ tokenHash: sha256(token) });
    },

    /**
     * Validates the cookie token. Returns a minimal principal; throws 401 / 409 otherwise.
     * `requireOpen: false` is for delivering an ISSUED result: once the credential exists, closing issuance must not take the answer away.
     */
    async authenticate(token, { requestId, touch = true, requireOpen = true } = {}) {
      if (typeof token !== "string" || token.length < 20) throw unauthenticated();
      const session = await VoterSession.findOne({ tokenHash: sha256(token), active: true });
      if (!session) throw unauthenticated();
      const expired = expiryOf(session);
      if (expired) {
        await VoterSession.deleteOne({ _id: session._id });
        audit.record({ action: "VOTER_SESSION_EXPIRED", result: "failure", requestId, meta: { reason: expired } });
        throw new AppError(401, "SESSION_EXPIRED", "Your session has expired");
      }
      const voter = await Voter.findById(session.voterId);
      if (!voter || voter.status !== "ACTIVE") {
        await VoterSession.deleteOne({ _id: session._id });
        throw unauthenticated();
      }
      if (requireOpen) await requireIssuing();
      if (touch) await VoterSession.updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date(now()) } });
      return { sessionId: String(session._id), voterDbId: String(voter._id), stage: session.stage, stageExpiresAt: session.stageExpiresAt, sessionExpiresAt: session.absoluteExpiresAt, voter: toSafeVoter(voter), sessionRef: sessionRefOf(session._id) };
    },

    async currentStage(sessionId) {
      const s = await VoterSession.findOne({ _id: sessionId, active: true });
      return s ? { stage: s.stage, stageExpiresAt: s.stageExpiresAt } : null;
    },

    /** Atomic compare-and-set: succeeds only if the session is still in `from`. Returns true for the single winner. */
    async transitionStage({ sessionId, from, to, expiresAt }) {
      if (!canTransition(from, to)) throw new Error(`illegal stage transition ${from} -> ${to}`);
      const res = await VoterSession.updateOne({ _id: sessionId, stage: from, active: true }, { $set: { stage: to, stageExpiresAt: expiresAt, lastActivityAt: new Date(now()) } });
      return res.modifiedCount === 1;
    },

    /** TERMINATION: the identity session is deleted (not deactivated: no timestamp of the moment remains). The route clears the cookie. */
    async terminate(sessionId) {
      await VoterSession.deleteOne({ _id: sessionId });
    },
  };
  return service;
}
