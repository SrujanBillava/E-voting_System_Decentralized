// A constituency's RESULT, the thing trustees endorse and the contract finalizes. FROZEN ENCODING (identical to V3Encodings.resultsHash in smart-contract-v3):
//   totals[16]: the vote total of candidate slot j for j < K_c, ZERO in every padded slot
//   resultsHash = keccak256(abi.encode(RESULTS_TAG, chainId, contractAddress, electionId, transcriptHash, constituencyId, ballotCount, K_c, totals))
// A valid result has every active total <= ballotCount, padded totals zero, and the active totals summing to EXACTLY ballotCount (every valid ballot is one-hot).
import { contextWords } from "./context.ts";
import { assertInteger, keccakWords } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { MAX_SLOTS, RESULTS_TAG, type ElectionContext } from "./params.ts";

export interface ResultsHeader {
  readonly context: ElectionContext;
  readonly transcriptHash: bigint;
  readonly constituencyId: bigint;
  readonly ballotCount: number;
  readonly candidateCount: number;
}

/** The totals of the active slots as the fixed uint256[16] (zero padded). */
export function padTotals(totals: readonly number[], candidateCount: number): bigint[] {
  assertInteger(candidateCount, 1, MAX_SLOTS, "candidate count");
  if (!Array.isArray(totals) || totals.length !== candidateCount || totals.some((t) => !Number.isInteger(t) || t < 0)) throw new InvalidInputError("BAD_RESULTS", "need exactly one non-negative integer total per candidate slot");
  return [...totals.map(BigInt), ...Array.from({ length: MAX_SLOTS - candidateCount }, () => 0n)];
}

/** Throws unless totals is a valid result for a constituency with `ballotCount` ballots and `candidateCount` candidates. */
export function assertValidResults(totals: readonly bigint[], ballotCount: number, candidateCount: number): void {
  assertInteger(candidateCount, 1, MAX_SLOTS, "candidate count");
  assertInteger(ballotCount, 0, 1 << 20, "ballot count");
  if (!Array.isArray(totals) || totals.length !== MAX_SLOTS || totals.some((t) => typeof t !== "bigint" || t < 0n)) throw new InvalidInputError("BAD_RESULTS", "totals must be 16 non-negative integers");
  let sum = 0n;
  totals.forEach((t, j) => {
    if (j < candidateCount) {
      if (t > BigInt(ballotCount)) throw new InvalidInputError("TOTAL_ABOVE_BALLOT_COUNT", `slot ${j}: a total cannot exceed the number of ballots`);
      sum += t;
    } else if (t !== 0n) throw new InvalidInputError("PADDED_TOTAL_NOT_ZERO", `slot ${j}: a padded slot must be zero`);
  });
  if (sum !== BigInt(ballotCount)) throw new InvalidInputError("TOTALS_DO_NOT_SUM_TO_BALLOTS", "the totals must add up to exactly the number of ballots");
}

/** keccak256(abi.encode(RESULTS_TAG, chainId, contract, electionId, transcriptHash, constituencyId, ballotCount, K_c, totals[16])) as a uint256. Validates the result first. */
export function resultsHash(header: ResultsHeader, totals: readonly bigint[]): bigint {
  assertValidResults(totals, header.ballotCount, header.candidateCount);
  return keccakWords([RESULTS_TAG, ...contextWords(header.context), header.transcriptHash, header.constituencyId, BigInt(header.ballotCount), BigInt(header.candidateCount), ...totals]);
}
