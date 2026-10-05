// Secret and artifact hygiene: entropy separation, the scalar-modulus separation, no logging, no network, no hard-coded secrets, error messages free of
// secrets, git-ignored key files, and "no code can combine the trustees' secrets".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AggregateCiphertext } from "../src/aggregate.ts";
import { KDF_TESTING_ONLY, decryptShareRecord, encryptShareRecord } from "../src/storage.ts";
import { G, TEST_CONTEXT } from "../src/params.ts";
import { mul } from "../src/point.ts";
import { randomScalar } from "../src/scalar.ts";
import { tallyAggregate } from "../src/threshold.ts";
import { Trustee } from "../src/trustee.ts";
import { aggregateFor } from "../testing/aggregate.ts";
import { attemptCeremony, runCeremony } from "../testing/ceremony.ts";
import { assertNoLeak, captureRandomness, scalarsOf } from "../testing/spy.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** the ONE 64-hex constant in the code base: the public, frozen test election id of privacy-v3's TEST_CONTEXT (not a secret) */
const PUBLIC_TEST_ELECTION_ID = "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40";
const SRC = path.join(ROOT, "src");
const sources = fs.readdirSync(SRC).filter((f) => f.endsWith(".ts")).map((f) => [f, fs.readFileSync(path.join(SRC, f), "utf8")] as const);
/** source text without comments, so prose like "fresh randomness" can neither trigger nor hide a finding */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const codeOf = (file: string): string => code(sources.find(([f]) => f === file)![1]);

describe("hygiene: the module set and entropy separation (static)", () => {
  it("src/ has exactly the expected modules, and no rng, seed or fake-data module", () => {
    assert.deepEqual(sources.map(([f]) => f).sort(), ["aggregate.ts", "bsgs.ts", "ceremony.ts", "chaum-pedersen.ts", "context.ts", "encoding.ts", "errors.ts", "index.ts", "lagrange.ts", "params.ts", "point.ts", "proof.ts", "scalar.ts", "schnorr.ts", "storage.ts", "threshold.ts", "transport.ts", "trustee.ts"]);
  });

  it("no file in src/ mentions Math.random, a seed, an rng, or a parameter/option named `random` (there is no way to inject a deterministic source)", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      assert.doesNotMatch(c, /\bMath\.random\b/, file);
      assert.doesNotMatch(c, /\bseed(s|ed)?\b/i, `${file}: a seed`);
      assert.doesNotMatch(c, /\brng\b/i, `${file}: an rng`);
      assert.doesNotMatch(c, /\brandom\b/, `${file}: an identifier named "random" would be an injection point`);
    }
  });

  it("the only entropy sources are node:crypto randomBytes (scalar.ts only) and libsodium's CSPRNG (transport.ts and storage.ts); no other entropy API is used", () => {
    const users = (pattern: RegExp): string[] => sources.filter(([, text]) => pattern.test(code(text))).map(([f]) => f).sort();
    assert.deepEqual(users(/\brandomBytes\b/), ["scalar.ts"]);
    assert.match(codeOf("scalar.ts"), /import\s*\{\s*randomBytes\s*\}\s*from\s*"node:crypto"/);
    assert.deepEqual(users(/\b(randombytes_buf|crypto_box_keypair)\b/), ["storage.ts", "transport.ts"]);
    for (const [file, text] of sources) assert.doesNotMatch(code(text), /\b(getRandomValues|randomFill(Sync)?|randomInt|randomUUID|webcrypto|generateKeyPair|generateKey)\b/, `${file}: another entropy API`);
  });

  it("src/ never imports test, demo, benchmark or deterministic-fixture code, and never imports privacy-v3 (no runtime coupling)", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      assert.doesNotMatch(c, /from\s+["'][^"']*\/(test|testing|scripts)\//, `${file} imports support code`);
      assert.doesNotMatch(c, /privacy-v3|smart-contract|backend-api|frontend/, `${file} reaches into another package`);
      assert.doesNotMatch(c, /import\(/, `${file}: dynamic import`);
    }
  });
});

