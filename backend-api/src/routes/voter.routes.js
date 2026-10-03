import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireVoterSession, requireVoterStage, voterCookieName } from "../middleware/requireVoterSession.js";
import { STAGES } from "../auth/voterStages.js";
import { AppError } from "../utils/errors.js";
import { parse } from "../utils/validate.js";

const Login = z.strictObject({ identifier: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) });

export function createVoterRouter({ authService, config, loginRateLimit = { windowMs: 15 * 60_000, limit: 10 } }) {
  const router = Router();
  const cookie = voterCookieName(config);
  const options = (maxAge) => ({ httpOnly: true, secure: config.isProduction, sameSite: "strict", path: "/", ...(maxAge ? { maxAge } : {}) });
  const limiter = rateLimit({ ...loginRateLimit, standardHeaders: true, legacyHeaders: false, handler: (_q, _r, next) => next(new AppError(429, "RATE_LIMITED", "Too many attempts, try again later")) });
  const session = requireVoterSession(authService, config, { touch: false }); // /status is passive: it must not extend the idle window

  router.post("/auth/login", limiter, async (req, res) => {
    const { identifier, password } = parse(Login, req.body);
    const out = await authService.login({ identifier, password, ip: req.ip, requestId: req.id });
    res.cookie(cookie, out.token, options(out.maxAgeMs));
    res.json({ data: { voter: out.voter, stage: out.stage, stageExpiresAt: out.stageExpiresAt } });
  });

  router.post("/auth/logout", async (req, res) => {
    await authService.logout({ token: req.cookies?.[cookie], ip: req.ip, requestId: req.id });
    res.clearCookie(cookie, options());
    res.status(204).end();
  });

  // The single source the UI renders from after any refresh.
  router.get("/status", session, (req, res) => {
    const s = req.voterSession;
    res.json({ data: { voter: s.voter, stage: s.stage, stageExpiresAt: s.stageExpiresAt, sessionExpiresAt: s.sessionExpiresAt, electionPhase: s.electionPhase } });
  });

  return router;
}

export { requireVoterStage, STAGES };
