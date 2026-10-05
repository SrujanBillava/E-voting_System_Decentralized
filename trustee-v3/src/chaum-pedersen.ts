// Chaum-Pedersen proof that a partial decryption D = s_i * A used the SAME secret share s_i as the trustee's published verification key vk_i = s_i * G:
//   log_G(vk_i) == log_A(D)
//
//   prover:   u <- random nonce;  a = u*G;  b = u*A;  e = H(PDEC_TAG, context, constituency, slot, trustee, vk, A, D, a, b);  z = u + e*s_i  (mod l)   proof = (e, z)
//   H(x) = uint256(keccak256(abi.encode(x))) mod l: see hashToScalar in scalar.ts
//   verifier: a' = z*G - e*vk;  b' = z*A - e*D;  accept iff e == H(..., a', b')
//
// The challenge binds the domain tag, the election context, the constituency, the candidate slot, the trustee index, vk, A, D and both commitments, so a
// proof cannot be moved to another slot, constituency, election, trustee or aggregate. This is only meaningful for A != identity (every point must also
// be in the prime-order subgroup): both are enforced by the verifier AND by the prover.
import { assertContext, contextWords } from "./context.ts";
import { assertInteger, encodeWords } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { PDEC_TAG, type ElectionContext, type Point } from "./params.ts";
import { assertProof, type Proof } from "./proof.ts";
import { G, mul, parsePoint, sub } from "./point.ts";
import { add as sAdd, assertScalar, hashToScalar, mul as sMul, randomScalar } from "./scalar.ts";

export interface DecryptionBinding {
  readonly context: ElectionContext;
  readonly constituencyId: bigint; // bytes32 as a number
  readonly slot: number; // candidate slot
  readonly trusteeIndex: number;
}

function assertBinding(b: DecryptionBinding): void {
  assertContext(b.context);
  if (typeof b.constituencyId !== "bigint" || b.constituencyId <= 0n || b.constituencyId >= 1n << 256n) throw new InvalidInputError("BAD_CONSTITUENCY", "constituency id must be a non-zero bytes32");
  assertInteger(b.slot, 0, 15, "candidate slot");
  assertInteger(b.trusteeIndex, 1, 255, "trustee index");
}

export function decryptionChallenge(b: DecryptionBinding, vk: Point, A: Point, D: Point, a: Point, bPoint: Point): bigint {
  return hashToScalar(
    encodeWords([
      PDEC_TAG,
      ...contextWords(b.context),
      b.constituencyId,
      BigInt(b.slot),
      BigInt(b.trusteeIndex),
      vk[0], vk[1],
      A[0], A[1],
      D[0], D[1],
      a[0], a[1],
      bPoint[0], bPoint[1],
    ]),
  );
}

/** Deterministic core for known-answer tests and adversarial proofs: D = secret * A with the given nonce. */
export function proveDecryptionShareWithNonce(b: DecryptionBinding, secret: bigint, aggregateA: Point, nonce: bigint): { D: Point; proof: Proof } {
  assertBinding(b);
  assertScalar(secret, "secret share", { nonZero: true });
  assertScalar(nonce, "nonce", { nonZero: true });
  const A = parsePoint(aggregateA, "A"); // subgroup, non-identity
  const vk = mul(G, secret);
  const D = mul(A, secret);
  const e = decryptionChallenge(b, vk, A, D, mul(G, nonce), mul(A, nonce));
  const z = sAdd(nonce, sMul(e, secret));
  if (e === 0n || z === 0n) throw new InvalidInputError("DEGENERATE_PROOF", "this nonce yields a zero challenge or response; draw another");
  return { D, proof: { e, z } };
}

export function proveDecryptionShare(b: DecryptionBinding, secret: bigint, aggregateA: Point): { D: Point; proof: Proof } {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return proveDecryptionShareWithNonce(b, secret, aggregateA, randomScalar());
    } catch (error) {
      if (!(error instanceof InvalidInputError) || error.code !== "DEGENERATE_PROOF") throw error;
    }
  }
  throw new InvalidInputError("DEGENERATE_PROOF", "no usable nonce found");
}

/** Never throws: malformed or torsion/identity points, non-canonical scalars, a wrong binding or a wrong statement are all "not proven". */
export function verifyDecryptionShare(b: DecryptionBinding, verificationKey: unknown, aggregateA: unknown, partial: unknown, proof: unknown): boolean {
  try {
    assertBinding(b);
    const vk = parsePoint(verificationKey, "verification key");
    const A = parsePoint(aggregateA, "A");
    const D = parsePoint(partial, "partial decryption");
    const { e, z } = assertProof(proof);
    const a = sub(mul(G, z), mul(vk, e));
    const bPoint = sub(mul(A, z), mul(D, e));
    return decryptionChallenge(b, vk, A, D, a, bPoint) === e;
  } catch {
    return false;
  }
}
