// The two encodings shared with VoteChainV3: the partial-decryption bundle hash and the results hash. Known-answer vectors (spec/integration-vectors.json) checked
// against this implementation AND an independent ethers recomputation; every field is bound; the validity rules; drift.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AbiCoder, id as keccakOfText, keccak256, toBeHex } from "ethers";
import { BUNDLE_WORDS, activeWordsOf, bundleFromPartial, bundleHash, padBundle, partialFromBundle, type BundleHeader } from "../src/bundle.ts";
import { hex32 } from "../src/encoding.ts";
import { PDEC_BUNDLE_TAG, RESULTS_TAG, TEST_CONTEXT } from "../src/params.ts";
import { assertValidResults, padTotals, resultsHash } from "../src/results.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v = JSON.parse(fs.readFileSync(path.join(ROOT, "spec", "integration-vectors.json"), "utf8"));
const coder = AbiCoder.defaultAbiCoder();
const big = (hex: string): bigint => BigInt(hex);
const transcriptHash = big(v.transcriptHash);
const ctxTypes = ["uint256", "address", "bytes32"] as const;
void ctxTypes;

describe("tally encodings: tags and vectors", () => {
  it("the tags are keccak256 of their labels, as recommended: VOTECHAIN-V3-PDEC-BUNDLE-1 and VOTECHAIN-V3-RESULTS-1", () => {
    assert.equal(v.tags.PDEC_BUNDLE_TAG, keccakOfText("VOTECHAIN-V3-PDEC-BUNDLE-1"));
    assert.equal(v.tags.RESULTS_TAG, keccakOfText("VOTECHAIN-V3-RESULTS-1"));
    assert.equal(PDEC_BUNDLE_TAG, big(v.tags.PDEC_BUNDLE_TAG));
    assert.equal(RESULTS_TAG, big(v.tags.RESULTS_TAG));
    assert.notEqual(PDEC_BUNDLE_TAG, RESULTS_TAG);
  });

  for (const vector of v.bundles as any[]) {
    it(`bundle hash, ${vector.name}: the implementation and an independent abi.encode + keccak256 give the vector's hash (73 static words, 2336 bytes)`, () => {
      const words = (vector.words as string[]).map(big);
      const header: BundleHeader = { context: TEST_CONTEXT, transcriptHash, trusteeIndex: vector.trusteeIndex, constituencyId: big(vector.constituencyId), ballotCount: vector.ballotCount, candidateCount: vector.candidateCount };
      assert.equal(hex32(bundleHash(header, words)), vector.bundleHash);
      const encoded = coder.encode(
        ["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256", "bytes32", "uint256", "uint256", "uint256[64]"],
        [v.tags.PDEC_BUNDLE_TAG, TEST_CONTEXT.chainId, toBeHex(TEST_CONTEXT.contractAddress, 20), toBeHex(TEST_CONTEXT.electionId, 32), v.transcriptHash, vector.trusteeIndex, vector.constituencyId, vector.ballotCount, vector.candidateCount, words],
      );
      assert.equal((encoded.length - 2) / 2, 2336);
      assert.equal(vector.preimageBytes, 2336);
      assert.equal(keccak256(encoded), vector.bundleHash);
      assert.equal(keccak256(encoded), vector.keccakOfPreimage);
      // the padded slots are the one canonical padding: four zero words
      assert.ok(words.slice(4 * vector.candidateCount).every((w) => w === 0n));
      assert.deepEqual(padBundle(words.slice(0, 4 * vector.candidateCount), vector.candidateCount), words);
    });
  }

  for (const vector of v.results as any[]) {
    it(`results hash, ${vector.name}: the implementation and an independent abi.encode + keccak256 give the vector's hash (24 static words, 768 bytes)`, () => {
      const totals = (vector.totals as string[]).map(big);
      const header = { context: TEST_CONTEXT, transcriptHash, constituencyId: big(vector.constituencyId), ballotCount: vector.ballotCount, candidateCount: vector.candidateCount };
      assert.equal(hex32(resultsHash(header, totals)), vector.resultsHash);
      const encoded = coder.encode(
        ["bytes32", "uint256", "address", "bytes32", "bytes32", "bytes32", "uint256", "uint256", "uint256[16]"],
        [v.tags.RESULTS_TAG, TEST_CONTEXT.chainId, toBeHex(TEST_CONTEXT.contractAddress, 20), toBeHex(TEST_CONTEXT.electionId, 32), v.transcriptHash, vector.constituencyId, vector.ballotCount, vector.candidateCount, totals],
      );
      assert.equal((encoded.length - 2) / 2, 768);
      assert.equal(keccak256(encoded), vector.resultsHash);
      assert.equal(keccak256(encoded), vector.keccakOfPreimage);
      assert.ok(totals.slice(vector.candidateCount).every((t) => t === 0n));
      assert.doesNotThrow(() => assertValidResults(totals, vector.ballotCount, vector.candidateCount));
    });
  }
});

