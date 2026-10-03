import jwt from "jsonwebtoken";

export const ISSUER = "votechain-api";
export const ADMIN_AUDIENCE = "votechain-admin";
export const ROLE_ADMIN = "ADMIN";
export const ACCESS_TTL_SECONDS = 15 * 60;

/** Minimal claims only: who (sub), which session (sid), role, timing, unique id. */
export function signAccessToken({ secret, adminId, sessionId, jti, nowMs, ttlSeconds = ACCESS_TTL_SECONDS }) {
  const iat = Math.floor(nowMs / 1000);
  return jwt.sign({ sub: String(adminId), sid: String(sessionId), role: ROLE_ADMIN, jti, iat, exp: iat + ttlSeconds, iss: ISSUER, aud: ADMIN_AUDIENCE }, secret, {
    algorithm: "HS256",
  });
}

/** Throws a jsonwebtoken error on any problem. Only HS256, our issuer and the admin audience are accepted. */
export function verifyAccessToken({ secret, token, nowMs }) {
  return jwt.verify(token, secret, { algorithms: ["HS256"], issuer: ISSUER, audience: ADMIN_AUDIENCE, clockTimestamp: Math.floor(nowMs / 1000) });
}
