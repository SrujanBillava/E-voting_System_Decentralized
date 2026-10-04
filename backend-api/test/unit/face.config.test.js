import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Wallet } from "ethers";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "../../src/config/env.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { KEYS, TEST_FACE_KEY, TEST_JWT_SECRET, TEST_NULLIFIER_SECRET, TEST_TOTP_KEY, hardhatAccount, validEnv } from "../helpers/env.js";

const BACKEND_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const NAME = "FACE_TEMPLATE_ENCRYPTION_KEY";

const issuesOf = (env) => {
  try {
    loadEnv(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
    return { issues: err.issues, text: err.message };
  }
  assert.fail("expected loadEnv to throw");
};

describe("config: FACE_TEMPLATE_ENCRYPTION_KEY", () => {
  it("is loaded as a 32-byte key, with or without 0x, in any letter case", () => {
    for (const value of [TEST_FACE_KEY, "0x" + TEST_FACE_KEY, TEST_FACE_KEY.toUpperCase()]) {
      const key = loadEnv(validEnv({ [NAME]: value })).secrets.faceTemplateKey;
      assert.ok(Buffer.isBuffer(key));
      assert.equal(key.toString("hex"), TEST_FACE_KEY);
    }
  });

  it("is required: a missing or empty value stops startup and names the variable, not a value", () => {
    for (const value of [undefined, ""]) {
      const { issues } = issuesOf(validEnv({ [NAME]: value }));
      assert.deepEqual(issues.map((i) => i.path), [NAME]);
    }
  });

  it("must be exactly 32 bytes of hex", () => {
    for (const bad of [TEST_FACE_KEY.slice(2), TEST_FACE_KEY + "ab", "z".repeat(64), "not a key", TEST_FACE_KEY.slice(0, 63) + "g", " " + TEST_FACE_KEY]) {
      const { issues, text } = issuesOf(validEnv({ [NAME]: bad }));
      assert.deepEqual(issues.map((i) => i.path), [NAME]);
      assert.ok(!text.includes(bad.trim()), "the message never repeats the value");
    }
  });

  it("rejects low-entropy keys", () => {
    for (const weak of ["0".repeat(64), "ab".repeat(32), "0123".repeat(16), "f".repeat(64)]) {
      const { issues } = issuesOf(validEnv({ [NAME]: weak }));
      assert.deepEqual(issues.map((i) => i.path), [NAME]);
    }
  });

  it("must differ from EVERY other secret, and says which one it repeats", () => {
    const others = {
      OWNER_PRIVATE_KEY: KEYS.owner,
      AUTHORITY_PRIVATE_KEY: KEYS.authority,
      RELAYER_PRIVATE_KEY: KEYS.relayer,
      NULLIFIER_SECRET: TEST_NULLIFIER_SECRET,
      JWT_ACCESS_SECRET: TEST_JWT_SECRET,
      ADMIN_TOTP_ENCRYPTION_KEY: TEST_TOTP_KEY,
    };
    for (const [name, value] of Object.entries(others)) {
      for (const reused of [value, value.replace(/^0x/, "").toUpperCase(), "0x" + value.replace(/^0x/, "")]) {
        const { issues, text } = issuesOf(validEnv({ [NAME]: reused }));
        assert.ok(issues.some((i) => i.path === NAME && i.message === `must not reuse ${name}`), `${name}: ${JSON.stringify(issues)}`);
        assert.ok(!text.toLowerCase().includes(value.replace(/^0x/, "").toLowerCase()), "the message never repeats the value");
      }
    }
  });

  it("must not be a PART of a longer secret, or appear in a connection string", () => {
    const filler = "c4".repeat(16) + "7d".repeat(8) + "19a3".repeat(4);
    for (const name of ["NULLIFIER_SECRET", "JWT_ACCESS_SECRET"]) {
      for (const longer of [TEST_FACE_KEY + filler, filler + TEST_FACE_KEY, filler + TEST_FACE_KEY.toUpperCase() + filler]) {
        const { issues } = issuesOf(validEnv({ [name]: longer }));
        assert.ok(issues.some((i) => i.path === NAME && i.message === `must not reuse ${name}`), `${name}: ${JSON.stringify(issues)}`);
      }
    }
    const inMongo = issuesOf(validEnv({ MONGODB_URI: `mongodb://app:${TEST_FACE_KEY}@127.0.0.1:27017/evoting` }));
    assert.ok(inMongo.issues.some((i) => i.path === NAME && i.message === "must not appear in MONGODB_URI"));
    assert.ok(!inMongo.text.includes(TEST_FACE_KEY));
    const inRpc = issuesOf(validEnv({ CHAIN_RPC_URL: `https://rpc.example.org/v3/${TEST_FACE_KEY.toUpperCase()}` }));
    assert.ok(inRpc.issues.some((i) => i.path === NAME && i.message === "must not appear in CHAIN_RPC_URL"));
    assert.equal(loadEnv(validEnv({ NULLIFIER_SECRET: TEST_NULLIFIER_SECRET + filler })).secrets.faceTemplateKey.length, 32, "an unrelated longer secret is fine");
  });

  it("production refuses a publicly known Hardhat development key", () => {
    const production = (overrides) =>
      validEnv({ NODE_ENV: "production", CHAIN_ID: "11155111", OWNER_PRIVATE_KEY: Wallet.createRandom().privateKey, AUTHORITY_PRIVATE_KEY: Wallet.createRandom().privateKey, RELAYER_PRIVATE_KEY: Wallet.createRandom().privateKey, CORS_ORIGINS: "https://vote.example.org", ...overrides });
    assert.equal(loadEnv(production()).secrets.faceTemplateKey.length, 32);
    const { issues } = issuesOf(production({ [NAME]: hardhatAccount(7).privateKey }));
    assert.ok(issues.some((i) => i.path === NAME && /Hardhat development key/.test(i.message)), JSON.stringify(issues));
    assert.equal(loadEnv(validEnv({ [NAME]: hardhatAccount(7).privateKey })).nodeEnv, "test", "outside production it is allowed (local development)");
  });

  it("cannot leak through the config object: secrets are not enumerable and describeConfig omits it", () => {
    const config = loadEnv(validEnv());
    assert.ok(!JSON.stringify(config).includes(TEST_FACE_KEY));
    assert.ok(!JSON.stringify(describeConfig(config)).includes(TEST_FACE_KEY));
    assert.ok(!Object.keys(config).includes("secrets"));
  });

  it("is registered with the logger, which scrubs it from any text it writes", () => {
    const config = loadEnv(validEnv());
    assert.ok(secretValuesOf(config).includes(TEST_FACE_KEY));
    const memory = createMemoryLogger({ secrets: secretValuesOf(config) });
    memory.logger.error({ err: new Error(`bad key ${TEST_FACE_KEY}`), note: `0x${TEST_FACE_KEY.toUpperCase()}` }, `startup ${TEST_FACE_KEY}`);
    assert.ok(!memory.lines.join("").toLowerCase().includes(TEST_FACE_KEY));
  });
});

describe("config: face key in .env.example and init-local-env", () => {
  it(".env.example lists the variable, empty", () => {
    const example = fs.readFileSync(path.join(BACKEND_ROOT, ".env.example"), "utf8");
    assert.match(example, /^FACE_TEMPLATE_ENCRYPTION_KEY=$/m);
  });

  it("init-local-env writes a fresh random key that differs from every other secret and between runs", () => {
    const seen = [];
    for (let run = 0; run < 2; run++) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "votechain-face-env-"));
      try {
        const backend = path.join(root, "backend-api");
        fs.mkdirSync(path.join(backend, "scripts"), { recursive: true });
        fs.copyFileSync(path.join(BACKEND_ROOT, "scripts/init-local-env.js"), path.join(backend, "scripts/init-local-env.js"));
        fs.copyFileSync(path.join(BACKEND_ROOT, ".env.example"), path.join(backend, ".env.example"));
        fs.writeFileSync(path.join(backend, "package.json"), '{"type":"module"}');
        fs.symlinkSync(path.join(BACKEND_ROOT, "node_modules"), path.join(backend, "node_modules"), "junction");
        const result = spawnSync(process.execPath, [path.join(backend, "scripts/init-local-env.js")], { cwd: backend, encoding: "utf8", timeout: 20_000 });
        assert.equal(result.status, 0, result.stderr);

        const text = fs.readFileSync(path.join(backend, ".env"), "utf8");
        const values = Object.fromEntries(text.split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
        assert.match(values[NAME], /^[0-9a-f]{64}$/);
        const others = Object.entries(values).filter(([name]) => name !== NAME).map(([, value]) => value.replace(/^0x/, "").toLowerCase());
        assert.ok(!others.includes(values[NAME]));
        assert.ok(!(result.stdout + result.stderr).includes(values[NAME]), "the key is never printed");
        const config = loadEnv({ ...values, CHAIN_ID: "31337", VOTING_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3", ELECTION_ID: "0x" + "11".repeat(32) });
        assert.equal(config.secrets.faceTemplateKey.toString("hex"), values[NAME]);
        seen.push(values[NAME]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
    assert.notEqual(seen[0], seen[1]);
  });
});

import { FACE_VERIFIED_TTL_MS } from "../../src/biometrics/constants.js";
import { STAGE_TTL_MS, STAGES } from "../../src/auth/voterStages.js";

describe("stage lifetimes stay in one place", () => {
  it("STAGE_TTL_MS has a FACE_VERIFIED entry equal to the biometric constant", () => {
    assert.equal(STAGE_TTL_MS[STAGES.FACE_VERIFIED], FACE_VERIFIED_TTL_MS);
  });
});
