// The ONLY ciphertext type the trustee workflow accepts: an AGGREGATE of the encrypted ballots of one constituency (per candidate slot: A = sum of the C1
// points, B = sum of the C2 points, exactly what VoteChainV3 keeps and what anybody can recompute from the BallotRecorded log).
// There is no function in this toolkit that decrypts a single ballot. Cryptographically a one-ballot "aggregate" is an individual ballot, so the type
// carries the ballot count and a Trustee refuses aggregates below its minimum (default 2).
import { assertContext } from "./context.ts";
import { assertInteger } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { MAX_BALLOT_COUNT, MAX_SLOTS, IDENTITY, type ElectionContext, type Point } from "./params.ts";
import { add, isCoordinate, isIdentity, isOnCurve, parsePoint, pointToWire, pointsEqual, type WirePoint } from "./point.ts";
import { hex32 } from "./encoding.ts";

export interface AggregateSlot {
  readonly A: Point; // sum of C1 over all ballots
  readonly B: Point; // sum of C2 over all ballots
}

const CREATE = Symbol("AggregateCiphertext.create");

export class AggregateCiphertext {
  readonly context: ElectionContext;
  readonly constituencyId: bigint;
  readonly ballotCount: number;
  readonly slots: readonly AggregateSlot[];
  readonly #brand = true;

  constructor(token: symbol, context: ElectionContext, constituencyId: bigint, ballotCount: number, slots: readonly AggregateSlot[]) {
    if (token !== CREATE) throw new InvalidInputError("NOT_AN_AGGREGATE", "use AggregateCiphertext.create or AggregateCiphertext.fromBallotLog");
    this.context = context;
    this.constituencyId = constituencyId;
    this.ballotCount = ballotCount;
    this.slots = Object.freeze(slots.map((s) => Object.freeze({ A: s.A, B: s.B })));
    Object.freeze(this);
  }

  /** True only for instances made by this class (a private-field brand: look-alike objects and Object.create tricks do not pass). */
  static isAggregate(value: unknown): value is AggregateCiphertext {
    return typeof value === "object" && value !== null && #brand in value;
  }

  /**
   * From the per-slot sums. Validates everything: a non-empty aggregate needs A != identity (otherwise no proof about it means anything), every point in the
   * prime-order subgroup; an EMPTY aggregate (ballotCount 0) must be exactly the identity in every slot, which is also what the contract starts from.
   */
  static create(input: { context: ElectionContext; constituencyId: bigint; ballotCount: number; slots: readonly { A: Point; B: Point }[] }): AggregateCiphertext {
    const context = assertContext(input.context);
    if (typeof input.constituencyId !== "bigint" || input.constituencyId <= 0n || input.constituencyId >= 1n << 256n) throw new InvalidInputError("BAD_CONSTITUENCY", "constituency id must be a non-zero bytes32");
    assertInteger(input.ballotCount, 0, MAX_BALLOT_COUNT, "ballot count");
    if (!Array.isArray(input.slots) || input.slots.length < 1 || input.slots.length > MAX_SLOTS) throw new InvalidInputError("BAD_SLOTS", `an aggregate has 1..${MAX_SLOTS} candidate slots`);
    const slots = input.slots.map((s, j) => {
      if (input.ballotCount === 0) {
        if (!pointsEqual(s.A as Point, IDENTITY) || !pointsEqual(s.B as Point, IDENTITY)) throw new InvalidInputError("INVALID_AGGREGATE", `slot ${j}: an aggregate of zero ballots must be the identity`);
        return { A: IDENTITY, B: IDENTITY };
      }
      return { A: parsePoint(s.A, `slot ${j} A`), B: parsePoint(s.B, `slot ${j} B`, { allowIdentity: true }) };
    });
    return new AggregateCiphertext(CREATE, context, input.constituencyId, input.ballotCount, slots);
  }

  /**
   * Recomputes the aggregate from the PUBLIC ballot log, the way an independent trustee or auditor does. Each entry is the `coords` of one BallotRecorded event:
   * 4 * slotCount values, slot-major C1.x, C1.y, C2.x, C2.y. Per ballot only canonical coordinates, on-curve points and C1 != identity are checked (the contract's
   * validity proof already vouches for the rest); the final sums are fully validated by create().
   */
  static fromBallotLog(input: { context: ElectionContext; constituencyId: bigint; slotCount: number; ballots: readonly { coords: readonly bigint[] }[] }): AggregateCiphertext {
    assertInteger(input.slotCount, 1, MAX_SLOTS, "slot count");
    if (!Array.isArray(input.ballots)) throw new InvalidInputError("BAD_LOG", "the ballot log must be an array");
    const A: Point[] = Array.from({ length: input.slotCount }, () => [IDENTITY[0], IDENTITY[1]]);
    const B: Point[] = Array.from({ length: input.slotCount }, () => [IDENTITY[0], IDENTITY[1]]);
    input.ballots.forEach((ballot, n) => {
      const c = ballot.coords;
      if (!Array.isArray(c) || c.length !== 4 * input.slotCount || !c.every(isCoordinate)) throw new InvalidInputError("BAD_LOG", `ballot ${n} does not have ${4 * input.slotCount} canonical coordinates`);
      for (let j = 0; j < input.slotCount; j++) {
        const c1: Point = [c[4 * j] as bigint, c[4 * j + 1] as bigint];
        const c2: Point = [c[4 * j + 2] as bigint, c[4 * j + 3] as bigint];
        if (!isOnCurve(c1) || !isOnCurve(c2) || isIdentity(c1)) throw new InvalidInputError("BAD_LOG", `ballot ${n} slot ${j} is not a valid ciphertext`);
        A[j] = add(A[j] as Point, c1);
        B[j] = add(B[j] as Point, c2);
      }
    });
    return AggregateCiphertext.create({ context: input.context, constituencyId: input.constituencyId, ballotCount: input.ballots.length, slots: A.map((a, j) => ({ A: a, B: B[j] as Point })) });
  }

  toWire(): { constituencyId: string; ballotCount: number; slots: { A: WirePoint; B: WirePoint }[] } {
    return { constituencyId: hex32(this.constituencyId), ballotCount: this.ballotCount, slots: this.slots.map((s) => ({ A: pointToWire(s.A), B: pointToWire(s.B) })) };
  }
}
