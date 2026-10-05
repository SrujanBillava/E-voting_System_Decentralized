import { AppError } from "../utils/errors.js";

export const voterCookieName = (config) => (config.isProduction ? "__Host-vc3_voter" : "vc3_voter");

/** Reads the opaque session cookie and attaches req.voterSession (a minimal principal). */
export function requireVoterSession(authService, config, { touch = true, requireOpen = true } = {}) {
  const name = voterCookieName(config);
  return async (req, _res, next) => {
    try {
      req.voterSession = await authService.authenticate(req.cookies?.[name], { requestId: req.id, touch, requireOpen });
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Routes declare the stage(s) they accept; no controller compares stage strings itself. */
export function requireVoterStage(...allowed) {
  return (req, _res, next) => {
    const current = req.voterSession?.stage;
    if (!allowed.includes(current)) return next(new AppError(409, "STAGE_REQUIRED", `This step requires stage ${allowed.join(" or ")}`));
    next();
  };
}
