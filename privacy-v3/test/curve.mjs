// Test helpers for BabyJubJub points that are NOT in the prime-order subgroup (the full curve has order 8*l; its torsion subgroup E[8] has 8 elements).
import { FIELD_PRIME as P, SUBGROUP_ORDER } from "../src/params.js";
import { isIdentity, mul } from "../src/elgamal.js";

const A = 168700n; // twisted Edwards a
const D = 168696n; // twisted Edwards d (a non-square: the addition law is complete)
const mod = (v) => ((v % P) + P) % P;

export function modPow(b, e, m = P) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** Tonelli-Shanks: a square root of n mod p, or null. */
export function modSqrt(n, p = P) {
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
  let m = s, c = modPow(z, q, p), t = modPow(n, q, p), r = modPow(n, (q + 1n) / 2n, p);
  while (t !== 1n) {
    let i = 0n, tt = t;
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

/** Points ON the curve (both y roots) for x = 1..limit: y^2 = (1 - a x^2) / (1 - d x^2). Mostly NOT in the prime-order subgroup (only 1 in 8 is). */
export function curvePoints(limit = 300) {
  const out = [];
  for (let x = 1n; x <= BigInt(limit); x++) {
    const y = modSqrt(mod(1n - A * x * x) * modPow(mod(1n - D * x * x), P - 2n) % P);
    if (y !== null) out.push([x, y], [x, mod(P - y)]);
  }
  return out;
}

/** order of a torsion point (1, 2, 4 or 8) */
export function torsionOrder(t) {
  for (const k of [1n, 2n, 4n, 8n]) if (isIdentity(mul(t, k))) return Number(k);
  throw new Error("not a torsion point");
}

/**
 * The whole torsion subgroup E[8], found as l*P for curve points P (multiplying by the odd subgroup order l kills the prime-order part and
 * leaves the torsion part; the map is onto E[8]). Returns 8 points; the caller can check the order profile 1,2,4,4,8,8,8,8.
 */
export function torsionSubgroup() {
  const seen = new Map();
  for (const point of curvePoints(400)) {
    const t = mul(point, SUBGROUP_ORDER);
    seen.set(`${t[0]}:${t[1]}`, t);
    if (seen.size === 8) break;
  }
  return [...seen.values()];
}
