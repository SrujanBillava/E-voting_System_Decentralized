import { createHash, randomBytes, randomInt } from "node:crypto";
import { STAGE_ORDER, STAGES } from "../auth/voterStages.js";
import {
  CHALLENGE_TTL_MS,
  DESCRIPTOR_LENGTH,
  ENROLMENT_CONSISTENCY_THRESHOLD,
  FACE_METHOD,
  FACE_MODEL,
  FACE_VERIFIED_TTL_MS,
  LIVENESS_ACTIONS,
  MATCH_THRESHOLD,
  MAX_CHALLENGES_PER_SESSION,
  MAX_FAILED_ATTEMPTS,
  MAX_SAMPLES,
  MIN_SAMPLES,
  TEMPLATE_VERSION,
} from "../biometrics/constants.js";
import { toUnitVector } from "../biometrics/descriptor.js";
import { decide, lowestPairSimilarity } from "../biometrics/matching.js";
import { openTemplate, sealTemplate } from "../biometrics/templateBox.js";
import { AppError } from "../utils/errors.js";
import { requireSetup } from "./chainConfig.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const isDuplicate = (err) => err?.code === 11000;

const invalid = (field) => new AppError(400, "VALIDATION_FAILED", `Invalid request: ${field}`);
const notEnrolled = () => new AppError(409, "FACE_NOT_ENROLLED", "No face is enrolled for this voter. Ask the polling officer.");
const locked = () => new AppError(423, "FACE_LOCKED", "Face verification is locked for this session. Ask the polling officer.");

/**
 * Biometrics: the single stage transition AUTHENTICATED -> FACE_VERIFIED, and the admin enrolment that feeds it.
 *
 * The browser sends a face descriptor (numbers), never an image. THE SERVER MAKES THE DECISION: it decrypts the
 * voter's enrolled template and compares. See src/biometrics/constants.js for the honest limitation: this is
 * supervised face matching, because a modified client can submit any descriptor it likes.
 *
 * `now` and `threshold` are injectable for tests.
 */
