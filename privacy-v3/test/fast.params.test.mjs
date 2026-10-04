import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { concat, id as keccakOfText, keccak256, toBeHex, zeroPadValue } from "ethers";
import { ROOT } from "../src/artifacts.js";
import { ballotHash, ciphertextCoordinates, validityCircuitInput, validityPublicSignals } from "../src/ballot.js";
import { identityCiphertext } from "../src/elgamal.js";
import { BALLOT_TAG, FIELD_PRIME, K_MAX, SEMAPHORE_DEPTH, SUBGROUP_ORDER, TEST_CONTEXT, constituencyIdOf, constituencyIdValue, electionScope } from "../src/params.js";

const circuit = fs.readFileSync(path.join(ROOT, "circuits", "ballot_validity.circom"), "utf8");
const word = (v) => zeroPadValue(toBeHex(v), 32);
/** Independent implementation of the frozen encoding: 69 consecutive 32-byte words (tag, chainId, contract, electionId, constituencyId, 64 coordinates), then keccak256. */
const handRolled = (ctx, cid, cts) =>
  BigInt(keccak256(concat([BALLOT_TAG, word(ctx.chainId), word(ctx.contractAddress), word(ctx.electionId), word(cid), ...cts.flatMap((c) => [word(c.c1[0]), word(c.c1[1]), word(c.c2[0]), word(c.c2[1])])])));
const identities = () => Array.from({ length: K_MAX }, identityCiphertext);
const sequence = () => Array.from({ length: K_MAX }, (_, j) => ({ c1: [4n * BigInt(j) + 1n, 4n * BigInt(j) + 2n], c2: [4n * BigInt(j) + 3n, 4n * BigInt(j) + 4n] }));
const BLR = constituencyIdValue("KA-BLR");

describe("parameters", () => {
  it("K_MAX is 16, the circuit is compiled for 16 slots, and the declared Semaphore depth is 20", () => {
    assert.equal(K_MAX, 16);
    assert.equal(SEMAPHORE_DEPTH, 20);
    assert.match(circuit, /component main \{ public \[nullifier, kc, H, C\] \} = BallotValidity\(16\);/);
  });

  it("the circuit has exactly the frozen interface: public inputs nullifier, kc, H[2], C[K][4] in that order, no public output, no context inputs, no in-circuit hash", () => {
    const body = circuit.slice(circuit.indexOf("template BallotValidity"));
    const declared = [...body.matchAll(/signal (input|output) (\w+)((?:\[[^\]]+\])*);/g)].map(([, kind, name, dims]) => `${kind} ${name}${dims}`);
    assert.deepEqual(declared.slice(0, 6), ["input nullifier", "input kc", "input H[2]", "input C[K][4]", "input m[K]", "input r[K]"], "public inputs first, in the frozen order, then the private witness");
    assert.ok(!declared.some((d) => d.startsWith("output")), "no public outputs");
    const code = circuit.replace(/\/\/.*$/gm, ""); // comments explain what is NOT in the circuit, so look at code only
    for (const forbidden of [/chainId/i, /contractAddress/i, /electionId/i, /constituencyId/i, /ballotHash/i, /poseidon/i]) assert.doesNotMatch(code, forbidden, String(forbidden));
  });

  it("the ballot tag is keccak256 of its label (a bytes32); context values are uint256 and the election id is the FULL bytes32", () => {
    assert.equal(BALLOT_TAG, keccakOfText("VOTECHAIN-V3-BALLOT-1"));
    assert.match(BALLOT_TAG, /^0x[0-9a-f]{64}$/);
    assert.equal(TEST_CONTEXT.electionId, BigInt("0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40"), "not reduced or shifted");
    assert.ok(TEST_CONTEXT.electionId >= 1n << 254n, "a genuine 256-bit value, which is why it cannot be a circuit input");
    assert.equal(BLR, BigInt(constituencyIdOf("KA-BLR")));
    assert.match(constituencyIdOf("KA-BLR"), /^0x[0-9a-f]{64}$/);
    assert.notEqual(constituencyIdValue("KA-BLR"), constituencyIdValue("MH-MUM"));
    assert.ok(SUBGROUP_ORDER < 1n << 251n && SUBGROUP_ORDER > 1n << 250n, "the circuit's 251-bit scalar width is exactly what the subgroup order needs");
  });

  it("different elections / chains / contracts give different scopes (scope derivation unchanged by this alignment)", () => {
    const s = electionScope(TEST_CONTEXT);
    assert.notEqual(s, electionScope({ ...TEST_CONTEXT, electionId: TEST_CONTEXT.electionId + (1n << 8n) }));
    assert.notEqual(s, electionScope({ ...TEST_CONTEXT, chainId: 1n }));
    assert.notEqual(s, electionScope({ ...TEST_CONTEXT, contractAddress: TEST_CONTEXT.contractAddress + 1n }));
  });
});

