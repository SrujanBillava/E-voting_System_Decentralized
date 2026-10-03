import { id, keccak256, toUtf8Bytes } from "ethers";

/**
 * On-chain constituency id: keccak256(utf8(code)). This is the ONLY place the backend derives it.
 * It must match both `Voting.addConstituency` and `smart-contract/ignition/data/election.ts`.
 * Codes are case-sensitive on-chain; callers canonicalise BEFORE calling this.
 */
export function constituencyIdOf(code) {
  if (typeof code !== "string" || code.length === 0) throw new TypeError("constituency code must be a non-empty string");
  return keccak256(toUtf8Bytes(code));
}

/** Election id for a human election code: keccak256(utf8(code)). */
export function electionIdOf(electionCode) {
  if (typeof electionCode !== "string" || electionCode.length === 0) throw new TypeError("election code must be a non-empty string");
  return id(electionCode);
}

/** The one canonical policy for constituency codes: trimmed, UPPERCASE, A-Z0-9 groups joined by single hyphens. */
export const CONSTITUENCY_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/**
 * Returns the canonical code, or null if the input cannot be one. The contract is case-sensitive, so
 * this MUST run before deriving an id, sending a transaction or storing a code on a voter.
 */
export function canonicalConstituencyCode(input) {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  return code.length <= 40 && CONSTITUENCY_CODE_PATTERN.test(code) ? code : null;
}
