import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import { loadEnv } from "../../src/config/env.js";
import { MODELS } from "../../src/compose.js";
import { closeDb, connectTestDb, resetDb, skipWithoutMongo, testUri } from "../helpers/db.js";
import { rawEnv } from "../helpers/env.js";
import { commitmentOf, createVoter, pollCredential, requestCredential, toEligible } from "../helpers/journey.js";
import { freePort, spawnService, waitFor } from "../helpers/node.js";
import { simulates, startRpcProxy } from "../helpers/rpcProxy.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

// THE DEMONSTRATION, end to end with the REAL entry point (src/server.js) as its own OS process, a real voter journey over HTTP, and the chain behind a failing
// proxy:  request -> the RPC fails (beyond the old 30-attempt cancellation threshold) -> the service is restarted three times while the node is unreachable ->
// connectivity returns -> the ORIGINAL request completes with the voter's original session -> the commitment is in the group exactly once.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { CredentialIssuance, CommitmentBatch } = MODELS;
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("identity-v3 as a SEPARATE PROCESS through an RPC outage and three restarts", { skip }, () => {
  let world;
  let proxy;
  const running = [];
  before(async () => {
    await connectTestDb();
    await resetDb();
    world = await newWorld();
    await world.mineAt(Math.floor(Date.now() / 1000) + 15 * 60); // the chain clock well ahead of the wall clock: the service's epochs follow the chain
    proxy = await startRpcProxy(world.url);
  });
  after(async () => {
    for (const r of running) r.stop();
    await proxy?.stop();
    world?.stop();
    await closeDb();
  });

  it("DEMONSTRATION: the voter's original credential request survives the outage and the restarts and completes, exactly once on-chain, without the voter starting again", async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const raw = rawEnv(world, { CHAIN_RPC_URL: proxy.url, IDENTITY_MONGODB_URI: testUri, PORT: String(port), BATCH_INTERVAL_MS: "200", CHAIN_RETRY_MAX_MS: "500", LOG_LEVEL: "info" });
    const config = loadEnv(raw);
    const env = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
    const start = () => {
      const service = spawnService(ROOT, env);
      running.push(service);
      return service;
    };
    const healthy = () => waitFor(async () => (await fetch(`${base}/api/v3/health`)).ok);

    // 1. a voter requests a credential (login, face, eligibility, the public commitment) from the running service
    let service = start();
    await healthy();
    const voter = await createVoter(config, { constituencyCode: "KA-BLR", n: 7 });
    const cookie = await toEligible(base, voter);
    const commitment = commitmentOf("outage-demonstration");
    assert.equal((await requestCredential(base, cookie, { commitment })).status, 202);
    const record = await CredentialIssuance.findOne({});
    assert.equal(record.state, "RESERVED");
    const nonce = await world.provider.getTransactionCount(world.issuer.address, "latest");

    // 2. the node answers reads but the batch simulation fails (rate limits, JSON-RPC errors, resets): the exact path that used to cancel after 30 attempts
    let k = 0;
    const selector = world.voteChain.interface.getFunction("registerCommitmentBatch").selector;
    proxy.when((msg) => (simulates(msg, selector) ? ["ratelimit", "rpcerror", "reset"][k++ % 3] : null));
    await world.nextEpoch(); // the cohort is due
    const prepared = await waitFor(
      async () => {
        assert.equal((await pollCredential(base, cookie)).body.data.state, "PENDING", "the voter keeps waiting, nothing else");
        const b = await CommitmentBatch.findOne({ state: "PREPARED" });
        return b && b.transientFailures > 30 ? b : null;
      },
      { timeoutMs: 120_000, everyMs: 500 },
    );
    assert.ok(prepared.transientFailures > 30, "beyond the old cancellation threshold");
    const pending = await CredentialIssuance.findById(record._id);
    assert.equal(pending.state, "BATCHED");
    assert.equal(pending.failures, 0, "no failure counted against the voter");

    // 3. the node becomes unreachable altogether, and the service is restarted three times during the outage
    await proxy.down();
    const restarts = [];
    for (let r = 1; r <= 3; r++) {
      service.stop();
      assert.equal((await service.exited).code, 0, "a clean stop at any point");
      service = start();
      restarts.push(service);
      await waitFor(() => /unreachable at startup/.test(service.output()), { timeoutMs: 15_000 });
      await sleep(1500);
      assert.equal(service.child.exitCode, null, `restart ${r}: the service waits for the node instead of exiting`);
    }
    assert.equal((await CredentialIssuance.findById(record._id)).state, "BATCHED", "still the same pending request");

    // 4. connectivity returns: the waiting process passes its preflight, recovers the batch, and the ORIGINAL request completes
    proxy.heal();
    await proxy.up();
    await healthy();
    const delivered = await waitFor(
      async () => {
        const res = await pollCredential(base, cookie);
        return res.status === 200 && res.body.data.state === "CREDENTIAL_ISSUED" ? res : null;
      },
      { timeoutMs: 60_000, everyMs: 300 },
    );
    assert.equal(delivered.body.data.constituency.code, "KA-BLR");
    assert.equal((await pollCredential(base, cookie)).status, 401, "delivered once; the identity session is over");

    const leaves = await world.groupLeaves("KA-BLR");
    assert.equal(leaves.filter((l) => l === BigInt(commitment)).length, 1, "the commitment exists exactly once on-chain");
    assert.equal(leaves.length, 1);
    assert.equal(await world.provider.getTransactionCount(world.issuer.address, "latest"), nonce + 1, "one transaction");
    const raw2 = await mongoose.connection.db.collection("credentialissuances_v3").find({}).toArray();
    assert.deepEqual(raw2.map((r) => [r.state, Object.keys(r).sort().join()]), [["ISSUED", "_id,electionId,state,voterId"]]);
    assert.deepEqual((await CommitmentBatch.find({})).map((b) => [b.state, b.transientFailures]), [["FINALIZED", undefined]], "one batch, no retry data left");

    const logs = [running[0], ...restarts].map((s) => s.output());
    assert.match(logs[0], /waiting for the blockchain node/);
    for (const log of logs.slice(1)) assert.match(log, /unreachable at startup/);
    assert.match(logs[3], /chain preflight passed/);
    assert.ok(logs.every((log) => !/were cancelled|CREDENTIAL_CANCELLED/.test(log)), "nobody was cancelled in any process");
    assert.ok(logs.every((log) => !log.includes(world.issuer.privateKey.slice(2))), "the key never reaches a log");
    service.stop();
    assert.equal((await service.exited).code, 0);
  });
});
