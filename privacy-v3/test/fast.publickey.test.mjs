// Election public key H: the reusable validation, and the two places that enforce it (the voter before encrypting, the ballot box at construction).
// circomlib's variable-base multiplication ASSUMES the base point is in the prime-order subgroup and is not the identity, and the circuit only checks
// "on the curve and x != 0", so these tests are what stands between a malformed key and an encrypted vote.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BallotBox } from "../src/ballotbox.js";
import { add, assertValidPublicKey, generateTestKeyPair, isIdentity, mul, validatePublicKey } from "../src/elgamal.js";
import { FIELD_PRIME, SUBGROUP_ORDER, TEST_CONTEXT } from "../src/params.js";
import { castBallot, prepareBallot } from "../src/voter.js";
import { fakeVoter } from "../testing/fake-voters.js";
import { curvePoints, torsionOrder, torsionSubgroup } from "./curve.mjs";

const ctx = TEST_CONTEXT;
const MESSAGE = /invalid election public key/;

describe("election public key validation (validatePublicKey / assertValidPublicKey)", () => {
  const honest = Array.from({ length: 4 }, () => generateTestKeyPair().publicKey);
  const torsion = torsionSubgroup();
  const nonIdentityTorsion = torsion.filter((t) => !isIdentity(t));

  it("accepts honestly generated keys", () => {
    for (const H of honest) {
      assert.equal(validatePublicKey(H), true);
      assert.doesNotThrow(() => assertValidPublicKey(H));
    }
  });

  it("rejects the identity point, canonical and unreduced", () => {
    for (const bad of [[0n, 1n], [FIELD_PRIME, 1n], [0n, FIELD_PRIME + 1n], [FIELD_PRIME, FIELD_PRIME + 1n]]) {
      assert.equal(validatePublicKey(bad), false, String(bad));
      assert.throws(() => assertValidPublicKey(bad), MESSAGE);
    }
  });

  it("the torsion subgroup E[8] has exactly the expected shape (so the next two tests really cover all of it)", () => {
    assert.equal(torsion.length, 8);
    assert.deepEqual(torsion.map(torsionOrder).sort((a, b) => a - b), [1, 2, 4, 4, 8, 8, 8, 8], "one identity, one point of order 2, two of order 4, four of order 8");
  });

  it("rejects EVERY non-identity point of the torsion subgroup: the order-2 point (0,-1), both order-4 and all four order-8 points", () => {
    assert.equal(nonIdentityTorsion.length, 7);
    for (const t of nonIdentityTorsion) {
      assert.equal(validatePublicKey(t), false, `order ${torsionOrder(t)} point ${t[0]}:${t[1]}`);
      assert.throws(() => assertValidPublicKey(t), MESSAGE);
    }
    assert.equal(validatePublicKey([0n, FIELD_PRIME - 1n]), false, "(0,-1)");
  });

  it("rejects a valid subgroup key with ANY torsion component added (H + t on the curve, but outside the prime-order subgroup); H + identity is H", () => {
    for (const H of honest) {
      for (const t of nonIdentityTorsion) {
        const mixed = add(H, t);
        assert.equal(validatePublicKey(mixed), false, `H + order ${torsionOrder(t)}`);
        assert.ok(!isIdentity(mul(mixed, SUBGROUP_ORDER)), "it really is outside the subgroup");
      }
      assert.equal(validatePublicKey(add(H, [0n, 1n])), true);
    }
  });

  it("on random curve points, validation accepts exactly those inside the prime-order subgroup (l*P = identity) and nothing else", () => {
    const sample = curvePoints(300).slice(0, 80);
    let inside = 0;
    let outside = 0;
    for (const point of sample) {
      const inSubgroup = isIdentity(mul(point, SUBGROUP_ORDER));
      assert.equal(validatePublicKey(point), inSubgroup);
      if (inSubgroup) inside++;
      else outside++;
    }
    assert.ok(outside > 0, "the sample contains points outside the subgroup (cofactor 8: about 7 in 8)");
    assert.ok(inside + outside === sample.length);
  });

  it("rejects off-curve points", () => {
    const [x, y] = honest[0];
    for (const bad of [[x, y + 1n], [x + 1n, y], [1n, 1n], [2n, 3n], [x, FIELD_PRIME - 1n], [y, x]]) {
      assert.equal(validatePublicKey(bad), false, `${bad[0]}:${bad[1]}`);
      assert.throws(() => assertValidPublicKey(bad), MESSAGE);
    }
  });

  it("rejects malformed encodings (wrong types, lengths, negative or non-canonical numbers)", () => {
    const [x, y] = honest[1];
    const cases = [null, undefined, "H", 7, {}, [], [x], [x, y, 1n], [Number(x), Number(y)], [x.toString(), y.toString()], [-x, y], [x, -y], [x, y + FIELD_PRIME], [x + FIELD_PRIME, y], new Uint8Array(64), [true, false]];
    for (const bad of cases) {
      assert.equal(validatePublicKey(bad), false, `${typeof bad}: ${String(bad).slice(0, 40)}`);
      assert.throws(() => assertValidPublicKey(bad), MESSAGE);
    }
  });
});

describe("the validation is ENFORCED where the key is used", () => {
  const good = generateTestKeyPair().publicKey;
  const torsion = torsionSubgroup().filter((t) => !isIdentity(t));
  const badKeys = {
    "the identity": [0n, 1n],
    "the order-2 point": [0n, FIELD_PRIME - 1n],
    "an order-4 point": torsion.find((t) => torsionOrder(t) === 4),
    "an order-8 point": torsion.find((t) => torsionOrder(t) === 8),
    "a subgroup key plus an order-8 component": add(good, torsion.find((t) => torsionOrder(t) === 8)),
    "an off-curve point": [good[0], good[1] + 1n],
  };

  for (const [name, H] of Object.entries(badKeys)) {
    it(`voter side: no ballot is encrypted under ${name}`, async () => {
      const args = { identity: fakeVoter("key-check"), ctx, constituency: "KA-BLR", kc: 3, choice: 1, H };
      assert.throws(() => prepareBallot(args), MESSAGE);
      await assert.rejects(castBallot({ ...args, group: null }), MESSAGE); // rejected before any proof work: nothing was encrypted or proven
    });

    it(`verifier side: a ballot box cannot be created with ${name} as the election key`, () => {
      assert.throws(() => new BallotBox({ ctx, publicKey: H, constituencies: {} }), MESSAGE);
    });
  }

  it("control: a valid key is accepted by both the voter side and the ballot box", () => {
    const ballot = prepareBallot({ identity: fakeVoter("key-check"), ctx, constituency: "KA-BLR", kc: 3, choice: 1, H: good });
    assert.equal(ballot.ciphertexts.length, 16);
    assert.doesNotThrow(() => new BallotBox({ ctx, publicKey: good, constituencies: {} }));
  });
});
