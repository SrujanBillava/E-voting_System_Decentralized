// TEST / DEMO SUPPORT ONLY. An aggregate ciphertext for given per-candidate totals, built the way the homomorphic sum of that many one-hot ballots is
// distributed: slot c = (R_c*G, t_c*G + R_c*H) with fresh R_c (the sum of independent encryptions of the votes IS an encryption of the total under the sum
// of their randomness). It lets the tests cover many elections without encrypting every single ballot.
import { AggregateCiphertext } from "../src/aggregate.ts";
import { TEST_CONTEXT, type ElectionContext, type Point } from "../src/params.ts";
import { G, add, mul } from "../src/point.ts";
import { randomScalar } from "../src/scalar.ts";

export function aggregateFor(H: Point, totals: readonly number[], options: { context?: ElectionContext; constituencyId?: bigint; ballotCount?: number } = {}): AggregateCiphertext {
  const slots = totals.map((t) => {
    const r = randomScalar();
    return { A: mul(G, r), B: add(mul(G, BigInt(t)), mul(H, r)) };
  });
  return AggregateCiphertext.create({
    context: options.context ?? TEST_CONTEXT,
    constituencyId: options.constituencyId ?? 0x1234567890abcdefn,
    ballotCount: options.ballotCount ?? totals.reduce((a, b) => a + b, 0),
    slots,
  });
}
