import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateTestKeyPair } from "../../../privacy-v3/src/elgamal.js";
import { BallotPackage, canonicalPackage } from "../../../relay-v3/src/services/ballotPackage.js";
import { loadAbi } from "../../../relay-v3/src/chain/abi.js";
import { Identity, ballotHash, constituencyIdOf, constituencyIdValue, padCiphertexts, prepareBallot, wireCiphertexts } from "../../src/crypto/privacy.ts";
import { assertRecordIntact, digestOf, expectedOf, toRelayPackage, type BallotRecord } from "../../src/core/index.ts";
import type { Point } from "../../src/crypto/privacy.ts";

const ctx = { chainId: 31337n, contractAddress: 0x5fbdb2315678afecb367f032d93f642f64180aa3n, electionId: 0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40n };
const code = "KA-BLR";
const kc = 3;
const H = generateTestKeyPair().publicKey as Point;

/** a genuine encrypted ballot (real encryption and hash, NO proofs: the proofs are exercised by the end-to-end tests) wrapped as a stored package */
function record(): BallotRecord {
  const identity = new Identity();
  const ballot = prepareBallot({ identity, ctx, constituency: code, kc, choice: 1, H });
  const core = {
    v: 1 as const,
    constituency: { code, id: constituencyIdOf(code) },
    kc,
    H: [H[0].toString(), H[1].toString()] as [string, string],
    ctx: { chainId: ctx.chainId.toString(), contractAddress: ctx.contractAddress.toString(), electionId: ctx.electionId.toString() },
    scope: ballot.scope.toString(),
    nullifier: ballot.nullifier.toString(),
    ballotHash: ballot.hash.toString(),
    ciphertexts: wireCiphertexts(ballot.ciphertexts, kc),
    validity: { proof: { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"], protocol: "groth16", curve: "bn128" } },
  };
  return { ...core, digest: digestOf(core), membership: { merkleTreeDepth: 20, merkleTreeRoot: "1000", message: ballot.hash.toString(), nullifier: ballot.nullifier.toString(), scope: ballot.scope.toString(), points: ["1", "2", "3", "4", "5", "6", "7", "8"] } };
}
const damaged = (fn: (r: BallotRecord) => void) => () => {
  const r = structuredClone(record());
  fn(r);
  assertRecordIntact(r);
};
const PACKAGE_DAMAGED = (e: unknown) => e instanceof Error && (e as { code?: string }).code === "PACKAGE_DAMAGED";

describe("the immutable ballot package", () => {
  it("a genuine package is intact, its ballot hash is the frozen encoding of exactly its ciphertexts, and the digest is stable", () => {
    const r = record();
    assert.doesNotThrow(() => assertRecordIntact(r));
    assert.equal(r.digest, digestOf(r));
    const padded = padCiphertexts(r.ciphertexts.map((c) => ({ c1: [BigInt(c.c1[0]), BigInt(c.c1[1])] as Point, c2: [BigInt(c.c2[0]), BigInt(c.c2[1])] as Point })));
    assert.equal(ballotHash(ctx, constituencyIdValue(code), padded).toString(), r.ballotHash);
    assert.match(r.digest, /^0x[0-9a-f]{64}$/);
  });

  it("ANY edit of an immutable field is refused: ciphertexts, K_c, H, context, scope, nullifier, ballot hash, validity proof, digest", () => {
    const edits: [string, (r: BallotRecord) => void][] = [
      ["a ciphertext coordinate", (r) => void (r.ciphertexts[0]!.c1[0] = (BigInt(r.ciphertexts[0]!.c1[0]) + 1n).toString())],
      ["a ciphertext dropped", (r) => void r.ciphertexts.pop()],
      ["K_c", (r) => void (r.kc = 4)],
      ["H", (r) => void (r.H = ["1", "1"])],
      ["the chain id", (r) => void (r.ctx.chainId = "1")],
      ["the contract", (r) => void (r.ctx.contractAddress = "5")],
      ["the election id", (r) => void (r.ctx.electionId = "5")],
      ["the scope", (r) => void (r.scope = "5")],
      ["the nullifier", (r) => void (r.nullifier = "5")],
      ["the ballot hash", (r) => void (r.ballotHash = "5")],
      ["the validity proof", (r) => void (r.validity.proof.pi_a[0] = "9")],
      ["the digest", (r) => void (r.digest = "0x" + "00".repeat(32))],
      ["the constituency", (r) => void (r.constituency.code = "KA-MYS")],
    ];
    for (const [what, edit] of edits) assert.throws(damaged(edit), PACKAGE_DAMAGED, what);
  });

  it("the membership proof must be about THIS ballot (message, nullifier, scope); but its root and points are the one part that may change", () => {
    for (const edit of [(r: BallotRecord) => void (r.membership.message = "5"), (r: BallotRecord) => void (r.membership.nullifier = "5"), (r: BallotRecord) => void (r.membership.scope = "5")]) assert.throws(damaged(edit), PACKAGE_DAMAGED);
    const r = record();
    const refreshed: BallotRecord = { ...r, membership: { ...r.membership, merkleTreeRoot: "2000", points: ["8", "7", "6", "5", "4", "3", "2", "1"] } };
    assert.doesNotThrow(() => assertRecordIntact(refreshed));
    assert.equal(digestOf(refreshed), r.digest, "refreshing the membership proof does not change the digest");
  });

  it("holds NO plaintext choice, one-hot vector or randomness (the stored fields are public material only)", () => {
    const r = record();
    assert.deepEqual(Object.keys(r).sort(), ["H", "ballotHash", "ciphertexts", "constituency", "ctx", "digest", "kc", "membership", "nullifier", "scope", "v", "validity"]);
    assert.ok(!/choice|oneHot|one-hot|randomness|plaintext|"m"|"r"/i.test(JSON.stringify(Object.keys(r))));
  });

  it("the wire package is EXACTLY what relay-v3 accepts: its strict schema parses it, and it encodes to the contract's submitBallot", () => {
    const r = record();
    const wire = toRelayPackage(r);
    assert.deepEqual(Object.keys(wire).sort(), ["constituencyId", "coords", "membership", "validity"]);
    assert.doesNotThrow(() => BallotPackage.parse(wire));
    assert.equal(wire.coords.length, 4 * kc);
    const canonical = canonicalPackage(wire, loadAbi().voteChain) as { nullifier: string; coords: bigint[]; calldata: string };
    assert.equal(canonical.nullifier, r.nullifier);
    assert.deepEqual(canonical.coords.map(String), expectedOf(r).coords);
    assert.match(canonical.calldata, /^0x[0-9a-f]+$/);
    // the strict schema is the relay's defence; this proves the kiosk gives it nothing to refuse: not one extra key
    assert.throws(() => BallotPackage.parse({ ...wire, voterId: "VC-X" }));
  });
});
