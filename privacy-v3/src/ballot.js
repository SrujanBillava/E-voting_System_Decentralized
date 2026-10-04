// Ballot construction: one-hot vector, per-slot encryption, ballot hash and the validity-circuit input/public signals.
import { AbiCoder, keccak256, toBeHex } from "ethers";
import { identityCiphertext, encrypt, randomScalar } from "./elgamal.js";
import { BALLOT_TAG, K_MAX } from "./params.js";

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

/**
 * The 64 ciphertext coordinates in SLOT-MAJOR order, slot 0 first: [C1.x, C1.y, C2.x, C2.y] for each of the K_MAX slots (padded slots included, as
 * the identity pair). This is the order of the validity circuit's public inputs after [nullifier, kc, H.x, H.y] and the order inside the ballot hash.
 */
export function ciphertextCoordinates(ciphertexts) {
  if (ciphertexts.length !== K_MAX) throw new RangeError(`expected ${K_MAX} ciphertexts (padded)`);
  return ciphertexts.flatMap(({ c1, c2 }) => [c1[0], c1[1], c2[0], c2[1]]);
}

/**
 * The frozen ballot hash, used as the Semaphore message. It is computed OUTSIDE the validity circuit, by the voter and independently by the verifier
 * (later the smart contract), and it is a full 256-bit value (Semaphore hashes the message again before it enters its circuit):
 *
 *   ballotHash = uint256( keccak256( abi.encode( bytes32 tag, uint256 chainId, address contract, bytes32 electionId, bytes32 constituencyId, uint256[64] coords ) ) )
 *
 * `coords` are the 64 ciphertext coordinates of ciphertextCoordinates() (static array: 64 consecutive 32-byte words). The types above are the
 * prototype's reading of the frozen text and must be matched exactly by the contract.
 */
export function ballotHash(ctx, constituencyId, ciphertexts) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256[64]"],
    [BALLOT_TAG, ctx.chainId, toBeHex(ctx.contractAddress, 20), toBeHex(ctx.electionId, 32), toBeHex(constituencyId, 32), ciphertextCoordinates(ciphertexts)],
  );
  return BigInt(keccak256(encoded));
}

/** Expand the kc real ciphertexts a voter sends to the K_MAX-slot form the circuit and the ballot hash use. */
export function padCiphertexts(real) {
  return [...real, ...Array.from({ length: K_MAX - real.length }, identityCiphertext)];
}

const str = (v) => v.toString();

/**
 * The 68 public signals of the validity proof, in the order snarkjs reports them: [nullifier, kc, H.x, H.y, ...64 ciphertext coordinates].
 * The verifier builds this itself from ITS OWN election key and candidate count, the nullifier of the Semaphore proof and the received ciphertexts.
 */
export function validityPublicSignals({ kc, H, nullifier, ciphertexts }) {
  return [nullifier, BigInt(kc), H[0], H[1], ...ciphertextCoordinates(ciphertexts)].map(str);
}

/** Full circuit input (public + private), named exactly like the signals of circuits/ballot_validity.circom. */
export function validityCircuitInput({ kc, H, nullifier, ciphertexts, m, r }) {
  return {
    nullifier: str(nullifier),
    kc: str(kc),
    H: [str(H[0]), str(H[1])],
    C: ciphertexts.map((c) => [str(c.c1[0]), str(c.c1[1]), str(c.c2[0]), str(c.c2[1])]),
    m: m.map(str),
    r: r.map(str),
  };
}
