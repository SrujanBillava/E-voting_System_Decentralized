import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { CLOSED_OK_STAGES, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, STAGE_TTL_MS, STAGES, canTransition } from "../auth/voterStages.js";
import { AppError } from "../utils/errors.js";
import { readPhaseName } from "./chainConfig.js";
import { VOTER_ID_PATTERN } from "./voter.service.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const invalid = () => new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Authentication required");

export const toSafeVoter = (v) => ({ voterId: v.voterId, name: v.name, constituencyCode: v.constituencyCode, faceEnrolled: v.faceEnrolled });

/** Voter login + server-side sessions. `now` and `bcryptCost` are injectable for tests. */
export function createVoterAuthService({ Voter, VoterSession, chain, audit, now = Date.now, bcryptCost = 12 }) {
  const dummyHash = bcrypt.hashSync(randomBytes(16).toString("hex"), bcryptCost);

  const revoke = (filter) => VoterSession.updateMany({ ...filter, active: true }, { $set: { active: false, revokedAt: new Date(now()) } });

  /** The election must be Open for any voter activity; the contract is the source of truth. */
  async function requireOpen({ closedOk = false } = {}) {
    const phase = await readPhaseName(chain);
    if (phase === "Setup") throw new AppError(409, "ELECTION_NOT_OPEN", "The election is not open yet");
    if (phase === "Closed" && !closedOk) throw new AppError(409, "ELECTION_CLOSED", "The election is closed");
    return phase;
  }

  const expiryOf = (s) => {
    const t = now();
    if (s.absoluteExpiresAt.getTime() <= t) return "absolute";
    if (s.lastActivityAt.getTime() + SESSION_IDLE_MS <= t) return "idle";
    if (s.stageExpiresAt.getTime() <= t) return "stage";
    return null;
  };

  return {
    async login({ identifier, password, ip, requestId }) {
      const byVoterId = VOTER_ID_PATTERN.test(identifier.trim().toUpperCase());
      const query = byVoterId ? { voterId: identifier.trim().toUpperCase() } : { email: identifier.trim().toLowerCase() };
      const voter = await Voter.findOne(query).select("+passwordHash");
      const ok = await bcrypt.compare(password, voter?.passwordHash ?? dummyHash);
      if (!voter || !ok) {
        await audit.record({ action: "VOTER_LOGIN_FAILURE", result: "failure", requestId, ip, meta: { reason: voter ? "bad_password" : "unknown_voter" } });
        throw invalid();
      }
      if (voter.status !== "ACTIVE") {
        await audit.record({ action: "VOTER_LOGIN_FAILURE", result: "failure", requestId, ip, meta: { reason: "suspended", voterId: voter.voterId } });
        throw new AppError(403, "VOTER_SUSPENDED", "This voter account is suspended");
      }
      await requireOpen();

      // Free the slot if this voter's previous session is already dead; a LIVE one blocks login.
      const t = now();
      await revoke({ voterId: voter._id, $or: [{ absoluteExpiresAt: { $lte: new Date(t) } }, { lastActivityAt: { $lte: new Date(t - SESSION_IDLE_MS) } }, { stageExpiresAt: { $lte: new Date(t) } }] });

      const token = randomBytes(32).toString("base64url");
      const stageExpiresAt = new Date(t + STAGE_TTL_MS[STAGES.AUTHENTICATED]);
      try {
        await VoterSession.create({
          voterId: voter._id,
          tokenHash: sha256(token),
          stage: STAGES.AUTHENTICATED,
          createdAt: new Date(t),
          lastActivityAt: new Date(t),
          absoluteExpiresAt: new Date(t + SESSION_ABSOLUTE_MS),
          stageExpiresAt,
        });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        await audit.record({ action: "VOTER_SESSION_ACTIVE_REJECTED", result: "failure", requestId, ip, meta: { voterId: voter.voterId } });
        throw new AppError(409, "SESSION_ACTIVE", "This voter already has an active session");
      }
      await audit.record({ action: "VOTER_LOGIN_SUCCESS", result: "success", requestId, ip, meta: { voterId: voter.voterId } });
      return { token, maxAgeMs: SESSION_ABSOLUTE_MS, voter: toSafeVoter(voter), stage: STAGES.AUTHENTICATED, stageExpiresAt, sessionExpiresAt: new Date(t + SESSION_ABSOLUTE_MS) };
    },

    async logout({ token, ip, requestId }) {
      if (typeof token !== "string" || token.length < 20) return;
      const session = await VoterSession.findOneAndUpdate({ tokenHash: sha256(token), active: true }, { $set: { active: false, revokedAt: new Date(now()) } });
      if (session) await audit.record({ action: "VOTER_LOGOUT", result: "success", requestId, ip });
    },

    /** Validates the cookie token. Returns a minimal principal; throws 401 / 409 otherwise. */
    async authenticate(token, { ip, requestId, touch = true, allowClosed = false } = {}) {
      if (typeof token !== "string" || token.length < 20) throw unauthenticated();
      const session = await VoterSession.findOne({ tokenHash: sha256(token), active: true });
      if (!session) throw unauthenticated();
      const expired = expiryOf(session);
      if (expired) {
        await revoke({ _id: session._id });
        await audit.record({ action: "VOTER_SESSION_EXPIRED", result: "failure", requestId, ip, meta: { reason: expired } });
        throw new AppError(401, "SESSION_EXPIRED", "Your session has expired");
      }
      const voter = await Voter.findById(session.voterId);
      if (!voter || voter.status !== "ACTIVE") {
        await revoke({ _id: session._id });
        throw unauthenticated();
      }
      // ELECTION_CLOSED / ELECTION_NOT_OPEN end the journey. Receipt/recovery routes (allowClosed) keep working in a Closed
      // election, but only for a session that already reached the chain: nobody can START or continue voting after close.
      const phase = await requireOpen({ closedOk: allowClosed && CLOSED_OK_STAGES.includes(session.stage) });
      // Meaningful actions extend the idle window; passive polling (touch: false) must not.
      if (touch) await VoterSession.updateOne({ _id: session._id }, { $set: { lastActivityAt: new Date(now()) } });
      return { sessionId: String(session._id), voterDbId: String(voter._id), stage: session.stage, stageExpiresAt: session.stageExpiresAt, sessionExpiresAt: session.absoluteExpiresAt, voter: toSafeVoter(voter), electionPhase: phase };
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

    /**
     * Receipt recovery for a voter whose ballot is ALREADY on-chain (re-login after the receipt screen was lost). The session has
     * passed biometrics (FACE_VERIFIED or later) and the caller has verified the evidence; this jumps straight to COMPLETED.
     * AUTHENTICATED is deliberately excluded: face verification is never skipped. Returns true for the single winner.
     */
    async recoverToCompleted({ sessionId, expiresAt }) {
      const from = [STAGES.FACE_VERIFIED, STAGES.ELIGIBLE];
      const res = await VoterSession.updateOne({ _id: sessionId, stage: { $in: from }, active: true }, { $set: { stage: STAGES.COMPLETED, stageExpiresAt: expiresAt, lastActivityAt: new Date(now()) } });
      return res.modifiedCount === 1;
    },
  };
}
