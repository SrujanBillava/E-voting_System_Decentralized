import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { AbiCoder, concat, id as keccakOfText, keccak256, solidityPacked, toBeHex, zeroPadValue } from "ethers";
import { ROOT } from "../src/artifacts.js";
import { ballotHash, ciphertextCoordinates, validityCircuitInput, validityPublicSignals } from "../src/ballot.js";
import { encrypt, identityCiphertext, mul } from "../src/elgamal.js";
import { BALLOT_HASH_ABI_TYPES, BALLOT_TAG, COORDS_PER_SLOT, COORD_COUNT, FIELD_PRIME, G, K_MAX, SCOPE_ABI_TYPES, SCOPE_TAG, SEMAPHORE_DEPTH, SUBGROUP_ORDER, TEST_CONTEXT, constituencyIdOf, constituencyIdValue, electionScope } from "../src/params.js";

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

// ---------------------------------------------------------------------------------------------------------------------------------------------
// FROZEN ENCODINGS: election scope and ballot hash. Known-answer vectors live in spec/vectors.json and ENCODINGS.md; everything is cross-checked.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, "spec", "vectors.json"), "utf8"));
const doc = fs.readFileSync(path.join(ROOT, "ENCODINGS.md"), "utf8");
const ctxOf = (v) => ({ chainId: BigInt(v.chainId), contractAddress: BigInt(v.contractAddress), electionId: BigInt(v.electionId) });
const scopeWords = (c) => [SCOPE_TAG, word(c.chainId), word(c.contractAddress), word(c.electionId)];
const independentScope = (c) => BigInt(keccak256(concat(scopeWords(c))));
const ciphertextsFromCoords = (coords) => Array.from({ length: K_MAX }, (_, j) => ({ c1: [BigInt(coords[4 * j]), BigInt(coords[4 * j + 1])], c2: [BigInt(coords[4 * j + 2]), BigInt(coords[4 * j + 3])] }));

describe("frozen election scope = uint256(keccak256(abi.encode(bytes32 SCOPE_TAG, uint256 chainId, address contractAddress, bytes32 electionId)))", () => {
  const T = TEST_CONTEXT;
  const base = electionScope(T);

  it("tags are keccak256 of their labels and match the vector file and the spec document", () => {
    assert.equal(SCOPE_TAG, keccakOfText("VOTECHAIN-V3-SCOPE-1"));
    assert.equal(BALLOT_TAG, keccakOfText("VOTECHAIN-V3-BALLOT-1"));
    assert.equal(vectors.tags.SCOPE_TAG.bytes32, SCOPE_TAG);
    assert.equal(vectors.tags.BALLOT_TAG.bytes32, BALLOT_TAG);
    assert.equal(vectors.tags.SCOPE_TAG.label, "VOTECHAIN-V3-SCOPE-1");
    assert.equal(vectors.tags.BALLOT_TAG.label, "VOTECHAIN-V3-BALLOT-1");
    assert.notEqual(SCOPE_TAG, BALLOT_TAG);
  });

  it("equals an independent hand-rolled encoding (4 x 32-byte words, then keccak256) and is the full 256-bit digest, untruncated", () => {
    assert.equal(base, independentScope(T));
    assert.equal(base, BigInt(keccak256(concat(scopeWords(T)))));
    const encoded = AbiCoder.defaultAbiCoder().encode(SCOPE_ABI_TYPES, [SCOPE_TAG, T.chainId, toBeHex(T.contractAddress, 20), toBeHex(T.electionId, 32)]);
    assert.equal(encoded.length, 2 + 128 * 2, "128 bytes: tag, chainId, address (left-padded), electionId");
    assert.equal(encoded, concat(scopeWords(T)));
    assert.ok(base < 1n << 256n);
    assert.ok(electionScope({ ...T, chainId: 7n }) !== independentScope({ ...T, chainId: 8n }));
  });

  it("known-answer vector for TEST_CONTEXT", () => {
    assert.equal(base, 0x1887f99239e42e29219c719fb42287a8880a654be45f20163ab1ce7f1a241742n);
  });

  it("changing chainId changes the scope", () => {
    for (const chainId of [1n, 31338n, 0n, 1n << 200n]) assert.notEqual(electionScope({ ...T, chainId }), base, `chainId ${chainId}`);
    assert.equal(electionScope({ ...T, chainId: 1n }), 0x236fb1bb2b99f173fe129f024ffdf13d53910545917e3f9733b7bc507dffbd09n);
  });

  it("changing the contract address changes the scope", () => {
    for (const contractAddress of [T.contractAddress + 1n, T.contractAddress ^ (1n << 159n), 1n, 0n]) assert.notEqual(electionScope({ ...T, contractAddress }), base);
    assert.equal(electionScope({ ...T, contractAddress: T.contractAddress + 1n }), 0xee16f7daad7467735f8c7b792c7e05030daac241441a8a5ebdb3d40bd7b3615cn);
  });

  it("changing the election id changes the scope", () => {
    for (const electionId of [T.electionId + 1n, T.electionId ^ (1n << 255n), T.electionId ^ (1n << 100n), 0n, 1n]) assert.notEqual(electionScope({ ...T, electionId }), base);
  });

  it("election ids differing ONLY in their lowest 8 bits produce different scopes (no truncation of the election id)", () => {
    const scopes = new Set([base]);
    for (let bit = 0n; bit < 8n; bit++) scopes.add(electionScope({ ...T, electionId: T.electionId ^ (1n << bit) }));
    for (const low of [0x00n, 0x01n, 0x7fn, 0x80n, 0xfen, 0xffn]) scopes.add(electionScope({ ...T, electionId: (T.electionId & ~0xffn) | low }));
    const distinctLowBytes = new Set([T.electionId & 0xffn, ...[...Array(8).keys()].map((b) => (T.electionId ^ (1n << BigInt(b))) & 0xffn), 0x00n, 0x01n, 0x7fn, 0x80n, 0xfen, 0xffn]).size;
    assert.equal(scopes.size, distinctLowBytes, "one distinct scope per distinct low byte, all other bits identical");
    assert.equal(electionScope({ ...T, electionId: T.electionId ^ 1n }), 0x080bd725db820f530bfb32207e5607a8125c0b64cbcf1547e8bff5f1f3f7160bn);
    assert.equal(electionScope({ ...T, electionId: T.electionId ^ 0xffn }), 0xc4df961f6288cb97a894cfb65d703a3443823c74690645b99af1a3d5903cbfb5n);
  });

  it("is abi.encode, not abi.encodePacked, and uses no Poseidon and no election-id shift (source scan + packed-encoding difference)", () => {
    const packed = BigInt(keccak256(solidityPacked(["bytes32", "uint256", "address", "bytes32"], [SCOPE_TAG, T.chainId, toBeHex(T.contractAddress, 20), toBeHex(T.electionId, 32)])));
    assert.notEqual(base, packed, "abi.encodePacked would give a different value");
    const params = fs.readFileSync(path.join(ROOT, "src", "params.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(params, /poseidon/i);
    assert.doesNotMatch(params, />>\s*8n?/);
    const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1"); // comments may say "never abi.encodePacked"
    for (const file of fs.readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".js"))) assert.doesNotMatch(codeOnly(fs.readFileSync(path.join(ROOT, "src", file), "utf8")), /encodePacked|solidityPacked/, `${file}: abi.encode only`);
  });
});

