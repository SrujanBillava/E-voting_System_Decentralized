// TEST SUPPORT ONLY. BabyJubJub has cofactor 8: the full curve has 8*l points and a torsion subgroup E[8] of 8 elements. These helpers produce points that are
// ON the curve but NOT in the prime-order subgroup, which every validator in the toolkit must refuse.
import { FIELD_PRIME as P, SUBGROUP_ORDER, type Point } from "../src/params.ts";
import { add, isIdentity, isOnCurve, mul as pointMul } from "../src/point.ts";
import { mulPointEscalar } from "@zk-kit/baby-jubjub";

const A = 168700n; // twisted Edwards a
const D = 168696n; // twisted Edwards d
const mod = (v: bigint): bigint => ((v % P) + P) % P;

export function modPow(b: bigint, e: bigint, m: bigint = P): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** Tonelli-Shanks. */
export function modSqrt(n: bigint, p: bigint = P): bigint | null {
  n = mod(n);
  if (n === 0n) return 0n;
  if (modPow(n, (p - 1n) / 2n, p) !== 1n) return null;
  let q = p - 1n;
  let s = 0n;
  while ((q & 1n) === 0n) {
    q >>= 1n;
    s++;
  }
  let z = 2n;
  while (modPow(z, (p - 1n) / 2n, p) !== p - 1n) z++;
  let m = s;
  let c = modPow(z, q, p);
  let t = modPow(n, q, p);
  let r = modPow(n, (q + 1n) / 2n, p);
  while (t !== 1n) {
    let i = 0n;
    let tt = t;
    while (tt !== 1n) {
      tt = (tt * tt) % p;
      i++;
    }
    const b = modPow(c, 1n << (m - i - 1n), p);
    m = i;
    c = (b * b) % p;
    t = (t * c) % p;
    r = (r * b) % p;
  }
  return r;
}

/** Curve points for x = 1..limit (both y roots): y^2 = (1 - a x^2) / (1 - d x^2). Only about 1 in 8 lies in the prime-order subgroup. */
export function curvePoints(limit = 300): Point[] {
  const out: Point[] = [];
  for (let x = 1n; x <= BigInt(limit); x++) {
    const y = modSqrt((mod(1n - A * x * x) * modPow(mod(1n - D * x * x), P - 2n)) % P);
    if (y !== null) out.push([x, y], [x, mod(P - y)]);
  }
  return out;
}

/** The torsion subgroup E[8] (8 points, orders 1,2,4,4,8,8,8,8), found as l*Q for curve points Q. */
export function torsionSubgroup(): Point[] {
  const seen = new Map<string, Point>();
  for (const point of curvePoints(400)) {
    const t = mulPointEscalar([point[0], point[1]], SUBGROUP_ORDER) as Point;
    seen.set(`${t[0]}:${t[1]}`, t);
    if (seen.size === 8) break;
  }
  return [...seen.values()];
}

export const nonIdentityTorsion = (): Point[] => torsionSubgroup().filter((t) => !isIdentity(t));

export function torsionOrder(t: Point): number {
  for (const k of [1n, 2n, 4n, 8n]) if (isIdentity(mulPointEscalar([t[0], t[1]], k) as Point)) return Number(k);
  throw new Error("not a torsion point");
}

/** a curve point outside the prime-order subgroup that is NOT pure torsion: Q + t for a subgroup point Q and a torsion point t != identity */
export function mixedPoint(subgroupPoint: Point, which = 0): Point {
  const t = nonIdentityTorsion()[which % 7] as Point;
  const mixed = add(subgroupPoint, t);
  if (!isOnCurve(mixed)) throw new Error("not on the curve");
  return mixed;
}

export { pointMul };
