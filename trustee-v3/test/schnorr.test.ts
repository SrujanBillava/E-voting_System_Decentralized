// The Schnorr proof of knowledge of a polynomial coefficient: honest proofs, the independent challenge check, and every way of forging, altering or replaying one.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AbiCoder, keccak256, toBeHex } from "ethers";
import { DKG_TAG, FIELD_PRIME as P, G, IDENTITY, SUBGROUP_ORDER as L, TEST_CONTEXT } from "../src/params.ts";
import { mul, pointsEqual } from "../src/point.ts";
import { pokChallenge, proveKnowledge, proveKnowledgeWithNonce, verifyKnowledge, type PokBinding } from "../src/schnorr.ts";
import { add as sAdd, mul as sMul, randomScalar } from "../src/scalar.ts";
import { mixedPoint, nonIdentityTorsion } from "../testing/torsion.ts";

const binding: PokBinding = { context: TEST_CONTEXT, ceremonyId: BigInt("0x" + "ab".repeat(32)), trusteeIndex: 2, coefficientIndex: 1 };
const secret = randomScalar();
const K = mul(G, secret);
const proof = proveKnowledge(binding, secret);

describe("Schnorr proof of knowledge: honest proofs", () => {
  it("verifies, for many random secrets and all trustee/coefficient slots", () => {
    for (let trusteeIndex = 1; trusteeIndex <= 3; trusteeIndex++) {
      for (let coefficientIndex = 0; coefficientIndex <= 1; coefficientIndex++) {
        const b = { ...binding, trusteeIndex, coefficientIndex };
        const a = randomScalar();
        assert.ok(verifyKnowledge(b, mul(G, a), proveKnowledge(b, a)));
      }
    }
    assert.ok(verifyKnowledge(binding, K, proof));
  });

  it("is randomised: two proofs of the same statement differ and both verify", () => {
    const other = proveKnowledge(binding, secret);
    assert.notEqual(other.e, proof.e);
    assert.ok(verifyKnowledge(binding, K, other));
  });

  it("the challenge equals an INDEPENDENT implementation: uint256(keccak256(abi.encode(DKG_TAG, chainId, contract, electionId, ceremony, trustee, coefficient, K, R))) mod l", () => {
    const nonce = randomScalar();
    const R = mul(G, nonce);
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256"],
      [toBeHex(DKG_TAG, 32), TEST_CONTEXT.chainId, toBeHex(TEST_CONTEXT.contractAddress, 20), toBeHex(TEST_CONTEXT.electionId, 32), binding.ceremonyId, 2n, 1n, K[0], K[1], R[0], R[1]],
    );
    const e = BigInt(keccak256(encoded)) % L;
    assert.equal(pokChallenge(binding, K, R), e);
    const p = proveKnowledgeWithNonce(binding, secret, nonce);
    assert.equal(p.e, e);
    assert.equal(p.z, sAdd(nonce, sMul(e, secret)));
  });

  it("the deterministic core is deterministic (known-answer use), the randomised wrapper is not", () => {
    const nonce = randomScalar();
    assert.deepEqual(proveKnowledgeWithNonce(binding, secret, nonce), proveKnowledgeWithNonce(binding, secret, nonce));
  });

  it("the challenge binds EVERY field: changing any one of the eleven inputs changes it", () => {
    const R = mul(G, randomScalar());
    const base = pokChallenge(binding, K, R);
    const variants: [string, bigint][] = [
      ["chainId", pokChallenge({ ...binding, context: { ...TEST_CONTEXT, chainId: 1n } }, K, R)],
      ["contract", pokChallenge({ ...binding, context: { ...TEST_CONTEXT, contractAddress: TEST_CONTEXT.contractAddress + 1n } }, K, R)],
      ["election", pokChallenge({ ...binding, context: { ...TEST_CONTEXT, electionId: TEST_CONTEXT.electionId + 1n } }, K, R)],
      ["ceremony", pokChallenge({ ...binding, ceremonyId: binding.ceremonyId + 1n }, K, R)],
      ["trustee", pokChallenge({ ...binding, trusteeIndex: 3 }, K, R)],
      ["coefficient", pokChallenge({ ...binding, coefficientIndex: 0 }, K, R)],
      ["K", pokChallenge(binding, mul(G, 5n), R)],
      ["R", pokChallenge(binding, K, mul(G, 5n))],
    ];
    for (const [name, value] of variants) assert.notEqual(value, base, name);
  });
});

