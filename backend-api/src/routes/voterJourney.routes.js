import { Router } from "express";
import { z } from "zod";
import { STAGES } from "../auth/voterStages.js";
import { requireVoterSession, requireVoterStage } from "../middleware/requireVoterSession.js";
import { parse } from "../utils/validate.js";

const Nothing = z.strictObject({});

/** Voting-journey steps after login. Each declares the stage it needs; none accepts client-chosen identity. */
export function createVoterJourneyRouter({ authService, eligibilityService, config }) {
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

  return router;
}
