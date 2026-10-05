// The CHAIN-DERIVED aggregate: the only ciphertext an integrated trustee may decrypt. SECURITY CRITICAL.
//
// Threshold ElGamal cannot tell a genuine aggregate from one voter's ballot presented as an "aggregate" with a false ballot count, so a trustee must NEVER decrypt
// an aggregate handed to it by another component. verifyChainAggregate rebuilds the aggregate itself from the COMPLETE public BallotRecorded log, checks the log is
// complete and correctly indexed, compares the result with the contract's stored aggregate slot by slot and with its ballot count, and refuses on ANY mismatch.
// A VerifiedAggregate can only come out of that function (private-field brand), and Trustee.partialDecryptVerified accepts nothing else. A constituency with a single
// valid ballot is therefore still tallyable: its aggregate was independently reconstructed from the whole chain log.
import { AggregateCiphertext } from "./aggregate.ts";
import { assertInteger } from "./encoding.ts";
import { InvalidInputError, ToolkitError, VerificationError } from "./errors.ts";
import { MAX_SLOTS, type ElectionContext, type Point } from "./params.ts";
import { pointsEqual } from "./point.ts";

/** One decoded BallotRecorded event: the active slots' ciphertext coordinates, slot-major C1.x, C1.y, C2.x, C2.y. */
export interface BallotLogEntry {
  readonly constituencyId: bigint;
  readonly nullifier: bigint;
  /** the contract's election-wide running index, 1..totalBallots */
  readonly ballotIndex: number;
  readonly ballotHash: bigint;
  readonly coords: readonly bigint[];
}

/** What the contract itself stores for one constituency. */
export interface ContractConstituencyState {
  readonly constituencyId: bigint;
  readonly candidateCount: number;
  readonly ballotCount: number;
  /** the election-wide number of ballots recorded (the contract's totalBallots): the log must contain exactly this many events */
  readonly totalBallots: number;
  /** aggregateOf(constituencyId, j) for j < candidateCount */
  readonly aggregate: readonly { readonly A: Point; readonly B: Point }[];
}

const VERIFY = Symbol("VerifiedAggregate.verify");

export class VerifiedAggregate {
  /** the aggregate recomputed from the log AND equal to the contract's */
  readonly aggregate: AggregateCiphertext;
  /** ballots of this constituency found in the log */
  readonly eventCount: number;
  /** all ballots of the election found in the log */
  readonly logLength: number;
  readonly #brand = true;

  constructor(token: symbol, aggregate: AggregateCiphertext, eventCount: number, logLength: number) {
    if (token !== VERIFY) throw new InvalidInputError("NOT_A_VERIFIED_AGGREGATE", "a VerifiedAggregate only comes out of verifyChainAggregate");
    this.aggregate = aggregate;
    this.eventCount = eventCount;
    this.logLength = logLength;
    Object.freeze(this);
  }

  static isVerified(value: unknown): value is VerifiedAggregate {
    return typeof value === "object" && value !== null && #brand in value;
  }
}

/**
 * Rebuilds the encrypted aggregate of one constituency from the complete BallotRecorded log and compares it with the contract. Order of the checks:
 *  1 the contract state is well formed;  2 the log holds exactly `totalBallots` events, with election-wide indices 1, 2, 3, ... in order (so nothing is missing,
 *  duplicated or reordered anywhere);  3 this constituency's events number exactly its ballot count;  4 the aggregate recomputed from them (every coordinate
 *  canonical, every point on the curve, every active C1 not the identity, the sums in the prime-order subgroup) equals the contract's A and B for EVERY active slot.
 */
export function verifyChainAggregate(input: { context: ElectionContext; state: ContractConstituencyState; log: readonly BallotLogEntry[] }): VerifiedAggregate {
  const { state, log } = input;
  try {
    assertInteger(state.candidateCount, 1, MAX_SLOTS, "candidate count");
    assertInteger(state.ballotCount, 0, 1 << 20, "ballot count");
    assertInteger(state.totalBallots, state.ballotCount, 1 << 30, "total ballots");
    if (!Array.isArray(state.aggregate) || state.aggregate.length !== state.candidateCount) throw new InvalidInputError("STATE_MALFORMED", "the contract state needs one aggregate pair per candidate slot");
  } catch (error) {
    throw new VerificationError("STATE_MALFORMED", error instanceof ToolkitError ? error.detail : "malformed contract state");
  }
  if (!Array.isArray(log)) throw new VerificationError("LOG_MALFORMED", "the ballot log must be an array of events");
  if (log.length !== state.totalBallots) throw new VerificationError("LOG_INCOMPLETE", `the log holds ${log.length} ballot events but the contract recorded ${state.totalBallots}`);

  const indices = log.map((entry) => entry.ballotIndex);
  if (indices.some((i) => !Number.isInteger(i))) throw new VerificationError("LOG_MALFORMED", "an event has no valid ballot index");
  if (!indices.every((index, i) => index === i + 1)) {
    // the election-wide indices must run exactly 1, 2, 3, ... in log order; say precisely what is wrong
    if (new Set(indices).size !== indices.length) throw new VerificationError("LOG_DUPLICATE_EVENT", "a ballot index appears more than once");
    if (indices.every((index) => index >= 1 && index <= indices.length)) throw new VerificationError("LOG_OUT_OF_ORDER", "the events are not in ballot-index order");
    throw new VerificationError("LOG_INDEX_GAP", "the ballot indices are not 1, 2, 3, ...: an event is missing or an index is invalid");
  }

  const own = log.filter((entry) => entry.constituencyId === state.constituencyId);
  if (own.length !== state.ballotCount) throw new VerificationError("LOG_COUNT_MISMATCH", `the log holds ${own.length} ballots of this constituency but the contract counts ${state.ballotCount}`);
  if (own.some((entry) => entry.coords.length !== 4 * state.candidateCount)) throw new VerificationError("INVALID_BALLOT_LOG", "a logged ballot does not carry 4 coordinates per candidate slot");

  let rebuilt: AggregateCiphertext;
  try {
    rebuilt = AggregateCiphertext.fromBallotLog({ context: input.context, constituencyId: state.constituencyId, slotCount: state.candidateCount, ballots: own.map((entry) => ({ coords: entry.coords })) });
  } catch (error) {
    throw new VerificationError("INVALID_BALLOT_LOG", error instanceof ToolkitError ? error.detail : "the logged ballots cannot be aggregated");
  }
  if (rebuilt.ballotCount !== state.ballotCount) throw new VerificationError("LOG_COUNT_MISMATCH", "the rebuilt ballot count differs from the contract's");
  rebuilt.slots.forEach((slot, j) => {
    const stored = state.aggregate[j] as { A: Point; B: Point };
    if (!pointsEqual(slot.A, stored.A) || !pointsEqual(slot.B, stored.B)) throw new VerificationError("AGGREGATE_MISMATCH", `slot ${j}: the aggregate rebuilt from the log differs from the contract's aggregate`);
  });
  return new VerifiedAggregate(VERIFY, rebuilt, own.length, log.length);
}