describe("frozen ballot-hash encoding", () => {
  it("shared constants: tag, 16 slots, 4 coordinates per slot, 64 coordinates, the exact ABI types (static uint256[64], never uint256[])", () => {
    assert.equal(K_MAX, 16);
    assert.equal(COORDS_PER_SLOT, 4);
    assert.equal(COORD_COUNT, 64);
    assert.deepEqual([...BALLOT_HASH_ABI_TYPES], ["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256[64]"]);
    assert.deepEqual([...SCOPE_ABI_TYPES], ["bytes32", "uint256", "address", "bytes32"]);
    assert.ok(Object.isFrozen(BALLOT_HASH_ABI_TYPES) && Object.isFrozen(SCOPE_ABI_TYPES));
    assert.ok(!BALLOT_HASH_ABI_TYPES.includes("uint256[]"));
  });

  it("the preimage is exactly 69 words = 2,208 bytes (static array: no offset word, no length word); abi.encodePacked and a dynamic array give different hashes", () => {
    const cts = sequence();
    const coords = ciphertextCoordinates(cts);
    const args = [BALLOT_TAG, TEST_CONTEXT.chainId, toBeHex(TEST_CONTEXT.contractAddress, 20), toBeHex(TEST_CONTEXT.electionId, 32), toBeHex(BLR, 32)];
    const frozen = AbiCoder.defaultAbiCoder().encode(BALLOT_HASH_ABI_TYPES, [...args, coords]);
    assert.equal((frozen.length - 2) / 2, 69 * 32);
    assert.equal(BigInt(keccak256(frozen)), ballotHash(TEST_CONTEXT, BLR, cts));
    const dynamic = AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256[]"], [...args, coords]);
    assert.equal((dynamic.length - 2) / 2, 71 * 32, "a dynamic array adds an offset word and a length word");
    assert.notEqual(BigInt(keccak256(dynamic)), ballotHash(TEST_CONTEXT, BLR, cts));
    const packed = solidityPacked(["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256[64]"], [...args, coords]);
    assert.notEqual(BigInt(keccak256(packed)), ballotHash(TEST_CONTEXT, BLR, cts));
  });
});

