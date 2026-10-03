import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { loadEnv } from "../../src/config/env.js";

const BACKEND_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// The scripts locate everything relative to their own file, so each test builds a small fake monorepo in a
// temp directory, copies the script into it and runs it there. Nothing in the real repository is touched.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "votechain-scripts-"));
  const backend = path.join(root, "backend-api");
  fs.mkdirSync(path.join(backend, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(backend, "src/chain/generated"), { recursive: true });
  fs.mkdirSync(path.join(root, "smart-contract/exports"), { recursive: true });
  for (const script of ["sync-abi.js", "init-local-env.js"]) fs.copyFileSync(path.join(BACKEND_ROOT, "scripts", script), path.join(backend, "scripts", script));
  fs.copyFileSync(path.join(BACKEND_ROOT, ".env.example"), path.join(backend, ".env.example"));
  fs.writeFileSync(path.join(backend, "package.json"), '{"type":"module"}');
  fs.symlinkSync(path.join(BACKEND_ROOT, "node_modules"), path.join(backend, "node_modules"), "junction"); // "junction" works without privileges on Windows
  const run = (script, ...args) => spawnSync(process.execPath, [path.join(backend, "scripts", script), ...args], { cwd: backend, encoding: "utf8", timeout: 20_000 });
  return {
    root,
    backend,
    exportFile: path.join(root, "smart-contract/exports/Voting.json"),
    copyFile: path.join(backend, "src/chain/generated/Voting.json"),
    envFile: path.join(backend, ".env"),
    run,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("script: sync-abi", () => {
  it("--check passes when the backend copy is byte-identical to the contract export", () => {
    const s = sandbox();
    try {
      fs.writeFileSync(s.exportFile, '{"a":1}\n');
      fs.writeFileSync(s.copyFile, '{"a":1}\n');
      const result = s.run("sync-abi.js", "--check");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /in sync/);
    } finally {
      s.cleanup();
    }
  });

  it("--check fails (exit 1) on any difference, a missing copy, or a missing export, and never writes", () => {
    const s = sandbox();
    try {
      fs.writeFileSync(s.exportFile, '{"a":1}\n');
      fs.writeFileSync(s.copyFile, '{"a":2}\n');
      let result = s.run("sync-abi.js", "--check");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /OUT OF SYNC/);
      assert.equal(fs.readFileSync(s.copyFile, "utf8"), '{"a":2}\n', "--check must not modify the copy");

      fs.writeFileSync(s.copyFile, '{"a":1}');
      assert.equal(s.run("sync-abi.js", "--check").status, 1, "even a missing trailing newline is a difference");

      fs.rmSync(s.copyFile);
      assert.equal(s.run("sync-abi.js", "--check").status, 1);
      assert.ok(!fs.existsSync(s.copyFile), "--check must not create the copy");

      fs.rmSync(s.exportFile);
      result = s.run("sync-abi.js", "--check");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Contract export not found/);
    } finally {
      s.cleanup();
    }
  });

  it("without --check it copies the export over the backend copy and reports what it did", () => {
    const s = sandbox();
    try {
      fs.writeFileSync(s.exportFile, '{"fresh":true}\n');
      fs.writeFileSync(s.copyFile, '{"stale":true}\n');
      let result = s.run("sync-abi.js");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /ABI copied/);
      assert.equal(fs.readFileSync(s.copyFile, "utf8"), '{"fresh":true}\n');
      result = s.run("sync-abi.js");
      assert.match(result.stdout, /already up to date/);
      assert.equal(s.run("sync-abi.js", "--check").status, 0);
    } finally {
      s.cleanup();
    }
  });

  it("without --check and without an export it fails instead of creating an empty copy", () => {
    const s = sandbox();
    try {
      const result = s.run("sync-abi.js");
      assert.equal(result.status, 1);
      assert.ok(!fs.existsSync(s.copyFile));
    } finally {
      s.cleanup();
    }
  });
});

describe("script: init-local-env", () => {
  it("creates a private (0600) .env that loadEnv accepts and that holds a fresh random 32-byte nullifier secret", () => {
    const s = sandbox();
    try {
      const result = s.run("init-local-env.js");
      assert.equal(result.status, 0, result.stderr);
      if (process.platform !== "win32") assert.equal(fs.statSync(s.envFile).mode & 0o777, 0o600); // POSIX permission bits do not exist on Windows

      const values = Object.fromEntries(
        fs.readFileSync(s.envFile, "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      const config = loadEnv({ ...values, CHAIN_ID: "31337", VOTING_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3", ELECTION_ID: "0x" + "11".repeat(32) });
      assert.equal(config.nodeEnv, "development");
      assert.equal(config.secrets.nullifierSecret.length, 32);
      assert.equal(config.signerAddresses.owner, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
      assert.equal(config.signerAddresses.authority, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
      assert.equal(config.signerAddresses.relayer, "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
    } finally {
      s.cleanup();
    }
  });

  it("prints the three public addresses but no key and no secret", () => {
    const s = sandbox();
    try {
      const result = s.run("init-local-env.js");
      const env = fs.readFileSync(s.envFile, "utf8");
      const keys = [...env.matchAll(/^(?:OWNER|AUTHORITY|RELAYER)_PRIVATE_KEY=0x([0-9a-f]{64})$/gm)].map((m) => m[1]);
      const secret = env.match(/^NULLIFIER_SECRET=([0-9a-f]{64})$/m)[1];
      assert.equal(keys.length, 3);
      for (const hidden of [...keys, secret]) assert.ok(!(result.stdout + result.stderr).includes(hidden));
      assert.match(result.stdout, /0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266/);
    } finally {
      s.cleanup();
    }
  });

  it("two runs produce different nullifier secrets (it is generated, not fixed)", () => {
    const secrets = [];
    for (let i = 0; i < 2; i++) {
      const s = sandbox();
      try {
        s.run("init-local-env.js");
        secrets.push(fs.readFileSync(s.envFile, "utf8").match(/^NULLIFIER_SECRET=(.+)$/m)[1]);
      } finally {
        s.cleanup();
      }
    }
    assert.match(secrets[0], /^[0-9a-f]{64}$/);
    assert.notEqual(secrets[0], secrets[1]);
  });

  it("refuses to overwrite an existing .env and leaves it byte-for-byte alone", () => {
    const s = sandbox();
    try {
      fs.writeFileSync(s.envFile, "PRECIOUS=keep-me\n", { mode: 0o644 });
      const result = s.run("init-local-env.js");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /already exists/);
      assert.equal(fs.readFileSync(s.envFile, "utf8"), "PRECIOUS=keep-me\n");
      if (process.platform !== "win32") assert.equal(fs.statSync(s.envFile).mode & 0o777, 0o644);
    } finally {
      s.cleanup();
    }
  });

  it("does not write through a dangling symlink named .env", { skip: process.platform === "win32" }, () => {
    const s = sandbox();
    try {
      const victim = path.join(s.root, "victim.txt");
      fs.symlinkSync(victim, s.envFile);
      const result = s.run("init-local-env.js");
      assert.notEqual(result.status, 0);
      assert.ok(!fs.existsSync(victim), "the symlink target must not be created");
    } finally {
      s.cleanup();
    }
  });
});
