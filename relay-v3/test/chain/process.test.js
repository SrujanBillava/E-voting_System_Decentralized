import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { skipWithoutMongo, testUri } from "../helpers/db.js";
import { freePort, spawnService, waitFor } from "../helpers/node.js";
import { rawEnv } from "../helpers/env.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");

describe("relay-v3 as a SEPARATE PROCESS (its real entry point, its own environment)", { skip }, () => {
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
    const service = spawnService(ROOT, { ...Object.fromEntries(Object.entries(rawEnv(world, { RELAY_MONGODB_URI: testUri })).map(([k, v]) => [k, String(v)])), LOG_LEVEL: "info", ...over });
    running.push(service);
    return service;
  };

  it("starts, answers on its own port with no cookie and no login, refuses garbage, serves the public group, and never prints its key", async () => {
    const port = await freePort();
    const service = start({ PORT: String(port) });
    const base = `http://127.0.0.1:${port}`;
    const health = await waitFor(async () => {
      const res = await fetch(`${base}/v1/health`);
      return res.ok ? res.json() : null;
    });
    assert.equal(health.data.status, "ok");
    const bad = await fetch(`${base}/v1/ballots`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get("set-cookie"), null);
    const group = await fetch(`${base}/v1/groups/KA-BLR`, { credentials: "omit" });
    assert.equal(group.status, 200);
    assert.equal((await group.json()).data.size, 0);
    assert.equal((await fetch(`${base}/api/v3/voter/status`)).status, 404, "it has no identity routes at all");
    service.stop();
    assert.equal((await service.exited).code, 0, "a clean shutdown");
    const log = service.output();
    assert.match(log, /relay-v3/);
    assert.match(log, /chain preflight passed/);
    assert.ok(!log.includes(world.relayer.privateKey.slice(2)), "the relayer key never reaches the log");
    assert.ok(!/identity|voter|cookie/i.test(log.replace(/IDENTITY|identity service's/g, "")), "nothing identity-side in its log");
  });

  it("REFUSES TO START with an identity-side secret, another role's key, or the identity database in its environment", async () => {
    for (const [name, value] of [["ISSUER_PRIVATE_KEY", world.issuer.privateKey], ["OWNER_PRIVATE_KEY", world.owner.privateKey], ["FACE_TEMPLATE_ENCRYPTION_KEY", "ab".repeat(32)], ["IDENTITY_MONGODB_URI", "mongodb://127.0.0.1:27017/identity"], ["JWT_ACCESS_SECRET", "cd".repeat(32)]]) {
      const service = start({ PORT: String(await freePort()), [name]: value });
      const { code } = await service.exited;
      assert.equal(code, 1, name);
      assert.match(service.output(), new RegExp(name));
      assert.ok(!service.output().includes(value), "the value is never printed");
    }
    const sharedStore = start({ PORT: String(await freePort()), RELAY_MONGODB_URI: "mongodb://127.0.0.1:27017/votechain_identity_v3_test" });
    assert.equal((await sharedStore.exited).code, 1);
    assert.match(sharedStore.output(), /RELAY_MONGODB_URI/);
  });

  it("the startup preflight refuses a relayer key that is the contract's issuer, owner or a trustee, and exits non-zero", async () => {
    for (const [wallet, role] of [[world.issuer, "issuer"], [world.owner, "owner"], [world.trustees[1], "trustee"]]) {
      const service = start({ PORT: String(await freePort()), RELAYER_PRIVATE_KEY: wallet.privateKey });
      const { code } = await service.exited;
      assert.equal(code, 1, role);
      assert.match(service.output(), /ROLE_CONFLICT|must not be/, role);
      assert.ok(!service.output().includes(wallet.privateKey.slice(2)), "never the key");
    }
  });
});
