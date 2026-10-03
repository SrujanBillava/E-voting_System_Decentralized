import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { createShutdown, installCrashHandlers, listen } from "../../src/server.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { KEYS, TEST_NULLIFIER_SECRET, validEnv } from "../helpers/env.js";

const SERVER_JS = fileURLToPath(new URL("../../src/server.js", import.meta.url));
// The process runs in an empty directory with a minimal environment: server.js loads ./.env from its working
// directory (dotenv), and a developer's real backend-api/.env must never leak into these tests.
const BASE_ENV = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const emptyDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "votechain-server-"));
const closeServer = (server) => new Promise((resolve) => server.close(resolve));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("server: listen()", () => {
  it("resolves with a server that is really listening and serves the app", async () => {
    const server = await listen((req, res) => res.end("hello"), 0);
    try {
      const body = await new Promise((resolve, reject) => http.get({ port: server.address().port, host: "127.0.0.1" }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }).on("error", reject));
      assert.equal(body, "hello");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects with EADDRINUSE when the port is taken, instead of pretending to listen", async () => {
    const blocker = net.createServer().listen(0, "0.0.0.0");
    await new Promise((resolve) => blocker.once("listening", resolve));
    try {
      await assert.rejects(listen((req, res) => res.end(), blocker.address().port), (err) => err.code === "EADDRINUSE");
    } finally {
      await closeServer(blocker);
    }
  });

  it("rejects for a port that cannot be used at all", async () => {
    await assert.rejects(listen((req, res) => res.end(), 70000), (err) => err.code === "ERR_SOCKET_BAD_PORT");
  });
});

describe("server: createShutdown()", () => {
  const fakeServer = () => {
    const state = { closes: 0, finish: undefined };
    return { state, close(cb) { state.closes++; state.finish = cb; } };
  };
  const harness = (options = {}) => {
    const { logger, lines } = createMemoryLogger();
    const exits = [];
    const server = fakeServer();
    const closed = { count: 0, fail: false };
    const shutdown = createShutdown({
      server,
      logger,
      exit: (code) => exits.push(code),
      close: async () => { closed.count++; if (closed.fail) throw new Error("close failed"); },
      ...options,
    });
    return { shutdown, server, exits, closed, lines };
  };

  it("stops the server, releases resources, then exits 0", async () => {
    const h = harness();
    h.shutdown("SIGTERM");
    assert.equal(h.server.state.closes, 1);
    assert.deepEqual(h.exits, []);
    await h.server.state.finish();
    assert.equal(h.closed.count, 1);
    assert.deepEqual(h.exits, [0]);
    assert.equal(JSON.parse(h.lines[0]).signal, "SIGTERM");
  });

  it("a second signal (Ctrl-C twice, SIGINT then SIGTERM) does nothing more", async () => {
    const h = harness();
    h.shutdown("SIGINT");
    h.shutdown("SIGINT");
    h.shutdown("SIGTERM");
    assert.equal(h.server.state.closes, 1);
    await h.server.state.finish();
    assert.equal(h.closed.count, 1);
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.lines.length, 1);
  });

  it("exits 1 when releasing resources fails (and still exits)", async () => {
    const h = harness();
    h.closed.fail = true;
    h.shutdown("SIGTERM");
    await h.server.state.finish();
    assert.deepEqual(h.exits, [1]);
  });

  it("a server that never finishes closing is cut off after the grace period with exit code 1", async () => {
    const h = harness({ forceAfterMs: 30 });
    h.shutdown("SIGTERM");
    await delay(120);
    assert.deepEqual(h.exits, [1]);
  });

  it("a clean shutdown cancels the force-exit timer (no second exit later)", async () => {
    const h = harness({ forceAfterMs: 60 });
    h.shutdown("SIGTERM");
    await h.server.state.finish();
    await delay(150);
    assert.deepEqual(h.exits, [0]);
  });
});

