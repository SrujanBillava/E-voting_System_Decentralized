// Shared constants of the isolated Privacy V3 core prototype.
import { Base8, r as FIELD_PRIME, subOrder as SUBGROUP_ORDER } from "@zk-kit/baby-jubjub";
import { AbiCoder, id as keccakOfText, keccak256, toBeHex } from "ethers";

export { FIELD_PRIME, SUBGROUP_ORDER };

/** BN254 BASE field modulus q: the range of Groth16 proof point coordinates (the scalar field FIELD_PRIME is the range of circuit signals). */
export const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** Maximum candidates per constituency supported by the circuit (the circuit is compiled for exactly this many slots). */
export const K_MAX = 16;

/** G: the generator of the prime-order BabyJubJub subgroup (circomlib "Base8"). Public keys, ciphertexts and the Semaphore identities live in this group. */
export const G = Object.freeze([...Base8]);
/** The neutral element of the twisted Edwards curve. Also the canonical "padding" ciphertext half. */
export const IDENTITY = Object.freeze([0n, 1n]);

/** Ciphertext coordinates per slot, in this order: C1.x, C1.y, C2.x, C2.y. */
export const COORDS_PER_SLOT = 4;
/** All coordinates of a ballot: K_MAX slots x 4 = 64, padded slots included. */
export const COORD_COUNT = K_MAX * COORDS_PER_SLOT;

// ------------------------------------------------------------------------------------------------------------------------------------------
// FROZEN ENCODINGS (see ENCODINGS.md; known-answer vectors in spec/vectors.json). abi.encode ONLY, never abi.encodePacked.
// ------------------------------------------------------------------------------------------------------------------------------------------

/** bytes32 tags: keccak256 of the UTF-8 labels. */
export const SCOPE_TAG = keccakOfText("VOTECHAIN-V3-SCOPE-1");
export const BALLOT_TAG = keccakOfText("VOTECHAIN-V3-BALLOT-1");

/** abi.encode(bytes32 SCOPE_TAG, uint256 chainId, address contractAddress, bytes32 electionId) */
export const SCOPE_ABI_TYPES = Object.freeze(["bytes32", "uint256", "address", "bytes32"]);
/** abi.encode(bytes32 BALLOT_TAG, uint256 chainId, address contractAddress, bytes32 electionId, bytes32 constituencyId, uint256[64] coords): a STATIC uint256[64], never a dynamic uint256[] */
export const BALLOT_HASH_ABI_TYPES = Object.freeze(["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256[64]"]);

/** The Semaphore tree depth every proof is generated and verified at (frozen architecture). Smaller depths are only used by fast tests. */
export const SEMAPHORE_DEPTH = 20;

/** V2 convention: constituencyId = keccak256(utf8(code)), a bytes32. */
export const constituencyIdOf = (code) => keccakOfText(code);

/** The same bytes32 as a uint256 value (what the ballot hash encodes). */
export const constituencyIdValue = (code) => BigInt(constituencyIdOf(code));

/**
 * FIXED TEST CONSTANTS. The values mirror the frozen V2 local demo deployment but nothing is read from V2 and nothing here is a secret.
 * chainId / contractAddress / electionId are the "election context" that every ballot hash and scope is bound to.
 * electionId is the FULL bytes32 (as a uint256 value), exactly as the contract holds it.
 */
export const TEST_CONTEXT = Object.freeze({
  chainId: 31337n,
  contractAddress: 0x5fbdb2315678afecb367f032d93f642f64180aa3n,
  electionId: BigInt("0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40"),
});

/**
 * The frozen Semaphore scope of an election: ONE scope for the whole election (not per constituency), so one identity can produce exactly one
 * nullifier per election.
 *
 *   SCOPE = uint256( keccak256( abi.encode( bytes32 SCOPE_TAG, uint256 chainId, address contractAddress, bytes32 electionId ) ) )
 *
 * The FULL 256-bit value is handed to Semaphore unchanged: no truncation here, no Poseidon. Semaphore V4 itself hashes the scope again
 * (keccak256 >> 8) before it enters its circuit, exactly as its verifier does.
 */
export const electionScope = (ctx) =>
  BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(SCOPE_ABI_TYPES, [SCOPE_TAG, ctx.chainId, toBeHex(ctx.contractAddress, 20), toBeHex(ctx.electionId, 32)])));
