// Bounded integer recovery: given M = t*G and a known bound 0 <= t <= bound, find t by baby-step giant-step.
// m = ceil(sqrt(bound + 1)); the table holds (j*G).x -> j for the m baby steps; the giant steps subtract m*G from M until a table hit.
// Cost: about m point additions to build (once per bound) and at most about (bound + 1) / m = m more per solve, i.e. O(sqrt(bound)).
import { InvalidInputError } from "./errors.ts";
import { G, IDENTITY, type Point } from "./params.ts";
import { add, isOnCurve, mul, neg, pointsEqual } from "./point.ts";

/** Table size cap: bound 2^32 means 65,536 baby steps. A tally never needs more than one constituency's ballots (at most 2^20). */
export const MAX_BSGS_BOUND = 2 ** 32;

export class BoundedDiscreteLog {
  readonly bound: number;
  readonly babySteps: number;
  readonly #x = new Map<bigint, number>();
  readonly #y: bigint[] = [];
  readonly #giantStep: Point;

  constructor(bound: number) {
    if (!Number.isSafeInteger(bound) || bound < 0 || bound > MAX_BSGS_BOUND) throw new InvalidInputError("BAD_BOUND", `the bound must be an integer in 0..${MAX_BSGS_BOUND}`);
    this.bound = bound;
    this.babySteps = Math.max(1, Math.ceil(Math.sqrt(bound + 1)));
    let p: Point = [IDENTITY[0], IDENTITY[1]];
    for (let j = 0; j < this.babySteps; j++) {
      this.#x.set(p[0], j);
      this.#y.push(p[1]);
      p = add(p, G);
    }
    this.#giantStep = neg(p); // -(m*G), p is now m*G
  }

  /**
   * t with t*G == M and 0 <= t <= bound, or null if M is not such a multiple (a wrong key, a tampered aggregate, a tally above the bound).
   * A hit needs BOTH coordinates to match, so it proves M = t*G; callers still re-check t*G == M independently.
   */
  solve(M: Point): number | null {
    if (!isOnCurve(M)) throw new InvalidInputError("BAD_POINT", "M is not a curve point");
    const giantSteps = Math.ceil((this.bound + 1) / this.babySteps);
    let cur: Point = M;
    for (let i = 0; i < giantSteps; i++) {
      const j = this.#x.get(cur[0]);
      if (j !== undefined && this.#y[j] === cur[1]) {
        const t = i * this.babySteps + j;
        return t <= this.bound ? t : null;
      }
      cur = add(cur, this.#giantStep);
    }
    return null;
  }

  /** Independent confirmation of a recovered value: t*G == M. */
  static confirm(t: number, M: Point): boolean {
    return Number.isSafeInteger(t) && t >= 0 && pointsEqual(mul(G, BigInt(t)), M);
  }
}

const cache = new Map<number, BoundedDiscreteLog>();
/** One table per bound, reused across slots and tallies. */
export function boundedDiscreteLog(bound: number): BoundedDiscreteLog {
  let table = cache.get(bound);
  if (!table) {
    if (cache.size >= 8) cache.clear();
    table = new BoundedDiscreteLog(bound);
    cache.set(bound, table);
  }
  return table;
}
