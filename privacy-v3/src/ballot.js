// Ballot construction: one-hot vector, per-slot encryption, ballot hash and the validity-circuit input/public signals.
import { poseidon5 } from "poseidon-lite";
import { identityCiphertext, encrypt, randomScalar } from "./elgamal.js";
import { DOMAIN_BALLOT, K_MAX } from "./params.js";

/** [0,..,1,..,0] of length K_MAX with the 1 at `choice` (0-based, choice < kc). */
export function oneHot(choice, kc) {
  if (!Number.isInteger(kc) || kc < 1 || kc > K_MAX) throw new RangeError(`kc must be an integer in 1..${K_MAX}`);
  if (!Number.isInteger(choice) || choice < 0 || choice >= kc) throw new RangeError(`choice must be an integer in 0..${kc - 1}`);
  return Array.from({ length: K_MAX }, (_, j) => (j === choice ? 1n : 0n));
}

/**
 * Encrypts a K_MAX-long vector. Real slots (j < kc) get fresh independent randomness; padded slots are the canonical identity pair
 * (their witness randomness is a dummy 1 that the circuit ignores).
 * `m` may contain ANY values here, including invalid ones: this function is also how the negative tests build malicious witnesses.
 * `H` must already have been validated by the caller (prepareBallot does, via assertValidPublicKey). Randomness always comes from randomScalar().
 */
export function encryptVector({ H, kc, m }) {
  const ciphertexts = [];
  const r = [];
  for (let j = 0; j < K_MAX; j++) {
    if (j < kc) {
      const rj = randomScalar();
      r.push(rj);
      ciphertexts.push(encrypt(H, m[j], rj));
    } else {
      r.push(1n);
      ciphertexts.push(identityCiphertext());
    }
  }
  return { ciphertexts, r };
}

/** Poseidon chain over (domain, chainId, contract, electionId, constituencyId) and then every ciphertext coordinate, slot by slot. Mirrors the circuit. */
export function ballotHash(ctx, constituencyId, ciphertexts) {
  if (ciphertexts.length !== K_MAX) throw new RangeError(`expected ${K_MAX} ciphertexts (padded)`);
  let h = poseidon5([DOMAIN_BALLOT, ctx.chainId, ctx.contractAddress, ctx.electionId, constituencyId]);
  for (const { c1, c2 } of ciphertexts) h = poseidon5([h, c1[0], c1[1], c2[0], c2[1]]);
  return h;
}

/** Expand the kc real ciphertexts a voter sends to the K_MAX-slot form the circuit and the ballot hash use. */
export function padCiphertexts(real) {
  return [...real, ...Array.from({ length: K_MAX - real.length }, identityCiphertext)];
}

const str = (v) => v.toString();

/** The public part of the validity statement, in the order snarkjs reports public signals: [ballotHash, ...public inputs]. */
export function validityPublicSignals({ ctx, constituencyId, kc, H, nullifier, ciphertexts, hash }) {
  return [
    hash,
    ctx.chainId,
    ctx.contractAddress,
    ctx.electionId,
    constituencyId,
    BigInt(kc),
    H[0],
    H[1],
    nullifier,
    ...ciphertexts.map((c) => c.c1[0]),
    ...ciphertexts.map((c) => c.c1[1]),
    ...ciphertexts.map((c) => c.c2[0]),
    ...ciphertexts.map((c) => c.c2[1]),
  ].map(str);
}

/** Full circuit input (public + private), named exactly like the signals of circuits/ballot_validity.circom. */
export function validityCircuitInput({ ctx, constituencyId, kc, H, nullifier, ciphertexts, m, r }) {
  return {
    chainId: str(ctx.chainId),
    contractAddress: str(ctx.contractAddress),
    electionId: str(ctx.electionId),
    constituencyId: str(constituencyId),
    kc: str(kc),
    H: [str(H[0]), str(H[1])],
    nullifier: str(nullifier),
    C1x: ciphertexts.map((c) => str(c.c1[0])),
    C1y: ciphertexts.map((c) => str(c.c1[1])),
    C2x: ciphertexts.map((c) => str(c.c2[0])),
    C2y: ciphertexts.map((c) => str(c.c2[1])),
    m: m.map(str),
    r: r.map(str),
  };
}
