// The Chaum-Pedersen proof of a partial decryption: honest proofs, the independent challenge check, and the full adversarial list.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AbiCoder, keccak256, toBeHex } from "ethers";
import { decryptionChallenge, proveDecryptionShare, proveDecryptionShareWithNonce, verifyDecryptionShare, type DecryptionBinding } from "../src/chaum-pedersen.ts";
import { FIELD_PRIME as P, G, IDENTITY, PDEC_TAG, SUBGROUP_ORDER as L, TEST_CONTEXT } from "../src/params.ts";
import { add, mul, neg, pointsEqual } from "../src/point.ts";
import { add as sAdd, mul as sMul, randomScalar } from "../src/scalar.ts";
import { mixedPoint, nonIdentityTorsion } from "../testing/torsion.ts";

const constituencyId = BigInt("0x" + "c0".repeat(32));
const binding: DecryptionBinding = { context: TEST_CONTEXT, constituencyId, slot: 2, trusteeIndex: 3 };
const s = randomScalar();
const vk = mul(G, s);
const A = mul(G, randomScalar());
const { D, proof } = proveDecryptionShare(binding, s, A);
const ok = (b: DecryptionBinding, key: unknown, aggregate: unknown, partial: unknown, pr: unknown): boolean => verifyDecryptionShare(b, key, aggregate, partial, pr);

describe("Chaum-Pedersen: honest proofs", () => {
  it("D = s*A, and the proof verifies, for many random shares, aggregates, slots and trustees", () => {
    assert.ok(pointsEqual(D, mul(A, s)));
    assert.ok(ok(binding, vk, A, D, proof));
    for (let i = 0; i < 12; i++) {
      const secret = randomScalar();
      const agg = mul(G, randomScalar());
      const b = { ...binding, slot: i % 16, trusteeIndex: 1 + (i % 3) };
      const r = proveDecryptionShare(b, secret, agg);
      assert.ok(ok(b, mul(G, secret), agg, r.D, r.proof));
    }
  });

  it("is randomised, and the deterministic core is deterministic", () => {
    const again = proveDecryptionShare(binding, s, A);
    assert.ok(pointsEqual(again.D, D));
    assert.notEqual(again.proof.e, proof.e);
    assert.ok(ok(binding, vk, A, again.D, again.proof));
    const nonce = randomScalar();
    assert.deepEqual(proveDecryptionShareWithNonce(binding, s, A, nonce), proveDecryptionShareWithNonce(binding, s, A, nonce));
  });

  it("the challenge equals an INDEPENDENT implementation: uint256(keccak256(abi.encode(PDEC_TAG, chainId, contract, electionId, constituency, slot, trustee, vk, A, D, a, b))) mod l", () => {
    const nonce = randomScalar();
    const a = mul(G, nonce);
    const b = mul(A, nonce);
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256", "uint256", ...Array(10).fill("uint256")],
      [toBeHex(PDEC_TAG, 32), TEST_CONTEXT.chainId, toBeHex(TEST_CONTEXT.contractAddress, 20), toBeHex(TEST_CONTEXT.electionId, 32), toBeHex(constituencyId, 32), 2n, 3n, vk[0], vk[1], A[0], A[1], D[0], D[1], a[0], a[1], b[0], b[1]],
    );
    const e = BigInt(keccak256(encoded)) % L;
    assert.equal(decryptionChallenge(binding, vk, A, D, a, b), e);
    const result = proveDecryptionShareWithNonce(binding, s, A, nonce);
    assert.equal(result.proof.e, e);
    assert.equal(result.proof.z, sAdd(nonce, sMul(e, s)));
  });

  it("the challenge binds EVERY field: context (3), constituency, slot, trustee, vk, A, D, a, b", () => {
    const a = mul(G, randomScalar());
    const b = mul(G, randomScalar());
    const base = decryptionChallenge(binding, vk, A, D, a, b);
    const other = mul(G, 7n);
    const variants: [string, bigint][] = [
      ["chainId", decryptionChallenge({ ...binding, context: { ...TEST_CONTEXT, chainId: 2n } }, vk, A, D, a, b)],
      ["contract", decryptionChallenge({ ...binding, context: { ...TEST_CONTEXT, contractAddress: 5n } }, vk, A, D, a, b)],
      ["election", decryptionChallenge({ ...binding, context: { ...TEST_CONTEXT, electionId: 5n } }, vk, A, D, a, b)],
      ["constituency", decryptionChallenge({ ...binding, constituencyId: constituencyId + 1n }, vk, A, D, a, b)],
      ["slot", decryptionChallenge({ ...binding, slot: 3 }, vk, A, D, a, b)],
      ["trustee", decryptionChallenge({ ...binding, trusteeIndex: 2 }, vk, A, D, a, b)],
      ["vk", decryptionChallenge(binding, other, A, D, a, b)],
      ["A", decryptionChallenge(binding, vk, other, D, a, b)],
      ["D", decryptionChallenge(binding, vk, A, other, a, b)],
      ["a", decryptionChallenge(binding, vk, A, D, other, b)],
      ["b", decryptionChallenge(binding, vk, A, D, a, other)],
    ];
    for (const [name, value] of variants) assert.notEqual(value, base, name);
  });
});

