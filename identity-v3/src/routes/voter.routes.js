import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { requireVoterSession, requireVoterStage, voterCookieName } from "../middleware/requireVoterSession.js";
import { STAGES } from "../auth/voterStages.js";
import { AppError } from "../utils/errors.js";
import { parse } from "../utils/validate.js";

const Nothing = z.strictObject({});
const Login = z.strictObject({ identifier: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) });
const Verify = z.strictObject({
  challenge: z.string().min(20).max(200),
  descriptor: z.array(z.number()).max(1024),
  liveness: z.strictObject({ passed: z.boolean() }).optional(),
});
// The ONLY thing a caller supplies to get a credential: the PUBLIC Semaphore identity commitment, a canonical decimal string. No constituency, no voter id.
const CredentialRequest = z.strictObject({ commitment: z.string().regex(/^[1-9][0-9]{0,77}$/) });

const cookieOptions = (config, maxAge) => ({ httpOnly: true, secure: config.isProduction, sameSite: "strict", path: "/", ...(maxAge ? { maxAge } : {}) });

/** The whole voter-facing surface of the identity service: login, face, eligibility, credential. There is NO ballot, receipt or result route, by design. */
export function createVoterRouter({ authService, faceService, credentialService, config, loginRateLimit = { windowMs: 15 * 60_000, limit: 10 }, faceRateLimit = { windowMs: 60_000, limit: 60 } }) {
  const router = Router();
  const cookie = voterCookieName(config);
  const limiter = (opts) => rateLimit({ ...opts, standardHeaders: true, legacyHeaders: false, handler: (_q, _r, next) => next(new AppError(429, "RATE_LIMITED", "Too many attempts, try again later")) });
  const session = requireVoterSession(authService, config);
  const passive = requireVoterSession(authService, config, { touch: false });
  const ctxOf = (req) => ({ requestId: req.id });

  router.post("/auth/login", limiter(loginRateLimit), async (req, res) => {
    const { identifier, password } = parse(Login, req.body);
    const out = await authService.login({ identifier, password, requestId: req.id });
    res.cookie(cookie, out.token, cookieOptions(config, out.maxAgeMs));
    res.json({ data: { voter: out.voter, stage: out.stage, stageExpiresAt: out.stageExpiresAt } });
  });

  router.post("/auth/logout", async (req, res) => {
    await authService.logout({ token: req.cookies?.[cookie] });
    res.clearCookie(cookie, cookieOptions(config));
    res.status(204).end();
  });

  router.get("/status", passive, (req, res) => {
    const s = req.voterSession;
    res.json({ data: { voter: s.voter, stage: s.stage, stageExpiresAt: s.stageExpiresAt, sessionExpiresAt: s.sessionExpiresAt } });
  });

  // ---- biometrics: AUTHENTICATED -> FACE_VERIFIED
  const faceLimit = limiter(faceRateLimit);
  router.get("/face/status", faceLimit, passive, async (req, res) => {
    parse(Nothing, req.query);
    res.json({ data: await faceService.status(req.voterSession) });
  });
  router.post("/face/challenge", faceLimit, session, requireVoterStage(STAGES.AUTHENTICATED), async (req, res) => {
    parse(Nothing, req.body ?? {});
    res.json({ data: await faceService.issueChallenge(req.voterSession, ctxOf(req)) });
  });
  router.post("/face/verify", faceLimit, session, requireVoterStage(STAGES.AUTHENTICATED), async (req, res) => {
    const body = parse(Verify, req.body);
    res.json({ data: await faceService.verify({ session: req.voterSession, ...body }, ctxOf(req)) });
  });

  // ---- FACE_VERIFIED -> ELIGIBLE
  router.post("/eligibility/check", session, requireVoterStage(STAGES.FACE_VERIFIED, STAGES.ELIGIBLE), async (req, res) => {
    parse(Nothing, req.body ?? {});
    parse(Nothing, req.query);
    res.json({ data: await credentialService.checkEligibility(req.voterSession, ctxOf(req)) });
  });

  // ---- ELIGIBLE -> COMMITMENT_PENDING -> CREDENTIAL_ISSUED
  router.post("/credential", session, requireVoterStage(STAGES.ELIGIBLE, STAGES.COMMITMENT_PENDING), async (req, res) => {
    parse(Nothing, req.query);
    const body = parse(CredentialRequest, req.body);
    const out = await credentialService.request(req.voterSession, body, ctxOf(req));
    res.status(out.http).json({ data: out.body });
  });

  // The poll. It delivers the issuance result ONCE and then ENDS the identity session (the only stage that may call it after issuance is the terminal one).
  const delivery = requireVoterSession(authService, config, { requireOpen: false });
  router.get("/credential", delivery, requireVoterStage(STAGES.COMMITMENT_PENDING, STAGES.CREDENTIAL_ISSUED), async (req, res) => {
    parse(Nothing, req.query);
    const out = await credentialService.status(req.voterSession, ctxOf(req));
    if (out.terminate) res.clearCookie(cookie, cookieOptions(config));
    if (out.error) throw out.error;
    res.status(out.http).json({ data: out.body });
  });

  return router;
}
