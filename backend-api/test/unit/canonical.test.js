import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalConstituencyCode, constituencyIdOf } from "../../src/chain/ids.js";
import { VOTER_ID_PATTERN, generateUid, generateVoterId } from "../../src/services/voter.service.js";

describe("constituency code canonicalisation", () => {
  it("trims and uppercases valid codes, so the derived on-chain id is stable", () => {
    assert.equal(canonicalConstituencyCode(" ka-blr "), "KA-BLR");
    assert.equal(constituencyIdOf(canonicalConstituencyCode("ka-blr")), constituencyIdOf("KA-BLR"));
  });
  it("rejects anything outside A-Z0-9 groups joined by single hyphens", () => {
    for (const bad of ["", "-", "A--B", "-A", "A-", "A B", "A_B", "KA-ÉÉ", "A".repeat(41), null, undefined, 5, { $ne: 1 }, ["KA"]]) assert.equal(canonicalConstituencyCode(bad), null, String(bad));
  });
});

describe("voter identifiers", () => {
  it("voterId follows the VoteChain format and is not derived from uid", () => {
    const ids = new Set(Array.from({ length: 500 }, generateVoterId));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, VOTER_ID_PATTERN);
  });
  it("uid is 128 bits of hex and unique", () => {
    const uids = new Set(Array.from({ length: 500 }, generateUid));
    assert.equal(uids.size, 500);
    for (const uid of uids) assert.match(uid, /^[0-9a-f]{32}$/);
  });
});
