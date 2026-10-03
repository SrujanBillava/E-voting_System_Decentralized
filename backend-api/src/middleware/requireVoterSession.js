import { AppError } from "../utils/errors.js";

export const voterCookieName = (config) => (config.isProduction ? "__Host-vc_voter" : "vc_voter");

/** Reads the opaque session cookie and attaches req.voterSession (a minimal principal). */
export function requireVoterSession(authService, config, { touch = true, allowClosed = false } = {}) {
  const name = voterCookieName(config);
  return async (req, _res, next) => {
    try {
      req.voterSession = await authService.authenticate(req.cookies?.[name], { ip: req.ip, requestId: req.id, touch, allowClosed });
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Future routes declare the stage(s) they accept; no controller compares stage strings itself. */
export function requireVoterStage(...allowed) {
  return (req, _res, next) => {
    const current = req.voterSession?.stage;
    if (!allowed.includes(current)) return next(new AppError(409, "STAGE_REQUIRED", `This step requires stage ${allowed.join(" or ")}`));
    next();
  };
}
