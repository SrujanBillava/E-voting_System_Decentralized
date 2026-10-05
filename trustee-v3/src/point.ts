// BabyJubJub points: strict validation at every trust boundary, and thin arithmetic over the reviewed @zk-kit/baby-jubjub implementation.
// A point received from anybody (a commitment, a verification key, an aggregate half, a partial decryption) must be, in this order:
//   a pair of canonical field elements (0 <= c < p), ON the curve, and inside the PRIME-ORDER subgroup (l*P = identity), and, unless a caller says
//   otherwise, NOT the identity. The curve has cofactor 8: points with a torsion component are on the curve but outside the subgroup, and are refused.
import { addPoint, inCurve, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { hex32, parseHex32 } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { FIELD_PRIME, G, IDENTITY, SUBGROUP_ORDER, type Point } from "./params.ts";
import { isCanonicalScalar } from "./scalar.ts";

export type { Point };
/** Wire form of a point: [x, y] as 0x + 64 lowercase hex digits each. */
export type WirePoint = [string, string];

const copy = (p: Point): [bigint, bigint] => [p[0], p[1]];

export const isCoordinate = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v < FIELD_PRIME;
export const isIdentity = (p: Point): boolean => p[0] === IDENTITY[0] && p[1] === IDENTITY[1];
export const pointsEqual = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

/** A pair of canonical coordinates satisfying the curve equation. Says nothing about the subgroup. */
export function isOnCurve(p: unknown): p is Point {
  if (!Array.isArray(p) || p.length !== 2 || !isCoordinate(p[0]) || !isCoordinate(p[1])) return false;
  return inCurve([p[0], p[1]]);
}

/** a + b. Inputs must already be validated points (the addition law is complete on the curve). */
export function add(a: Point, b: Point): Point {
  return addPoint(copy(a), copy(b));
}
export const neg = (p: Point): Point => [(FIELD_PRIME - p[0]) % FIELD_PRIME, p[1]];
export const sub = (a: Point, b: Point): Point => add(a, neg(b));

/** k * p. The scalar MUST be reduced mod l: a non-reduced scalar is the signature of arithmetic done in the wrong modulus, so it is an error, not a silent reduction. */
export function mul(p: Point, k: bigint): Point {
  if (!isCanonicalScalar(k)) throw new InvalidInputError("BAD_SCALAR", "point multiplication needs a scalar reduced mod l");
  if (k === 0n) return [IDENTITY[0], IDENTITY[1]];
  return mulPointEscalar(copy(p), k);
}

const SUBGROUP_MEMO = new Map<string, boolean>();
const SUBGROUP_MEMO_LIMIT = 16384;

/** On the curve and l*P = identity. One scalar multiplication, memoised (the answer is a pure function of the point). */
export function isInSubgroup(p: unknown): p is Point {
  if (!isOnCurve(p)) return false;
  const key = `${p[0]}:${p[1]}`;
  const known = SUBGROUP_MEMO.get(key);
  if (known !== undefined) return known;
  const result = isIdentity(mulPointEscalar(copy(p), SUBGROUP_ORDER));
  if (SUBGROUP_MEMO.size >= SUBGROUP_MEMO_LIMIT) SUBGROUP_MEMO.clear();
  SUBGROUP_MEMO.set(key, result);
  return result;
}

export interface PointOptions {
  /** the identity is a valid value here (default: refused) */
  allowIdentity?: boolean;
}

/** Validates a received point and returns it (as a fresh tuple). Throws InvalidInputError with a reason; the message never contains the coordinates. */
export function parsePoint(value: unknown, what: string, opts: PointOptions = {}): Point {
  if (!Array.isArray(value) || value.length !== 2) throw new InvalidInputError("BAD_POINT", `${what} must be a pair [x, y]`);
  if (!isCoordinate(value[0]) || !isCoordinate(value[1])) throw new InvalidInputError("BAD_POINT", `${what} has a non-canonical coordinate`);
  if (!isOnCurve(value)) throw new InvalidInputError("BAD_POINT", `${what} is not on the curve`);
  if (!isInSubgroup(value)) throw new InvalidInputError("BAD_POINT", `${what} is not in the prime-order subgroup`);
  const point: Point = [value[0], value[1]];
  if (isIdentity(point) && !opts.allowIdentity) throw new InvalidInputError("IDENTITY_POINT", `${what} must not be the identity`);
  return point;
}

export function isValidPoint(value: unknown, opts: PointOptions = {}): value is Point {
  try {
    parsePoint(value, "point", opts);
    return true;
  } catch {
    return false;
  }
}

export const pointToWire = (p: Point): WirePoint => [hex32(p[0]), hex32(p[1])];

/** Strict wire parsing (exact hex form) followed by full point validation. */
export function parsePointWire(value: unknown, what: string, opts: PointOptions = {}): Point {
  if (!Array.isArray(value) || value.length !== 2) throw new InvalidInputError("BAD_POINT", `${what} must be a pair of hex strings`);
  return parsePoint([parseHex32(value[0], `${what}.x`), parseHex32(value[1], `${what}.y`)], what, opts);
}

/** The public generator, re-exported for convenience. */
export { G, IDENTITY };
