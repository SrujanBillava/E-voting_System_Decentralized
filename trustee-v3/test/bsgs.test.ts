// Bounded integer recovery by baby-step giant-step: M = t*G with 0 <= t <= bound.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedDiscreteLog, MAX_BSGS_BOUND, boundedDiscreteLog } from "../src/bsgs.ts";
import { G, IDENTITY, SUBGROUP_ORDER as L } from "../src/params.ts";
import { add, mul, neg } from "../src/point.ts";
import { randomScalar } from "../src/scalar.ts";
import { nonIdentityTorsion } from "../testing/torsion.ts";

const tG = (t: number | bigint): [bigint, bigint] => mul(G, BigInt(t)) as [bigint, bigint];

describe("BSGS: correctness", () => {
  it("EXHAUSTIVE for small bounds: every t in 0..bound is recovered, for every bound 0..40", () => {
    for (let bound = 0; bound <= 40; bound++) {
      const table = new BoundedDiscreteLog(bound);
      let point: [bigint, bigint] = [IDENTITY[0], IDENTITY[1]];
      for (let t = 0; t <= bound; t++) {
        assert.equal(table.solve(point), t, `bound ${bound}, t ${t}`);
        point = add(point, G) as [bigint, bigint];
      }
    }
  });

  it("recovers random values for the bounds the system uses: 100, 1,000, 10,000, 100,000 and 1,000,000 (including both ends of the range)", () => {
    for (const bound of [100, 1_000, 10_000, 100_000, 1_000_000]) {
      const table = new BoundedDiscreteLog(bound);
      const values = [0, 1, bound - 1, bound, Math.floor(bound / 2), ...Array.from({ length: 6 }, () => Math.floor(Math.random() * (bound + 1)))];
      for (const t of values) {
        const found = table.solve(tG(t));
        assert.equal(found, t, `bound ${bound}, t ${t}`);
        assert.ok(BoundedDiscreteLog.confirm(found!, tG(t)));
      }
    }
  });

  it("the identity is 0; values just ABOVE the bound are not found (null), whatever the bound", () => {
    const table = new BoundedDiscreteLog(1000);
    assert.equal(table.solve([IDENTITY[0], IDENTITY[1]]), 0);
    assert.equal(table.solve(tG(1001)), null);
    assert.equal(table.solve(tG(1002)), null);
    assert.equal(table.solve(tG(5000)), null);
    assert.equal(table.solve(tG(2 ** 31)), null);
    assert.equal(table.solve(tG(L - 1n)), null, "-G is not a count");
    assert.equal(table.solve(neg(G)), null);
    assert.equal(table.solve(tG(L >> 1n)), null);
  });

  it("points that are not multiples of G in range are not found: random subgroup points, torsion points, a tampered tally", () => {
    const table = new BoundedDiscreteLog(10_000);
    for (let i = 0; i < 5; i++) assert.equal(table.solve(mul(G, randomScalar())), null);
    for (const torsion of nonIdentityTorsion()) assert.equal(table.solve(torsion), null);
    assert.equal(table.solve(add(tG(123), tG(1_000_000))), null);
    assert.equal(table.solve(add(tG(500), nonIdentityTorsion()[3]!)), null, "t*G plus a torsion component is not t'*G");
  });

  it("a point that is not on the curve is an error, not a silent null", () => {
    const table = new BoundedDiscreteLog(100);
    assert.throws(() => table.solve([1n, 2n]), /BAD_POINT/);
    assert.throws(() => table.solve([G[0] + 1n, G[1]]), /BAD_POINT/);
  });

  it("a hit needs BOTH coordinates: a point with the right x but the wrong y is not accepted as t*G", () => {
    const table = new BoundedDiscreteLog(1000);
    const [x, y] = tG(777);
    const fake: [bigint, bigint] = [x, (-y + 21888242871839275222246405745257275088548364400416034343698204186575808495617n) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n];
    assert.equal(table.solve(tG(777)), 777);
    // (x, -y) may or may not lie on the curve; either way it must never be reported as 777
    try {
      assert.notEqual(table.solve(fake), 777);
    } catch (error) {
      assert.match(String(error), /BAD_POINT/);
    }
  });

  it("table sizes follow ceil(sqrt(bound + 1)): O(sqrt(bound)) baby steps, so a million ballots need about a thousand", () => {
    assert.equal(new BoundedDiscreteLog(0).babySteps, 1);
    assert.equal(new BoundedDiscreteLog(100).babySteps, 11);
    assert.equal(new BoundedDiscreteLog(1_000).babySteps, 32);
    assert.equal(new BoundedDiscreteLog(1_000_000).babySteps, 1001);
  });

  it("tables are cached per bound", () => {
    assert.equal(boundedDiscreteLog(321), boundedDiscreteLog(321));
    assert.notEqual(boundedDiscreteLog(321), boundedDiscreteLog(322));
  });

  it("bounds are validated: negative, fractional, NaN, unsafe or above the cap are refused", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, MAX_BSGS_BOUND + 1, 2 ** 53, "100" as unknown as number]) assert.throws(() => new BoundedDiscreteLog(bad), /BAD_BOUND/, String(bad));
    assert.doesNotThrow(() => new BoundedDiscreteLog(0));
  });

  it("confirm() is an independent check of t*G == M and refuses non-counts", () => {
    assert.ok(BoundedDiscreteLog.confirm(5, tG(5)));
    assert.ok(!BoundedDiscreteLog.confirm(6, tG(5)));
    assert.ok(!BoundedDiscreteLog.confirm(-1, tG(5)));
    assert.ok(!BoundedDiscreteLog.confirm(1.5, tG(5)));
    assert.ok(!BoundedDiscreteLog.confirm(NaN, tG(5)));
  });
});