export function createFaceService({ Voter, VoterSession, FaceTemplate, FaceChallenge, authService, chain, audit, templateKey, now = Date.now, threshold = MATCH_THRESHOLD }) {
  if (!Buffer.isBuffer(templateKey) || templateKey.length !== 32) throw new Error("the face template key must be 32 bytes");

  // The unique indexes are load-bearing (one template per voter, one challenge row per session): make sure they
  // exist before the first use. createIndexes() is idempotent, and a failed build is tried again on the next call.
  let indexes;
  const ready = () =>
    (indexes ??= Promise.all([FaceTemplate.createIndexes(), FaceChallenge.createIndexes()]).catch((err) => {
      indexes = undefined;
      throw err;
    }));

  const findVoter = async (voterDbId) => {
    const voter = await Voter.findById(voterDbId);
    if (!voter) throw new AppError(404, "NOT_FOUND", "Voter not found");
    return voter;
  };
  const attemptsLeftOf = (state) => Math.max(0, MAX_FAILED_ATTEMPTS - (state?.attempts ?? 0));
  const usable = (template) => template.algorithm === FACE_MODEL && template.dimension === DESCRIPTOR_LENGTH && template.templateVersion === TEMPLATE_VERSION;
  const passedFace = (stage) => STAGE_ORDER.indexOf(stage) >= STAGE_ORDER.indexOf(STAGES.FACE_VERIFIED);

  return {
    // ------------------------------------------------------------------ admin: enrolment (Setup phase only)

    /** Stores 3-5 sample descriptors for one voter, encrypted, replacing any earlier enrolment. */
    async enroll({ voterDbId, descriptors }, ctx) {
      await ready();
      await requireSetup(chain);
      const voter = await findVoter(voterDbId);
      if (!Array.isArray(descriptors) || descriptors.length < MIN_SAMPLES || descriptors.length > MAX_SAMPLES) throw invalid("descriptors");
      const samples = descriptors.map(toUnitVector);
      if (samples.includes(null)) throw invalid("descriptors");

      const meta = { voterDbId: String(voter._id), voterId: voter.voterId };
      const who = { adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip };
      if (lowestPairSimilarity(samples) < ENROLMENT_CONSISTENCY_THRESHOLD) {
        await audit.record({ action: "FACE_ENROLMENT_REJECTED", result: "failure", ...who, meta: { ...meta, reason: "inconsistent_samples" } });
        throw new AppError(422, "FACE_SAMPLES_INCONSISTENT", "The samples do not look like the same face. Capture them again.");
      }

      const enrolledAt = new Date(now());
      const fields = {
        box: sealTemplate(templateKey, String(voter._id), samples),
        sampleCount: samples.length,
        dimension: DESCRIPTOR_LENGTH,
        algorithm: FACE_MODEL,
        templateVersion: TEMPLATE_VERSION,
        enrolledBy: ctx.adminId ?? null,
        enrolledAt,
      };
      try {
        await FaceTemplate.updateOne({ voterId: voter._id }, { $set: fields }, { upsert: true });
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        await FaceTemplate.updateOne({ voterId: voter._id }, { $set: fields }); // a parallel enrolment inserted the row first
      }
      const flagged = await Voter.updateOne({ _id: voter._id }, { $set: { faceEnrolled: true } });
      if (flagged?.matchedCount === 0) {
        // The voter was deleted while this enrolment was in flight: biometric data must not outlive the voter.
        await FaceTemplate.deleteOne({ voterId: voter._id });
        throw new AppError(404, "NOT_FOUND", "Voter not found");
      }
      await audit.record({ action: "FACE_ENROLLED", result: "success", ...who, meta: { ...meta, sampleCount: samples.length } });
      return { voter: { id: String(voter._id), voterId: voter.voterId, faceEnrolled: true }, face: { sampleCount: samples.length, enrolledAt, algorithm: FACE_MODEL } };
    },

    /** Deletes a voter's template. The voter must be enrolled again before they can vote. */
    async remove({ voterDbId }, ctx) {
      await ready();
      await requireSetup(chain);
      const voter = await findVoter(voterDbId);
      await Voter.updateOne({ _id: voter._id }, { $set: { faceEnrolled: false } });
      await FaceTemplate.deleteOne({ voterId: voter._id });
      await audit.record({ action: "FACE_ENROLMENT_REMOVED", result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, meta: { voterDbId: String(voter._id), voterId: voter.voterId } });
    },

    /**
     * Every stored template must still be readable with the CONFIGURED key and be in the current format. Used before the election opens:
     * once it is Open nothing can be re-enrolled, so a rotated or mistyped key would strand every enrolled voter. Counts only.
     */
    async templateReadiness() {
      await ready();
      let total = 0;
      let unreadable = 0;
      for await (const template of FaceTemplate.find({}).select("+box").cursor()) {
        total++;
        if (!usable(template)) {
          unreadable++;
          continue;
        }
        try {
          openTemplate(templateKey, String(template.voterId), template.box);
        } catch {
          unreadable++;
        }
      }
      return { total, unreadable };
    },

    /** What an admin may see about an enrolment: facts about it, never the template. */
    async info(voterDbId) {
      const voter = await findVoter(voterDbId);
      const template = await FaceTemplate.findOne({ voterId: voter._id });
      return {
        voterId: voter.voterId,
        enrolled: Boolean(voter.faceEnrolled && template),
        sampleCount: template?.sampleCount ?? 0,
        enrolledAt: template?.enrolledAt ?? null,
        algorithm: template?.algorithm ?? null,
        needsReenrolment: Boolean(template) && !usable(template),
      };
    },

    // ------------------------------------------------------------------ voter: AUTHENTICATED -> FACE_VERIFIED

    /** For the UI after a refresh. Passive: it reveals nothing about the template or the challenge. */
    async status(session) {
      const state = await FaceChallenge.findOne({ sessionId: session.sessionId });
      const verified = passedFace(session.stage);
      const attemptsLeft = attemptsLeftOf(state);
      return { enrolled: Boolean(session.voter.faceEnrolled), verified, attemptsLeft, locked: !verified && attemptsLeft === 0 };
    },

    /**
     * Issues the session's challenge: random, valid for about 30 seconds, usable once. It replaces any earlier
     * challenge of the same session. `action` is what the browser asks the voter to do first (advisory).
     */
    async issueChallenge(session, ctx) {
      await ready();
      const sessionId = session.sessionId;
      if (!session.voter.faceEnrolled) {
        await audit.record({ action: "FACE_VERIFY_FAILURE", result: "failure", requestId: ctx.requestId, ip: ctx.ip, meta: { voterId: session.voter.voterId, reason: "not_enrolled" } });
        throw notEnrolled();
      }
      try {
        await FaceChallenge.updateOne({ sessionId }, { $setOnInsert: { voterId: session.voterDbId, purgeAt: session.sessionExpiresAt } }, { upsert: true });
      } catch (err) {
        if (!isDuplicate(err)) throw err; // a parallel request created the row first: fine
      }

      const t = now();
      const token = randomBytes(32).toString("base64url");
      const action = LIVENESS_ACTIONS[randomInt(LIVENESS_ACTIONS.length)];
      const expiresAt = new Date(t + CHALLENGE_TTL_MS);
      const state = await FaceChallenge.findOneAndUpdate(
        { sessionId, attempts: { $lt: MAX_FAILED_ATTEMPTS }, challengesIssued: { $lt: MAX_CHALLENGES_PER_SESSION } },
        { $set: { tokenHash: sha256(token), action, issuedAt: new Date(t), expiresAt, usedAt: null }, $inc: { challengesIssued: 1 } },
        { returnDocument: "after" },
      );
      if (!state) {
        const current = await FaceChallenge.findOne({ sessionId });
        if (attemptsLeftOf(current) === 0) throw locked();
        throw new AppError(429, "FACE_CHALLENGE_LIMIT", "Too many face challenges in this session. Log in again.");
      }
      return { challenge: token, action, expiresAt, attemptsLeft: attemptsLeftOf(state) };
    },

    /**
     * Compares the submitted descriptor with the voter's enrolled template.
     *
     * Returns { verified: true, stage, stageExpiresAt } on a match, or { verified: false, attemptsLeft, locked }
     * on a mismatch. Everything else (no enrolment, bad challenge, locked, lost stage) is thrown as an AppError.
     * `liveness` is the browser's own report. The server cannot check it, so it never helps a face to pass:
     * a reported failure is refused, a reported pass is only written to the audit row.
     */
    async verify({ session, challenge, descriptor, liveness }, ctx) {
      await ready();
      const sessionId = session.sessionId;
      const who = { requestId: ctx.requestId, ip: ctx.ip };
      const voterMeta = { voterId: session.voter.voterId };
      const fail = (reason, extra = {}) => audit.record({ action: "FACE_VERIFY_FAILURE", result: "failure", ...who, meta: { ...voterMeta, reason, ...extra } });

      if (typeof challenge !== "string" || challenge.length < 20) throw invalid("challenge");
      const probe = toUnitVector(descriptor);
      if (!probe) throw invalid("descriptor");
      if (!session.voter.faceEnrolled) {
        await fail("not_enrolled");
        throw notEnrolled();
      }
      // The liveness report can only ever REFUSE. A browser that says its own check failed is taken at its word;
      // a browser that says it passed is still compared like any other (the report proves nothing).
      if (liveness?.passed === false) {
        await fail("liveness_reported_fail");
        throw new AppError(422, "FACE_LIVENESS_FAILED", "The liveness check did not pass. Follow the instruction on the screen and try again.");
      }

      // Read and decrypt the template BEFORE anything is consumed: a server-side fault must not cost the voter an attempt.
      const template = await FaceTemplate.findOne({ voterId: session.voterDbId }).select("+box");
      if (!template) {
        await fail("not_enrolled");
        throw notEnrolled();
      }
      if (!usable(template)) {
        await fail("reenrolment_required");
        throw new AppError(409, "FACE_REENROLMENT_REQUIRED", "This voter must be enrolled again. Ask the polling officer.");
      }
      let samples;
      try {
        samples = openTemplate(templateKey, String(session.voterDbId), template.box);
      } catch (err) {
        await fail("template_unreadable");
        throw err; // not an AppError: answered as a generic 500 and logged
      }

      // ONE atomic update uses the challenge and counts the attempt. Of any number of parallel requests exactly one
      // gets through, a challenge never works twice, and no more than MAX_FAILED_ATTEMPTS comparisons ever happen.
      const t = now();
      const claimed = await FaceChallenge.findOneAndUpdate(
        { sessionId, tokenHash: sha256(challenge), usedAt: null, expiresAt: { $gt: new Date(t) }, attempts: { $lt: MAX_FAILED_ATTEMPTS } },
        { $set: { usedAt: new Date(t) }, $inc: { attempts: 1 } },
        { returnDocument: "after" },
      );
      if (!claimed) {
        const current = await FaceChallenge.findOne({ sessionId });
        if (attemptsLeftOf(current) === 0) {
          await fail("locked");
          throw locked();
        }
        await fail("bad_challenge");
        throw new AppError(409, "FACE_CHALLENGE_INVALID", "The face challenge is missing, expired or already used. Request a new one.");
      }

      const { match, score } = decide(probe, samples, threshold);
      const attempt = claimed.attempts;
      const livenessLabel = liveness === undefined ? "not_reported" : "reported_pass";

      if (!match) {
        const attemptsLeft = attemptsLeftOf(claimed);
        await fail("mismatch", { attempt, score, liveness: livenessLabel });
        if (attemptsLeft === 0) {
          await FaceChallenge.updateOne({ sessionId, lockedAt: null }, { $set: { lockedAt: new Date(t) } });
          await audit.record({ action: "FACE_LOCKED", result: "failure", ...who, meta: { ...voterMeta, attempt } });
        }
        return { verified: false, attemptsLeft, locked: attemptsLeft === 0 };
      }

      const stageExpiresAt = new Date(t + FACE_VERIFIED_TTL_MS);
      const won = await authService.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: stageExpiresAt });
      if (!won) {
        // The session left AUTHENTICATED (or was revoked) while we compared.
        await fail("stage_lost", { attempt });
        throw new AppError(409, "STAGE_REQUIRED", `This step requires stage ${STAGES.AUTHENTICATED}`);
      }
      // The step is granted from here on. The audit row comes first; the two labels after it are bookkeeping, and
      // a failure to write them must not turn a granted step into an error for the voter.
      await audit.record({ action: "FACE_VERIFY_SUCCESS", result: "success", ...who, meta: { ...voterMeta, attempt, score, liveness: livenessLabel } });
      await Promise.allSettled([
        VoterSession.updateOne({ _id: sessionId }, { $set: { faceMethod: FACE_METHOD } }),
        FaceChallenge.updateOne({ sessionId }, { $set: { verifiedAt: new Date(t) } }),
      ]);
      return { verified: true, stage: STAGES.FACE_VERIFIED, stageExpiresAt };
    },
  };
}
