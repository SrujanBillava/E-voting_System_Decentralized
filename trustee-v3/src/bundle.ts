// The partial-decryption BUNDLE a trustee anchors on-chain: one per trustee and constituency, a fixed 64-word package (K_MAX = 16 slots x 4 words).
// FROZEN ENCODING (identical to V3Encodings.partialBundleHash in smart-contract-v3):
//   words[4j .. 4j+3] = D.x, D.y, e, z for every ACTIVE slot j < K_c   (D = s_i*A, and (e, z) its Chaum-Pedersen proof, exactly as trustee-v3 produces them)
//   words[4j .. 4j+3] = 0, 0, 0, 0 for every PADDED slot j >= K_c       (the one canonical padding)
//   bundleHash = keccak256(abi.encode(PDEC_BUNDLE_TAG, chainId, contractAddress, electionId, transcriptHash, trusteeIndex, constituencyId, ballotCount, K_c, words))
// All static 32-byte words, so the encoding is unambiguous. The contract computes this hash itself; an auditor recomputes it from the emitted active words.
import { contextWords } from "./context.ts";
import { InvalidInputError } from "./errors.ts";
import { assertInteger, hex32, keccakWords, parseHex32 } from "./encoding.ts";
import { MAX_SLOTS, PDEC_BUNDLE_TAG, type ElectionContext } from "./params.ts";
import type { PartialDecryption } from "./threshold.ts";

export const WORDS_PER_SLOT = 4;
export const BUNDLE_WORDS = MAX_SLOTS * WORDS_PER_SLOT; // 64

export interface BundleHeader {
  readonly context: ElectionContext;
  readonly transcriptHash: bigint;
  readonly trusteeIndex: number;
  readonly constituencyId: bigint;
  readonly ballotCount: number;
  readonly candidateCount: number;
}

const UINT256 = 1n << 256n;

function assertWords(words: readonly bigint[], length: number, what: string): void {
  if (!Array.isArray(words) || words.length !== length || words.some((w) => typeof w !== "bigint" || w < 0n || w >= UINT256)) {
    throw new InvalidInputError("BAD_BUNDLE", `${what} must be ${length} uint256 words`);
  }
}

/** The 64-word bundle from the ACTIVE words (4 per candidate slot): the padded slots are zero. */
export function padBundle(activeWords: readonly bigint[], candidateCount: number): bigint[] {
  assertInteger(candidateCount, 1, MAX_SLOTS, "candidate count");
  assertWords(activeWords, candidateCount * WORDS_PER_SLOT, "the active words of a bundle");
  return [...activeWords, ...Array.from({ length: BUNDLE_WORDS - activeWords.length }, () => 0n)];
}

/** The ACTIVE words (what the contract emits) of a 64-word bundle; refuses a bundle whose padding is not canonical. */
export function activeWordsOf(words: readonly bigint[], candidateCount: number): bigint[] {
  assertWords(words, BUNDLE_WORDS, "a bundle");
  assertInteger(candidateCount, 1, MAX_SLOTS, "candidate count");
  const active = candidateCount * WORDS_PER_SLOT;
  if (words.slice(active).some((w) => w !== 0n)) throw new InvalidInputError("NON_CANONICAL_PADDING", "every padded slot of a bundle must be four zero words");
  return words.slice(0, active);
}

/** A trustee's partial decryption (wire form, one entry per active slot, in slot order) as the 64-word bundle. */
export function bundleFromPartial(partial: PartialDecryption, candidateCount: number): bigint[] {
  assertInteger(candidateCount, 1, MAX_SLOTS, "candidate count");
  if (partial.slots.length !== candidateCount) throw new InvalidInputError("BAD_BUNDLE", "a partial decryption needs exactly one entry per candidate slot");
  const words: bigint[] = [];
  partial.slots.forEach((slot, j) => {
    if (slot.slot !== j) throw new InvalidInputError("BAD_BUNDLE", "slots must be listed in order");
    words.push(parseHex32(slot.D[0], "D.x"), parseHex32(slot.D[1], "D.y"), parseHex32(slot.proof.e, "e"), parseHex32(slot.proof.z, "z"));
  });
  return padBundle(words, candidateCount);
}

/** The inverse, from the active words an auditor reads out of the PartialDecryptionPublished event. Nothing is validated here: the proofs are verified separately. */
export function partialFromBundle(args: { trusteeIndex: number; constituencyId: bigint; activeWords: readonly bigint[]; candidateCount: number }): PartialDecryption {
  assertWords(args.activeWords, args.candidateCount * WORDS_PER_SLOT, "the active words of a bundle");
  const slots: PartialDecryption["slots"] = [];
  for (let j = 0; j < args.candidateCount; j++) {
    const [x, y, e, z] = args.activeWords.slice(j * WORDS_PER_SLOT, (j + 1) * WORDS_PER_SLOT) as [bigint, bigint, bigint, bigint];
    slots.push({ slot: j, D: [hex32(x), hex32(y)], proof: { e: hex32(e), z: hex32(z) } });
  }
  return { trusteeIndex: args.trusteeIndex, constituencyId: hex32(args.constituencyId), slots };
}

/** keccak256(abi.encode(PDEC_BUNDLE_TAG, chainId, contract, electionId, transcriptHash, trusteeIndex, constituencyId, ballotCount, K_c, words[64])) as a uint256. */
export function bundleHash(header: BundleHeader, words: readonly bigint[]): bigint {
  assertWords(words, BUNDLE_WORDS, "a bundle");
  assertInteger(header.trusteeIndex, 1, 255, "trustee index");
  assertInteger(header.candidateCount, 1, MAX_SLOTS, "candidate count");
  assertInteger(header.ballotCount, 0, 1 << 20, "ballot count");
  return keccakWords([PDEC_BUNDLE_TAG, ...contextWords(header.context), header.transcriptHash, BigInt(header.trusteeIndex), header.constituencyId, BigInt(header.ballotCount), BigInt(header.candidateCount), ...words]);
}
