import { createHash, randomBytes, randomInt } from "node:crypto";
import { STAGES } from "../auth/voterStages.js";
// REUSE, not copy: the V2 biometric math and the encrypted template box are pure modules (node:crypto only) and stay the single source of truth.
import {
  CHALLENGE_TTL_MS,
  DESCRIPTOR_LENGTH,
  FACE_METHOD,
  FACE_MODEL,
  FACE_VERIFIED_TTL_MS,
  LIVENESS_ACTIONS,
  MATCH_THRESHOLD,
  MAX_CHALLENGES_PER_SESSION,
  MAX_FAILED_ATTEMPTS,
  TEMPLATE_VERSION,
} from "../../../backend-api/src/biometrics/constants.js";
import { toUnitVector } from "../../../backend-api/src/biometrics/descriptor.js";
import { decide } from "../../../backend-api/src/biometrics/matching.js";
import { openTemplate } from "../../../backend-api/src/biometrics/templateBox.js";
import { AppError } from "../utils/errors.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isDuplicate = (err) => err?.code === 11000;
const invalid = (field) => new AppError(400, "VALIDATION_FAILED", `Invalid request: ${field}`);
const notEnrolled = () => new AppError(409, "FACE_NOT_ENROLLED", "No face is enrolled for this voter. Ask the polling officer.");
const locked = () => new AppError(423, "FACE_LOCKED", "Face verification is locked for this session. Ask the polling officer.");

/**
 * AUTHENTICATED -> FACE_VERIFIED: the V2 supervised face matching, verification side only (enrolment is a registration-time task and stays in V2's admin tools).
 * The browser sends a descriptor (numbers, never an image); THE SERVER DECIDES. This is supervised matching, not proof of liveness (see the V2 biometrics constants).
 */