describe("Chaum-Pedersen: wrong share, wrong key, modified values", () => {
  it("WRONG TRUSTEE SHARE: a partial decryption made with a different share fails against the real verification key", () => {
    const wrong = proveDecryptionShare(binding, sAdd(s, 1n), A);
    assert.ok(!ok(binding, vk, A, wrong.D, wrong.proof));
    assert.ok(!ok(binding, vk, A, mul(A, sAdd(s, 1n)), proof), "a wrong D under an honest proof");
    assert.ok(!ok(binding, vk, A, D, proveDecryptionShare(binding, randomScalar(), A).proof));
  });

  it("a CONSISTENT-LOOKING lie fails: D = s'*A with vk' = s'*G proves nothing about the REAL vk", () => {
    const sPrime = randomScalar();
    const lie = proveDecryptionShare(binding, sPrime, A);
    assert.ok(ok(binding, mul(G, sPrime), A, lie.D, lie.proof), "it is a perfectly valid proof for vk'");
    assert.ok(!ok(binding, vk, A, lie.D, lie.proof), "but not for the key the trustee is bound to");
  });

  it("WRONG VERIFICATION KEY: another trustee's vk, a random key, the negated key", () => {
    assert.ok(!ok(binding, mul(G, randomScalar()), A, D, proof));
    assert.ok(!ok(binding, neg(vk), A, D, proof));
    assert.ok(!ok(binding, add(vk, G), A, D, proof));
  });

  it("MODIFIED D: D + G, -D, another trustee's D, the identity", () => {
    assert.ok(!ok(binding, vk, A, add(D, G), proof));
    assert.ok(!ok(binding, vk, A, neg(D), proof));
    assert.ok(!ok(binding, vk, A, mul(A, randomScalar()), proof));
    assert.ok(!ok(binding, vk, A, [...IDENTITY], proof));
  });

  it("MODIFIED PROOF e or z: +1, swapped, bit flips", () => {
    assert.ok(!ok(binding, vk, A, D, { e: sAdd(proof.e, 1n), z: proof.z }));
    assert.ok(!ok(binding, vk, A, D, { e: proof.e, z: sAdd(proof.z, 1n) }));
    assert.ok(!ok(binding, vk, A, D, { e: proof.z, z: proof.e }));
    for (let bit = 0; bit < 250; bit += 25) {
      assert.ok(!ok(binding, vk, A, D, { e: proof.e ^ (1n << BigInt(bit)), z: proof.z }));
      assert.ok(!ok(binding, vk, A, D, { e: proof.e, z: proof.z ^ (1n << BigInt(bit)) }));
    }
  });

  it("STRICT CANONICAL checks: e + l, z + l, p-sized values, zero and negative scalars are refused", () => {
    for (const bad of [{ e: proof.e + L, z: proof.z }, { e: proof.e, z: proof.z + L }, { e: proof.e + P, z: proof.z }, { e: 0n, z: proof.z }, { e: proof.e, z: 0n }, { e: L, z: proof.z }, { e: -proof.e, z: proof.z }]) {
      assert.ok(!ok(binding, vk, A, D, bad));
    }
    for (const bad of [null, undefined, {}, { e: 1n }, { e: 1, z: 2 }, ["x"], 7]) assert.ok(!ok(binding, vk, A, D, bad as unknown), String(bad));
  });
});

describe("Chaum-Pedersen: replay and relabelling", () => {
  it("a proof reused for ANOTHER CANDIDATE SLOT fails", () => {
    for (const slot of [0, 1, 3, 15]) assert.ok(!ok({ ...binding, slot }, vk, A, D, proof), `slot ${slot}`);
  });

  it("a proof reused for ANOTHER CONSTITUENCY fails", () => {
    assert.ok(!ok({ ...binding, constituencyId: constituencyId + 1n }, vk, A, D, proof));
    assert.ok(!ok({ ...binding, constituencyId: constituencyId ^ (1n << 255n) }, vk, A, D, proof));
  });

  it("a proof reused for ANOTHER ELECTION / CONTEXT fails: chain id, contract address, election id", () => {
    assert.ok(!ok({ ...binding, context: { ...TEST_CONTEXT, chainId: 1n } }, vk, A, D, proof));
    assert.ok(!ok({ ...binding, context: { ...TEST_CONTEXT, contractAddress: TEST_CONTEXT.contractAddress ^ 1n } }, vk, A, D, proof));
    assert.ok(!ok({ ...binding, context: { ...TEST_CONTEXT, electionId: TEST_CONTEXT.electionId ^ 1n } }, vk, A, D, proof));
  });

  it("a proof reused for ANOTHER AGGREGATE A fails", () => {
    const other = mul(G, randomScalar());
    assert.ok(!ok(binding, vk, other, D, proof));
    assert.ok(!ok(binding, vk, other, mul(other, s), proof), "even with the matching D: the proof is bound to this A");
  });

  it("DUPLICATE TRUSTEE pretending to be a second trustee: trustee 1's partial decryption relabelled as trustee 2 (or 3) fails, under either verification key", () => {
    const one: DecryptionBinding = { ...binding, trusteeIndex: 1 };
    const s1 = randomScalar();
    const s2 = randomScalar();
    const vk1 = mul(G, s1);
    const vk2 = mul(G, s2);
    const p1 = proveDecryptionShare(one, s1, A);
    assert.ok(ok(one, vk1, A, p1.D, p1.proof));
    assert.ok(!ok({ ...one, trusteeIndex: 2 }, vk2, A, p1.D, p1.proof), "relabelled and checked against trustee 2's key");
    assert.ok(!ok({ ...one, trusteeIndex: 2 }, vk1, A, p1.D, p1.proof), "relabelled but checked against its own key: the index is bound in the challenge");
    assert.ok(!ok({ ...one, trusteeIndex: 3 }, vk1, A, p1.D, p1.proof));
  });
});

