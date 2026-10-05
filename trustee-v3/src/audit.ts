// The PUBLIC AUDITOR of a constituency's tally: everything an outsider can and must check from public data alone, with no secret and no trust in any trustee.
// Pure functions over plain data (the chain adapter in chain/ fetches the data). Chaum-Pedersen proofs are verified HERE, off-chain, as frozen: the contract only
// pins, anchors, restricts and counts endorsements. The full secret s is never reconstructed: partial decryptions are combined as curve POINTS.
//
//   1-5   the pinned transcript hashes to the pinned hash, has {n: 3, t: 2}, and contains the contract's H and vk_1..vk_3
//   6-7   the aggregate rebuilt from ALL BallotRecorded events equals the contract's aggregate and ballot count (verifyChainAggregate)
//   8-12  every publication: its bundle hash recomputed from the emitted words equals the emitted AND the stored hash; its Chaum-Pedersen proofs verify;
//         duplicate trustee indices are refused; at least 2 valid trustees are required
//   13-17 any 2 valid partials combine (Lagrange, on points) and BSGS recovers every total within [0, ballotCount], each confirmed by t*G, summing to ballotCount
import { type VerifiedAggregate, type BallotLogEntry, type ContractConstituencyState, verifyChainAggregate } from "./chain-aggregate.ts";
import { type ParsedTranscript, DEFAULT_PARAMS, verifyTranscript } from "./ceremony.ts";
import { activeWordsOf, bundleHash, padBundle, partialFromBundle } from "./bundle.ts";
import { assertInteger, hex32 } from "./encoding.ts";
import { ToolkitError, VerificationError } from "./errors.ts";
import { DEFAULT_THRESHOLD, DEFAULT_TRUSTEES, IDENTITY, type ElectionContext, type Point } from "./params.ts";
import { pointToWire, pointsEqual, type WirePoint } from "./point.ts";
import { padTotals, resultsHash } from "./results.ts";
import { type PartialDecryption, tallyAggregate, verifyPartialDecryption } from "./threshold.ts";

/** What VoteChainV3 pins in Setup. */
export interface PinnedConfiguration {
  readonly context: ElectionContext;
  readonly transcriptHash: bigint;
  /** the election key H the ballots are encrypted under */
  readonly electionKey: Point;
  /** vk_1, vk_2, vk_3 */
  readonly verificationKeys: readonly Point[];
  /** the three trustee addresses (informational here; the contract enforces who may publish) */
  readonly trustees: readonly string[];
}

/** One decoded PartialDecryptionPublished event. */
export interface PartialPublication {
  readonly trusteeIndex: number;
  readonly constituencyId: bigint;
  readonly bundleHash: bigint;
  readonly ballotCount: number;
  readonly candidateCount: number;
  /** the ACTIVE words (4 per candidate slot: D.x, D.y, e, z); the padded slots are zero by rule */
  readonly words: readonly bigint[];
}

export interface AuditInput {
  /** the public key-ceremony transcript (wire JSON), e.g. fetched from storage */
  readonly transcript: unknown;
  readonly pinned: PinnedConfiguration;
  readonly state: ContractConstituencyState;
  /** the COMPLETE BallotRecorded log of the election */
  readonly log: readonly BallotLogEntry[];
  readonly publications: readonly PartialPublication[];
  /** the bundle hash the contract stores per trustee 1..3 (0 = none); when given, every publication must match it */
  readonly storedBundleHashes?: readonly bigint[];
}

export interface InvalidPublication {
  readonly trusteeIndex: number;
  readonly code: string;
  readonly reason: string;
}

export interface AuditResult {
  readonly transcript: ParsedTranscript;
  readonly aggregate: VerifiedAggregate;
  /** trustees whose publication passed every check */
  readonly validTrustees: number[];
  readonly invalid: InvalidPublication[];
  /** the two trustees whose partials were combined (empty for a constituency without ballots) */
  readonly usedTrustees: number[];
  /** votes per active candidate slot */
  readonly totals: number[];
  /** the fixed uint256[16] result the trustees endorse */
  readonly totals16: bigint[];
  readonly resultsHash: bigint;
  readonly decryptedPoints: WirePoint[];
}

/** Steps 1-5: the transcript is exactly the one the contract pinned. Returns the verified transcript. */
export function verifyPinnedTranscript(transcript: unknown, pinned: PinnedConfiguration): ParsedTranscript {
  if (!Array.isArray(pinned.verificationKeys) || pinned.verificationKeys.length !== DEFAULT_TRUSTEES) throw new VerificationError("PINNED_CONFIG_MALFORMED", "the pinned configuration needs exactly three verification keys");
  const result = verifyTranscript(transcript, { context: pinned.context, params: DEFAULT_PARAMS, transcriptHash: hex32(pinned.transcriptHash) });
  if (!result.ok) throw new VerificationError(result.code, result.reason);
  const t = result.transcript;
  if (!pointsEqual(t.electionPublicKey, pinned.electionKey)) throw new VerificationError("PINNED_H_MISMATCH", "the transcript's election public key is not the key the contract pinned (the key ballots are encrypted under)");
  t.verificationKeys.forEach((vk, i) => {
    if (!pointsEqual(vk, pinned.verificationKeys[i] as Point)) throw new VerificationError("PINNED_VK_MISMATCH", `the transcript's verification key ${i + 1} is not the one the contract pinned`);
  });
  return t;
}