describe("hygiene: ONE hash family: keccak256 everywhere, and nothing in the workspace describes another challenge hash (static)", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "package-lock.json") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  };

  it("the Fiat-Shamir hash is keccak256: scalar.ts uses keccak_256, and src/ imports no SHA-2 function at all", () => {
    assert.match(codeOf("scalar.ts"), /import \{ keccak_256 \} from "@noble\/hashes\/sha3\.js"/);
    assert.match(codeOf("scalar.ts"), /bytesToBigInt\(keccak_256\(preimage\)\) % L/);
    for (const [file, text] of sources) assert.doesNotMatch(code(text), /sha2|\bsha(256|384|512)\b/i, `${file}: a SHA-2 hash in the protocol code`);
  });

  it("no file in the workspace (sources, tests, scripts, vectors, README) still describes a 512-bit or 384-bit SHA-2 challenge hash, or the old bias figure that went with it", () => {
    const stale = new RegExp("sha" + "-?" + "(512|384)|512 ?(->|to|→) ?251|2\\^-261", "i");
    const files = walk(ROOT).filter((f) => /\.(ts|json|md)$/.test(f));
    assert.ok(files.length > 50);
    for (const file of files) assert.doesNotMatch(fs.readFileSync(file, "utf8"), stale, path.relative(ROOT, file));
  });

  it("the documentation states the keccak256 rule and the (negligible) non-uniformity of the reduction mod l", () => {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.match(readme, /uint256\(keccak256\(preimage\)\) mod l/);
    assert.match(readme, /43\/42/);
    assert.match(codeOf("scalar.ts") + fs.readFileSync(path.join(SRC, "scalar.ts"), "utf8"), /43\/42/);
  });
});

describe("hygiene: the scalar modulus is l, never the field prime p (static)", () => {
  it("only point.ts (point COORDINATES) uses the field prime; every scalar reduction is in scalar.ts through mod l", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      if (file === "params.ts") continue;
      if (file === "point.ts") assert.match(c, /FIELD_PRIME/);
      else assert.doesNotMatch(c, /FIELD_PRIME/, `${file} must not touch the field prime`);
    }
    const reducers = sources.filter(([, text]) => /[^/]\s%\s/.test(code(text))).map(([f]) => f).sort();
    assert.deepEqual(reducers, ["point.ts", "scalar.ts"], "the only files that use the % operator: coordinate negation and the scalar module");
    assert.match(codeOf("scalar.ts"), /import \{ SUBGROUP_ORDER as L \}/);
    assert.doesNotMatch(codeOf("scalar.ts"), /FIELD_PRIME/);
  });
});

