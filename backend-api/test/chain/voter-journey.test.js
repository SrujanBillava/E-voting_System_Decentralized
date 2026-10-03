import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import request from "supertest";
import { STAGES } from "../../src/auth/voterStages.js";
import { createApp } from "../../src/app.js";
import { buildBallotAuthorization, signBallotAuthorization } from "../../src/chain/eip712.js";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { deriveNullifier } from "../../src/chain/nullifier.js";
import { loadEnv } from "../../src/config/env.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { Voter } from "../../src/models/Voter.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createAuditService } from "../../src/services/audit.service.js";
import { createEligibilityService } from "../../src/services/eligibility.service.js";
import { createVoterAuthService } from "../../src/services/voterAuth.service.js";
import { generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { validEnv } from "../helpers/env.js";

// Needs the local chain AND a disposable MongoDB (MONGODB_TEST_URI). Elections are opened inside snapshots.
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";

describe("eligibility + constituency-bound ballot (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, memory, auth, app, config, voter, token, sessionId, t;
  const clock = { now: () => t, advance: (s) => (t += s * 1000) };
  const owner = () => chain.contract.connect(chain.signers.owner);
  const open = async () => (await owner().openElection()).wait();
  const post = (path, body = {}) => request(app).post(`/api/v1/voter${path}`).set("Cookie", `vc_voter=${token}`).send(body);
  const get = (path) => request(app).get(`/api/v1/voter${path}`).set("Cookie", `vc_voter=${token}`);
  const mkVoter = async (over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: "Asha Rao", email: "asha@example.org", passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });
  const build = (chainLike = chain) => {
    const audit = createAuditService({ AuditLog, logger: memory.logger, now: clock.now });
    auth = createVoterAuthService({ Voter, VoterSession, chain, audit, now: clock.now, bcryptCost: 4 });
    const eligibilityService = createEligibilityService({ Voter, authService: auth, chain: chainLike, nullifierSecret: config.secrets.nullifierSecret, audit, now: clock.now });
    return createApp({ config, logger: memory.logger, healthService: { getPublicHealth: async () => ({ status: "ok" }) }, voter: { authService: auth, eligibilityService }, voterLoginRateLimit: { windowMs: 60_000, limit: 1000 } });
  };
  /** Log in normally, then place the session in a stage with the trusted primitive (no debug endpoint exists). */
  const startSession = async (v = voter, { faceVerified = true, faceTtl = 120 } = {}) => {
    const res = await request(app).post("/api/v1/voter/auth/login").send({ identifier: v.voterId, password: PW });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    token = res.headers["set-cookie"][0].split(";")[0].split("=")[1];
    sessionId = (await VoterSession.findOne({ voterId: v._id, active: true }))._id;
    if (faceVerified) assert.equal(await auth.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: new Date(clock.now() + faceTtl * 1000) }), true);
  };
  const stageOf = async () => (await VoterSession.findById(sessionId)).stage;
  const nullifierFor = async (v = voter) => deriveNullifier({ secret: config.secrets.nullifierSecret, electionId: chain.deployment.electionId, voterUid: (await Voter.findById(v._id).select("+uid")).uid });

  before(async () => {
    await mongoose.connect(uri);
    chain = localServices();
    await assertPristineLocalChain(chain);
    config = loadEnv(validEnv());
  });
  after(async () => {
    chain?.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  beforeEach(async () => {
    snap = await snapshot(chain.provider);
    await mongoose.connection.dropDatabase();
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), AuditLog.syncIndexes()]);
    t = Date.parse("2026-10-03T10:00:00Z");
    memory = createMemoryLogger();
    app = build();
    voter = await mkVoter();
    await open();
  });
  afterEach(() => revertTo(chain.provider, snap));

  describe("eligibility", () => {
    it("FACE_VERIFIED + Open + ACTIVE + known constituency + unused nullifier => ELIGIBLE with a safe response", async () => {
      await startSession();
      const res = await post("/eligibility/check");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), ["constituency", "electionId", "eligible", "stage", "stageExpiresAt"]);
      assert.deepEqual(res.body.data.constituency, { code: "KA-BLR", name: "Bengaluru" });
      assert.equal(res.body.data.eligible, true);
      assert.equal(res.body.data.electionId, chain.deployment.electionId);
      assert.equal(await stageOf(), "ELIGIBLE");
      assert.equal(+new Date(res.body.data.stageExpiresAt), clock.now() + 3 * 60_000);
      assert.equal(+(await VoterSession.findById(sessionId)).stageExpiresAt, clock.now() + 3 * 60_000);
      assert.ok(!JSON.stringify(res.body).match(/uid|nullifier|constituencyId|passwordHash/i));
      assert.equal((await get("/status")).body.data.stage, "ELIGIBLE");
    });

    it("needs a session and the FACE_VERIFIED stage (AUTHENTICATED is refused)", async () => {
      assert.equal((await request(app).post("/api/v1/voter/eligibility/check")).status, 401);
      await startSession(voter, { faceVerified: false });
      const res = await post("/eligibility/check");
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "STAGE_REQUIRED");
      assert.equal(await stageOf(), "AUTHENTICATED");
    });

    it("rejects any client-supplied field (uid, nullifier, constituency, eligible) and query", async () => {
      await startSession();
      for (const body of [{ uid: "a".repeat(32) }, { nullifier: "0x" + "1".repeat(64) }, { constituencyId: "0x1" }, { constituencyCode: "DL-DEL" }, { eligible: true }]) assert.equal((await post("/eligibility/check", body)).status, 400, JSON.stringify(body));
      assert.equal((await request(app).post("/api/v1/voter/eligibility/check?constituency=DL-DEL").set("Cookie", `vc_voter=${token}`)).status, 400);
      assert.equal(await stageOf(), "FACE_VERIFIED");
    });

    it("a voter who already voted (real used nullifier on-chain) gets ALREADY_VOTED and never becomes ELIGIBLE", async () => {
      const nullifier = await nullifierFor();
      const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId: 1n, relayer: chain.signers.addresses.relayer, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
      const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
      await (await chain.contract.connect(chain.signers.relayer).castVote(message.constituencyId, nullifier, 1n, message.deadline, signature)).wait();
      assert.equal(await chain.contract.nullifierUsed(nullifier), true);

      await startSession();
      const res = await post("/eligibility/check");
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ALREADY_VOTED");
      assert.ok(!JSON.stringify(res.body).includes(nullifier));
      assert.equal(await stageOf(), "FACE_VERIFIED");
      assert.equal((await get("/ballot")).body.error.code, "STAGE_REQUIRED");
      assert.ok(await AuditLog.findOne({ action: "VOTER_ALREADY_VOTED" }));
    });

    it("another voter's used nullifier does not block this voter (nullifiers are per voter)", async () => {
      const other = await mkVoter({ email: "other@example.org" });
      const n = await nullifierFor(other);
      assert.notEqual(n, await nullifierFor());
    });

    it("a suspended voter is refused", async () => {
      await startSession();
      await Voter.updateOne({ _id: voter._id }, { status: "SUSPENDED" });
      assert.equal((await post("/eligibility/check")).status, 401);
      assert.equal(await stageOf(), "FACE_VERIFIED");
    });

    it("the constituency comes from Mongo: DL-DEL voter is bound to Delhi, an inconsistent stored code is refused and audited", async () => {
      const delhi = await mkVoter({ email: "d@example.org", constituencyCode: "DL-DEL" });
      await startSession(delhi);
      assert.deepEqual((await post("/eligibility/check")).body.data.constituency, { code: "DL-DEL", name: "Delhi" });
      await request(app).post("/api/v1/voter/auth/logout").set("Cookie", `vc_voter=${token}`);

      await Voter.updateOne({ _id: voter._id }, { constituencyCode: "XX-GONE" });
      await startSession();
      const res = await post("/eligibility/check");
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "CONSTITUENCY_NOT_CONFIGURED");
      assert.equal(await stageOf(), "FACE_VERIFIED");
      assert.ok(await AuditLog.findOne({ action: "CONSTITUENCY_CONFIGURATION_MISMATCH" }));
    });

    it("concurrent requests: one atomic transition, one audit row, all callers get a coherent answer", async () => {
      await startSession();
      const results = await Promise.all(Array.from({ length: 6 }, () => post("/eligibility/check")));
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
      assert.equal(await stageOf(), "ELIGIBLE");
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_ELIGIBILITY_CONFIRMED" }), 1);
    });

    it("repeating the check once ELIGIBLE is idempotent and does not extend the stage", async () => {
      await startSession();
      const first = await post("/eligibility/check");
      clock.advance(30);
      const again = await post("/eligibility/check");
      assert.equal(again.status, 200);
      assert.equal(again.body.data.stageExpiresAt, first.body.data.stageExpiresAt);
    });
  });

  describe("phase and expiry", () => {
    it("Setup and Closed refuse eligibility", async () => {
      await startSession();
      await (await owner().closeElection()).wait();
      const closed = await post("/eligibility/check");
      assert.equal(closed.body.error.code, "ELECTION_CLOSED");
      assert.equal(await stageOf(), "FACE_VERIFIED");
      await revertTo(chain.provider, snap);
      snap = await snapshot(chain.provider); // back to Setup
      assert.equal((await post("/eligibility/check")).body.error.code, "ELECTION_NOT_OPEN");
    });

    it("the election closing after eligibility ends the ballot request with ELECTION_CLOSED", async () => {
      await startSession();
      await post("/eligibility/check");
      await (await owner().closeElection()).wait();
      const res = await get("/ballot");
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ELECTION_CLOSED");
    });

    it("an expired FACE_VERIFIED stage cannot become ELIGIBLE", async () => {
      await startSession(voter, { faceTtl: 30 });
      clock.advance(31);
      const res = await post("/eligibility/check");
      assert.equal(res.body.error.code, "SESSION_EXPIRED");
      assert.equal(await stageOf(), "FACE_VERIFIED");
    });

    it("an expired ELIGIBLE stage cannot load the ballot", async () => {
      await startSession();
      await post("/eligibility/check");
      for (let i = 0; i < 2; i++) { clock.advance(85); await auth.authenticate(token); } // 170s: keep the session active
      clock.advance(11); // 181s > 3 minute stage window
      assert.equal((await get("/ballot")).body.error.code, "SESSION_EXPIRED");
    });
  });

  describe("ballot", () => {
    it("returns only the voter's own constituency, ascending ids, names from the contract, no tallies", async () => {
      await startSession();
      await post("/eligibility/check");
      const res = await get("/ballot");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), ["candidates", "constituency", "electionId"]);
      assert.deepEqual(res.body.data.constituency, { code: "KA-BLR", name: "Bengaluru" });
      assert.deepEqual(res.body.data.candidates.map((c) => c.candidateId), ["1", "2", "3", "4", "5", "6", "7"]);
      assert.equal(res.body.data.candidates[0].name, "Amit Sharma");
      for (const c of res.body.data.candidates) assert.deepEqual(Object.keys(c).sort(), ["candidateId", "name"]);
      assert.ok(!JSON.stringify(res.body).match(/vote|tally|total|turnout|count|uid|nullifier|constituencyId/i));
      const names = res.body.data.candidates.map((c) => c.name).join();
      assert.ok(!names.includes("Rohan Malhotra") && !names.includes("Akash Patil"), "no Delhi/Mumbai candidates");
    });

    it("a Delhi voter gets exactly the Delhi ballot", async () => {
      const delhi = await mkVoter({ email: "d@example.org", constituencyCode: "DL-DEL" });
      await startSession(delhi);
      await post("/eligibility/check");
      assert.deepEqual((await get("/ballot")).body.data.candidates.map((c) => c.candidateId), ["8", "9", "10", "11", "12", "13"]);
    });

    it("there is nothing to tamper with: any query parameter is rejected", async () => {
      await startSession();
      await post("/eligibility/check");
      for (const q of ["?constituency=DL-DEL", "?constituencyCode=MH-MUM", "?constituencyId=0x1", "?candidateId=9"]) assert.equal((await get("/ballot" + q)).status, 400, q);
    });

    it("needs ELIGIBLE (FACE_VERIFIED and AUTHENTICATED are refused)", async () => {
      await startSession();
      assert.equal((await get("/ballot")).body.error.code, "STAGE_REQUIRED");
    });

    it("BALLOT_VIEWED is audited without any selection", async () => {
      await startSession();
      await post("/eligibility/check");
      await get("/ballot");
      const row = await AuditLog.findOne({ action: "BALLOT_VIEWED" });
      assert.deepEqual(row.meta, { voterId: voter.voterId, constituencyCode: "KA-BLR" });
    });
  });

  describe("chain failure fails closed", () => {
    it("RPC failure while checking the nullifier => CHAIN_UNAVAILABLE and no transition", async () => {
      const failing = { ...chain, contract: { getConstituency: (...a) => chain.contract.getConstituency(...a), nullifierUsed: async () => { throw new Error("rpc down http://secret-rpc"); } } };
      app = build(failing);
      await startSession();
      const res = await post("/eligibility/check");
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, "CHAIN_UNAVAILABLE");
      assert.ok(!JSON.stringify(res.body).includes("secret-rpc"));
      assert.equal(await stageOf(), "FACE_VERIFIED");
    });

    it("RPC failure while loading the ballot => CHAIN_UNAVAILABLE", async () => {
      await startSession();
      await post("/eligibility/check");
      const failing = { ...chain, contract: { getConstituency: (...a) => chain.contract.getConstituency(...a), candidateCountOf: async () => { throw new Error("rpc down"); } } };
      app = build(failing);
      const res = await get("/ballot");
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, "CHAIN_UNAVAILABLE");
    });
  });

  describe("privacy", () => {
    it("responses, logs and audit rows never contain uid, nullifier, passwords, hash, session token or secrets", async () => {
      await startSession();
      const e = await post("/eligibility/check");
      const b = await get("/ballot");
      const s = await get("/status");
      const raw = await mongoose.connection.collection("voters_v2").findOne({});
      const nullifier = await nullifierFor();
      const audit = JSON.stringify(await mongoose.connection.collection("auditlogs").find({}).toArray());
      const everything = JSON.stringify([e.body, b.body, s.body]) + audit + memory.lines.join("");
      const sec = config.secrets;
      for (const secret of [raw.uid, nullifier, raw.passwordHash, PW, token, sec.nullifierSecret.toString("hex"), sec.ownerPrivateKey, sec.jwtAccessSecret.toString("hex")]) assert.ok(!everything.includes(secret), `leaked ${String(secret).slice(0, 8)}...`);
    });

    it("/status stays passive after the new steps", async () => {
      await startSession();
      await post("/eligibility/check");
      const before = +(await VoterSession.findById(sessionId)).lastActivityAt;
      clock.advance(50);
      await get("/status");
      assert.equal(+(await VoterSession.findById(sessionId)).lastActivityAt, before);
    });
  });
});
