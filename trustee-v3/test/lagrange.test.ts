// Lagrange coefficients at 0, mod l: the 2-of-3 pairs, interpolation of polynomials, and the wrong-modulus trap.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mulPointEscalar } from "@zk-kit/baby-jubjub";
import { lagrangeCoefficientsAtZero, interpolatePointsAtZero } from "../src/lagrange.ts";
import { FIELD_PRIME, G, SUBGROUP_ORDER as L, type Point } from "../src/params.ts";
import { mul, pointsEqual } from "../src/point.ts";
import { add as sAdd, inv, mod, mul as sMul, randomScalar } from "../src/scalar.ts";

describe("2-of-3 Lagrange coefficients mod l", () => {
  it("known answers: (1,2) -> (2, -1); (1,3) -> (3/2, -1/2); (2,3) -> (3, -2), all mod l", () => {
    assert.deepEqual(lagrangeCoefficientsAtZero([1, 2]), [2n, mod(-1n)]);
    assert.deepEqual(lagrangeCoefficientsAtZero([1, 3]), [sMul(3n, inv(2n)), mod(sMul(mod(-1n), inv(2n)))]);
    assert.deepEqual(lagrangeCoefficientsAtZero([2, 3]), [3n, mod(-2n)]);
  });

  it("the coefficients of any pair sum to 1 (interpolating the constant polynomial 1 gives 1), and are order-independent per trustee", () => {
    for (const [a, b] of [[1, 2], [1, 3], [2, 3]] as const) {
      const [la, lb] = lagrangeCoefficientsAtZero([a, b]) as [bigint, bigint];
      assert.equal(sAdd(la, lb), 1n);
      const [lb2, la2] = lagrangeCoefficientsAtZero([b, a]) as [bigint, bigint];
      assert.equal(la, la2);
      assert.equal(lb, lb2);
    }
  });

  it("interpolates a random degree-1 polynomial's value at 0 from ANY two of its three shares (secret scalars, test-side only)", () => {
    for (let i = 0; i < 50; i++) {
      const a0 = randomScalar();
      const a1 = randomScalar();
      const f = (x: number): bigint => sAdd(a0, sMul(a1, BigInt(x)));
      for (const [a, b] of [[1, 2], [1, 3], [2, 3]] as const) {
        const [la, lb] = lagrangeCoefficientsAtZero([a, b]) as [bigint, bigint];
        assert.equal(sAdd(sMul(la, f(a)), sMul(lb, f(b))), a0);
      }
    }
  });

  it("interpolatePointsAtZero does the same in the exponent: lambda_a*(f(a)G) + lambda_b*(f(b)G) = a0*G", () => {
    for (let i = 0; i < 10; i++) {
      const a0 = randomScalar();
      const a1 = randomScalar();
      const share = (x: number): Point => mul(G, sAdd(a0, sMul(a1, BigInt(x))));
      for (const [a, b] of [[1, 2], [1, 3], [2, 3]] as const) assert.ok(pointsEqual(interpolatePointsAtZero([a, b], [share(a), share(b)]), mul(G, a0)));
    }
  });

  it("works for larger thresholds too (3 of 5), since the code is generic in (n, t)", () => {
    const coefficients = [randomScalar(), randomScalar(), randomScalar()];
    const f = (x: number): bigint => coefficients.reduceRight((acc, c) => sAdd(sMul(acc, BigInt(x)), c), 0n);
    for (const subset of [[1, 2, 3], [2, 4, 5], [1, 3, 5]]) {
      const lambdas = lagrangeCoefficientsAtZero(subset);
      assert.equal(subset.reduce((acc, x, k) => sAdd(acc, sMul(lambdas[k] as bigint, f(x))), 0n), coefficients[0]);
    }
  });

  it("rejects duplicate indices, zero, negative, fractional, out-of-range and empty index lists", () => {
    assert.throws(() => lagrangeCoefficientsAtZero([1, 1]), /DUPLICATE_INDEX/);
    assert.throws(() => lagrangeCoefficientsAtZero([]), /BAD_INDICES/);
    for (const bad of [[0, 1], [-1, 2], [1.5, 2], [1, 256], [NaN, 2]]) assert.throws(() => lagrangeCoefficientsAtZero(bad), /BAD_INTEGER/, String(bad));
    assert.throws(() => interpolatePointsAtZero([1, 2], [G]), /BAD_INDICES/);
  });

  it("computing the coefficients mod the FIELD prime p instead of mod l gives different, WRONG values, and the toolkit's point multiplication refuses them", () => {
    const wrong = [2n, FIELD_PRIME - 1n]; // lambda_2 = -1 reduced mod p, not mod l
    const right = lagrangeCoefficientsAtZero([1, 2]);
    assert.notEqual(wrong[1], right[1]);
    assert.throws(() => mul(G, wrong[1] as bigint), /BAD_SCALAR/);
    // what the unguarded library would do with it: a different point, so any decryption using it would not recover the tally
    const viaLibrary = mulPointEscalar([G[0], G[1]], wrong[1] as bigint);
    assert.ok(!pointsEqual(viaLibrary as Point, mul(G, right[1] as bigint)));
    assert.ok(L < FIELD_PRIME);
  });
});
