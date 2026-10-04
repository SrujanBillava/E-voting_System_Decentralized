// On-chain BabyJubJub point ADDITION (the only curve arithmetic V3 has on-chain), cross-tested against the JavaScript reference implementation.
import { expect } from "chai";
import { add as jsAdd, mul, neg, randomScalar } from "../../privacy-v3/src/elgamal.js";
import { G, IDENTITY, FIELD_PRIME as P } from "../../privacy-v3/src/params.js";
import { curvePoints, modPow, torsionSubgroup } from "../../privacy-v3/test/curve.mjs";
import { newWorld } from "./helpers/world.js";

describe("BabyJubJub aggregation arithmetic: Solidity == JavaScript", () => {
  let h;
  const sol = async (p, q) => (await h.add(p[0], p[1], q[0], q[1])).map(BigInt);
  const eq = (a, b, msg) => expect(a.map(String), msg).to.deep.equal(b.map(String));
  let points;

  before(async () => {
    const w = await newWorld();
    h = await w.ethers.deployContract("BabyJubJubHarness");
    points = Array.from({ length: 40 }, () => mul(G, randomScalar()));
  });

  it("the identity is (0, 1), not (0, 0): O + P = P and P + O = P and O + O = O", async () => {
    const O = [...IDENTITY];
    expect(O).to.deep.equal([0n, 1n]);
    for (const p of points.slice(0, 5)) {
      eq(await sol(O, p), p, "O + P");
      eq(await sol(p, O), p, "P + O");
    }
    eq(await sol(O, O), O, "O + O");
  });

  it("P + (-P) = O", async () => {
    for (const p of points.slice(0, 10)) eq(await sol(p, neg(p)), [0n, 1n], "P + (-P)");
    eq(await sol(G, neg(G)), [0n, 1n]);
  });

  it("P + P (doubling) equals the JS doubling and 2*P", async () => {
    for (const p of points.slice(0, 10)) {
      const doubled = await sol(p, p);
      eq(doubled, jsAdd(p, p), "P + P vs JS add");
      eq(doubled, mul(p, 2n), "P + P vs 2*P");
    }
    eq(await sol(G, G), mul(G, 2n));
  });

  it("random subgroup points: 40 random pairs agree with the JS addition, and addition is commutative", async () => {
    for (let i = 0; i < points.length; i += 2) {
      const p = points[i];
      const q = points[i + 1];
      const r = await sol(p, q);
      eq(r, jsAdd(p, q));
      eq(await sol(q, p), r, "commutative");
    }
  });

  it("long sequential sums built from the identity, exactly how the aggregate is built: prefix sums of 1, 2, 3, 10, 100 and 300 random points", async () => {
    const many = Array.from({ length: 300 }, () => mul(G, randomScalar()));
    let acc = [...IDENTITY];
    const checkpoints = new Set([1, 2, 3, 10, 100, 300]);
    for (let i = 0; i < many.length; i++) {
      acc = jsAdd(acc, many[i]);
      if (checkpoints.has(i + 1)) {
        const [x, y] = (await h.sum(many.slice(0, i + 1).map((p) => p[0]), many.slice(0, i + 1).map((p) => p[1]))).map(BigInt);
        eq([x, y], acc, `sum of the first ${i + 1}`);
      }
    }
  });

  it("a sum that cancels returns to the identity (+P then -P, many times)", async () => {
    const ps = points.slice(0, 20);
    const xs = [...ps, ...ps.map(neg)].map((p) => p[0]);
    const ys = [...ps, ...ps.map(neg)].map((p) => p[1]);
    eq((await h.sum(xs, ys)).map(BigInt), [0n, 1n]);
  });

  it("the complete addition law also holds for the whole curve, not just the subgroup: torsion points and subgroup + torsion agree with JS", async () => {
    const torsion = torsionSubgroup();
    expect(torsion).to.have.length(8);
    for (const t of torsion) {
      eq(await sol(t, t), jsAdd(t, t), "T + T");
      for (const p of points.slice(0, 3)) eq(await sol(p, t), jsAdd(p, t), "P + T");
    }
    for (const [i, p] of curvePoints(60).slice(0, 20).entries()) eq(await sol(p, points[i]), jsAdd(p, points[i]), "arbitrary curve point + subgroup point");
  });

  it("isOnCurve: genuine points pass; off-curve points and non-canonical coordinates fail", async () => {
    for (const p of points.slice(0, 5)) expect(await h.isOnCurve(p[0], p[1])).to.equal(true);
    expect(await h.isOnCurve(0n, 1n)).to.equal(true);
    expect(await h.isOnCurve(points[0][0], points[0][1] + 1n)).to.equal(false);
    expect(await h.isOnCurve(1n, 1n)).to.equal(false);
    expect(await h.isOnCurve(P + points[0][0], points[0][1])).to.equal(false);
    expect(await h.isOnCurve(points[0][0], P + points[0][1])).to.equal(false);
  });

  it("fails closed on degenerate input: points that are not on the curve and make a denominator zero revert instead of returning garbage", async () => {
    const D = 168696n;
    const y2 = P - modPow(D, P - 2n); // d * 1*1*1*y2 = -1  =>  1 + d*x1*x2*y1*y2 = 0
    await expect(h.add(1n, 1n, 1n, y2)).to.be.revertedWithCustomError(h, "DegenerateAddition");
  });
});
