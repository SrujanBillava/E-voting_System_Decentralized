// BabyJubJub exponential ElGamal: Enc_H(m; r) = (r*G, m*G + r*H). Additively homomorphic; decryption recovers m*G, then a small discrete log.
import { randomBytes } from "node:crypto";
import { addPoint, inCurve, mulPointEscalar } from "@zk-kit/baby-jubjub";
import { FIELD_PRIME, G, IDENTITY, SUBGROUP_ORDER } from "./params.js";

export const add = (a, b) => addPoint([...a], [...b]);
export const mul = (point, scalar) => mulPointEscalar([...point], BigInt(scalar));
export const neg = ([x, y]) => [(FIELD_PRIME - x) % FIELD_PRIME, y];
export const isIdentity = (p) => p[0] === 0n && p[1] === 1n;
export const pointEquals = (a, b) => a[0] === b[0] && a[1] === b[1];
const pointKey = (p) => `${p[0]}:${p[1]}`;

/**
 * Uniform scalar in [1, l-1] (384 random bits reduced mod l-1: the modulo bias is about 2^-133).
 * THE ONLY SOURCE OF RANDOMNESS in the core: the operating system's CSPRNG through node:crypto. There is deliberately no parameter,
 * option, seed or hook to substitute another source (test/fast.rng.test.mjs enforces that).
 */
export function randomScalar() {
  return (BigInt("0x" + randomBytes(48).toString("hex")) % (SUBGROUP_ORDER - 1n)) + 1n;
}

/**
 * Election key pair. In this prototype the secret is a single TEST key generated in memory and never written anywhere;
 * the real system will use a threshold (DKG) key and no party will ever hold the whole secret.
 */
export function generateTestKeyPair() {
  const secret = randomScalar();
  return { secret, publicKey: mul(G, secret) };
}

/**
 * What every party must check ONCE before trusting an election public key H: a pair of canonical field elements ON the curve, not the
 * identity or any other small-order point, and inside the prime-order subgroup (l*H = identity). The circuit alone does NOT check the
 * subgroup (circomlib's EscalarMulAny assumes it), so this function is the enforcement point. Returns a boolean; see assertValidPublicKey.
 */
export function validatePublicKey(H) {
  if (!Array.isArray(H) || H.length !== 2 || H.some((v) => typeof v !== "bigint" || v < 0n || v >= FIELD_PRIME)) return false;
  if (!inCurve([...H]) || H[0] === 0n) return false;
  return isIdentity(mul(H, SUBGROUP_ORDER));
}

/** Throwing form of validatePublicKey, used at both trust boundaries: the voter before encrypting (prepareBallot) and the ballot box at construction. */
export function assertValidPublicKey(H) {
  if (!validatePublicKey(H)) throw new Error("invalid election public key (must be a non-identity point of the prime-order subgroup)");
}

/**
 * Enc_H(m; r) for a small non-negative integer m: the bare mathematical primitive. The caller supplies r, which MUST be fresh and uniform
 * (randomScalar()); inside the core only encryptVector() calls it, always with randomScalar().
 */
export function encrypt(H, m, r) {
  return { c1: mul(G, r), c2: add(mul(G, BigInt(m)), mul(H, r)) };
}

/** The canonical ciphertext of padded slots (and the neutral element of the homomorphic sum). */
export const identityCiphertext = () => ({ c1: [...IDENTITY], c2: [...IDENTITY] });

export const addCiphertexts = (a, b) => ({ c1: add(a.c1, b.c1), c2: add(a.c2, b.c2) });

/** C2 - s*C1 = m*G for a single ciphertext, or for a homomorphic sum of ciphertexts: the (small) total times G. */
export const decryptToPoint = (secret, ct) => add(ct.c2, neg(mul(ct.c1, secret)));

/**
 * Baby-step giant-step discrete log of t*G for 0 <= t < m*m+m, with m = ceil(sqrt(bound)).
 * Tallies are small (at most the number of voters of a constituency), so a few thousand point additions suffice.
 */
export function makeDiscreteLog(bound = 1n << 20n) {
  const m = BigInt(Math.ceil(Math.sqrt(Number(bound))));
  const table = new Map();
  let p = [...IDENTITY];
  for (let j = 0n; j < m; j++) {
    table.set(pointKey(p), j);
    p = add(p, G);
  }
  const giant = neg(p); // -(m*G)
  return function discreteLog(point) {
    let cur = [...point];
    for (let i = 0n; i <= m; i++) {
      const j = table.get(pointKey(cur));
      if (j !== undefined) return i * m + j;
      cur = add(cur, giant);
    }
    return null; // not a multiple of G below the bound: wrong key, tampered ciphertext or a tally above the bound
  };
}