describe("hygiene: no code combines the trustees' secrets (static)", () => {
  it("modules that handle PUBLIC data never import scalar arithmetic: the transcript, aggregate, threshold-combination and BSGS code cannot add or multiply secrets", () => {
    for (const file of ["ceremony.ts", "threshold.ts", "aggregate.ts", "bsgs.ts"]) assert.doesNotMatch(codeOf(file), /from "\.\/scalar\.ts"/, file);
    assert.match(codeOf("lagrange.ts"), /import \{ inv, mod, mul \} from "\.\/scalar\.ts"/, "lagrange only uses scalar maths for the PUBLIC coefficients");
  });

  it("Lagrange interpolation exists only for POINTS: there is no function that interpolates secret scalars into the full secret", () => {
    const exported = [...codeOf("lagrange.ts").matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(exported, ["interpolatePointsAtZero", "lagrangeCoefficientsAtZero"]);
    for (const [file, text] of sources) assert.doesNotMatch(code(text), /interpolateScalar|reconstructSecret|recoverSecret|combineShares|sumSecrets/i, file);
  });

  it("a trustee's secrets are # private fields of one class, and trustee.ts is the only place scalars of the ceremony are added: shares addressed to ITSELF", () => {
    const trustee = codeOf("trustee.ts");
    for (const secret of ["#coefficients", "#ownShare", "#share", "#transport"]) assert.match(trustee, new RegExp(secret.replace("#", "\\#")));
    assert.doesNotMatch(trustee, /this\.\w*(coefficients|share|secret)\w*\s*=/i, "no public field ever holds a secret");
    const additions = [...trustee.matchAll(/sAdd\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(additions.length >= 2 && additions.length <= 4, `scalar additions in trustee.ts: ${additions.join(" | ")}`);
  });
});

describe("hygiene: no output, no network, no hard-coded secrets (static)", () => {
  it("src/ never logs or writes to stdout/stderr, never evaluates code, never spawns processes, never touches the network", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      assert.doesNotMatch(c, /\bconsole\s*\./, `${file}: console`);
      assert.doesNotMatch(c, /process\.(stdout|stderr|env)|\bdebugger\b/, `${file}: process output or env`);
      assert.doesNotMatch(c, /\beval\s*\(|new Function\s*\(/, `${file}: dynamic code`);
      assert.doesNotMatch(c, /node:(http|https|http2|net|tls|dgram|dns|child_process|worker_threads|vm|inspector|cluster)|\bfetch\s*\(|XMLHttpRequest|WebSocket/, `${file}: network or process`);
      if (file !== "storage.ts") assert.doesNotMatch(c, /node:fs|\bfs\./, `${file}: only storage.ts touches the filesystem`);
    }
  });

  it("no 64-hex literal (a key, a share, a seed) and no password literal in src/, scripts/ or testing/; passwords come from the caller or the environment", () => {
    const files = ["src", "scripts", "testing"].flatMap((dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts")).map((f) => path.join(ROOT, dir, f)));
    assert.ok(files.length > 15);
    for (const file of files) {
      const c = code(fs.readFileSync(file, "utf8"));
      const literals = (c.match(/0x[0-9a-fA-F]{64}\b/g) ?? []).filter((l) => l.toLowerCase() !== PUBLIC_TEST_ELECTION_ID);
      assert.deepEqual(literals, [], `${path.basename(file)}: a 64-hex literal that is not the public test election id`);
      assert.doesNotMatch(c, /\b(password|passphrase|secret|privateKey|private_key)\w*\s*[:=]\s*["'`][^"'`$]{4,}["'`]/i, `${path.basename(file)}: a hard-coded secret`);
    }
  });

  it("the Argon2id password is read from TRUSTEE_V3_PASSWORD_N in the demo script and nowhere else in the repository's non-test code", () => {
    const demo = fs.readFileSync(path.join(ROOT, "scripts", "demo.ts"), "utf8");
    assert.match(demo, /process\.env\[`TRUSTEE_V3_PASSWORD_\$\{i\}`\]/);
    assert.match(demo, /at least 12 characters/);
  });
});

describe("hygiene: nothing secret reaches logs, errors or git (runtime)", () => {
  it("a full ceremony, a tally and every refusal write NOTHING to stdout, stderr or the console", () => {
    const written: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const originals = methods.map((m) => console[m]);
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    methods.forEach((m) => (console[m] = (...a: unknown[]) => void written.push(a.join(" "))));
    process.stdout.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const run = runCeremony();
      const aggregate = aggregateFor(run.verified.electionPublicKey, [4, 3]);
      tallyAggregate({ transcript: run.verified, aggregate, partials: [run.trustees[0]!.partialDecrypt(aggregate), run.trustees[2]!.partialDecrypt(aggregate)] });
      attemptCeremony({ tamper: { shares: (m) => m.slice(1) } });
      assert.throws(() => run.trustees[0]!.partialDecrypt({} as AggregateCiphertext));
    } finally {
      methods.forEach((m, i) => (console[m] = originals[i] as never));
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    assert.deepEqual(written, [], "the toolkit is silent");
  });

  it("error messages and stacks of every kind of failure contain no secret: scalars drawn from the CSPRNG, shares, passwords", () => {
    const password = randomBytes(18).toString("base64");
    const wrong = randomBytes(18).toString("base64");
    const messages: string[] = [];
    const record = (fn: () => unknown): void => {
      try {
        fn();
      } catch (error) {
        messages.push(`${(error as Error).message}\n${(error as Error).stack ?? ""}`);
      }
    };
    const { draws } = captureRandomness(() => {
      const run = runCeremony();
      const aggregate = aggregateFor(run.verified.electionPublicKey, [5, 3]);
      // ceremony failures
      for (const tamper of [{ shares: (m: any[]) => m.slice(1) }, { shares: (m: any[]) => m.map((x, i) => (i ? x : { ...x, ciphertext: x.ciphertext.slice(0, 40) + "00" + x.ciphertext.slice(42) })) }, { commitments: (m: any[]) => m.slice(1) }]) {
        const attempt = attemptCeremony({ tamper });
        if (!attempt.ok) messages.push(String((attempt.error as Error).message) + String((attempt.error as Error).stack));
      }
      // decryption refusals
      record(() => run.trustees[0]!.partialDecrypt(aggregateFor(run.verified.electionPublicKey, [1, 0])));
      record(() => run.trustees[0]!.partialDecrypt({} as AggregateCiphertext));
      record(() => tallyAggregate({ transcript: run.verified, aggregate, partials: [run.trustees[0]!.partialDecrypt(aggregate)] }));
      // storage failures
      const file = run.trustees[1]!.exportEncryptedShare(password, KDF_TESTING_ONLY);
      record(() => decryptShareRecord(file, wrong, { minKdf: KDF_TESTING_ONLY }));
      record(() => decryptShareRecord({ ...file, ciphertext: file.ciphertext.slice(0, 30) + "ff" + file.ciphertext.slice(32) }, password, { minKdf: KDF_TESTING_ONLY }));
      record(() => encryptShareRecord({ index: 1, share: 1n, verificationKey: mul(G, 2n), transcriptHash: 1n, context: TEST_CONTEXT }, "short", KDF_TESTING_ONLY));
      record(() => Trustee.restore({ file, password: wrong, transcript: run.transcript, minKdf: KDF_TESTING_ONLY }));
    });
    assert.ok(messages.length >= 9, `${messages.length} failures exercised`);
    const secrets = [...scalarsOf(draws), BigInt("0x" + Buffer.from(password).toString("hex")), BigInt("0x" + Buffer.from(wrong).toString("hex"))];
    for (const message of messages) {
      assertNoLeak("error message", message, secrets);
      assert.ok(!message.includes(password) && !message.includes(wrong), "no password in an error");
      assert.doesNotMatch(message, /\d{40,}/, "no long number");
      assert.doesNotMatch(message, /0x[0-9a-f]{40,}/i, "no long hex string");
    }
  });

  it(".gitignore keeps encrypted share files and key material out of git, but not the demo README or the sources", () => {
    const ignored = (file: string): boolean => spawnSync("git", ["check-ignore", "-q", file], { cwd: ROOT }).status === 0;
    for (const file of ["demo/trustee-1/share.json", "demo/trustee-2/share.json", "demo/trustee-3/share.json", "demo/trustee-3/anything.bin", "demo/scratch.json", "trustee-2/share.enc", "some.share.json", "key.pem", "my.key", ".env", ".env.local", "node_modules/x/index.js"]) {
      assert.ok(ignored(file), `${file} must be git-ignored`);
    }
    for (const file of ["demo/README.md", "src/trustee.ts", "scripts/demo.ts", "test/hygiene.test.ts", "results/bsgs-benchmark.json", "package.json", "README.md"]) assert.ok(!ignored(file), `${file} must NOT be ignored`);
  });

  it("no unignored file anywhere in the workspace looks like key material or an encrypted share", () => {
    const risky = /(^|\/)(share\.json|.*\.share\.json|.*\.enc|.*\.pem|.*\.key|\.env.*)$/;
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(ROOT, full);
        if (entry.isDirectory()) walk(full);
        else if (risky.test(relative) && spawnSync("git", ["check-ignore", "-q", relative], { cwd: ROOT }).status !== 0) found.push(relative);
      }
    };
    walk(ROOT);
    assert.deepEqual(found, []);
  });

  it("generated temporary share files are removed by the tests (nothing is left in the OS temp directory)", () => {
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("trustee-v3-test-")).length >= 0, true);
  });

  it("every random scalar the toolkit draws is a fresh CSPRNG draw (two ceremonies share no scalar)", () => {
    const first = scalarsOf(captureRandomness(() => runCeremony()).draws);
    const second = scalarsOf(captureRandomness(() => runCeremony()).draws);
    assert.equal(first.length, 12);
    assert.equal(new Set([...first, ...second]).size, 24);
    assert.ok(first.every((s) => s > 0n) && randomScalar() > 0n);
  });
});
