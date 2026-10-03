import { generateSecret, generateURI, verifySync } from "otplib";

export const TOTP_ISSUER = "VoteChain";

export const newTotpSecret = () => generateSecret();
export const totpUri = (email, secret) => generateURI({ issuer: TOTP_ISSUER, label: email, secret });

/**
 * Checks a 6-digit code at `nowMs` (+/- one 30s step). Returns the matched time step so the caller
 * can enforce one-time use, or null.
 */
export function checkTotp(secret, token, nowMs) {
  if (!/^[0-9]{6}$/.test(token)) return null;
  const result = verifySync({ secret, token, epoch: Math.floor(nowMs / 1000), epochTolerance: 30 });
  return result.valid ? result.timeStep : null;
}
