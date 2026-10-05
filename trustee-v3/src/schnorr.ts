// Schnorr proof of knowledge of a discrete logarithm: "I know a such that K = a*G". Every DKG trustee proves this for EVERY published polynomial
// coefficient commitment, which is what stops a rogue-key attack (publishing a commitment that is a function of the others without knowing its logarithm).
//
//   prover:   u <- random nonce;  R = u*G;  e = H(DKG_TAG, context, ceremony, trustee, coefficient, K, R);  z = u + e*a  (mod l)       proof = (e, z)
//   H(x) = uint256(keccak256(abi.encode(x))) mod l: see hashToScalar in scalar.ts
//   verifier: R' = z*G - e*K;  accept iff e == H(..., K, R')
//
// The challenge binds the domain tag, the election context (chain id, contract, election id), the ceremony id, the trustee index, the coefficient index,
// the public commitment K and the Schnorr commitment R, so a proof cannot be replayed into another election, ceremony, trustee slot or coefficient slot.
import { assertContext, contextWords } from "./context.ts";
import { assertInteger, encodeWords } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { DKG_TAG, type ElectionContext, type Point } from "./params.ts";
import { assertProof, type Proof } from "./proof.ts";
import { G, mul, parsePoint, sub } from "./point.ts";
import { add as sAdd, assertScalar, hashToScalar, mul as sMul, randomScalar } from "./scalar.ts";

export interface PokBinding {
  readonly context: ElectionContext;
  readonly ceremonyId: bigint;
  readonly trusteeIndex: number;
  readonly coefficientIndex: number;
}

function assertBinding(b: PokBinding): void {
  assertContext(b.context);
  if (typeof b.ceremonyId !== "bigint" || b.ceremonyId <= 0n || b.ceremonyId >= 1n << 256n) throw new InvalidInputError("BAD_CEREMONY_ID", "ceremony id must be a non-zero uint256");
  assertInteger(b.trusteeIndex, 1, 255, "trustee index");
  assertInteger(b.coefficientIndex, 0, 255, "coefficient index");
}

export function pokChallenge(b: PokBinding, commitment: Point, nonceCommitment: Point): bigint {
  return hashToScalar(
    encodeWords([DKG_TAG, ...contextWords(b.context), b.ceremonyId, BigInt(b.trusteeIndex), BigInt(b.coefficientIndex), commitment[0], commitment[1], nonceCommitment[0], nonceCommitment[1]]),
  );
}

/** Deterministic core, exposed for known-answer tests and for building adversarial proofs. Production code calls proveKnowledge, which draws the nonce itself. */
export function proveKnowledgeWithNonce(b: PokBinding, secret: bigint, nonce: bigint): Proof {
  assertBinding(b);
  assertScalar(secret, "secret", { nonZero: true });
  assertScalar(nonce, "nonce", { nonZero: true });
  const commitment = mul(G, secret);
  const e = pokChallenge(b, commitment, mul(G, nonce));
  const z = sAdd(nonce, sMul(e, secret));
  if (e === 0n || z === 0n) throw new InvalidInputError("DEGENERATE_PROOF", "this nonce yields a zero challenge or response; draw another");
  return { e, z };
}

export function proveKnowledge(b: PokBinding, secret: bigint): Proof {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return proveKnowledgeWithNonce(b, secret, randomScalar());
    } catch (error) {
      if (!(error instanceof InvalidInputError) || error.code !== "DEGENERATE_PROOF") throw error;
    }
  }
  throw new InvalidInputError("DEGENERATE_PROOF", "no usable nonce found");
}

/** Never throws: a malformed commitment, a malformed or non-canonical proof, or a wrong binding is simply "not proven". */
export function verifyKnowledge(b: PokBinding, commitment: unknown, proof: unknown): boolean {
  try {
    assertBinding(b);
    const K = parsePoint(commitment, "commitment"); // canonical, on the curve, in the prime-order subgroup, not the identity
    const { e, z } = assertProof(proof);
    const R = sub(mul(G, z), mul(K, e));
    return pokChallenge(b, K, R) === e;
  } catch {
    return false;
  }
}
