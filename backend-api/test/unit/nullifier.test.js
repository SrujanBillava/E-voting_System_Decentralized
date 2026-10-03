import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { NULLIFIER_DOMAIN, deriveNullifier, encodeNullifierMessage } from "../../src/chain/nullifier.js";

// Fixed vectors computed with an INDEPENDENT implementation (Python hmac/struct), not with this code.
// If any of these change, every voter's nullifier changes: that would allow double voting across a
// deployment, so a refactor must never be able to do it silently.
const SECRET_1 = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const SECRET_2 = Buffer.from("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f", "hex");
const ELECTION_1 = "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40";
const ELECTION_2 = "0x" + "11".repeat(32);

const VECTORS = [
  { name: "A", secret: SECRET_1, electionId: ELECTION_1, uid: "voter-uid-0001", expected: "0x2031d99c0347c6a6d9d7482ef0786bf940b8aad23d2a8b51d53d45ce98099e54", messageLength: 73 },
  { name: "B different uid", secret: SECRET_1, electionId: ELECTION_1, uid: "voter-uid-0002", expected: "0xc762632f18bde99f9dfd3baa9ae69af18b468000e3b2a6cd9b29faef0a69484c", messageLength: 73 },
  { name: "C different election", secret: SECRET_1, electionId: ELECTION_2, uid: "voter-uid-0001", expected: "0x7c7ddad6ee63554027e6a1c2d620109dab00cabcce2ac7cd56772ed05de3cfa8", messageLength: 73 },
  { name: "D different secret", secret: SECRET_2, electionId: ELECTION_1, uid: "voter-uid-0001", expected: "0x424ba8c1ec6ca7ee1d90793cfd5860fb362785e40d8148dcd0e9e24832179d0b", messageLength: 73 },
  { name: "E unicode uid", secret: SECRET_1, electionId: ELECTION_1, uid: "vötér-ïd-😀", expected: "0x28bc1265468f229bdf28e302a503ce920c5134a26bfcff20f30a46532b02f932", messageLength: 75 },
  { name: "F uid 'a'", secret: SECRET_1, electionId: ELECTION_1, uid: "a", expected: "0x94f76e41efd2a9991a0d2087ef28674408719855096eaee8b532a673103ba02f", messageLength: 60 },
  { name: "G uid 'a\\0'", secret: SECRET_1, electionId: ELECTION_1, uid: "a\u0000", expected: "0x2130faeb5af64a86d906fe635d362f4849bd5d2c2ab1b403f72f23bf5c0363d8", messageLength: 61 },
  { name: "H uid 'ab'", secret: SECRET_1, electionId: ELECTION_1, uid: "ab", expected: "0x5d2f5358cae5fda8b9139d8f4b5a999082795adaa219ea45ae489db83ec172bd", messageLength: 61 },
];

describe("nullifier: fixed vectors (independently computed)", () => {
  for (const v of VECTORS) {
    it(`vector ${v.name}`, () => {
      assert.equal(deriveNullifier({ secret: v.secret, electionId: v.electionId, voterUid: v.uid }), v.expected);
      assert.equal(encodeNullifierMessage(v.electionId, v.uid).length, v.messageLength);
    });
  }

  it("the encoded message for vector A is byte-for-byte the documented layout", () => {
    const expectedHex =
      "564f5445434841494e2d4e554c4c49464945522d563100" + // "VOTECHAIN-NULLIFIER-V1\0"
      "5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40" + // electionId, 32 raw bytes
      "0000000e" + // u32 big-endian length of the uid (14)
      "766f7465722d7569642d30303031"; // "voter-uid-0001"
    assert.equal(encodeNullifierMessage(ELECTION_1, "voter-uid-0001").toString("hex"), expectedHex);
    assert.equal(NULLIFIER_DOMAIN.toString("utf8"), "VOTECHAIN-NULLIFIER-V1\u0000");
  });
});

