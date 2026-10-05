import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { skipWithoutMongo, testUri } from "../helpers/db.js";
import { rawEnv } from "../helpers/env.js";
import { freePort, spawnService, waitFor } from "../helpers/node.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");

describe("identity-v3 as a SEPARATE PROCESS (its real entry point, its own environment)", { skip }, () => {
  let world;
  const running = [];
  before(async () => {
    world = await newWorld();
  });
  after(() => {
    for (const r of running) r.stop();
    world?.stop();
  });
  const start = (over = {}) => {
    const service = spawnService(ROOT, { ...Object.fromEntries(Object.entries(rawEnv(world, { IDENTITY_MONGODB_URI: testUri })).map(([k, v]) => [k, String(v)])), LOG_LEVEL: "info", BATCH_INTERVAL_MS: "300", ...over });
    running.push(service);
    return service;
  };

  it("starts (preflight, recovery, batch timer), answers on its own port, refuses anonymous access, has no ballot route, and never prints its key", async () => {
    const port = await freePort();
    const service = start({ PORT: String(port) });
    const base = `http://127.0.0.1:${port}`;
    const health = await waitFor(async () => {
      const res = await fetch(`${base}/api/v3/health`);
      return res.ok ? res.json() : null;
    });
    assert.equal(health.data.status, "ok");
    assert.equal((await fetch(`${base}/api/v3/voter/credential`)).status, 401);
    assert.equal((await fetch(`${base}/api/v3/voter/credential`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commitment: "123456789" }) })).status, 401);
    const login = await fetch(`${base}/api/v3/voter/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: "nobody@example.org", password: "whatever password" }) });
    assert.equal(login.status, 401);
    for (const route of ["/api/v3/ballots", "/v1/ballots", "/api/v3/voter/ballot", "/api/v3/voter/receipt"]) assert.equal((await fetch(`${base}${route}`, { method: "POST" })).status, 404, route);
    await new Promise((r) => setTimeout(r, 1000)); // the batch timer ticks (300 ms) without incident
    service.stop();
    assert.equal((await service.exited).code, 0);
    const log = service.output();
    assert.match(log, /identity-v3/);
    assert.match(log, /chain preflight passed/);
    assert.ok(!log.includes(world.issuer.privateKey.slice(2)), "the issuer key never reaches the log");
    assert.ok(!/batch tick failed/.test(log), "the timer ran cleanly");
  });

  it("REFUSES TO START with the relayer's key, the owner key, V2 secrets, or the relayer's database in its environment", async () => {
    for (const [name, value] of [["RELAYER_PRIVATE_KEY", world.relayer.privateKey], ["OWNER_PRIVATE_KEY", world.owner.privateKey], ["NULLIFIER_SECRET", "ab".repeat(32)], ["RELAY_MONGODB_URI", "mongodb://127.0.0.1:27017/votechain_relay_v3"], ["JWT_ACCESS_SECRET", "cd".repeat(32)]]) {
      const service = start({ PORT: String(await freePort()), [name]: value });
      assert.equal((await service.exited).code, 1, name);
      assert.match(service.output(), new RegExp(name));
      assert.ok(!service.output().includes(value));
    }
    const sharedStore = start({ PORT: String(await freePort()), IDENTITY_MONGODB_URI: "mongodb://127.0.0.1:27017/votechain_relay_v3_test" });
    assert.equal((await sharedStore.exited).code, 1);
    assert.match(sharedStore.output(), /IDENTITY_MONGODB_URI/);
  });

  it("the startup preflight refuses a key that is not the contract's issuer, and exits non-zero", async () => {
    for (const wallet of [world.relayer, world.owner]) {
      const service = start({ PORT: String(await freePort()), ISSUER_PRIVATE_KEY: wallet.privateKey });
      assert.equal((await service.exited).code, 1);
      assert.match(service.output(), /ISSUER_MISMATCH|not the contract's issuer/);
      assert.ok(!service.output().includes(wallet.privateKey.slice(2)));
    }
  });
});
