// Shared constants of the isolated Privacy V3 core prototype.
import { Base8, r as FIELD_PRIME, subOrder as SUBGROUP_ORDER } from "@zk-kit/baby-jubjub";
import { id as keccakOfText } from "ethers";
import { poseidon4 } from "poseidon-lite";

export { FIELD_PRIME, SUBGROUP_ORDER };

/** BN254 BASE field modulus q: the range of Groth16 proof point coordinates (the scalar field FIELD_PRIME is the range of circuit signals). */
export const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** Maximum candidates per constituency supported by the circuit (the circuit is compiled for exactly this many slots). */
export const K_MAX = 16;

/** G: the generator of the prime-order BabyJubJub subgroup (circomlib "Base8"). Public keys, ciphertexts and the Semaphore identities live in this group. */
export const G = Object.freeze([...Base8]);
/** The neutral element of the twisted Edwards curve. Also the canonical "padding" ciphertext half. */
export const IDENTITY = Object.freeze([0n, 1n]);

const asciiToBigInt = (text) => BigInt("0x" + Buffer.from(text, "ascii").toString("hex"));

/**
 * Domain tag of the ballot hash: a bytes32 constant, keccak256("VOTECHAIN-V3-BALLOT-1"). PROTOTYPE VALUE: the real tag is fixed when the V3 contract is written.
 * (The Semaphore scope below still uses its own Poseidon-based tag; see README, "Known differences from the frozen architecture".)
 */
export const BALLOT_TAG = keccakOfText("VOTECHAIN-V3-BALLOT-1");
export const DOMAIN_SCOPE = asciiToBigInt("VOTECHAIN-V3-SCOPE-1");

/** The Semaphore tree depth every proof is generated and verified at (frozen architecture). Smaller depths are only used by fast tests. */
export const SEMAPHORE_DEPTH = 20;

/** bytes32 -> BN254 field element by dropping the lowest 8 bits (the reduction Semaphore uses for keccak digests): injective on the top 248 bits. Used by the scope only. */
export const bytes32ToField = (hex) => BigInt(hex) >> 8n;

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
 * The Semaphore scope of an election: ONE scope for the whole election (not per constituency), so one identity can produce
 * exactly one nullifier per election. Semaphore itself hashes the scope again (keccak >> 8) before it enters its circuit.
 */
export const electionScope = (ctx) => poseidon4([DOMAIN_SCOPE, ctx.chainId, ctx.contractAddress, ctx.electionId >> 8n]);
