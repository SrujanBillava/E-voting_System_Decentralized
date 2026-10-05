// The public API is aggregate-only: nothing can decrypt an individual ballot, and the low-level primitives are not part of the exported workflow.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as api from "../src/index.ts";
import { AggregateCiphertext } from "../src/aggregate.ts";
import { Trustee } from "../src/trustee.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const sources = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts")).map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")] as const);
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("API inspection: aggregate-only decryption", () => {
  it("the exported workflow is exactly this list (a new export must be a conscious decision)", () => {
    assert.deepEqual(Object.keys(api).sort(), [
      "AggregateCiphertext", "BUNDLE_WORDS", "CeremonyAbort", "DEFAULT_MIN_BALLOTS", "DEFAULT_PARAMS", "DEFAULT_THRESHOLD", "DEFAULT_TRUSTEES", "InvalidInputError", "KDF_MODERATE", "KDF_SENSITIVE", "MAX_BALLOT_COUNT", "MAX_SLOTS", "SUBGROUP_ORDER",
      "TEST_CONTEXT", "TRANSCRIPT_VERSION", "ToolkitError", "Trustee", "VerificationError", "VerifiedAggregate", "WORDS_PER_SLOT", "activeWordsOf", "assertValidResults", "auditConstituency", "buildTranscript", "bundleFromPartial", "bundleHash",
      "combinePartialDecryptions", "confirmCeremony", "deserializeTranscript", "padBundle", "padTotals", "partialFromBundle", "readShareFile", "resultsHash", "serializeTranscript", "tallyAggregate", "verifyChainAggregate", "verifyFinalResult",
      "verifyPartialDecryption", "verifyPinnedTranscript", "verifyTranscript", "writeShareFile",
    ]);
  });

  it("there is NO exported function or method that decrypts an individual ballot, ciphertext or vote, or reveals a secret", () => {
    const names = [...Object.keys(api), ...Object.getOwnPropertyNames(Trustee.prototype), ...Object.getOwnPropertyNames(AggregateCiphertext), ...Object.getOwnPropertyNames(AggregateCiphertext.prototype)];
    for (const name of names) {
      assert.doesNotMatch(name, /individual|ballot.*decrypt|decrypt.*ballot|decryptCiphertext|decryptVote|decryptOne|reveal|exportSecret|exportShare\b|getShare|getSecret|reconstruct|recoverSecret|secretKey|privateKey/i, name);
    }
  });

  it("the only decryption entry points take an AggregateCiphertext or a verified set of partial decryptions of one: trustees decrypt aggregates, nothing else", () => {
    assert.equal(Trustee.prototype.partialDecrypt.length, 1);
    assert.match(code(sources.find(([f]) => f === "trustee.ts")![1]), /partialDecrypt\(aggregate: AggregateCiphertext\): PartialDecryption/);
    const threshold = code(sources.find(([f]) => f === "threshold.ts")![1]);
    for (const fn of ["verifyPartialDecryption", "combinePartialDecryptions", "tallyAggregate"]) assert.match(threshold, new RegExp(`export function ${fn}\\(input: \\{[^}]*aggregate: AggregateCiphertext`), fn);
  });

  it("the INTEGRATED decryption entry point takes ONLY a VerifiedAggregate, and the chain adapter exports exactly this list (a new export must be a conscious decision)", async () => {
    assert.equal(Trustee.prototype.partialDecryptVerified.length, 1);
    assert.match(code(sources.find(([f]) => f === "trustee.ts")![1]), /partialDecryptVerified\(verified: VerifiedAggregate\): PartialDecryption/);
    const chain = await import("votechain-trustee-v3/chain");
    assert.deepEqual(Object.keys(chain).sort(), [
      "auditFromChain", "constituencyKey", "endorseAuditedResult", "publishFromShareFile", "publishPartialDecryption", "readBallotLog", "readConstituencyState", "readContext", "readPartialPublications", "readPinnedConfiguration",
      "readStoredBundleHashes", "readVerifiedFinalResult",
    ]);
  });

  it("every function in src/ whose name mentions decryption is on this list, and none accepts a bare ciphertext or ballot", () => {
    const found = new Set<string>();
    for (const [, text] of sources) for (const m of code(text).matchAll(/(?:function\s+|^\s+|const\s+)(\w*[dD]ecrypt\w*)\s*(?:\(|=)/gm)) found.add(m[1]!);
    assert.deepEqual([...found].sort(), ["combinePartialDecryptions", "decrypt", "decryptShareRecord", "decryptionChallenge", "partialDecrypt", "partialDecryptVerified", "proveDecryptionShare", "proveDecryptionShareWithNonce", "verifyDecryptionShare", "verifyPartialDecryption"]);
    // none of them is parameterised by an ElGamal ciphertext type
    for (const [file, text] of sources) assert.doesNotMatch(code(text), /[{,]\s*c1\s*:|\binterface\s+\w*Ciphertext\w*\b|\btype\s+\w*Ciphertext\w*\s*=/, `${file}: a ciphertext (c1, c2) type`);
  });

  it("partialDecrypt refuses everything that is not an AggregateCiphertext: a bare ciphertext, a ballot log entry, plain data, a wire aggregate", async () => {
    const { runCeremony } = await import("../testing/ceremony.ts");
    const { aggregateFor } = await import("../testing/aggregate.ts");
    const run = runCeremony();
    const aggregate = aggregateFor(run.verified.electionPublicKey, [3, 2]);
    const refused = [{ c1: [1n, 2n], c2: [3n, 4n] }, { coords: [1n, 2n, 3n, 4n] }, { A: aggregate.slots[0]!.A, B: aggregate.slots[0]!.B }, aggregate.toWire(), aggregate.slots, [aggregate], "ballot", 7n, null];
    for (const bad of refused) assert.throws(() => run.trustees[0]!.partialDecrypt(bad as unknown as AggregateCiphertext), /NOT_AN_AGGREGATE/);
    assert.doesNotThrow(() => run.trustees[0]!.partialDecrypt(aggregate));
  });

  it("an aggregate can only be created by two audited paths: from per-slot sums, or recomputed from the public ballot log; there is no way to wrap one ballot as an aggregate silently", () => {
    assert.deepEqual(Object.getOwnPropertyNames(AggregateCiphertext).filter((n) => !["length", "name", "prototype"].includes(n)).sort(), ["create", "fromBallotLog", "isAggregate"]);
    assert.deepEqual(Object.getOwnPropertyNames(AggregateCiphertext.prototype).sort(), ["constructor", "toWire"]);
  });

  it("the package exposes ONLY the workflow entry point and the chain adapter: the low-level primitives cannot be deep-imported by a consumer", async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.deepEqual(pkg.exports, { ".": "./src/index.ts", "./chain": "./chain/index.ts" }, "the workflow entry point and the chain adapter, nothing else");
    assert.equal(pkg.main, "./src/index.ts");
    const self = await import("votechain-trustee-v3");
    assert.equal(self.Trustee, Trustee);
    for (const deep of ["votechain-trustee-v3/src/schnorr.ts", "votechain-trustee-v3/src/chaum-pedersen.ts", "votechain-trustee-v3/src/point.ts", "votechain-trustee-v3/src/scalar.ts"]) {
      await assert.rejects(import(deep), /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/, deep);
    }
  });
});
