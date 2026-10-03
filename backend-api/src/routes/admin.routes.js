import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { AppError } from "../utils/errors.js";
import { parse } from "../utils/validate.js";
import { createAdminDataRouter } from "./adminData.routes.js";

export const REFRESH_COOKIE = "vc_admin_rt";
const COOKIE_PATH = "/api/v1/admin/auth";

const Login = z.strictObject({ email: z.string().max(254).email(), password: z.string().min(1).max(256), totp: z.string().regex(/^[0-9]{6}$/) });
const Open = z.strictObject({ confirmation: z.string().max(40), totp: z.string().regex(/^[0-9]{6}$/) });

export function createAdminRouter({ authService, electionService, voterService, configService, config, loginRateLimit = { windowMs: 60_000, limit: 5 } }) {
  const router = Router();
  const guard = requireAdmin(authService);
  const ctxOf = (req) => ({ adminId: req.admin?.adminId, ip: req.ip, requestId: req.id });

  const cookieOptions = (maxAge) => ({ httpOnly: true, secure: config.isProduction, sameSite: "strict", path: COOKIE_PATH, ...(maxAge ? { maxAge } : {}) });
  const setSession = (res, issued) => {
    res.cookie(REFRESH_COOKIE, issued.refreshToken, cookieOptions(issued.maxAgeMs));
    res.json({ data: { accessToken: issued.accessToken, admin: issued.admin } });
  };

  const loginLimiter = rateLimit({
    ...loginRateLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, "RATE_LIMITED", "Too many attempts, try again later")),
  });

  router.post("/auth/login", loginLimiter, async (req, res) => {
    const body = parse(Login, req.body);
    setSession(res, await authService.login({ ...body, ip: req.ip, requestId: req.id }));
  });

  router.post("/auth/refresh", async (req, res) => {
    try {
      setSession(res, await authService.refresh({ refreshToken: req.cookies?.[REFRESH_COOKIE], ip: req.ip, requestId: req.id }));
    } catch (err) {
      // Only a definite "not authenticated" ends the browser's session. A transient failure (database down, ...) must not log the admin out.
      if (err?.status === 401) res.clearCookie(REFRESH_COOKIE, cookieOptions());
      throw err;
    }
  });

  router.post("/auth/logout", async (req, res) => {
    await authService.logout({ refreshToken: req.cookies?.[REFRESH_COOKIE], ip: req.ip, requestId: req.id });
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    res.status(204).end();
  });

  router.get("/auth/me", guard, (req, res) => res.json({ data: { admin: req.admin.admin } }));

  router.get("/election", guard, async (_req, res) => res.json({ data: await electionService.getElection() }));
  router.post("/election/open", guard, async (req, res) => res.json({ data: await electionService.open(parse(Open, req.body), ctxOf(req)) }));
  router.post("/election/close", guard, async (req, res) => res.json({ data: await electionService.close(parse(Open, req.body), ctxOf(req)) }));

  if (voterService && configService) router.use(guard, createAdminDataRouter({ voterService, configService }));

  return router;
}
