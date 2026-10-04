// RNG separation. Ballot encryption in the core must draw its randomness ONLY from the operating system's CSPRNG (node:crypto randomBytes).
// There must be no parameter, option, seed or hook through which a deterministic source can reach production code. Deterministic fake voters exist
// only in testing/ (and are used by scripts/ and test/); src/ must never import them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "../src/artifacts.js";
import { encryptVector, oneHot } from "../src/ballot.js";
import { generateTestKeyPair, randomScalar } from "../src/elgamal.js";
import { SUBGROUP_ORDER, TEST_CONTEXT } from "../src/params.js";
import { prepareBallot } from "../src/voter.js";
import { fakeVoter } from "../testing/fake-voters.js";

const SRC = path.join(ROOT, "src");
const sources = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith(".js"))
  .map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")]);
/** source text without comments, so prose like "fresh randomness" cannot trigger (or hide) a finding */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const codeOf = (file) => code(sources.find(([f]) => f === file)[1]);

describe("RNG separation: the core has no seed and no RNG injection point (static)", () => {
  it("src/ contains the expected modules and no rng module", () => {
    assert.deepEqual(sources.map(([f]) => f).sort(), ["artifacts.js", "ballot.js", "ballotbox.js", "elgamal.js", "params.js", "semaphore.js", "validity.js", "voter.js"]);
    assert.equal(fs.existsSync(path.join(SRC, "rng.js")), false);
  });

  it("no file in src/ mentions a seed, an rng, Math.random, a parameter named `random`, or the deterministic fake voters", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      assert.doesNotMatch(c, /\bMath\.random\b/, file);
      assert.doesNotMatch(c, /\bseed(s|ed)?\b/i, `${file}: a seed`);
      assert.doesNotMatch(c, /\brng\b/i, `${file}: an rng`);
      assert.doesNotMatch(c, /\brandom\b/, `${file}: a parameter, option or variable named "random" would be an injection point`);
      assert.doesNotMatch(c, /\bfake-?voter\b/i, `${file}: deterministic fake voters belong to testing/`);
    }
  });

  it("src/ never imports test, demo or benchmark support code", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      assert.doesNotMatch(c, /from\s+["'][^"']*\/(test|testing|scripts)\//, `${file} imports support code`);
      assert.doesNotMatch(c, /from\s+["']\.\/rng(\.js)?["']/, `${file} imports an rng module`);
      assert.doesNotMatch(c, /import\(\s*["'][^"']*\/(test|testing|scripts)\//, `${file} dynamically imports support code`);
    }
  });

  it("the only entropy source is node:crypto randomBytes, and only src/elgamal.js uses it", () => {
    const users = sources.filter(([, text]) => /\brandomBytes\b/.test(code(text))).map(([f]) => f);
    assert.deepEqual(users, ["elgamal.js"]);
    assert.match(codeOf("elgamal.js"), /import\s*\{\s*randomBytes\s*\}\s*from\s*"node:crypto"/);
    for (const [file, text] of sources) assert.doesNotMatch(code(text), /\b(getRandomValues|randomFill(Sync)?|randomInt|randomUUID|webcrypto)\b/, `${file}: another entropy API`);
  });

  it("the deterministic fake voters live in testing/ (not src/) and are only label-derived Semaphore identities", () => {
    const text = fs.readFileSync(path.join(ROOT, "testing", "fake-voters.js"), "utf8");
    assert.match(text, /TEST \/ DEMO \/ BENCHMARK SUPPORT ONLY/);
    assert.equal(fakeVoter("x").commitment, fakeVoter("x").commitment, "deterministic by label, which is exactly why it must stay out of src/");
  });
});

describe("RNG separation: injected randomness is ignored (behavioural)", () => {
  // what an injected deterministic source would look like through the old hooks
  const constant = () => Buffer.alloc(48, 7);
  const hooks = { random: constant, rng: constant, seed: "same-seed", randomBytes: constant, entropy: constant };
  const H = generateTestKeyPair().publicKey;

  it("randomScalar and generateTestKeyPair take no arguments, and ignore any they are given", () => {
    assert.equal(randomScalar.length, 0);
    assert.equal(generateTestKeyPair.length, 0);
    assert.notEqual(randomScalar(constant), randomScalar(constant));
    assert.notEqual(randomScalar("same-seed"), randomScalar("same-seed"));
    assert.notEqual(generateTestKeyPair(constant).secret, generateTestKeyPair(constant).secret);
  });

  it("encryptVector draws fresh randomness every time, whatever random / seed / rng / entropy options are passed", () => {
    const m = oneHot(1, 3);
    const a = encryptVector({ H, kc: 3, m, ...hooks });
    const b = encryptVector({ H, kc: 3, m, ...hooks });
    for (let j = 0; j < 3; j++) {
      assert.notEqual(a.r[j], b.r[j], `slot ${j} randomness`);
      assert.notDeepEqual(a.ciphertexts[j].c1, b.ciphertexts[j].c1, `slot ${j} C1`);
      assert.notDeepEqual(a.ciphertexts[j].c2, b.ciphertexts[j].c2, `slot ${j} C2`);
    }
    assert.equal(new Set([...a.r.slice(0, 3), ...b.r.slice(0, 3)].map(String)).size, 6, "six independent scalars");
  });

  it("prepareBallot (the voter entry point) is not reproducible even for the same identity, choice and key", () => {
    const args = { identity: fakeVoter("rng-guard"), ctx: TEST_CONTEXT, constituency: "KA-BLR", kc: 3, choice: 1, H, ...hooks };
    const first = prepareBallot(args);
    const second = prepareBallot(args);
    assert.equal(first.nullifier, second.nullifier, "the nullifier is a function of the identity and the scope, so it IS deterministic");
    assert.notEqual(first.hash, second.hash, "...but the ciphertexts, and so the ballot hash, are not");
    for (let j = 0; j < 3; j++) assert.notEqual(first.r[j], second.r[j]);
  });

  it("the entropy looks like a CSPRNG output: 2000 draws are distinct, in [1, l-1], and have the expected top-bit and parity frequencies", () => {
    const draws = Array.from({ length: 2000 }, () => randomScalar());
    assert.equal(new Set(draws).size, draws.length);
    assert.ok(draws.every((r) => r >= 1n && r < SUBGROUP_ORDER));
    const high = draws.filter((r) => r >= 1n << 250n).length / draws.length; // expected (l - 2^250) / l = 0.339
    const odd = draws.filter((r) => (r & 1n) === 1n).length / draws.length; // expected 0.5
    assert.ok(high > 0.28 && high < 0.40, `fraction above 2^250: ${high}`);
    assert.ok(odd > 0.44 && odd < 0.56, `fraction odd: ${odd}`);
  });
});