describe("tally encodings: every field is bound", () => {
  const vector = v.bundles[0];
  const words = (vector.words as string[]).map(big);
  const base: BundleHeader = { context: TEST_CONTEXT, transcriptHash, trusteeIndex: 2, constituencyId: big(vector.constituencyId), ballotCount: 13, candidateCount: 3 };
  const original = bundleHash(base, words);

  it("the bundle hash binds chain id, contract, election id, transcript hash, trustee index, constituency, ballot count, candidate count and every one of the 64 words", () => {
    const variants: [string, bigint][] = [
      ["chainId", bundleHash({ ...base, context: { ...TEST_CONTEXT, chainId: 1n } }, words)],
      ["contract", bundleHash({ ...base, context: { ...TEST_CONTEXT, contractAddress: 1n } }, words)],
      ["election", bundleHash({ ...base, context: { ...TEST_CONTEXT, electionId: 1n } }, words)],
      ["transcript", bundleHash({ ...base, transcriptHash: transcriptHash + 1n }, words)],
      ["trustee", bundleHash({ ...base, trusteeIndex: 3 }, words)],
      ["constituency", bundleHash({ ...base, constituencyId: base.constituencyId + 1n }, words)],
      ["ballotCount", bundleHash({ ...base, ballotCount: 14 }, words)],
      ["candidateCount", bundleHash({ ...base, candidateCount: 4 }, words)],
    ];
    for (const [name, value] of variants) assert.notEqual(value, original, name);
    for (let i = 0; i < BUNDLE_WORDS; i++) assert.notEqual(bundleHash(base, words.map((w, k) => (k === i ? w ^ 1n : w))), original, `word ${i}`);
  });

  it("the results hash binds chain id, contract, election id, transcript hash, constituency, ballot count, candidate count and every total", () => {
    const totals = padTotals([7, 4, 2], 3);
    const header = { context: TEST_CONTEXT, transcriptHash, constituencyId: big(vector.constituencyId), ballotCount: 13, candidateCount: 3 };
    const original2 = resultsHash(header, totals);
    const variants: [string, bigint][] = [
      ["chainId", resultsHash({ ...header, context: { ...TEST_CONTEXT, chainId: 2n } }, totals)],
      ["contract", resultsHash({ ...header, context: { ...TEST_CONTEXT, contractAddress: 2n } }, totals)],
      ["election", resultsHash({ ...header, context: { ...TEST_CONTEXT, electionId: 2n } }, totals)],
      ["transcript", resultsHash({ ...header, transcriptHash: transcriptHash + 1n }, totals)],
      ["constituency", resultsHash({ ...header, constituencyId: header.constituencyId + 1n }, totals)],
      ["a different valid split of the same 13 ballots", resultsHash(header, padTotals([6, 5, 2], 3))],
      ["candidateCount", resultsHash({ ...header, candidateCount: 4 }, padTotals([7, 4, 2, 0], 4))],
    ];
    for (const [name, value] of variants) assert.notEqual(value, original2, name);
  });
});

