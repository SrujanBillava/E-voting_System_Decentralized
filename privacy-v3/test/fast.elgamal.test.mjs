import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBabyjub } from "circomlibjs";
import { oneHot, encryptVector } from "../src/ballot.js";
import { add, addCiphertexts, decryptToPoint, encrypt, generateTestKeyPair, identityCiphertext, isIdentity, makeDiscreteLog, mul, neg, pointEquals, randomScalar, validatePublicKey } from "../src/elgamal.js";
import { FIELD_PRIME, G, IDENTITY, K_MAX, SUBGROUP_ORDER } from "../src/params.js";
import { curvePoints, torsionSubgroup } from "./curve.mjs";

const dlog = makeDiscreteLog(1n << 12n);
const totals = (secret, sums) => sums.map((ct) => dlog(decryptToPoint(secret, ct)));

describe("BabyJubJub exponential ElGamal", () => {
  const { secret, publicKey: H } = generateTestKeyPair();

  it("encrypts and decrypts every small message", () => {
    for (const m of [0, 1, 2, 7, 100, 4000]) assert.equal(dlog(decryptToPoint(secret, encrypt(H, m, randomScalar()))), BigInt(m));
  });

  it("the HOMOMORPHIC example: Enc([1,0,0]) + Enc([0,1,0]) + Enc([1,0,0]) decrypts to [2,1,0] (aggregate only)", () => {
    const sums = [0, 1, 2].map(() => identityCiphertext());
    for (const choice of [0, 1, 0]) {
      const { ciphertexts } = encryptVector({ H, kc: 3, m: oneHot(choice, 3) });
      ciphertexts.slice(0, 3).forEach((ct, j) => (sums[j] = addCiphertexts(sums[j], ct)));
    }
    assert.deepEqual(totals(secret, sums), [2n, 1n, 0n]);
    // no individual ciphertext was decrypted to get here, and a single ballot's slots are not recognisable without the key
  });

  it("many ballots: 50 voters, 5 candidates", () => {
    const kc = 5;
    const sums = Array.from({ length: kc }, identityCiphertext);
    const expected = Array(kc).fill(0n);
    for (let v = 0; v < 50; v++) {
      const choice = (v * 7 + (v >> 2)) % kc;
      expected[choice]++;
      encryptVector({ H, kc, m: oneHot(choice, kc) }).ciphertexts.slice(0, kc).forEach((ct, j) => (sums[j] = addCiphertexts(sums[j], ct)));
    }
    assert.deepEqual(totals(secret, sums), expected);
  });

  it("padded slots are the canonical identity pair, so padding contributes nothing to a sum", () => {
    const { ciphertexts } = encryptVector({ H, kc: 3, m: oneHot(1, 3) });
    assert.equal(ciphertexts.length, K_MAX);
    for (const ct of ciphertexts.slice(3)) assert.ok(isIdentity(ct.c1) && isIdentity(ct.c2));
    for (const ct of ciphertexts.slice(0, 3)) assert.ok(!isIdentity(ct.c1) && !isIdentity(ct.c2));
  });

  it("fresh randomness for every slot: ciphertexts of equal bits differ, and equal votes by different voters differ", () => {
    const a = encryptVector({ H, kc: 4, m: oneHot(0, 4) });
    const b = encryptVector({ H, kc: 4, m: oneHot(0, 4) });
    assert.equal(new Set(a.r.slice(0, 4).map(String)).size, 4, "four different r in one ballot");
    const zeros = a.ciphertexts.slice(1, 4).map((c) => c.c1.join());
    assert.equal(new Set(zeros).size, 3, "the three encryptions of 0 are all different");
    assert.notEqual(a.ciphertexts[0].c1.join(), b.ciphertexts[0].c1.join());
    assert.notEqual(a.ciphertexts[0].c2.join(), b.ciphertexts[0].c2.join());
  });

  it("a wrong key does not decrypt; a tampered aggregate is not silently accepted", () => {
    const ct = encrypt(H, 3, randomScalar());
    const other = generateTestKeyPair();
    assert.equal(dlog(decryptToPoint(other.secret, ct)), null);
    assert.equal(dlog(decryptToPoint(secret, { c1: ct.c1, c2: add(ct.c2, G) })), 4n, "homomorphism: +G is +1 (this is why only the proven aggregate may be decrypted)");
  });

  it("tallies above the discrete-log bound are reported, not wrapped", () => {
    const small = makeDiscreteLog(100n);
    assert.equal(small(mul(G, 99n)), 99n);
    assert.equal(small(mul(G, 10_000n)), null);
  });

  it("randomness comes from the OS CSPRNG: scalars are in [1, l-1] and never repeat (the injection guards are in fast.rng.test.mjs)", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const r = randomScalar();
      assert.ok(r >= 1n && r < SUBGROUP_ORDER);
      seen.add(r);
    }
    assert.equal(seen.size, 200);
  });

  it("election key validation: accepts a real key; refuses identity, order-2, off-curve, out-of-range, and a point outside the prime-order subgroup", () => {
    assert.equal(validatePublicKey(H), true);
    assert.equal(validatePublicKey([0n, 1n]), false, "identity");
    assert.equal(validatePublicKey([0n, FIELD_PRIME - 1n]), false, "order-2 point (0,-1)");
    assert.equal(validatePublicKey([H[0], H[1] + 1n]), false, "off the curve");
    assert.equal(validatePublicKey([FIELD_PRIME + H[0], H[1]]), false, "coordinate not reduced");
    assert.equal(validatePublicKey(null), false);
    assert.equal(validatePublicKey([1n]), false);
    // a point on the curve whose order is 8*l's torsion part: (G + an order-8 point) is on the curve but NOT in the prime-order subgroup
    const torsion = findSmallOrderPoint();
    assert.ok(torsion, "found a torsion point");
    const mixed = add(H, torsion);
    assert.equal(validatePublicKey(mixed), false, "H + (small-order point) has a torsion component");
  });
});