describe("Chaum-Pedersen: invalid points", () => {
  it("MALFORMED POINTS for vk, A or D: off-curve, non-canonical coordinates, wrong shapes", () => {
    const bads: unknown[] = [[D[0], D[1] + 1n], [D[0] + P, D[1]], [-1n, 1n], [1n, 2n], null, undefined, "D", [D[0]], { x: 1n, y: 2n }, [1, 2]];
    for (const bad of bads) {
      assert.ok(!ok(binding, bad, A, D, proof), `vk ${String(bad)}`);
      assert.ok(!ok(binding, vk, bad, D, proof), `A ${String(bad)}`);
      assert.ok(!ok(binding, vk, A, bad, proof), `D ${String(bad)}`);
    }
  });

  it("TORSION / subgroup-invalid points are refused in every position: pure torsion, and subgroup points with a torsion component added", () => {
    const torsion = nonIdentityTorsion();
    for (const t of torsion) {
      assert.ok(!ok(binding, t, A, D, proof), "vk");
      assert.ok(!ok(binding, vk, t, D, proof), "A");
      assert.ok(!ok(binding, vk, A, t, proof), "D");
    }
    for (let i = 0; i < 7; i++) {
      assert.ok(!ok(binding, mixedPoint(vk, i), A, D, proof), "vk + torsion");
      assert.ok(!ok(binding, vk, mixedPoint(A, i), D, proof), "A + torsion");
      assert.ok(!ok(binding, vk, A, mixedPoint(D, i), proof), "D + torsion");
    }
    assert.throws(() => proveDecryptionShare(binding, s, torsion[0]!), /BAD_POINT/);
    assert.throws(() => proveDecryptionShare(binding, s, mixedPoint(A, 3)), /BAD_POINT/);
  });

  it("IDENTITY edge cases: A = identity (the statement means nothing), D = identity, vk = identity are all refused; a zero share cannot be proven", () => {
    assert.throws(() => proveDecryptionShare(binding, s, IDENTITY), /IDENTITY_POINT/);
    assert.ok(!ok(binding, vk, [...IDENTITY], [...IDENTITY], proof));
    assert.ok(!ok(binding, vk, A, [...IDENTITY], proof));
    assert.ok(!ok(binding, [...IDENTITY], A, D, proof));
    assert.throws(() => proveDecryptionShare(binding, 0n, A), /ZERO_SCALAR/);
  });

  it("WRONG SCALAR MODULUS: a response computed mod p (reduced or not) fails; shares and nonces that are not reduced mod l are refused by the prover", () => {
    const nonce = randomScalar();
    const honest = proveDecryptionShareWithNonce(binding, s, A, nonce);
    const e = honest.proof.e;
    assert.ok(!ok(binding, vk, A, D, { e, z: ((nonce + e * s) % P) % L }));
    assert.ok(!ok(binding, vk, A, D, { e, z: (nonce + e * s) % P }));
    assert.throws(() => proveDecryptionShare(binding, L + 3n, A), /BAD_SCALAR/);
    assert.throws(() => proveDecryptionShare(binding, P - 1n, A), /BAD_SCALAR/);
    assert.throws(() => proveDecryptionShareWithNonce(binding, s, A, L), /BAD_SCALAR/);
  });

  it("an invalid binding is not proven (never a throw in the verifier): bad slot, bad trustee, bad context, zero constituency", () => {
    assert.ok(!ok({ ...binding, slot: 16 }, vk, A, D, proof));
    assert.ok(!ok({ ...binding, slot: -1 }, vk, A, D, proof));
    assert.ok(!ok({ ...binding, trusteeIndex: 0 }, vk, A, D, proof));
    assert.ok(!ok({ ...binding, constituencyId: 0n }, vk, A, D, proof));
    assert.ok(!ok({ ...binding, context: { ...TEST_CONTEXT, electionId: 0n } }, vk, A, D, proof));
  });
});
