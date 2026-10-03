import { Router } from "express";
import { z } from "zod";
import { STAGES } from "../auth/voterStages.js";
import { requireVoterSession, requireVoterStage } from "../middleware/requireVoterSession.js";
import { AppError } from "../utils/errors.js";
import { parse } from "../utils/validate.js";

const Nothing = z.strictObject({});
const Authorize = z.strictObject({ candidateId: z.string().regex(/^[1-9][0-9]{0,17}$/) });
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** Voting-journey steps after login. Each declares the stage it needs; none accepts client-chosen identity. */
export function createVoterJourneyRouter({ authService, eligibilityService, authorizationService, castService, config }) {
  const router = Router();
  const session = requireVoterSession(authService, config);
  const ctxOf = (req) => ({ ip: req.ip, requestId: req.id });

  // FACE_VERIFIED is the real entry; ELIGIBLE is accepted only so a duplicate/racing request is idempotent.
  router.post("/eligibility/check", session, requireVoterStage(STAGES.FACE_VERIFIED, STAGES.ELIGIBLE), async (req, res) => {
    parse(Nothing, req.body ?? {});
    parse(Nothing, req.query);
    res.json({ data: await eligibilityService.check(req.voterSession, ctxOf(req)) });
  });

  router.get("/ballot", session, requireVoterStage(STAGES.ELIGIBLE), async (req, res) => {
    parse(Nothing, req.query); // there is deliberately nothing to choose: the ballot is the voter's own
    res.json({ data: await eligibilityService.ballot(req.voterSession, ctxOf(req)) });
  });

  if (authorizationService) {
    // The voter confirms a candidate here. Nothing else is accepted: identity is derived server-side.
    router.post("/authorization", session, requireVoterStage(STAGES.ELIGIBLE, STAGES.AUTH_ISSUED), async (req, res) => {
      parse(Nothing, req.query);
      const body = parse(Authorize, req.body);
      res.json({ data: await authorizationService.authorize(req.voterSession, body, ctxOf(req)) });
    });
  }

  if (castService) {
    // Empty body: the candidate comes from the stored ticket, never from this request.
    router.post("/cast", session, requireVoterStage(STAGES.AUTH_ISSUED, STAGES.SUBMITTED), async (req, res) => {
      parse(Nothing, req.body ?? {});
      parse(Nothing, req.query);
      const key = req.get("idempotency-key");
      if (!key || !IDEMPOTENCY_KEY.test(key)) throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
      const out = await castService.cast(req.voterSession, { idempotencyKey: key }, ctxOf(req));
      res.status(out.http).json({ data: out.body });
    });
  }

  return router;
}
