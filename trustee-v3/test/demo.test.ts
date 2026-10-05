// The demo script itself: a real run, in memory and with encrypted storage and reload.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [path.join("scripts", "demo.ts"), ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 300_000 });

describe("election demo script", () => {
  it("[7, 4, 2] is recovered by trustees 1+3, 1+2 and 2+3, with IDENTICAL group points, and one trustee alone is refused", () => {
    const result = run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.trueCounts, [7, 4, 2]);
    assert.equal(summary.ballotCount, 13);
    assert.deepEqual(summary.pairs.map((p: { trustees: number[] }) => p.trustees), [[1, 3], [1, 2], [2, 3]]);
    for (const pair of summary.pairs) {
      assert.deepEqual(pair.totals, [7, 4, 2]);
      assert.deepEqual(pair.decryptedPoints, summary.pairs[0].decryptedPoints);
    }
    assert.equal(summary.oneTrusteeAlone, "INSUFFICIENT_PARTIALS");
    assert.equal(summary.storedEncryptedShares, null);
    assert.equal(summary.threshold, "2-of-3");
    assert.match(summary.transcriptHash, /^0x[0-9a-f]{64}$/);
  });

  it("with --store: shares are written ENCRYPTED, one directory per trustee, the trustees are reloaded from those files, and the same [7, 4, 2] comes out; passwords never appear in any output", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trustee-v3-test-"));
    try {
      const passwords = [1, 2, 3].map(() => randomBytes(18).toString("base64"));
      const env = { TRUSTEE_V3_PASSWORD_1: passwords[0]!, TRUSTEE_V3_PASSWORD_2: passwords[1]!, TRUSTEE_V3_PASSWORD_3: passwords[2]! };
      const result = run(["--json", "--store", dir], env);
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      for (const pair of summary.pairs) assert.deepEqual(pair.totals, [7, 4, 2]);
      assert.equal(summary.storedEncryptedShares.length, 3);
      assert.deepEqual(fs.readdirSync(dir).sort(), ["trustee-1", "trustee-2", "trustee-3"]);
      for (const i of [1, 2, 3]) {
        assert.deepEqual(fs.readdirSync(path.join(dir, `trustee-${i}`)), ["share.json"]);
        const file = JSON.parse(fs.readFileSync(path.join(dir, `trustee-${i}`, "share.json"), "utf8"));
        assert.equal(file.public.index, i);
        assert.equal(file.kdf.alg, "argon2id13");
        assert.equal(file.kdf.memlimit, 268435456);
      }
      for (const password of passwords) {
        assert.ok(!result.stdout.includes(password) && !result.stderr.includes(password), "a password in the output");
        for (const i of [1, 2, 3]) assert.ok(!fs.readFileSync(path.join(dir, `trustee-${i}`, "share.json"), "utf8").includes(password));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--store without passwords in the environment fails closed (nothing hard-coded to fall back on), and writes nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trustee-v3-test-"));
    try {
      const env = { TRUSTEE_V3_PASSWORD_1: "", TRUSTEE_V3_PASSWORD_2: "", TRUSTEE_V3_PASSWORD_3: "" };
      const result = run(["--json", "--store", dir], env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /TRUSTEE_V3_PASSWORD_1/);
      assert.deepEqual(fs.readdirSync(dir), []);
      const short = run(["--json", "--store", dir], { TRUSTEE_V3_PASSWORD_1: "short", TRUSTEE_V3_PASSWORD_2: "short", TRUSTEE_V3_PASSWORD_3: "short" });
      assert.notEqual(short.status, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
