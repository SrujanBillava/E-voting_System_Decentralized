import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIELD_PRIME, canonicalConstituencyCode, constituencyIdOf, parseCommitment } from "../../src/chain/ids.js";
import { CommitmentBatch } from "../../src/models/CommitmentBatch.js";
import { CRED, DURABLE_FIELDS, LINKAGE_FIELDS, CredentialIssuance } from "../../src/models/CredentialIssuance.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { Voter } from "../../src/models/Voter.js";
import { TX_GAS_CAP, batchGasLimit } from "../../src/services/batcher.service.js";

const paths = (model) => Object.keys(model.schema.paths).filter((p) => p !== "__v");

describe("identity-v3 data model (static data-minimisation rules)", () => {
  it("the CredentialIssuance record is {_id, electionId, voterId, state} plus linkage fields that exist ONLY while pending; nothing else, no timestamps", () => {
    assert.deepEqual([...DURABLE_FIELDS].sort(), ["_id", "electionId", "state", "voterId"]);
    assert.deepEqual(paths(CredentialIssuance).sort(), [...DURABLE_FIELDS, ...LINKAGE_FIELDS].sort());
    assert.deepEqual(Object.values(CRED).sort(), ["BATCHED", "CANCELLED", "ISSUED", "RESERVED"]);
    assert.equal(CredentialIssuance.schema.options.timestamps, false, "no createdAt/updatedAt");
    assert.equal(CredentialIssuance.schema.path("_id").instance, "String", "a random UUID: an ObjectId would embed its creation time");
    assert.equal(CredentialIssuance.schema.options.versionKey, false);
  });

  it("(electionId, voterId) is UNIQUE: that index is what enforces one credential per voter; a commitment can be in flight for one voter only", () => {
    const indexes = CredentialIssuance.schema.indexes();
    const unique = indexes.filter(([, options]) => options.unique);
    assert.deepEqual(unique.map(([keys]) => Object.keys(keys).join("+")).sort(), ["electionId+commitment", "electionId+voterId"]);
    assert.ok(unique.find(([keys]) => "voterId" in keys));
  });

  it("the batch record is NOT voter-linked: no voter, session or credential field in it; the V2 secrets and the nullifier input are excluded from the registry model", () => {
    assert.ok(paths(CommitmentBatch).every((p) => !/voter|session|credential|email|name|uid/i.test(p)), paths(CommitmentBatch).join());
    assert.equal(Voter.schema.path("uid").options.select, false, "V2's uid is never selected by V3");
    assert.equal(Voter.schema.path("passwordHash").options.select, false);
    assert.ok(!paths(VoterSession).includes("revokedAt"), "no revokedAt: a finished session is deleted, not kept with a timestamp");
  });

  it("no model anywhere has a field that could hold ballot material: nullifier, ciphertext, coordinates, proof, candidate, ballot", () => {
    for (const model of [CredentialIssuance, CommitmentBatch, VoterSession, Voter]) {
      for (const p of paths(model)) assert.ok(!/nullifier|cipher|coord|proof|candidate|ballot|choice/i.test(p), `${model.modelName}.${p}`);
    }
  });
});

describe("commitments, ids and the gas limit", () => {
  const P = FIELD_PRIME;
  it("a commitment is a canonical decimal string in 1..p-1, and nothing else", () => {
    assert.equal(parseCommitment("1"), 1n);
    assert.equal(parseCommitment((P - 1n).toString()), P - 1n);
    for (const bad of ["0", P.toString(), (P + 5n).toString(), "01", "-1", "+1", "1.0", "0x10", "1e3", " 1", "1 ", "", "٣", "9".repeat(79), null, undefined, 5, 5n, [], {}]) assert.equal(parseCommitment(bad), null, String(bad));
  });
  it("constituency codes are canonicalised the way V2 does, and their ids are keccak256 of the code", () => {
    assert.equal(canonicalConstituencyCode(" ka-blr "), "KA-BLR");
    assert.equal(canonicalConstituencyCode("KA--BLR"), null);
    assert.equal(canonicalConstituencyCode("x".repeat(41)), null);
    assert.equal(canonicalConstituencyCode(5), null);
    assert.match(constituencyIdOf("KA-BLR"), /^0x[0-9a-f]{64}$/);
  });
  it("the batch gas limit is explicit, grows with the batch, covers the measured costs, and never exceeds the per-transaction cap", () => {
    assert.equal(TX_GAS_CAP, 16_777_216n);
    assert.ok(batchGasLimit(1) >= 206_077n, "covers the measured single-commitment batch");
    assert.ok(batchGasLimit(128) >= 10_137_345n * 106n / 100n, "covers the measured 128-commitment batch plus a 6% deeper tree");
    assert.ok(batchGasLimit(128) <= TX_GAS_CAP);
    assert.equal(batchGasLimit(100_000), TX_GAS_CAP);
    for (let n = 1; n < 128; n++) assert.ok(batchGasLimit(n) < batchGasLimit(n + 1));
  });
});
