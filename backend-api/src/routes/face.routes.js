import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { STAGES } from "../auth/voterStages.js";
import { MAX_SAMPLES, MIN_SAMPLES } from "../biometrics/constants.js";
import { isDescriptorShape } from "../biometrics/descriptor.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireVoterSession, requireVoterStage } from "../middleware/requireVoterSession.js";
import { AppError } from "../utils/errors.js";
import { parse } from "../utils/validate.js";

// A descriptor is validated as ONE value, so a bad one is reported as "descriptor", never element by element
// and never with its contents.
const descriptor = z.custom(isDescriptorShape);
const score = z.number().min(0).max(1);

const Nothing = z.strictObject({});
const Id = z.strictObject({ id: z.string().regex(/^[0-9a-f]{24}$/i) });
const Enrol = z.strictObject({ descriptors: z.array(descriptor).min(MIN_SAMPLES).max(MAX_SAMPLES) });
const Verify = z.strictObject({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/),
  descriptor,
  // The browser's own liveness result. The server cannot check it: "failed" is refused, "passed" is only recorded.
  liveness: z.strictObject({ passed: z.boolean(), real: score.optional(), live: score.optional() }).optional(),
});

/**
 * Voter side, mounted at /api/v1/voter/face. Both actions need a session that is still AUTHENTICATED:
 * this router performs exactly one stage transition, AUTHENTICATED -> FACE_VERIFIED.
 *
 * The three-attempt limit lives in the service. `faceRateLimit` only bounds how fast one address may call the
 * two actions at all (every refused call still costs a database read and an audit row).
 */
export function createFaceVoterRouter({ authService, faceService, config, faceRateLimit = { windowMs: 60_000, limit: 60 } }) {
  const router = Router();
  const limiter = rateLimit({ ...faceRateLimit, standardHeaders: true, legacyHeaders: false, handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Too many attempts, try again later")) });
  const session = requireVoterSession(authService, config);
  const passive = requireVoterSession(authService, config, { touch: false }); // polling must not keep an idle session alive
  const authenticated = requireVoterStage(STAGES.AUTHENTICATED);
  const ctxOf = (req) => ({ ip: req.ip, requestId: req.id });

  router.get("/status", passive, async (req, res) => {
    parse(Nothing, req.query);
    res.json({ data: await faceService.status(req.voterSession) });
  });

  router.post("/challenge", limiter, session, authenticated, async (req, res) => {
    parse(Nothing, req.body ?? {});
    parse(Nothing, req.query);
    res.json({ data: await faceService.issueChallenge(req.voterSession, ctxOf(req)) });
  });

  router.post("/verify", limiter, session, authenticated, async (req, res) => {
    parse(Nothing, req.query);
    const body = parse(Verify, req.body);
    const out = await faceService.verify({ ...body, session: req.voterSession }, ctxOf(req));
    if (out.verified) return res.json({ data: { stage: out.stage, stageExpiresAt: out.stageExpiresAt } });
    // A mismatch is an expected answer, not a fault. The client needs the attempts that are left.
    res.status(403).json({
      error: { code: "FACE_MISMATCH", message: "The face did not match the enrolled voter", details: { attemptsLeft: out.attemptsLeft, locked: out.locked }, requestId: req.id },
    });
  });

  return router;
}

/** Admin side, mounted at /api/v1/admin. Enrolment changes are refused once the election has left Setup. */
export function createFaceAdminRouter({ authService, faceService }) {
  const router = Router();
  const guard = requireAdmin(authService);
  const ctxOf = (req) => ({ adminId: req.admin.adminId, ip: req.ip, requestId: req.id });

  router.get("/voters/:id/face", guard, async (req, res) => res.json({ data: await faceService.info(parse(Id, req.params).id) }));

  router.put("/voters/:id/face", guard, async (req, res) => {
    const { id } = parse(Id, req.params);
    const { descriptors } = parse(Enrol, req.body);
    res.json({ data: await faceService.enroll({ voterDbId: id, descriptors }, ctxOf(req)) });
  });

  router.delete("/voters/:id/face", guard, async (req, res) => {
    await faceService.remove({ voterDbId: parse(Id, req.params).id }, ctxOf(req));
    res.status(204).end();
  });

  return router;
}