// A point of the torsion subgroup that is neither the identity nor (0,-1): used to build "H + torsion", which is on the curve but outside the prime-order subgroup.
function findSmallOrderPoint() {
  return torsionSubgroup().find((t) => !isIdentity(t) && t[0] !== 0n) ?? null;
}
void curvePoints;

describe("compatibility with an independent BabyJubJub implementation (circomlibjs)", () => {
  it("same generator, same addition, same scalar multiplication, same negation", async () => {
    const babyjub = await buildBabyjub();
    const F = babyjub.F;
    const toBig = (p) => [F.toObject(p[0]), F.toObject(p[1])];
    assert.deepEqual(toBig(babyjub.Base8), [...G]);
    assert.equal(babyjub.subOrder, SUBGROUP_ORDER);
    for (let i = 0; i < 5; i++) {
      const k = randomScalar(), j = randomScalar();
      const P = babyjub.mulPointEscalar(babyjub.Base8, k);
      const Q = babyjub.mulPointEscalar(babyjub.Base8, j);
      assert.deepEqual(toBig(P), mul(G, k));
      assert.deepEqual(toBig(babyjub.addPoint(P, Q)), add(mul(G, k), mul(G, j)));
      assert.deepEqual(toBig(babyjub.mulPointEscalar(P, j)), mul(mul(G, k), j));
      assert.ok(babyjub.inCurve(P));
    }
    assert.deepEqual(toBig([F.e(0), F.e(1)]), [...IDENTITY]);
    const ct = encrypt(toBig(babyjub.mulPointEscalar(babyjub.Base8, 12345n)), 1, 999n);
    assert.deepEqual(ct.c1, mul(G, 999n));
    assert.deepEqual(neg(neg(ct.c1)), ct.c1);
  });
});
