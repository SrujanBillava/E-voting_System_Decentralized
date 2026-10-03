import { AppError } from "../utils/errors.js";

/** The one place bearer tokens are checked. Attaches req.admin = { adminId, sessionId, admin }. */
export function requireAdmin(authService) {
  return async (req, _res, next) => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
    if (!match) return next(new AppError(401, "UNAUTHENTICATED", "Authentication required"));
    try {
      req.admin = await authService.authenticate(match[1]);
      next();
    } catch (err) {
      next(err);
    }
  };
}
