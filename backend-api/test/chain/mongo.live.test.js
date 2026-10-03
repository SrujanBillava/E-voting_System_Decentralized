import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import request from "supertest";
import { createMongo } from "../../src/db/mongo.js";
import { bootstrap } from "../../src/server.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { localChainEnv } from "../helpers/chain.js";

// Full startup with a REAL MongoDB and the REAL local chain.
// Skipped unless MONGODB_TEST_URI points at a disposable MongoDB, e.g.
//   MONGODB_TEST_URI=mongodb://127.0.0.1:27017/evoting-test npm run test:chain
const uri = process.env.MONGODB_TEST_URI;

describe("live: real MongoDB + real chain", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let ready;
  before(async () => {
    ready = await bootstrap({ env: localChainEnv({ MONGODB_URI: uri }), deps: { logger: createMemoryLogger().logger } });
  });
  after(async () => {
    await ready?.close();
  });

  it("the mongo module connects, pings and reports connected", async () => {
    assert.equal(ready.mongo.isConnected(), true);
    await ready.mongo.ping();
  });

  it("startup preflight passes in full (Mongo, RPC, chain, contract, signers, EIP-712, config)", () => {
    assert.equal(ready.preflight.ok, true, JSON.stringify(ready.preflight.checks.filter((c) => c.status !== "pass")));
    assert.equal(ready.preflight.checks.find((c) => c.name === "mongo.connectivity").status, "pass");
    assert.equal(ready.preflight.snapshot.constituencyCount, 3);
  });

  it("GET /api/v1/health -> 200 {status:'ok'} on the fully wired app", async () => {
    const res = await request(ready.app).get("/api/v1/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("the internal system preflight reports Mongo failure after Mongo is gone", async () => {
    const second = createMongo({ uri, logger: createMemoryLogger().logger });
    await second.connect();
    await ready.mongo.disconnect();
    const report = await ready.healthService.getSystemPreflight();
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((c) => c.name === "mongo.connectivity").status, "fail");
    await second.disconnect();
  });
});