describe("known-answer vectors (spec/vectors.json) agree with the code, an independent encoding, and ENCODINGS.md", () => {
  it("every scope vector: abi.encode preimage, scope, and the implementation all agree", () => {
    assert.ok(vectors.scope.vectors.length >= 6);
    for (const v of vectors.scope.vectors) {
      const c = ctxOf(v);
      assert.equal(v.abiEncoded, concat(scopeWords(c)), v.name);
      assert.equal(BigInt(v.scope), independentScope(c), v.name);
      assert.equal(BigInt(v.scope), electionScope(c), v.name);
      assert.match(v.scope, /^0x[0-9a-f]{64}$/);
      assert.match(v.contractAddress, /^0x[0-9a-f]{40}$/);
      assert.match(v.electionId, /^0x[0-9a-f]{64}$/);
    }
    assert.equal(new Set(vectors.scope.vectors.map((v) => v.scope)).size, vectors.scope.vectors.length, "all scope vectors differ");
  });

  it("every ballot-hash vector: 64 coordinates, independent encoding and implementation agree; the identity vectors are [0,1,0,1] x 16 and the sequence is 1..64", () => {
    assert.ok(vectors.ballotHash.vectors.length >= 6);
    for (const v of vectors.ballotHash.vectors) {
      assert.equal(v.coords.length, 64, v.name);
      assert.equal(v.constituencyId, constituencyIdOf(v.constituencyCode), v.name);
      const c = ctxOf(v);
      const independent = BigInt(keccak256(concat([BALLOT_TAG, word(c.chainId), word(c.contractAddress), word(c.electionId), word(BigInt(v.constituencyId)), ...v.coords.map((x) => word(BigInt(x)))])));
      assert.equal(BigInt(v.ballotHash), independent, v.name);
      assert.equal(BigInt(v.ballotHash), ballotHash(c, BigInt(v.constituencyId), ciphertextsFromCoords(v.coords)), v.name);
    }
    const byName = (start) => vectors.ballotHash.vectors.find((v) => v.name.startsWith(start));
    assert.deepEqual(byName("16 padded slots (every slot").coords, Array.from({ length: 16 }, () => ["0", "1", "0", "1"]).flat());
    assert.deepEqual(byName("sequential coordinates").coords, Array.from({ length: 64 }, (_, i) => String(i + 1)));
    assert.equal(new Set(vectors.ballotHash.vectors.map((v) => v.ballotHash)).size, vectors.ballotHash.vectors.length, "all ballot-hash vectors differ");
  });

  it("the 'real ciphertexts' vector is exactly what ElGamal produces for the listed inputs (H = 12345*G, r = 1001..1003, vote for candidate 1), padded slots = identity", () => {
    const { H: hs, kc, choice, r } = vectors.realCiphertextInputs;
    const H = hs.map(BigInt);
    assert.deepEqual(H, mul(G, 12345n));
    const cts = Array.from({ length: K_MAX }, (_, j) => (j < kc ? encrypt(H, j === choice ? 1 : 0, BigInt(r[j])) : identityCiphertext()));
    const v = vectors.ballotHash.vectors.find((x) => x.name.startsWith("real ElGamal"));
    assert.deepEqual(ciphertextCoordinates(cts).map(String), v.coords);
    assert.equal(ballotHash(TEST_CONTEXT, constituencyIdValue("KA-BLR"), cts), BigInt(v.ballotHash));
  });

  it("the previously published ballot-hash vectors are unchanged by freezing the encodings (identity padding, sequence)", () => {
    assert.equal(BigInt(vectors.ballotHash.vectors[0].ballotHash), 0xe6a73d4fa68edd0acc01594aaceb4eafa4d4a0ccdb12d16557659794621c539dn);
    assert.equal(BigInt(vectors.ballotHash.vectors[1].ballotHash), 0xc6d24f076cb2698a493b46ffd17902444aff965138495c13ac2af76c55c1683cn);
  });

  it("ENCODINGS.md contains every vector output, tag and constituency id, and nothing the vector file does not have", () => {
    const docValues = new Set(doc.match(/0x[0-9a-f]{64}/g));
    const fileOutputs = [...vectors.scope.vectors.map((v) => v.scope), ...vectors.ballotHash.vectors.map((v) => v.ballotHash), vectors.tags.SCOPE_TAG.bytes32, vectors.tags.BALLOT_TAG.bytes32, vectors.constituencyIds["KA-BLR"]];
    for (const value of fileOutputs) assert.ok(docValues.has(value), `ENCODINGS.md is missing ${value}`);
    const everything = new Set(JSON.stringify(vectors).match(/0x[0-9a-f]{64}/g));
    for (const value of docValues) assert.ok(everything.has(value), `ENCODINGS.md has a value that is not in spec/vectors.json: ${value}`);
    for (const rule of ["uint256[64]", "abi.encode", "slot-major", "abi.encodePacked", "2,208 bytes", "keccak256(\"VOTECHAIN-V3-SCOPE-1\")", "keccak256(\"VOTECHAIN-V3-BALLOT-1\")"]) assert.ok(doc.toLowerCase().includes(rule.toLowerCase()), `ENCODINGS.md must state: ${rule}`);
  });
});
