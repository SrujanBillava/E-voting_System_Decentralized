// The compact Fiat-Shamir proof shape shared by the Schnorr proof of knowledge and the Chaum-Pedersen proof: the pair (e, z), both scalars mod l.
// The verifier recomputes the commitment(s) from (e, z), so the nonce commitments are never transmitted.
import { exactKeys } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { assertScalar, parseScalarWire, scalarToWire } from "./scalar.ts";

export interface Proof {
  readonly e: bigint;
  readonly z: bigint;
}
export interface WireProof {
  e: string;
  z: string;
}

/**
 * Strict internal check: both values are bigints REDUCED mod l and non-zero. A value >= l is a malleable twin of a valid proof (z + l verifies the same
 * equation) and is refused; an honest prover hits 0 with probability about 2^-250 and simply draws a fresh nonce.
 */
export function assertProof(value: unknown, what = "proof"): Proof {
  if (typeof value !== "object" || value === null) throw new InvalidInputError("BAD_PROOF", `${what} must be an object {e, z}`);
  const { e, z } = value as { e?: unknown; z?: unknown };
  return { e: assertScalar(e, `${what}.e`, { nonZero: true }), z: assertScalar(z, `${what}.z`, { nonZero: true }) };
}

export const proofToWire = (p: Proof): WireProof => ({ e: scalarToWire(p.e), z: scalarToWire(p.z) });

export function parseProofWire(value: unknown, what = "proof"): Proof {
  const o = exactKeys(value, ["e", "z"], what);
  return { e: parseScalarWire(o.e, `${what}.e`, { nonZero: true }), z: parseScalarWire(o.z, `${what}.z`, { nonZero: true }) };
}
