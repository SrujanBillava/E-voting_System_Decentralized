import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { runPreflight } from "../../src/chain/preflight.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { createElectionService } from "../../src/services/election.service.js";
import { createHealthService } from "../../src/services/health.service.js";
import { adminWorld } from "../helpers/admin.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { hardhatAccount } from "../helpers/env.js";

// Needs the local chain (smart-contract: npm run node + npm run deploy:local) AND a disposable MongoDB.
// Chain state is restored with evm_snapshot/evm_revert around every test.
const uri = process.env.MONGODB_TEST_URI;

describe("admin election control (real chain + real MongoDB)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain;
  let w;
  let snap;
  let admin;
  let accessToken;
  const phase = async () => Number(await chain.contract.phase());
  const mongoOk = { ping: async () => {} };

  const buildWorld = async (chainServices = chain) => {
    const healthService = createHealthService({
      runPreflight: ({ deep }) => runPreflight({ deployment: chainServices.deployment, provider: chainServices.provider, contract: chainServices.contract, signers: chainServices.signers, mongo: mongoOk, deep }),
    });
    return adminWorld({ electionFactory: ({ auth, audit, ownerQueue }) => createElectionService({ chain: chainServices, healthService, auth, audit, ownerQueue }) });
  };
  const signIn = async () => {
    admin = await w.createAdmin();
    accessToken = (await w.loginAs(admin)).body.data.accessToken;
    w.clock.advance(31); // the login consumed this TOTP step; the step-up needs a fresh one
  };
  const post = (path, body, token = accessToken) => w.request().post(`/api/v1/admin/election/${path}`).set(token ? w.bearer(token) : {}).send(body);
  const openBody = (over = {}) => ({ confirmation: "OPEN ELECTION", totp: admin.code(), ...over });
  const closeBody = (over = {}) => ({ confirmation: "CLOSE ELECTION", totp: admin.code(), ...over });
  const openDirect = async () => (await chain.contract.connect(chain.signers.owner).openElection()).wait();

  before(async () => {
    await mongoose.connect(uri);
    chain = localServices();
    await assertPristineLocalChain(chain);
  });
  after(async () => {
    chain?.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    snap = await snapshot(chain.provider);
    w = await buildWorld();
    await signIn();
  });
  afterEach(async () => {
    await revertTo(chain.provider, snap);
  });

  it("GET /admin/election reports Setup with the real contract's counts, and no secrets", async () => {
    const res = await w.request().get("/api/v1/admin/election").set(w.bearer(accessToken));
    assert.equal(res.status, 200);
    const d = res.body.data;
    assert.equal(d.phase, "Setup");
    assert.equal(d.chainId, 31337);
    assert.equal(d.constituencyCount, 3);
    assert.equal(d.candidateCount, 18);
    assert.equal(d.totalBallots, 0);
    assert.equal(d.contractAddress, chain.deployment.contractAddress);
    assert.equal(d.electionId, chain.deployment.electionId);
    assert.equal(d.preflight.ok, true);
    const text = JSON.stringify(res.body);
    for (const secret of [chain.config?.secrets, w.config.secrets.ownerPrivateKey, w.config.secrets.authorityPrivateKey, w.config.secrets.relayerPrivateKey, w.config.secrets.nullifierSecret.toString("hex")]) {
      if (typeof secret === "string") assert.ok(!text.includes(secret.replace(/^0x/, "")));
    }
  });

  describe("open", () => {
    it("requires an admin", async () => {
      assert.equal((await post("open", openBody(), null)).status, 401);
      assert.equal(await phase(), 0);
    });

    it("rejects a wrong confirmation phrase without burning the TOTP code or touching the chain", async () => {
      const body = openBody();
      for (const confirmation of ["open election", "OPEN", "", "OPEN ELECTION "]) {
        const res = await post("open", { ...body, confirmation });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, confirmation.length > 0 && confirmation.length <= 40 ? "INVALID_CONFIRMATION" : res.body.error.code);
      }
      assert.equal(await phase(), 0);
      assert.equal((await post("open", body)).status, 200, "the same code is still unused");
    });

    it("rejects an invalid or missing step-up TOTP", async () => {
      assert.equal((await post("open", openBody({ totp: "000000" }))).body.error.code, "INVALID_STEP_UP");
      assert.equal((await post("open", { confirmation: "OPEN ELECTION" })).status, 400);
      assert.equal(await phase(), 0);
    });

    it("repeated bad step-up codes lock the admin: even the correct code cannot open the election afterwards", async () => {
      for (let i = 0; i < 5; i++) assert.equal((await post("open", openBody({ totp: "000000" }))).body.error.code, "INVALID_STEP_UP");
      const refused = await post("open", openBody());
      assert.equal(refused.status, 401);
      assert.equal(refused.body.error.code, "INVALID_STEP_UP");
      assert.equal(await phase(), 0);
      assert.ok((await AuditLog.countDocuments({ action: "ADMIN_STEP_UP_FAILURE" })) >= 6);
    });

    it("rejects a replayed TOTP code (the one already used by login)", async () => {
      w.clock.advance(-31); // back inside the login's time step
      const replay = await post("open", openBody());
      assert.equal(replay.status, 401);
      assert.equal(replay.body.error.code, "INVALID_STEP_UP");
      assert.equal(await phase(), 0);
      assert.ok((await AuditLog.countDocuments({ action: "TOTP_REPLAY_REJECTED" })) >= 1);
    });

    it("refuses when preflight fails (signer is not the contract's relayer)", async () => {
      const wrong = localServices({ RELAYER_PRIVATE_KEY: hardhatAccount(7).privateKey });
      try {
        w = await buildWorld(wrong);
        await signIn();
        const res = await post("open", openBody());
        assert.equal(res.status, 409);
        assert.equal(res.body.error.code, "PREFLIGHT_FAILED");
        assert.match(res.body.error.message, /contract\.relayer/);
        assert.equal(await phase(), 0);
      } finally {
        wrong.destroy();
      }
    });

    it("a valid admin opens the election: confirmed transaction, chain phase is Open", async () => {
      const res = await post("open", openBody());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), ["phase", "txHash"]);
      assert.equal(res.body.data.phase, "Open");
      assert.equal(await phase(), 1);
      const receipt = await chain.provider.getTransactionReceipt(res.body.data.txHash);
      assert.equal(receipt.status, 1);
      assert.equal(receipt.from, chain.signers.addresses.owner, "sent by the OWNER signer");
      const row = await AuditLog.findOne({ action: "ELECTION_OPENED" });
      assert.equal(row.txHash, res.body.data.txHash);
      assert.ok(await AuditLog.findOne({ action: "ELECTION_OPEN_REQUESTED" }));
    });

    it("opening twice is rejected (WRONG_PHASE)", async () => {
      assert.equal((await post("open", openBody())).status, 200);
      w.clock.advance(31);
      const again = await post("open", openBody());
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "WRONG_PHASE");
    });
  });

  describe("close", () => {
    it("requires an admin", async () => {
      await openDirect();
      assert.equal((await post("close", closeBody(), null)).status, 401);
      assert.equal(await phase(), 1);
    });

    it("cannot close while still in Setup", async () => {
      const res = await post("close", closeBody());
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "WRONG_PHASE");
      assert.equal(await phase(), 0);
    });

    it("rejects a wrong confirmation phrase and a missing/invalid/replayed TOTP", async () => {
      await openDirect();
      assert.equal((await post("close", closeBody({ confirmation: "OPEN ELECTION" }))).body.error.code, "INVALID_CONFIRMATION");
      assert.equal((await post("close", { confirmation: "CLOSE ELECTION" })).status, 400);
      assert.equal((await post("close", closeBody({ totp: "000000" }))).body.error.code, "INVALID_STEP_UP");
      w.clock.advance(-31);
      assert.equal((await post("close", closeBody())).body.error.code, "INVALID_STEP_UP", "login's code replayed");
      assert.equal(await phase(), 1);
    });

    it("a valid admin closes the election; chain phase is Closed; totalBallots returned", async () => {
      await openDirect();
      const res = await post("close", closeBody());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data.phase, "Closed");
      assert.equal(res.body.data.totalBallots, 0);
      assert.match(res.body.data.txHash, /^0x[0-9a-f]{64}$/);
      assert.equal(await phase(), 2);
      assert.equal((await AuditLog.findOne({ action: "ELECTION_CLOSED" })).txHash, res.body.data.txHash);
    });

    it("a second close and any later open are rejected; there is no reopen route", async () => {
      await openDirect();
      assert.equal((await post("close", closeBody())).status, 200);
      w.clock.advance(31);
      assert.equal((await post("close", closeBody())).body.error.code, "WRONG_PHASE");
      w.clock.advance(31);
      assert.equal((await post("open", openBody())).body.error.code, "WRONG_PHASE");
      for (const path of ["reopen", "reset", "set-phase"]) assert.equal((await post(path, { confirmation: "x", totp: "123456" })).status, 404, path);
      assert.equal(await phase(), 2);
    });
  });
});