describe("nullifier: properties", () => {
  const base = { secret: SECRET_1, electionId: ELECTION_1, voterUid: "voter-uid-0001" };

  it("is deterministic for the same secret, election and uid", () => {
    assert.equal(deriveNullifier(base), deriveNullifier({ ...base }));
    assert.equal(deriveNullifier(base), deriveNullifier({ ...base, secret: Buffer.from(SECRET_1) }));
  });

  it("changes with the uid, the election and the secret", () => {
    const n = deriveNullifier(base);
    assert.notEqual(n, deriveNullifier({ ...base, voterUid: "voter-uid-0002" }));
    assert.notEqual(n, deriveNullifier({ ...base, electionId: ELECTION_2 }));
    assert.notEqual(n, deriveNullifier({ ...base, secret: SECRET_2 }));
  });

  it("is exactly 32 bytes, lowercase 0x-hex, and never truncated", () => {
    const n = deriveNullifier(base);
    assert.match(n, /^0x[0-9a-f]{64}$/);
    assert.equal(Buffer.from(n.slice(2), "hex").length, 32);
  });

  it("is never zero for ordinary inputs (zero is rejected by the contract)", () => {
    for (let i = 0; i < 200; i++) assert.notEqual(BigInt(deriveNullifier({ ...base, voterUid: `uid-${i}` })), 0n);
  });

  it("applies no trimming or normalisation to the uid", () => {
    const n = deriveNullifier(base);
    assert.notEqual(n, deriveNullifier({ ...base, voterUid: " voter-uid-0001" }));
    assert.notEqual(n, deriveNullifier({ ...base, voterUid: "voter-uid-0001 " }));
    assert.notEqual(n, deriveNullifier({ ...base, voterUid: "VOTER-UID-0001" }));
    assert.notEqual(n, deriveNullifier({ ...base, voterUid: "voter-uid-0001\u0000" }));
  });

  it("no structural ambiguity: the length prefix separates uids that are prefixes of each other", () => {
    const a = encodeNullifierMessage(ELECTION_1, "a");
    const aNul = encodeNullifierMessage(ELECTION_1, "a\u0000");
    const ab = encodeNullifierMessage(ELECTION_1, "ab");
    assert.notEqual(a.toString("hex"), aNul.toString("hex"));
    assert.notEqual(aNul.toString("hex"), ab.toString("hex"));
    // the prefix of one message is never a complete other message
    assert.ok(!aNul.toString("hex").startsWith(a.toString("hex")));
  });

  it("no collisions across 3000 random (election, uid) pairs, in messages or in nullifiers", () => {
    const messages = new Set();
    const nullifiers = new Set();
    for (let i = 0; i < 3000; i++) {
      const electionId = "0x" + randomBytes(32).toString("hex");
      const voterUid = randomBytes(1 + (i % 40)).toString("base64");
      messages.add(encodeNullifierMessage(electionId, voterUid).toString("hex"));
      nullifiers.add(deriveNullifier({ secret: SECRET_1, electionId, voterUid }));
    }
    assert.equal(messages.size, 3000);
    assert.equal(nullifiers.size, 3000);
  });

  it("the encoding is injective: every message decodes back to exactly one (election, uid)", () => {
    const decode = (message) => {
      assert.ok(message.subarray(0, NULLIFIER_DOMAIN.length).equals(NULLIFIER_DOMAIN));
      const election = "0x" + message.subarray(23, 55).toString("hex");
      const length = message.readUInt32BE(55);
      assert.equal(message.length, 59 + length, "length prefix must account for every remaining byte");
      return { election, uid: message.subarray(59).toString("utf8") };
    };
    for (let i = 0; i < 500; i++) {
      const electionId = "0x" + randomBytes(32).toString("hex");
      const voterUid = i % 3 === 0 ? `uid\u0000${i}\u0000` : randomBytes(1 + (i % 30)).toString("hex");
      assert.deepEqual(decode(encodeNullifierMessage(electionId, voterUid)), { election: electionId, uid: voterUid });
    }
  });

  it("rejects bad inputs", () => {
    assert.throws(() => deriveNullifier({ ...base, voterUid: "" }), TypeError);
    assert.throws(() => deriveNullifier({ ...base, voterUid: 12345 }), TypeError);
    assert.throws(() => deriveNullifier({ ...base, voterUid: "x".repeat(1025) }), RangeError);
    assert.throws(() => deriveNullifier({ ...base, electionId: "0x1234" }), TypeError);
    assert.throws(() => deriveNullifier({ ...base, electionId: "not-hex" }), TypeError);
    assert.throws(() => deriveNullifier({ ...base, secret: Buffer.alloc(31, 7) }), TypeError);
    assert.throws(() => deriveNullifier({ ...base, secret: "0123456789abcdef".repeat(4) }), TypeError); // must be bytes, not a string
    assert.throws(() => deriveNullifier({ ...base, secret: undefined }), TypeError);
  });

  it("an error from bad input never echoes the secret", () => {
    const secret = Buffer.from("7f".repeat(32), "hex");
    try {
      deriveNullifier({ secret, electionId: "bad", voterUid: "x" });
    } catch (err) {
      assert.ok(!String(err.message).includes("7f7f7f"));
    }
  });
});

describe("nullifier: uid limits and well-formedness", () => {
  const base = { secret: SECRET_1, electionId: ELECTION_1 };

  it("the 1024-byte limit counts UTF-8 bytes, not characters, and 1024 itself is allowed", () => {
    assert.equal(encodeNullifierMessage(ELECTION_1, "x".repeat(1024)).length, 59 + 1024);
    assert.equal(encodeNullifierMessage(ELECTION_1, "é".repeat(512)).length, 59 + 1024); // 512 x 2 bytes
    assert.throws(() => encodeNullifierMessage(ELECTION_1, "x".repeat(1025)), RangeError);
    assert.throws(() => encodeNullifierMessage(ELECTION_1, "é".repeat(513)), RangeError);
    assert.throws(() => encodeNullifierMessage(ELECTION_1, "😀".repeat(257)), RangeError); // 257 x 4 bytes = 1028
    assert.match(deriveNullifier({ ...base, voterUid: "😀".repeat(256) }), /^0x[0-9a-f]{64}$/);
  });

  it("ill-formed UTF-16 (lone surrogates) is refused, so no two distinct uids can share one byte encoding", () => {
    for (const uid of ["\ud800", "a\udc00b", "x\ud83d", "\ude00\ud83d"]) {
      assert.throws(() => deriveNullifier({ ...base, voterUid: uid }), TypeError, JSON.stringify(uid));
    }
    // the reason: UTF-8 encoding would map each of them to the replacement character U+FFFD
    assert.equal(Buffer.from("\ud800", "utf8").toString("hex"), Buffer.from("\ufffd", "utf8").toString("hex"));
    assert.match(deriveNullifier({ ...base, voterUid: "\ufffd" }), /^0x[0-9a-f]{64}$/);
    assert.match(deriveNullifier({ ...base, voterUid: "\ud83d\ude00" }), /^0x[0-9a-f]{64}$/); // a proper surrogate pair is fine
  });
});