export function createFaceService({ VoterSession, FaceTemplate, FaceChallenge, authService, audit, templateKey, now = Date.now, threshold = MATCH_THRESHOLD }) {
  if (!Buffer.isBuffer(templateKey) || templateKey.length !== 32) throw new Error("the face template key must be 32 bytes");

  // The face-challenge index is load-bearing (one row per session); the template collection is V2's and gets no index from here.
  let indexes;
  const ready = () =>
    (indexes ??= FaceChallenge.createIndexes().catch((err) => {
      indexes = undefined;
      throw err;
    }));

  const attemptsLeftOf = (state) => Math.max(0, MAX_FAILED_ATTEMPTS - (state?.attempts ?? 0));
  const usable = (template) => template.algorithm === FACE_MODEL && template.dimension === DESCRIPTOR_LENGTH && template.templateVersion === TEMPLATE_VERSION;
  const passedFace = (stage) => stage !== STAGES.AUTHENTICATED;

  return {
    async status(session) {
      const state = await FaceChallenge.findOne({ sessionId: session.sessionId });
      const verified = passedFace(session.stage);
      const attemptsLeft = attemptsLeftOf(state);
      return { enrolled: Boolean(session.voter.faceEnrolled), verified, attemptsLeft, locked: !verified && attemptsLeft === 0 };
    },

    async issueChallenge(session, ctx) {
      await ready();
      const sessionId = session.sessionId;
      if (!session.voter.faceEnrolled) {
        audit.record({ action: "FACE_VERIFY_FAILURE", result: "failure", requestId: ctx.requestId, sessionRef: session.sessionRef, meta: { reason: "not_enrolled" } });
        throw notEnrolled();
      }
      try {
        await FaceChallenge.updateOne({ sessionId }, { $setOnInsert: { voterId: session.voterDbId, purgeAt: session.sessionExpiresAt } }, { upsert: true });
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
      const t = now();
      const token = randomBytes(32).toString("base64url");
      const action = LIVENESS_ACTIONS[randomInt(LIVENESS_ACTIONS.length)];
      const expiresAt = new Date(t + CHALLENGE_TTL_MS);
      const state = await FaceChallenge.findOneAndUpdate(
        { sessionId, attempts: { $lt: MAX_FAILED_ATTEMPTS }, challengesIssued: { $lt: MAX_CHALLENGES_PER_SESSION } },
        { $set: { tokenHash: sha256(token), action, expiresAt, usedAt: null }, $inc: { challengesIssued: 1 } },
        { returnDocument: "after" },
      );
      if (!state) {
        const current = await FaceChallenge.findOne({ sessionId });
        if (attemptsLeftOf(current) === 0) throw locked();
        throw new AppError(429, "FACE_CHALLENGE_LIMIT", "Too many face challenges in this session. Log in again.");
      }
      return { challenge: token, action, expiresAt, attemptsLeft: attemptsLeftOf(state) };
    },

    async verify({ session, challenge, descriptor, liveness }, ctx) {
      await ready();
      const sessionId = session.sessionId;
      const fail = (reason, extra = {}) => audit.record({ action: "FACE_VERIFY_FAILURE", result: "failure", requestId: ctx.requestId, sessionRef: session.sessionRef, meta: { reason, ...extra } });

      if (typeof challenge !== "string" || challenge.length < 20) throw invalid("challenge");
      const probe = toUnitVector(descriptor);
      if (!probe) throw invalid("descriptor");
      if (!session.voter.faceEnrolled) {
        fail("not_enrolled");
        throw notEnrolled();
      }
      if (liveness?.passed === false) {
        fail("liveness_reported_fail");
        throw new AppError(422, "FACE_LIVENESS_FAILED", "The liveness check did not pass. Follow the instruction on the screen and try again.");
      }

      // Read and decrypt the template BEFORE anything is consumed: a server-side fault must not cost the voter an attempt.
      const template = await FaceTemplate.findOne({ voterId: session.voterDbId }).select("+box");
      if (!template) {
        fail("not_enrolled");
        throw notEnrolled();
      }
      if (!usable(template)) {
        fail("reenrolment_required");
        throw new AppError(409, "FACE_REENROLMENT_REQUIRED", "This voter must be enrolled again. Ask the polling officer.");
      }
      let samples;
      try {
        samples = openTemplate(templateKey, String(session.voterDbId), template.box);
      } catch (err) {
        fail("template_unreadable");
        throw err;
      }

      // ONE atomic update uses the challenge and counts the attempt.
      const t = now();
      const claimed = await FaceChallenge.findOneAndUpdate(
        { sessionId, tokenHash: sha256(challenge), usedAt: null, expiresAt: { $gt: new Date(t) }, attempts: { $lt: MAX_FAILED_ATTEMPTS } },
        { $set: { usedAt: new Date(t) }, $inc: { attempts: 1 } },
        { returnDocument: "after" },
      );
      if (!claimed) {
        const current = await FaceChallenge.findOne({ sessionId });
        if (attemptsLeftOf(current) === 0) {
          fail("locked");
          throw locked();
        }
        fail("bad_challenge");
        throw new AppError(409, "FACE_CHALLENGE_INVALID", "The face challenge is missing, expired or already used. Request a new one.");
      }

      const { match, score } = decide(probe, samples, threshold);
      if (!match) {
        const attemptsLeft = attemptsLeftOf(claimed);
        fail("mismatch", { attempt: claimed.attempts, score });
        if (attemptsLeft === 0) {
          await FaceChallenge.updateOne({ sessionId, lockedAt: null }, { $set: { lockedAt: new Date(t) } });
          audit.record({ action: "FACE_LOCKED", result: "failure", requestId: ctx.requestId, sessionRef: session.sessionRef });
        }
        return { verified: false, attemptsLeft, locked: attemptsLeft === 0 };
      }

      const stageExpiresAt = new Date(t + FACE_VERIFIED_TTL_MS);
      const won = await authService.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: stageExpiresAt });
      if (!won) {
        fail("stage_lost", { attempt: claimed.attempts });
        throw new AppError(409, "STAGE_REQUIRED", `This step requires stage ${STAGES.AUTHENTICATED}`);
      }
      audit.record({ action: "FACE_VERIFY_SUCCESS", result: "success", requestId: ctx.requestId, sessionRef: session.sessionRef, meta: { attempt: claimed.attempts, score } });
      await VoterSession.updateOne({ _id: sessionId }, { $set: { faceMethod: FACE_METHOD } }).catch(() => {});
      return { verified: true, stage: STAGES.FACE_VERIFIED, stageExpiresAt };
    },
  };
}
