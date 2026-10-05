// Scalar arithmetic. EVERY secret scalar, DKG coefficient, share, Lagrange coefficient, Schnorr or Chaum-Pedersen nonce, challenge and response in this
// toolkit lives mod l = SUBGROUP_ORDER, the order of the prime-order BabyJubJub subgroup. The BN254 field prime p is the modulus of point COORDINATES only
// and is not imported here: using it for a scalar would silently produce values that no longer match the curve group.
import { randomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToBigInt, hex32, parseHex32 } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { SUBGROUP_ORDER as L } from "./params.ts";

export const mod = (a: bigint): bigint => ((a % L) + L) % L;
export const add = (a: bigint, b: bigint): bigint => mod(a + b);
export const sub = (a: bigint, b: bigint): bigint => mod(a - b);
export const mul = (a: bigint, b: bigint): bigint => mod(a * b);
export const neg = (a: bigint): bigint => mod(-a);

export function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mul(result, b);
    b = mul(b, b);
    e >>= 1n;
  }
  return result;
}

/** Modular inverse mod l (l is prime). Throws for 0. */
export function inv(a: bigint): bigint {
  const reduced = mod(a);
  if (reduced === 0n) throw new InvalidInputError("DIVISION_BY_ZERO", "cannot invert 0 mod l");
  return pow(reduced, L - 2n);
}

/**
 * A uniform scalar in [1, l-1]: 384 bits from the operating system's CSPRNG (node:crypto) reduced mod (l-1), plus 1; the modulo bias is about 2^-133.
 * THE ONLY scalar entropy source of the toolkit. There is deliberately no parameter, option, seed or hook to substitute another one.
 */
export function randomScalar(): bigint {
  return (bytesToBigInt(randomBytes(48)) % (L - 1n)) + 1n;
}

/** True for a bigint that is already reduced: 0 <= v < l. A non-reduced scalar is never silently reduced at a trust boundary: it is refused. */
export function isCanonicalScalar(v: unknown): v is bigint {
  return typeof v === "bigint" && v >= 0n && v < L;
}

export function assertScalar(v: unknown, what: string, opts: { nonZero?: boolean } = {}): bigint {
  if (!isCanonicalScalar(v)) throw new InvalidInputError("BAD_SCALAR", `${what} must be a scalar reduced mod l`);
  if (opts.nonZero && v === 0n) throw new InvalidInputError("ZERO_SCALAR", `${what} must not be zero`);
  return v;
}

/**
 * Fiat-Shamir challenge: uint256(keccak256(preimage)) mod l, over the domain-tagged static-word `abi.encode` preimage (EVM-native: a contract can recompute it).
 * 2^256 / l is about 42.3, so the reduction is not exactly uniform: about a third of the residues are 43/42 times as likely as the rest. For a Fiat-Shamir
 * challenge that costs about 0.02 bits of min-entropy (the likeliest challenge has probability 43/2^256, about 2^-250.57, against 2^-250.60 for a uniform
 * one), so soundness is unaffected.
 */
export function hashToScalar(preimage: Uint8Array): bigint {
  return bytesToBigInt(keccak_256(preimage)) % L;
}

export const scalarToWire = (v: bigint): string => hex32(assertScalar(v, "scalar"));

/** Strict: 0x + 64 lowercase hex digits AND a value below l. */
export function parseScalarWire(value: unknown, what: string, opts: { nonZero?: boolean } = {}): bigint {
  return assertScalar(parseHex32(value, what), what, opts);
}