describe("server: installCrashHandlers()", () => {
  it("logs an uncaught exception / unhandled rejection through the scrubbing logger and exits 1", () => {
    const { logger, lines } = createMemoryLogger({ secrets: ["https://rpc.example.org/v2/SECRETKEY123"] });
    const proc = new EventEmitter();
    const exits = [];
    installCrashHandlers({ logger, proc, exit: (code) => exits.push(code) });
    const err = Object.assign(new Error("failed for https://rpc.example.org/v2/SECRETKEY123"), { code: "SERVER_ERROR", info: { requestUrl: "https://rpc.example.org/v2/SECRETKEY123" } });
    proc.emit("uncaughtException", err);
    proc.emit("unhandledRejection", err);
    assert.deepEqual(exits, [1, 1]);
    const entries = lines.map((l) => JSON.parse(l));
    assert.deepEqual(entries.map((e) => e.msg), ["uncaught exception", "unhandled rejection"]);
    assert.ok(!lines.join("").includes("SECRETKEY123"));
    assert.deepEqual(entries[0].err, { name: "Error", code: "SERVER_ERROR", message: "failed for [REDACTED]" });
  });

  it("copes with a non-Error rejection reason", () => {
    const { logger, lines } = createMemoryLogger();
    const proc = new EventEmitter();
    const exits = [];
    installCrashHandlers({ logger, proc, exit: (code) => exits.push(code) });
    proc.emit("unhandledRejection", "just a string");
    proc.emit("unhandledRejection", undefined);
    assert.deepEqual(exits, [1, 1]);
    assert.equal(lines.length, 2);
  });
});

describe("server: running src/server.js as a process (configuration errors)", () => {
  const run = (env) => {
    const cwd = emptyDir();
    try {
      return spawnSync(process.execPath, [SERVER_JS], { cwd, env: { ...BASE_ENV, ...env }, encoding: "utf8", timeout: 20_000 });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  };

  it("exits 1 with names and reasons only when the environment is empty", () => {
    const result = run({});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid configuration/);
    for (const name of ["MONGODB_URI", "CHAIN_RPC_URL", "OWNER_PRIVATE_KEY", "NULLIFIER_SECRET"]) assert.match(result.stderr, new RegExp(name));
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("    at "), "no stack trace");
  });

  it("never echoes a bad secret back, whichever variable it was in", () => {
    const leaky = "0x" + "ab12".repeat(15) + "zzzz";
    const result = run({ ...validEnv({ OWNER_PRIVATE_KEY: leaky, NULLIFIER_SECRET: "too-short-secret-value-TOPSECRET", MONGODB_URI: "mongodb://user:TOPSECRETPW@h:99999/db" }) });
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    for (const secret of [leaky, "TOPSECRET", "too-short-secret"]) assert.ok(!output.includes(secret), `${secret} leaked`);
    assert.match(output, /OWNER_PRIVATE_KEY/);
    assert.match(output, /NULLIFIER_SECRET/);
    assert.match(output, /MONGODB_URI/);
  });

  it("production refuses the public Hardhat keys at the process level too", () => {
    const result = run({ ...validEnv({ NODE_ENV: "production", CHAIN_ID: "11155111", CORS_ORIGINS: "https://vote.example.org" }) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /publicly known Hardhat development key/);
    assert.ok(!result.stderr.includes(KEYS.owner.slice(2)) && !result.stderr.includes(TEST_NULLIFIER_SECRET));
  });

  it("an unreachable MongoDB ends the process with exit 1 and a one-line reason (no stack, no URI)", async () => {
    const cwd = emptyDir();
    const child = spawn(process.execPath, [SERVER_JS], {
      cwd,
      env: { ...BASE_ENV, ...validEnv({ MONGODB_URI: "mongodb://dbuser:TOPSECRETPW@127.0.0.1:1/none" }) },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
    assert.equal(code, 1);
    assert.ok(!output.includes("TOPSECRETPW") && !output.includes("dbuser"), output);
    assert.ok(!output.includes("    at "), "no stack trace");
  });
});