describe("frozen ballot hash = keccak256(abi.encode(tag, chainId, contract, electionId, constituencyId, coords)), computed outside the circuit", () => {
  it("equals an independent hand-rolled encoding (69 x 32-byte words + keccak256) for all-identity and for sequential coordinates", () => {
    assert.equal(ballotHash(TEST_CONTEXT, BLR, identities()), handRolled(TEST_CONTEXT, BLR, identities()));
    assert.equal(ballotHash(TEST_CONTEXT, BLR, sequence()), handRolled(TEST_CONTEXT, BLR, sequence()));
  });

  it("known-answer vectors (for the contract implementation to reproduce)", () => {
    assert.equal(ballotHash(TEST_CONTEXT, BLR, identities()), 0xe6a73d4fa68edd0acc01594aaceb4eafa4d4a0ccdb12d16557659794621c539dn);
    assert.equal(ballotHash(TEST_CONTEXT, BLR, sequence()), 0xc6d24f076cb2698a493b46ffd17902444aff965138495c13ac2af76c55c1683cn);
  });

  it("is a full 256-bit value, NOT reduced into the BN254 field (Semaphore hashes the message again before its circuit)", () => {
    const h = ballotHash(TEST_CONTEXT, BLR, identities());
    assert.ok(h < 1n << 256n);
    assert.ok(h >= FIELD_PRIME, "this vector is above the field modulus, so a field-element message would have broken it");
  });

  it("coordinates are SLOT-MAJOR: [C1.x, C1.y, C2.x, C2.y] for slot 0, then slot 1, ..., padding included", () => {
    const coords = ciphertextCoordinates(sequence());
    assert.equal(coords.length, 64);
    assert.deepEqual(coords.slice(0, 8), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]);
    assert.deepEqual(coords.slice(60), [61n, 62n, 63n, 64n]);
    assert.throws(() => ciphertextCoordinates(identities().slice(0, 15)), RangeError);
    assert.throws(() => ballotHash(TEST_CONTEXT, BLR, identities().slice(0, 15)), RangeError);
  });

  it("binds every context field and every ciphertext coordinate", () => {
    const cts = identities();
    const base = ballotHash(TEST_CONTEXT, BLR, cts);
    assert.equal(base, ballotHash(TEST_CONTEXT, BLR, cts), "deterministic");
    assert.notEqual(base, ballotHash({ ...TEST_CONTEXT, chainId: 1n }, BLR, cts));
    assert.notEqual(base, ballotHash({ ...TEST_CONTEXT, contractAddress: TEST_CONTEXT.contractAddress + 1n }, BLR, cts));
    assert.notEqual(base, ballotHash({ ...TEST_CONTEXT, electionId: TEST_CONTEXT.electionId ^ 1n }, BLR, cts), "even the lowest bit of the election id");
    assert.notEqual(base, ballotHash(TEST_CONTEXT, constituencyIdValue("MH-MUM"), cts));
    assert.notEqual(base, ballotHash(TEST_CONTEXT, BLR ^ 1n, cts), "even the lowest bit of the constituency id");
    for (let coord = 0; coord < 64; coord++) {
      const changed = cts.map((c) => ({ c1: [...c.c1], c2: [...c.c2] }));
      const slot = changed[Math.floor(coord / 4)];
      [slot.c1, slot.c1, slot.c2, slot.c2][coord % 4][coord % 2] += 1n;
      assert.notEqual(base, ballotHash(TEST_CONTEXT, BLR, changed), `coordinate #${coord}`);
    }
  });
});

describe("validity statement: 68 public signals in the frozen order", () => {
  it("[nullifier, kc, H.x, H.y, ...64 coordinates], and the circuit input names the same values", () => {
    const H = [11n, 22n];
    const cts = sequence();
    const signals = validityPublicSignals({ kc: 3, H, nullifier: 99n, ciphertexts: cts });
    assert.equal(signals.length, 68);
    assert.deepEqual(signals.slice(0, 4), ["99", "3", "11", "22"]);
    assert.deepEqual(signals.slice(4), ciphertextCoordinates(cts).map(String));
    const input = validityCircuitInput({ kc: 3, H, nullifier: 99n, ciphertexts: cts, m: Array(16).fill(0n), r: Array(16).fill(1n) });
    assert.deepEqual(Object.keys(input), ["nullifier", "kc", "H", "C", "m", "r"]);
    assert.deepEqual(input.C.flat(), signals.slice(4), "C[slot][4] flattens to the public coordinates in order");
  });
});
