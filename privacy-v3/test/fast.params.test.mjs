import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "../src/artifacts.js";
import { ballotHash } from "../src/ballot.js";
import { identityCiphertext } from "../src/elgamal.js";
import { DOMAIN_BALLOT, FIELD_PRIME, K_MAX, SUBGROUP_ORDER, TEST_CONTEXT, bytes32ToField, constituencyField, constituencyIdOf, electionScope } from "../src/params.js";

describe("parameters", () => {
  it("K_MAX is 16 and the circuit is compiled for 16 slots", () => {
    assert.equal(K_MAX, 16);
    const src = fs.readFileSync(path.join(ROOT, "circuits", "ballot_validity.circom"), "utf8");
    assert.match(src, /component main \{ public \[[^\]]+\] \} = BallotValidity\(16\);/);
  });

  it("the ballot domain tag in JS equals the constant inside the circuit", () => {
    const src = fs.readFileSync(path.join(ROOT, "circuits", "ballot_validity.circom"), "utf8");
    const hex = /function ballotDomain\(\) \{ return (0x[0-9a-fA-F]+);/.exec(src)?.[1];
    assert.ok(hex, "circuit constant not found");
    assert.equal(BigInt(hex), DOMAIN_BALLOT);
    assert.equal(Buffer.from(DOMAIN_BALLOT.toString(16), "hex").toString("ascii"), "VOTECHAIN-V3-BALLOT-1");
  });

  it("context values fit the field; bytes32 -> field drops 8 bits (injective on the top 248 bits)", () => {
    for (const v of [TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, constituencyField("KA-BLR")]) assert.ok(v > 0n && v < FIELD_PRIME);
    assert.equal(bytes32ToField("0x" + "ff".repeat(32)), (1n << 248n) - 1n);
    assert.ok(TEST_CONTEXT.electionId < 1n << 248n);
    assert.ok(SUBGROUP_ORDER < 1n << 251n && SUBGROUP_ORDER > 1n << 250n, "the circuit's 251-bit scalar width is exactly what the subgroup order needs");
  });

  it("different constituencies / elections / chains give different scopes and ids", () => {
    assert.notEqual(constituencyField("KA-BLR"), constituencyField("MH-MUM"));
    assert.match(constituencyIdOf("KA-BLR"), /^0x[0-9a-f]{64}$/);
    const s = electionScope(TEST_CONTEXT);
    assert.notEqual(s, electionScope({ ...TEST_CONTEXT, electionId: TEST_CONTEXT.electionId + 1n }));
    assert.notEqual(s, electionScope({ ...TEST_CONTEXT, chainId: 1n }));
    assert.notEqual(s, electionScope({ ...TEST_CONTEXT, contractAddress: TEST_CONTEXT.contractAddress + 1n }));
  });

  it("the ballot hash binds every context field and every ciphertext coordinate", () => {
    const cts = Array.from({ length: K_MAX }, identityCiphertext);
    const base = ballotHash(TEST_CONTEXT, constituencyField("KA-BLR"), cts);
    assert.equal(base, ballotHash(TEST_CONTEXT, constituencyField("KA-BLR"), cts), "deterministic");
    assert.notEqual(base, ballotHash({ ...TEST_CONTEXT, chainId: 1n }, constituencyField("KA-BLR"), cts));
    assert.notEqual(base, ballotHash({ ...TEST_CONTEXT, contractAddress: 1n }, constituencyField("KA-BLR"), cts));
    assert.notEqual(base, ballotHash({ ...TEST_CONTEXT, electionId: 1n }, constituencyField("KA-BLR"), cts));
    assert.notEqual(base, ballotHash(TEST_CONTEXT, constituencyField("MH-MUM"), cts));
    for (const [slot, which, coord] of [[0, "c1", 0], [0, "c1", 1], [0, "c2", 0], [0, "c2", 1], [15, "c2", 1], [7, "c1", 0]]) {
      const changed = cts.map((c) => ({ c1: [...c.c1], c2: [...c.c2] }));
      changed[slot][which][coord] += 1n;
      assert.notEqual(base, ballotHash(TEST_CONTEXT, constituencyField("KA-BLR"), changed), `slot ${slot} ${which}[${coord}]`);
    }
    assert.throws(() => ballotHash(TEST_CONTEXT, constituencyField("KA-BLR"), cts.slice(0, 15)), RangeError);
  });
});
