import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Interface, keccak256 } from "ethers";
import { loadAbi } from "../../src/chain/abi.js";
import { FIELD_PRIME, canonicalPackage } from "../../src/services/ballotPackage.js";

const iface = loadAbi().voteChain;
const d = (n) => BigInt(n).toString();
/** a structurally valid package for a 3-candidate constituency (the proofs are junk: only the contract can judge them) */
const sample = () => ({
  constituencyId: "0x" + "ab".repeat(32),
  membership: { merkleTreeDepth: "20", merkleTreeRoot: d(111), nullifier: d(222), points: Array.from({ length: 8 }, (_, i) => d(1000 + i)) },
  coords: Array.from({ length: 12 }, (_, i) => d(5000 + i)),
  validity: { a: [d(1), d(2)], b: [[d(3), d(4)], [d(5), d(6)]], c: [d(7), d(8)] },
});
const refusal = (body) => {
  try {
    canonicalPackage(body, iface);
    return null;
  } catch (err) {
    return err.code;
  }
};

describe("the anonymous ballot package: validation and ONE canonical representation", () => {
  it("is the ABI call data of submitBallot, and its keccak256 is the package hash", () => {
    const pkg = canonicalPackage(sample(), iface);
    assert.equal(pkg.calldata.slice(0, 10), iface.getFunction("submitBallot").selector);
    assert.equal(pkg.packageHash, keccak256(pkg.calldata));
    assert.equal(pkg.nullifier, "222");
    assert.equal(pkg.coords.length, 12);
    assert.equal(pkg.constituencyId, "0x" + "ab".repeat(32));
    const decoded = iface.decodeFunctionData("submitBallot", pkg.calldata);
    assert.equal(decoded[2].length, 12);
  });

  it("is independent of key order and of the case of the constituency id: the same package always has the same hash", () => {
    const a = canonicalPackage(sample(), iface);
    const s = sample();
    const shuffled = { validity: { c: s.validity.c, b: s.validity.b, a: s.validity.a }, coords: s.coords, constituencyId: s.constituencyId.toUpperCase().replace("0X", "0x"), membership: { points: s.membership.points, nullifier: s.membership.nullifier, merkleTreeRoot: s.membership.merkleTreeRoot, merkleTreeDepth: s.membership.merkleTreeDepth } };
    const b = canonicalPackage(shuffled, iface);
    assert.equal(a.packageHash, b.packageHash);
    assert.equal(a.calldata, b.calldata);
  });

  it("any change to any field changes the hash (so 'the same package' means exactly the same package)", () => {
    const base = canonicalPackage(sample(), iface).packageHash;
    const seen = new Set([base]);
    const mutate = (fn) => {
      const s = sample();
      fn(s);
      const h = canonicalPackage(s, iface).packageHash;
      assert.ok(!seen.has(h), "a changed field gave an already-seen hash");
      seen.add(h);
    };
    mutate((s) => (s.membership.merkleTreeRoot = d(112)));
    mutate((s) => (s.membership.nullifier = d(223)));
    mutate((s) => (s.membership.points[7] = d(9999)));
    mutate((s) => (s.coords[11] = d(1)));
    mutate((s) => (s.validity.a[1] = d(9)));
    mutate((s) => (s.validity.b[1][0] = d(9)));
    mutate((s) => (s.validity.c[0] = d(9)));
    mutate((s) => (s.constituencyId = "0x" + "cd".repeat(32)));
    mutate((s) => s.coords.push(d(1), d(2), d(3), d(4)));
  });

  it("refuses everything that is not exactly the package: extra keys at every level, wrong types, wrong spellings, wrong sizes", () => {
    assert.equal(canonicalPackage(sample(), iface).nullifier, "222");
    const cases = [
      (s) => (s.voterId = "VC-AAAAAAAAAA"),
      (s) => (s.membership.uid = "x"),
      (s) => (s.validity.token = "x"),
      (s) => (s.membership.nullifier = 222),
      (s) => (s.membership.nullifier = "0x de".replace(" ", "")),
      (s) => (s.membership.nullifier = "00222"),
      (s) => (s.membership.nullifier = "-222"),
      (s) => (s.membership.points = s.membership.points.slice(1)),
      (s) => (s.coords = s.coords.slice(0, 11)),
      (s) => (s.coords = []),
      (s) => (s.validity.b = [[d(3), d(4)]]),
      (s) => (s.constituencyId = "0xabc"),
    ];
    for (const [i, mutate] of cases.entries()) {
      const s = sample();
      mutate(s);
      assert.equal(refusal(s), "VALIDATION_FAILED", `case ${i}`);
    }
    for (const bad of [null, undefined, [], "x", 5, true]) assert.equal(refusal(bad), "VALIDATION_FAILED");
  });

  it("local checks mirror the contract's: depth 20, nullifier and every coordinate inside the field", () => {
    const wrongDepth = sample();
    wrongDepth.membership.merkleTreeDepth = "19";
    assert.equal(refusal(wrongDepth), "WRONG_SEMAPHORE_DEPTH");
    const outNullifier = sample();
    outNullifier.membership.nullifier = FIELD_PRIME.toString();
    assert.equal(refusal(outNullifier), "NULLIFIER_OUT_OF_FIELD");
    const outCoord = sample();
    outCoord.coords[5] = FIELD_PRIME.toString();
    assert.equal(refusal(outCoord), "COORDINATE_OUT_OF_FIELD");
    const maxOk = sample();
    maxOk.coords[5] = (FIELD_PRIME - 1n).toString();
    assert.equal(refusal(maxOk), null);
    const tooBig = sample();
    tooBig.membership.merkleTreeRoot = (2n ** 256n).toString();
    assert.equal(refusal(tooBig), "VALIDATION_FAILED", "above uint256 is a shape error, not an encoding crash");
  });

  it("the interface in use is the relayer's committed subset (it can encode submitBallot and nothing about issuance)", () => {
    assert.ok(iface instanceof Interface);
    assert.ok(iface.getFunction("submitBallot"));
    assert.equal(iface.getFunction("registerCommitmentBatch"), null);
  });
});
