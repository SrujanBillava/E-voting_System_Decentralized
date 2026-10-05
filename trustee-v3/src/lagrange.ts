// Lagrange interpolation at x = 0, mod l. The coefficients depend only on the (public) trustee indices. They are applied to curve POINTS
// (partial decryptions, verification keys): this toolkit contains no function that interpolates secret scalars, because no program may ever
// compute the full election secret s.
import { assertInteger } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { add, mul as pointMul } from "./point.ts";
import type { Point } from "./params.ts";
import { IDENTITY } from "./params.ts";
import { inv, mod, mul } from "./scalar.ts";

/** lambda_a = prod over the other indices m of m / (m - a), mod l. Indices must be distinct integers in 1..255. */
export function lagrangeCoefficientsAtZero(indices: readonly number[]): bigint[] {
  if (!Array.isArray(indices) || indices.length === 0) throw new InvalidInputError("BAD_INDICES", "need at least one trustee index");
  indices.forEach((i) => assertInteger(i, 1, 255, "trustee index"));
  if (new Set(indices).size !== indices.length) throw new InvalidInputError("DUPLICATE_INDEX", "trustee indices must be distinct");
  return indices.map((a) => {
    let numerator = 1n;
    let denominator = 1n;
    for (const m of indices) {
      if (m === a) continue;
      numerator = mul(numerator, BigInt(m));
      denominator = mul(denominator, mod(BigInt(m) - BigInt(a)));
    }
    return mul(numerator, inv(denominator));
  });
}

/** sum of lambda_i * P_i over validated points: the interpolation at 0 of the "polynomial in the exponent" through the given (index, point) pairs. */
export function interpolatePointsAtZero(indices: readonly number[], points: readonly Point[]): Point {
  if (indices.length !== points.length) throw new InvalidInputError("BAD_INDICES", "one point per index is required");
  const lambdas = lagrangeCoefficientsAtZero(indices);
  let acc: Point = [IDENTITY[0], IDENTITY[1]];
  points.forEach((p, i) => {
    acc = add(acc, pointMul(p, lambdas[i] as bigint));
  });
  return acc;
}
