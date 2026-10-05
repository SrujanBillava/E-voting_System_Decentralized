// Point validation at every trust boundary: canonical, on the curve, in the prime-order subgroup, and (unless allowed) not the identity.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIELD_PRIME as P, G, IDENTITY, SUBGROUP_ORDER as L } from "../src/params.ts";
import { add, isInSubgroup, isOnCurve, isValidPoint, mul, neg, parsePoint, parsePointWire, pointToWire, pointsEqual, sub } from "../src/point.ts";
import { randomScalar } from "../src/scalar.ts";
import { curvePoints, mixedPoint, nonIdentityTorsion, torsionOrder, torsionSubgroup } from "../testing/torsion.ts";
import { pv3 } from "../testing/pv3.ts";

describe("group arithmetic agrees with the reviewed privacy-v3 implementation", () => {
  it("add, neg, sub and mul give the same points as privacy-v3's elgamal helpers on random inputs", () => {
    for (let i = 0; i < 20; i++) {
      const a = randomScalar();
      const b = randomScalar();
      const A = mul(G, a);
      const B = mul(G, b);
      assert.ok(pointsEqual(A, pv3.elgamal.mul(G, a)));
      assert.ok(pointsEqual(add(A, B), pv3.elgamal.add(A, B)));
      assert.ok(pointsEqual(neg(A), pv3.elgamal.neg(A)));
      assert.ok(pointsEqual(sub(A, B), pv3.elgamal.add(A, pv3.elgamal.neg(B))));
      assert.ok(pointsEqual(add(A, B), mul(G, (a + b) % L)), "(a+b)G = aG + bG");
    }
  });

  it("identity laws: P + O = P, P + (-P) = O, 0*P = O, l*P = O; mul refuses scalars that are not reduced mod l", () => {
    const Pt = mul(G, randomScalar());
    assert.ok(pointsEqual(add(Pt, IDENTITY), Pt));
    assert.ok(pointsEqual(add(Pt, neg(Pt)), IDENTITY));
    assert.ok(pointsEqual(mul(Pt, 0n), IDENTITY));
    assert.ok(pointsEqual(mul(Pt, L - 1n), neg(Pt)));
    for (const bad of [L, L + 1n, -1n, P, 2n ** 300n]) assert.throws(() => mul(Pt, bad), /BAD_SCALAR/, String(bad));
  });
});

describe("parsePoint: what a received point must be", () => {
  const Q = mul(G, randomScalar());

  it("accepts honest subgroup points; accepts the identity only when told to", () => {
    assert.deepEqual(parsePoint([...Q], "Q"), [...Q]);
    assert.throws(() => parsePoint([...IDENTITY], "I"), /IDENTITY_POINT/);
    assert.deepEqual(parsePoint([...IDENTITY], "I", { allowIdentity: true }), [...IDENTITY]);
    assert.ok(isValidPoint([...Q]));
    assert.ok(!isValidPoint([...IDENTITY]));
    assert.ok(isValidPoint([...IDENTITY], { allowIdentity: true }));
  });

  it("refuses non-points: wrong types, wrong arity, nulls, strings, numbers, mutable-looking objects", () => {
    for (const bad of [null, undefined, 5, "x", {}, [], [1n], [1n, 2n, 3n], ["1", "2"], [1, 2], [Q[0], "y"], { 0: Q[0], 1: Q[1] }]) {
      assert.ok(!isValidPoint(bad as unknown), String(bad));
      assert.throws(() => parsePoint(bad as unknown, "x"), /BAD_POINT|IDENTITY_POINT/);
    }
  });

  it("refuses non-canonical coordinates: x + p and y + p describe the same residue but are a second spelling", () => {
    assert.ok(!isOnCurve([Q[0] + P, Q[1]]));
    assert.ok(!isOnCurve([Q[0], Q[1] + P]));
    assert.throws(() => parsePoint([Q[0] + P, Q[1]], "Q"), /non-canonical/);
    assert.throws(() => parsePoint([-1n, Q[1]], "Q"), /non-canonical/);
    assert.throws(() => parsePoint([P, Q[1]], "Q"), /non-canonical/);
  });

  it("refuses points that are not on the curve", () => {
    for (const bad of [[Q[0], Q[1] + 1n], [Q[0] + 1n, Q[1]], [1n, 1n], [2n, 3n], [0n, 0n]] as [bigint, bigint][]) {
      assert.ok(!isOnCurve(bad), String(bad));
      assert.throws(() => parsePoint(bad, "bad"), /not on the curve/);
    }
  });

  it("refuses EVERY non-identity torsion point (orders 2, 4 and 8), and the order-2 point (0, -1) in particular", () => {
    const torsion = torsionSubgroup();
    assert.equal(torsion.length, 8);
    assert.deepEqual(torsion.map(torsionOrder).sort((a, b) => a - b), [1, 2, 4, 4, 8, 8, 8, 8]);
    for (const t of nonIdentityTorsion()) {
      assert.ok(isOnCurve(t));
      assert.ok(!isInSubgroup(t), `order ${torsionOrder(t)}`);
      assert.throws(() => parsePoint([...t], "t"), /not in the prime-order subgroup/);
      assert.throws(() => parsePoint([...t], "t", { allowIdentity: true }), /not in the prime-order subgroup/);
    }
    assert.ok(!isValidPoint([0n, P - 1n]), "(0, -1)");
  });

  it("refuses a subgroup point with ANY torsion component added: it is on the curve but outside the subgroup", () => {
    for (let which = 0; which < 7; which++) {
      const mixed = mixedPoint(Q, which);
      assert.ok(isOnCurve(mixed));
      assert.ok(!isInSubgroup(mixed));
      assert.throws(() => parsePoint([...mixed], "mixed"), /not in the prime-order subgroup/);
    }
  });

  it("on random curve points, validation accepts exactly the points with l*P = identity", () => {
    const points = curvePoints(120);
    let inside = 0;
    for (const point of points) {
      const inGroup = pointsEqual(mul(G, 0n), IDENTITY) && pointsEqual(pv3.elgamal.mul(point, L), IDENTITY);
      assert.equal(isInSubgroup(point), inGroup);
      if (inGroup) inside++;
    }
    assert.ok(inside > 0 && inside < points.length, "the sample contains both kinds of points");
  });
});

describe("wire form of points", () => {
  const Q = mul(G, randomScalar());
  it("round trips and is exactly [0x + 64 hex, 0x + 64 hex]", () => {
    const wire = pointToWire(Q);
    assert.match(wire[0], /^0x[0-9a-f]{64}$/);
    assert.match(wire[1], /^0x[0-9a-f]{64}$/);
    assert.deepEqual([...parsePointWire(wire, "Q")], [...Q]);
  });
  it("refuses uppercase, short, decimal, non-arrays, and valid-looking hex of an invalid point", () => {
    const [x, y] = pointToWire(Q);
    for (const bad of [[x.toUpperCase().replace("0X", "0x"), y], [x.slice(0, -1), y], [x, y.slice(2)], ["1", "2"], [x], [x, y, y], "0x00", null, [5n, 6n]]) {
      assert.throws(() => parsePointWire(bad as unknown, "Q"), /BAD_ENCODING|BAD_POINT/, String(bad));
    }
    assert.throws(() => parsePointWire(["0x" + "00".repeat(32), "0x" + "00".repeat(32)], "Q"), /not on the curve/);
  });
});
