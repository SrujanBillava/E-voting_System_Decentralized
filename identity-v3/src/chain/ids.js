import { keccak256, toUtf8Bytes } from "ethers";

/** On-chain constituency id: keccak256(utf8(code)), the same rule as V2 and the V3 contract. Codes are case-sensitive on-chain: canonicalise first. */
export function constituencyIdOf(code) {
  if (typeof code !== "string" || code.length === 0) throw new TypeError("constituency code must be a non-empty string");
  return keccak256(toUtf8Bytes(code));
}

/** The one canonical policy for constituency codes: trimmed, UPPERCASE, A-Z0-9 groups joined by single hyphens. */
export const CONSTITUENCY_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export function canonicalConstituencyCode(input) {
  if (typeof input !== "string") return null;
  const code = input.trim().toUpperCase();
  return code.length <= 40 && CONSTITUENCY_CODE_PATTERN.test(code) ? code : null;
}

/** The BN254 scalar field (BabyJubJub base field): every Semaphore identity commitment is an element of it, 0 excluded (the contract rejects both). */
export const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * A commitment as the API accepts it: a canonical decimal string (no sign, no leading zero, no hex), 0 < c < p. Returns the BigInt, or null.
 * Canonical decimal only: one commitment has exactly one spelling, so uniqueness checks cannot be dodged by re-spelling it.
 */
export function parseCommitment(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) return null;
  const n = BigInt(value);
  return n > 0n && n < FIELD_PRIME ? n : null;
}
