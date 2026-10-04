// The voter side ("client"): builds one anonymous, encrypted, proven ballot. Everything secret (identity, choice, randomness) stays in here.
import { ballotHash, encryptVector, oneHot, padCiphertexts, validityCircuitInput, validityPublicSignals } from "./ballot.js";
import { assertValidPublicKey } from "./elgamal.js";
import { constituencyField, electionScope, K_MAX } from "./params.js";
import { nullifierOf, proveMembership } from "./semaphore.js";
import { proveValidity } from "./validity.js";

const pointToStrings = (p) => [p[0].toString(), p[1].toString()];
export const serializeCiphertext = (ct) => ({ c1: pointToStrings(ct.c1), c2: pointToStrings(ct.c2) });

/**
 * Everything a voter computes locally before any proof: the secret one-hot vector, the encryption (with its secret randomness),
 * the nullifier and the ballot hash that will be signed as the Semaphore message. Exposed separately so tests can compose attacks.
 */
export function prepareBallot({ identity, ctx, constituency, kc, choice, H, m: forcedVector }) {
  assertValidPublicKey(H); // never encrypt a vote under a key that is off-curve, the identity or has a torsion component (one scalar multiplication, not part of encryptMs)
  const constituencyId = constituencyField(constituency);
  const scope = electionScope(ctx);
  const nullifier = nullifierOf(identity, scope);
  const t = performance.now();
  const m = forcedVector ?? oneHot(choice, kc); // forcedVector exists ONLY so tests can build malicious (invalid) ballots
  const { ciphertexts, r } = encryptVector({ H, kc, m });
  const hash = ballotHash(ctx, constituencyId, ciphertexts);
  return { constituency, constituencyId, kc, H, scope, nullifier, m, r, ciphertexts, hash, encryptMs: performance.now() - t };
}

/** Wire format of the part of a ballot that is public: only the kc real slots travel. */
export const wireCiphertexts = (ciphertexts, kc) => ciphertexts.slice(0, kc).map(serializeCiphertext);

/**
 * @param {object} p
 * @param {import("@semaphore-protocol/identity").Identity} p.identity   the voter's Semaphore identity
 * @param {import("@semaphore-protocol/group").Group} p.group             the constituency group (public membership list)
 * @param {{chainId:bigint, contractAddress:bigint, electionId:bigint}} p.ctx
 * @param {string} p.constituency  e.g. "KA-BLR"
 * @param {number} p.kc            number of candidates of that constituency (public election data)
 * @param {number} p.choice        0-based candidate index (SECRET)
 * @param {bigint[]} p.H           election public key
 * @returns the wire submission (JSON-safe: decimal strings only) plus timings
 */
export async function castBallot({ identity, group, ctx, constituency, kc, choice, H }) {
  const ballot = prepareBallot({ identity, ctx, constituency, kc, choice, H });
  const { constituencyId, scope, nullifier, m, r, ciphertexts, hash } = ballot;

  let t = performance.now();
  const semaphore = await proveMembership({ identity, group, message: hash, scope });
  const semaphoreProveMs = performance.now() - t;

  const validity = await proveValidity(validityCircuitInput({ ctx, constituencyId, kc, H, nullifier, ciphertexts, m, r }));
  const expected = validityPublicSignals({ ctx, constituencyId, kc, H, nullifier, ciphertexts, hash });
  if (JSON.stringify(validity.publicSignals) !== JSON.stringify(expected)) throw new Error("validity proof public signals differ from the expected statement");

  return {
    submission: {
      constituency,
      ciphertexts: wireCiphertexts(ciphertexts, kc), // padding is canonical and re-added by the verifier
      semaphore,
      validity: { proof: validity.proof },
    },
    timings: { encryptMs: ballot.encryptMs, semaphoreProveMs, validityWitnessMs: validity.timings.witnessMs, validityProveMs: validity.timings.proveMs },
    internals: ballot,
  };
}

export { K_MAX, padCiphertexts };
