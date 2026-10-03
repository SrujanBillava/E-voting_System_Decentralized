import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../../src/config/env.js";
import { StartupError, bootstrap } from "../../src/server.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { KEYS, validEnv } from "../helpers/env.js";

function fakeMongo({ failConnect = false } = {}) {
  const calls = [];
  return {
    calls,
    factory: () => ({
      connect: async () => { calls.push("connect"); if (failConnect) throw new Error("mongo down"); },
      disconnect: async () => { calls.push("disconnect"); },
      ping: async () => { calls.push("ping"); },
      isConnected: () => true,
    }),
  };
}

describe("startup (bootstrap)", () => {
  it("refuses an invalid configuration before opening any connection", async () => {
    const mongo = fakeMongo();
    await assert.rejects(bootstrap({ env: validEnv({ OWNER_PRIVATE_KEY: "nope" }), deps: { createMongo: mongo.factory, logger: createMemoryLogger().logger } }), ConfigError);
    assert.deepEqual(mongo.calls, []);
  });

  it("refuses to start when the blockchain preflight fails (RPC unreachable) and releases what it opened", async () => {
    const mongo = fakeMongo();
    const { logger, lines } = createMemoryLogger();
    await assert.rejects(
      bootstrap({ env: validEnv({ CHAIN_RPC_URL: "http://127.0.0.1:1" }), deps: { createMongo: mongo.factory, logger } }),
      (err) => {
        assert.ok(err instanceof StartupError);
        assert.ok(err.preflight.checks.some((c) => c.name === "rpc.connectivity" && c.status === "fail"));
        return true;
      },
    );
    assert.deepEqual(mongo.calls.filter((c) => c !== "ping"), ["connect", "disconnect"]);
    assert.match(lines.join(""), /"check":"rpc.connectivity"/);
  });

  it("propagates a MongoDB connection failure and still cleans up", async () => {
    const mongo = fakeMongo({ failConnect: true });
    await assert.rejects(bootstrap({ env: validEnv(), deps: { createMongo: mongo.factory, logger: createMemoryLogger().logger } }), /mongo down/);
    assert.ok(mongo.calls.includes("disconnect"));
  });

  it("never writes a private key or the nullifier secret to the log", async () => {
    const mongo = fakeMongo();
    const { logger, lines } = createMemoryLogger({ secrets: [KEYS.owner, KEYS.authority, KEYS.relayer] });
    await assert.rejects(bootstrap({ env: validEnv({ CHAIN_RPC_URL: "http://127.0.0.1:1" }), deps: { createMongo: mongo.factory, logger } }));
    const text = lines.join("");
    for (const secret of [KEYS.owner, KEYS.authority, KEYS.relayer]) assert.ok(!text.includes(secret.slice(2)));
  });
});

describe("startup (bootstrap): resources", () => {
  it("a failed startup leaves nothing running: the process ends by itself, without process.exit()", () => {
    const serverUrl = new URL("../../src/server.js", import.meta.url).href;
    const helpersUrl = new URL("../helpers/env.js", import.meta.url).href;
    const script = `
      const { bootstrap } = await import(${JSON.stringify(serverUrl)});
      const { validEnv } = await import(${JSON.stringify(helpersUrl)});
      const calls = [];
      const createMongo = () => ({ connect: async () => calls.push("connect"), disconnect: async () => calls.push("disconnect"), ping: async () => {}, isConnected: () => true });
      const logger = { info() {}, warn() {}, error() {}, debug() {} };
      try {
        await bootstrap({ env: validEnv({ CHAIN_RPC_URL: "http://127.0.0.1:1" }), deps: { createMongo, logger } });
        console.log("UNEXPECTED SUCCESS");
      } catch (err) {
        console.log("failed as expected:" + err.name + ":" + calls.join(","));
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("../..", import.meta.url)), timeout: 20_000, encoding: "utf8" });
    assert.equal(result.error, undefined, "the process did not end by itself (an open handle was left behind)");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /failed as expected:StartupError:connect,disconnect/);
  });

  it("a failed startup disconnects MongoDB exactly once", async () => {
    const mongo = fakeMongo();
    await assert.rejects(bootstrap({ env: validEnv({ CHAIN_RPC_URL: "http://127.0.0.1:1" }), deps: { createMongo: mongo.factory, logger: createMemoryLogger().logger } }), StartupError);
    assert.deepEqual(mongo.calls.filter((c) => c === "disconnect"), ["disconnect"]);
  });
});

