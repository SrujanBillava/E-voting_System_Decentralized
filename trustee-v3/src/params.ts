// Frozen cryptographic parameters of the trustee toolkit. The curve is the BabyJubJub system already validated in privacy-v3
// (the same @zk-kit/baby-jubjub implementation, the same generator, the same subgroup order); nothing here is chosen freshly.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { Base8, r as FIELD, subOrder as ORDER } from "@zk-kit/baby-jubjub";

/**
 * p = the BN254 scalar field = the field the BabyJubJub COORDINATES live in.
 * It is NEVER a modulus for secret scalars, DKG coefficients, shares, Lagrange coefficients, challenges or proof responses: those are all mod ORDER.
 * Only point.ts may import this name (enforced by test/hygiene.test.ts).
 */
export const FIELD_PRIME: bigint = FIELD;

/** l = the order of the prime-order BabyJubJub subgroup. EVERY scalar in this toolkit is reduced mod l (and nothing else). */
export const SUBGROUP_ORDER: bigint = ORDER;

export type Point = readonly [bigint, bigint];

/** G: the generator of the prime-order subgroup (circomlib "Base8"), the same G privacy-v3 encrypts with. */
export const G: Point = Object.freeze([Base8[0], Base8[1]] as const);
/** The neutral element of the twisted Edwards curve. */
export const IDENTITY: Point = Object.freeze([0n, 1n] as const);

/** Frozen architecture: 3 trustees, threshold 2 (any 2 decrypt, 1 alone learns nothing). The code is generic in (n, t); the transcript pins them. */
export const DEFAULT_TRUSTEES = 3;
export const DEFAULT_THRESHOLD = 2;
export const MAX_TRUSTEES = 9;

/** privacy-v3 K_MAX: at most 16 candidate slots per constituency. */
export const MAX_SLOTS = 16;
/** A depth-20 Semaphore group holds at most 2^20 commitments, so a constituency never records more ballots than this. */
export const MAX_BALLOT_COUNT = 1 << 20;
/** An aggregate of fewer ballots than this is refused by a Trustee (a 1-ballot "aggregate" IS an individual ballot). Overridable per Trustee. */
export const DEFAULT_MIN_BALLOTS = 2;

const tagOf = (label: string): bigint => BigInt("0x" + bytesToHex(keccak_256(utf8ToBytes(label))));

/** Domain-separation tags: bytes32 = keccak256 of the label, handled as a uint256 word. One tag per use, never shared between uses. */
export const CEREMONY_TAG = tagOf("VOTECHAIN-V3-DKG-CEREMONY-1"); // ceremony id
export const DKG_TAG = tagOf("VOTECHAIN-V3-DKG-1"); // Schnorr proof of knowledge of a polynomial coefficient
export const TRANSCRIPT_TAG = tagOf("VOTECHAIN-V3-DKG-TRANSCRIPT-1"); // transcript hash
export const PDEC_TAG = tagOf("VOTECHAIN-V3-PDEC-1"); // Chaum-Pedersen proof of a partial decryption
export const PDEC_BUNDLE_TAG = tagOf("VOTECHAIN-V3-PDEC-BUNDLE-1"); // one trustee's partial decryption of one constituency, anchored on-chain
export const RESULTS_TAG = tagOf("VOTECHAIN-V3-RESULTS-1"); // a constituency's final result

/** The election context every ceremony and every partial decryption is bound to: the same triple privacy-v3 binds ballots and scopes to. */
export interface ElectionContext {
  readonly chainId: bigint;
  readonly contractAddress: bigint; // uint160 as a number
  readonly electionId: bigint; // bytes32 as a number
}

/**
 * PLACEHOLDER context: the same fixed test constants as privacy-v3 TEST_CONTEXT (chain 31337, the first deployment address, the frozen test election id).
 * Nothing is read from V2, the contract or the chain; the real contract address and election id replace it once they are pinned.
 */
export const TEST_CONTEXT: ElectionContext = Object.freeze({
  chainId: 31337n,
  contractAddress: 0x5fbdb2315678afecb367f032d93f642f64180aa3n,
  electionId: BigInt("0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40"),
});
