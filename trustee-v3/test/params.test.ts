// The frozen parameters: the SAME BabyJubJub system validated in privacy-v3, and the scalar modulus l from the frozen architecture.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { id as keccakOfText } from "ethers";
import { CEREMONY_TAG, DEFAULT_MIN_BALLOTS, DEFAULT_THRESHOLD, DEFAULT_TRUSTEES, DKG_TAG, FIELD_PRIME, G, IDENTITY, MAX_BALLOT_COUNT, MAX_SLOTS, PDEC_TAG, SUBGROUP_ORDER, TEST_CONTEXT, TRANSCRIPT_TAG } from "../src/params.ts";
import { add, isInSubgroup, isOnCurve, mul, pointsEqual } from "../src/point.ts";
import { pv3 } from "../testing/pv3.ts";

/** deterministic Miller-Rabin with the first 12 primes as bases (exact for all n < 3.3e24, overwhelming beyond) */
function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false;
  const bases = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const b of bases) if (n % b === 0n) return n === b;
  let d = n - 1n;
  let s = 0;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s++;
  }
  const pow = (b: bigint, e: bigint): bigint => {
    let r = 1n;
    b %= n;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % n;
      b = (b * b) % n;
      e >>= 1n;
    }
    return r;
  };
  outer: for (const a of bases) {
    let x = pow(a, d);
    if (x === 1n || x === n - 1n) continue;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) continue outer;
    }
    return false;
  }
  return true;
}

describe("frozen parameters", () => {
  it("l is exactly the subgroup order from the frozen architecture, and is prime and odd", () => {
    assert.equal(SUBGROUP_ORDER, 2736030358979909402780800718157159386076813972158567259200215660948447373041n);
    assert.ok(isProbablePrime(SUBGROUP_ORDER));
    assert.equal(SUBGROUP_ORDER % 2n, 1n);
    assert.ok(SUBGROUP_ORDER < FIELD_PRIME, "l < p: the scalar modulus is NOT the field prime");
    assert.notEqual(SUBGROUP_ORDER, FIELD_PRIME);
  });

  it("p is the BN254 scalar field and is prime", () => {
    assert.equal(FIELD_PRIME, 21888242871839275222246405745257275088548364400416034343698204186575808495617n);
    assert.ok(isProbablePrime(FIELD_PRIME));
  });

  it("G is the circomlib Base8 generator: on the curve, in the prime-order subgroup, order exactly l, and not the identity", () => {
    assert.deepEqual([...G], [5299619240641551281634865583518297030282874472190772894086521144482721001553n, 16950150798460657717958625567821834550301663161624707787222815936182638968203n]);
    assert.ok(isOnCurve(G));
    assert.ok(isInSubgroup(G));
    assert.ok(!pointsEqual(G, IDENTITY));
    assert.ok(pointsEqual(mul(G, 0n), IDENTITY));
    assert.ok(pointsEqual(add(mul(G, SUBGROUP_ORDER - 1n), G), IDENTITY), "(l-1)G + G = identity, so the order divides l, and l is prime");
  });

  it("the identity is (0, 1) and is on the curve", () => {
    assert.deepEqual([...IDENTITY], [0n, 1n]);
    assert.ok(isOnCurve(IDENTITY));
  });

  it("every constant equals the one privacy-v3 uses (the toolkit has no private copy that could drift unnoticed)", () => {
    assert.equal(SUBGROUP_ORDER, pv3.params.SUBGROUP_ORDER);
    assert.equal(FIELD_PRIME, pv3.params.FIELD_PRIME);
    assert.deepEqual([...G], [...pv3.params.G]);
    assert.deepEqual([...IDENTITY], [...pv3.params.IDENTITY]);
    assert.deepEqual(TEST_CONTEXT, pv3.params.TEST_CONTEXT);
    assert.equal(MAX_SLOTS, pv3.params.K_MAX);
  });

  it("3 trustees, threshold 2; at most 16 slots; at most 2^20 ballots per constituency (a depth-20 group)", () => {
    assert.equal(DEFAULT_TRUSTEES, 3);
    assert.equal(DEFAULT_THRESHOLD, 2);
    assert.equal(MAX_SLOTS, 16);
    assert.equal(MAX_BALLOT_COUNT, 1048576);
    assert.equal(DEFAULT_MIN_BALLOTS, 2);
  });

  it("the domain tags are keccak256 of their labels, pairwise distinct, and versioned", () => {
    const expected: [bigint, string][] = [
      [CEREMONY_TAG, "VOTECHAIN-V3-DKG-CEREMONY-1"],
      [DKG_TAG, "VOTECHAIN-V3-DKG-1"],
      [TRANSCRIPT_TAG, "VOTECHAIN-V3-DKG-TRANSCRIPT-1"],
      [PDEC_TAG, "VOTECHAIN-V3-PDEC-1"],
    ];
    for (const [tag, label] of expected) assert.equal(tag, BigInt(keccakOfText(label)), label);
    assert.equal(new Set(expected.map(([t]) => t)).size, expected.length);
  });
});