function checkPublication(
  publication: PartialPublication,
  context: { transcript: ParsedTranscript; aggregate: VerifiedAggregate; pinned: PinnedConfiguration; state: ContractConstituencyState; stored: readonly bigint[] | undefined },
): PartialDecryption {
  const { transcript, aggregate, pinned, state, stored } = context;
  const kc = state.candidateCount;
  assertInteger(publication.trusteeIndex, 1, DEFAULT_TRUSTEES, "trustee index");
  if (publication.constituencyId !== state.constituencyId) throw new VerificationError("WRONG_CONSTITUENCY", "the publication is for another constituency");
  if (publication.ballotCount !== state.ballotCount) throw new VerificationError("WRONG_BALLOT_COUNT", "the publication is bound to another ballot count");
  if (publication.candidateCount !== kc) throw new VerificationError("WRONG_CANDIDATE_COUNT", "the publication is bound to another candidate count");
  const padded = padBundle(publication.words, kc); // exactly 4 words per active slot
  const expected = bundleHash({ context: pinned.context, transcriptHash: pinned.transcriptHash, trusteeIndex: publication.trusteeIndex, constituencyId: state.constituencyId, ballotCount: state.ballotCount, candidateCount: kc }, padded);
  if (expected !== publication.bundleHash) throw new VerificationError("BUNDLE_HASH_MISMATCH", "the bundle hash recomputed from the published words differs from the announced hash");
  if (stored && stored[publication.trusteeIndex - 1] !== expected) throw new VerificationError("STORED_HASH_MISMATCH", "the bundle hash differs from the one the contract stored");
  const partial = partialFromBundle({ trusteeIndex: publication.trusteeIndex, constituencyId: state.constituencyId, activeWords: activeWordsOf(padded, kc), candidateCount: kc });
  if (!verifyPartialDecryption({ transcript, aggregate: aggregate.aggregate, partial })) throw new VerificationError("INVALID_PROOF", "a Chaum-Pedersen proof of this partial decryption does not verify");
  return partial;
}

/** Steps 1-17 for one constituency. Throws if anything is wrong or fewer than 2 trustees have a valid publication; otherwise returns the verified result. */
export function auditConstituency(input: AuditInput): AuditResult {
  const transcript = verifyPinnedTranscript(input.transcript, input.pinned);
  const aggregate = verifyChainAggregate({ context: input.pinned.context, state: input.state, log: input.log });
  const kc = input.state.candidateCount;
  const header = { context: input.pinned.context, transcriptHash: input.pinned.transcriptHash, constituencyId: input.state.constituencyId, ballotCount: input.state.ballotCount, candidateCount: kc };

  if (input.state.ballotCount === 0) {
    // an empty aggregate is the identity: nothing to decrypt, the only valid result is all zeros
    const totals16 = padTotals(Array.from({ length: kc }, () => 0), kc);
    return { transcript, aggregate, validTrustees: [], invalid: [], usedTrustees: [], totals: Array.from({ length: kc }, () => 0), totals16, resultsHash: resultsHash(header, totals16), decryptedPoints: Array.from({ length: kc }, () => pointToWire(IDENTITY)) };
  }

  const indices = input.publications.map((p) => p.trusteeIndex);
  if (new Set(indices).size !== indices.length) throw new VerificationError("DUPLICATE_TRUSTEE", "the same trustee index appears in more than one publication");
  const valid: { trusteeIndex: number; partial: PartialDecryption }[] = [];
  const invalid: InvalidPublication[] = [];
  for (const publication of input.publications) {
    try {
      valid.push({ trusteeIndex: publication.trusteeIndex, partial: checkPublication(publication, { transcript, aggregate, pinned: input.pinned, state: input.state, stored: input.storedBundleHashes }) });
    } catch (error) {
      invalid.push({ trusteeIndex: publication.trusteeIndex, code: error instanceof ToolkitError ? error.code : "INVALID_PUBLICATION", reason: error instanceof ToolkitError ? error.detail : "the publication could not be checked" });
    }
  }
  if (valid.length < DEFAULT_THRESHOLD) {
    throw new VerificationError("INSUFFICIENT_VALID_PARTIALS", `${DEFAULT_THRESHOLD} valid trustee publications are needed, ${valid.length} found${invalid.length ? ` (invalid: ${invalid.map((i) => `trustee ${i.trusteeIndex}: ${i.code}`).join(", ")})` : ""}`);
  }
  const tally = tallyAggregate({ transcript, aggregate: aggregate.aggregate, partials: valid.map((v) => v.partial) });
  const totals16 = padTotals(tally.totals, kc);
  return { transcript, aggregate, validTrustees: valid.map((v) => v.trusteeIndex), invalid, usedTrustees: tally.usedTrustees, totals: tally.totals, totals16, resultsHash: resultsHash(header, totals16), decryptedPoints: tally.decryptedPoints };
}

/** The result the contract finalized must be exactly the audited one: the same totals and the same results hash. */
export function verifyFinalResult(finalResult: { totals: readonly bigint[]; resultsHash: bigint; ballotCount: number; candidateCount: number }, audit: AuditResult): void {
  if (finalResult.ballotCount !== audit.aggregate.aggregate.ballotCount || finalResult.candidateCount !== audit.totals.length) throw new VerificationError("FINAL_RESULT_MISMATCH", "the finalized result is for another ballot or candidate count");
  if (finalResult.totals.length !== audit.totals16.length || finalResult.totals.some((t, j) => t !== audit.totals16[j])) throw new VerificationError("FINAL_RESULT_MISMATCH", "the finalized totals differ from the audited totals");
  if (finalResult.resultsHash !== audit.resultsHash) throw new VerificationError("FINAL_RESULT_MISMATCH", "the finalized results hash differs from the audited one");
}