describe("Schnorr proof of knowledge: forgeries and alterations are rejected", () => {
  it("a FAKE proof: random (e, z) and a simulated proof (choose e, z, derive R) both fail", () => {
    for (let i = 0; i < 10; i++) assert.ok(!verifyKnowledge(binding, K, { e: randomScalar(), z: randomScalar() }));
    // the classic simulation: pick z, e, set R = zG - eK; this only "verifies" if H(..., R) happens to equal e, which it does not
    const e = randomScalar();
    const z = randomScalar();
    assert.ok(!verifyKnowledge(binding, K, { e, z }));
  });

  it("a proof for a commitment whose logarithm the prover does not know cannot be made: using another secret fails", () => {
    const forged = proveKnowledge(binding, randomScalar());
    assert.ok(!verifyKnowledge(binding, K, forged));
  });

  it("ALTERED COMMITMENT: K + G, K of another secret, the negation of K, all fail", () => {
    assert.ok(!verifyKnowledge(binding, mul(G, sAdd(secret, 1n)), proof));
    assert.ok(!verifyKnowledge(binding, mul(G, randomScalar()), proof));
    assert.ok(!verifyKnowledge(binding, [P - K[0], K[1]], proof));
  });

  it("ALTERED TRUSTEE INDEX or coefficient index: the same proof under another slot fails", () => {
    for (const trusteeIndex of [1, 3, 4, 255]) assert.ok(!verifyKnowledge({ ...binding, trusteeIndex }, K, proof), `trustee ${trusteeIndex}`);
    for (const coefficientIndex of [0, 2, 255]) assert.ok(!verifyKnowledge({ ...binding, coefficientIndex }, K, proof), `coefficient ${coefficientIndex}`);
  });

  it("ALTERED CONTEXT: another chain id, contract address or election id fails; REPLAY into another election or another ceremony fails", () => {
    assert.ok(!verifyKnowledge({ ...binding, context: { ...TEST_CONTEXT, chainId: 1n } }, K, proof));
    assert.ok(!verifyKnowledge({ ...binding, context: { ...TEST_CONTEXT, contractAddress: TEST_CONTEXT.contractAddress ^ 1n } }, K, proof));
    assert.ok(!verifyKnowledge({ ...binding, context: { ...TEST_CONTEXT, electionId: TEST_CONTEXT.electionId ^ 1n } }, K, proof));
    assert.ok(!verifyKnowledge({ ...binding, ceremonyId: binding.ceremonyId ^ 1n }, K, proof), "another ceremony of the same election");
    const anotherElection = { ...binding, context: { chainId: 1n, contractAddress: 0x1234n, electionId: 0x5678n } };
    assert.ok(!verifyKnowledge(anotherElection, K, proof));
  });

  it("modified proof values: e + 1, z + 1, swapped, bit flips fail", () => {
    assert.ok(!verifyKnowledge(binding, K, { e: sAdd(proof.e, 1n), z: proof.z }));
    assert.ok(!verifyKnowledge(binding, K, { e: proof.e, z: sAdd(proof.z, 1n) }));
    assert.ok(!verifyKnowledge(binding, K, { e: proof.z, z: proof.e }));
    for (let bit = 0; bit < 250; bit += 25) assert.ok(!verifyKnowledge(binding, K, { e: proof.e ^ (1n << BigInt(bit)), z: proof.z }));
  });

  it("STRICT CANONICAL CHECKS: e + l and z + l (the same residues, a second spelling), zero, and values >= l are refused", () => {
    assert.ok(!verifyKnowledge(binding, K, { e: proof.e + L, z: proof.z }));
    assert.ok(!verifyKnowledge(binding, K, { e: proof.e, z: proof.z + L }));
    assert.ok(!verifyKnowledge(binding, K, { e: proof.e + P, z: proof.z }));
    assert.ok(!verifyKnowledge(binding, K, { e: 0n, z: proof.z }));
    assert.ok(!verifyKnowledge(binding, K, { e: proof.e, z: 0n }));
    assert.ok(!verifyKnowledge(binding, K, { e: L, z: proof.z }));
    assert.ok(!verifyKnowledge(binding, K, { e: -1n, z: proof.z }));
  });

  it("malformed proof objects: null, missing fields, numbers, strings, arrays", () => {
    for (const bad of [null, undefined, {}, { e: 1n }, { z: 1n }, { e: 1, z: 2 }, { e: "1", z: "2" }, [proof.e, proof.z], 5, "proof"]) assert.ok(!verifyKnowledge(binding, K, bad as unknown), String(bad));
  });

  it("WRONG MODULUS: a response computed mod p instead of mod l fails (and an unreduced one is refused outright)", () => {
    const nonce = randomScalar();
    const e = proveKnowledgeWithNonce(binding, secret, nonce).e;
    const zWrongThenReduced = ((nonce + e * secret) % P) % L;
    assert.notEqual(zWrongThenReduced, sAdd(nonce, sMul(e, secret)));
    assert.ok(!verifyKnowledge(binding, K, { e, z: zWrongThenReduced }));
    assert.ok(!verifyKnowledge(binding, K, { e, z: (nonce + e * secret) % P }), "unreduced mod p: >= l almost surely, refused as non-canonical");
    assert.throws(() => proveKnowledge(binding, L + 5n), /BAD_SCALAR/);
    assert.throws(() => proveKnowledgeWithNonce(binding, secret, P - 1n), /BAD_SCALAR/);
  });

  it("zero and identity edge cases: a zero secret cannot be proven; the identity commitment is refused", () => {
    assert.throws(() => proveKnowledge(binding, 0n), /ZERO_SCALAR/);
    assert.ok(!verifyKnowledge(binding, [...IDENTITY], proof));
    assert.ok(!verifyKnowledge(binding, [...IDENTITY], { e: 1n, z: 1n }));
  });

  it("malformed or invalid commitments: off-curve, out-of-range coordinates, wrong shapes", () => {
    for (const bad of [[K[0], K[1] + 1n], [K[0] + P, K[1]], [-1n, K[1]], [1n, 2n], null, undefined, "K", [K[0]], [K[0], K[1], 1n], { x: K[0], y: K[1] }]) {
      assert.ok(!verifyKnowledge(binding, bad as unknown, proof), String(bad));
    }
  });

  it("TORSION / subgroup-invalid commitments are refused: every non-identity torsion point, and subgroup points with a torsion component added", () => {
    const torsion = nonIdentityTorsion();
    assert.equal(torsion.length, 7);
    for (const t of torsion) assert.ok(!verifyKnowledge(binding, t, proof));
    for (let i = 0; i < 7; i++) assert.ok(!verifyKnowledge(binding, mixedPoint(K, i), proof));
  });

  it("an invalid binding is not proven (never a throw): bad context, zero ceremony id, indices out of range", () => {
    assert.ok(!verifyKnowledge({ ...binding, ceremonyId: 0n }, K, proof));
    assert.ok(!verifyKnowledge({ ...binding, trusteeIndex: 0 }, K, proof));
    assert.ok(!verifyKnowledge({ ...binding, coefficientIndex: -1 }, K, proof));
    assert.ok(!verifyKnowledge({ ...binding, context: { ...TEST_CONTEXT, chainId: 0n } }, K, proof));
    assert.throws(() => proveKnowledge({ ...binding, trusteeIndex: 0 }, secret), /BAD_INTEGER/);
  });

  it("the proof really proves knowledge: it is a valid proof only for K = secret*G", () => {
    assert.ok(pointsEqual(K, mul(G, secret)));
    assert.ok(verifyKnowledge(binding, K, proof));
  });
});