describe("tally encodings: shapes and validity rules", () => {
  it("padBundle zero-fills; activeWordsOf refuses non-canonical padding and wrong sizes; partial <-> bundle round trips", () => {
    const active = Array.from({ length: 12 }, (_, i) => BigInt(i + 1));
    const bundle = padBundle(active, 3);
    assert.equal(bundle.length, BUNDLE_WORDS);
    assert.deepEqual(activeWordsOf(bundle, 3), active);
    for (const slot of [3, 8, 15]) assert.throws(() => activeWordsOf(bundle.map((w, i) => (i === 4 * slot + 2 ? 1n : w)), 3), /NON_CANONICAL_PADDING/, `slot ${slot}`);
    assert.throws(() => padBundle(active, 4), /BAD_BUNDLE/);
    assert.throws(() => padBundle([...active, 0n], 3), /BAD_BUNDLE/);
    assert.throws(() => activeWordsOf(bundle.slice(0, 63), 3), /BAD_BUNDLE/);
    assert.throws(() => padBundle(active.map(() => -1n), 3), /BAD_BUNDLE/);
    assert.throws(() => padBundle(active.map(() => 1n << 256n), 3), /BAD_BUNDLE/);
    assert.throws(() => padBundle(active, 0), /BAD_INTEGER/);
    assert.throws(() => padBundle(active, 17), /BAD_INTEGER/);
    const partial = partialFromBundle({ trusteeIndex: 2, constituencyId: 77n, activeWords: active, candidateCount: 3 });
    assert.equal(partial.slots.length, 3);
    assert.deepEqual(activeWordsOf(bundleFromPartial(partial, 3), 3), active);
    assert.throws(() => bundleFromPartial(partial, 2), /BAD_BUNDLE/);
    assert.throws(() => bundleFromPartial({ ...partial, slots: [partial.slots[1]!, partial.slots[0]!, partial.slots[2]!] }, 3), /BAD_BUNDLE/);
  });

  it("assertValidResults: exactly K_c totals, each <= the ballot count, padded totals zero, and the sum equal to the ballot count", () => {
    assert.doesNotThrow(() => assertValidResults(padTotals([7, 4, 2], 3), 13, 3));
    assert.doesNotThrow(() => assertValidResults(padTotals([0, 0], 2), 0, 2), "an empty constituency");
    assert.doesNotThrow(() => assertValidResults(padTotals([1, 0, 0], 3), 1, 3), "a single ballot");
    const good = padTotals([7, 4, 2], 3);
    assert.throws(() => assertValidResults(good.map((t, j) => (j === 5 ? 1n : t)), 13, 3), /PADDED_TOTAL_NOT_ZERO/);
    assert.throws(() => assertValidResults(padTotals([14, 0, 0], 3), 13, 3), /TOTAL_ABOVE_BALLOT_COUNT/);
    assert.throws(() => assertValidResults(padTotals([7, 4, 3], 3), 13, 3), /TOTALS_DO_NOT_SUM_TO_BALLOTS/);
    assert.throws(() => assertValidResults(padTotals([7, 4, 1], 3), 13, 3), /TOTALS_DO_NOT_SUM_TO_BALLOTS/);
    assert.throws(() => assertValidResults(good.slice(0, 15), 13, 3), /BAD_RESULTS/);
    assert.throws(() => assertValidResults(good.map((t, j) => (j === 0 ? -1n : t)), 13, 3), /BAD_RESULTS/);
    assert.throws(() => resultsHash({ context: TEST_CONTEXT, transcriptHash, constituencyId: 1n, ballotCount: 13, candidateCount: 3 }, padTotals([7, 4, 3], 3)), /TOTALS_DO_NOT_SUM_TO_BALLOTS/, "an invalid result has no hash");
    assert.throws(() => padTotals([1, 2.5], 2), /BAD_RESULTS/);
    assert.throws(() => padTotals([1], 2), /BAD_RESULTS/);
    assert.throws(() => padTotals([-1, 0], 2), /BAD_RESULTS/);
  });
});

describe("tally encodings: drift", () => {
  const generate = (args: string[]) => spawnSync(process.execPath, [path.join("scripts", "make-integration-vectors.ts"), ...args], { cwd: ROOT, encoding: "utf8" });

  it("spec/integration-vectors.json is exactly what the generator emits now", () => {
    const result = generate(["--check"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /up to date/);
  });

  it("the drift check detects a changed digit, a missing file and an old-format file; generation is deterministic", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trustee-v3-test-"));
    try {
      const text = fs.readFileSync(path.join(ROOT, "spec", "integration-vectors.json"), "utf8");
      const index = text.indexOf('"bundleHash": "0x') + '"bundleHash": "0x'.length + 4;
      const tampered = text.slice(0, index) + (text[index] === "0" ? "1" : "0") + text.slice(index + 1);
      for (const [name, content] of [["changed", tampered], ["missing", null], ["old", "{}\n"]] as const) {
        const file = path.join(dir, `${name}.json`);
        if (content !== null) fs.writeFileSync(file, content);
        const result = generate(["--check", "--file", file]);
        assert.equal(result.status, 1, name);
        assert.match(result.stderr, /DRIFT/);
      }
      const fresh = path.join(dir, "fresh.json");
      assert.equal(generate(["--file", fresh]).status, 0);
      assert.equal(fs.readFileSync(fresh, "utf8"), text);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
