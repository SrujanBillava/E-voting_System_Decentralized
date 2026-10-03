import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import request from "supertest";
import { STAGES, canTransition } from "../../src/auth/voterStages.js";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { requireVoterStage } from "../../src/middleware/requireVoterSession.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { Voter } from "../../src/models/Voter.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createAuditService } from "../../src/services/audit.service.js";
import { createVoterAuthService } from "../../src/services/voterAuth.service.js";
import { generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { validEnv } from "../helpers/env.js";

// Needs the local chain AND a disposable MongoDB (MONGODB_TEST_URI). The election is opened inside a snapshot.
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";

describe("voter authentication + session + stage machine (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, memory, auth, app, voter, t;
  const clock = { now: () => t, advance: (s) => (t += s * 1000) };
  const owner = () => chain.contract.connect(chain.signers.owner);
  const open = async () => (await owner().openElection()).wait();
  const login = (body, a = app) => request(a).post("/api/v1/voter/auth/login").send(body);
  const cookieOf = (res) => (res.headers["set-cookie"] ?? []).find((c) => /vc_voter=/.test(c))?.split(";")[0];
  const status = (cookie, a = app) => request(a).get("/api/v1/voter/status").set("Cookie", cookie ?? "");
  const mkVoter = async (over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: "Asha Rao", email: "asha@example.org", passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });
  const build = (config, rate) => {
    const audit = createAuditService({ AuditLog, logger: memory.logger, now: clock.now });
    auth = createVoterAuthService({ Voter, VoterSession, chain, audit, now: clock.now, bcryptCost: 4 });
    return createApp({ config, logger: memory.logger, healthService: { getPublicHealth: async () => ({ status: "ok" }) }, voter: { authService: auth }, voterLoginRateLimit: rate ?? { windowMs: 60_000, limit: 1000 } });
  };

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
    await mongoose.connection.dropDatabase();
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), AuditLog.syncIndexes()]);
    t = Date.parse("2026-10-03T10:00:00Z");
    memory = createMemoryLogger();
    app = build(loadEnv(validEnv()));
    voter = await mkVoter();
  });
  afterEach(() => revertTo(chain.provider, snap));

  describe("login", () => {
    it("voterId + password succeeds only while the election is Open, with a safe response", async () => {
      await open();
      const res = await login({ identifier: voter.voterId, password: PW });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), ["stage", "stageExpiresAt", "voter"]);
      assert.deepEqual(res.body.data.voter, { voterId: voter.voterId, name: "Asha Rao", constituencyCode: "KA-BLR", faceEnrolled: false });
      assert.equal(res.body.data.stage, "AUTHENTICATED");
      assert.ok(!JSON.stringify(res.body).match(/uid|passwordHash|nullifier|token/i));
    });

    it("email (any case/whitespace) works too; voterId is case-insensitive", async () => {
      await open();
      assert.equal((await login({ identifier: "  ASHA@Example.ORG ", password: PW })).status, 200);
      await request(app).post("/api/v1/voter/auth/logout");
      await VoterSession.updateMany({}, { active: false });
      assert.equal((await login({ identifier: voter.voterId.toLowerCase(), password: PW })).status, 200);
    });

    it("wrong password and unknown voter give the identical generic response", async () => {
      await open();
      const a = await login({ identifier: voter.voterId, password: "wrong password here" });
      const b = await login({ identifier: "nobody@example.org", password: PW });
      const c = await login({ identifier: "VC-AAAAAAAAAA", password: PW });
      for (const r of [a, b, c]) assert.deepEqual([r.status, r.body.error.code, r.body.error.message], [401, "INVALID_CREDENTIALS", "Invalid credentials"]);
      assert.equal(await VoterSession.countDocuments({}), 0);
    });

    it("a suspended voter cannot log in (after a correct password)", async () => {
      await open();
      await Voter.updateOne({ _id: voter._id }, { status: "SUSPENDED" });
      const res = await login({ identifier: voter.voterId, password: PW });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "VOTER_SUSPENDED");
    });

    it("Setup and Closed both refuse login; only Open allows it", async () => {
      const setup = await login({ identifier: voter.voterId, password: PW });
      assert.equal(setup.body.error.code, "ELECTION_NOT_OPEN");
      await open();
      await (await owner().closeElection()).wait();
      assert.equal((await login({ identifier: voter.voterId, password: PW })).body.error.code, "ELECTION_CLOSED");
      assert.equal(await VoterSession.countDocuments({}), 0);
    });

    it("rejects operator payloads, extra fields and malformed bodies", async () => {
      await open();
      for (const body of [{ identifier: { $ne: null }, password: PW }, { identifier: voter.voterId, password: { $ne: "" } }, { identifier: voter.voterId, password: PW, role: "x" }, { identifier: voter.voterId }, { identifier: "ab", password: PW }]) {
        assert.equal((await login(body)).status, 400, JSON.stringify(body));
      }
    });

    it("is rate limited per IP", async () => {
      await open();
      const limited = build(loadEnv(validEnv()), { windowMs: 60_000, limit: 3 });
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await login({ identifier: voter.voterId, password: "wrong password!!" }, limited)).status);
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    });
  });

  describe("cookie", () => {
    it("is opaque, HttpOnly, SameSite=Strict, Path=/; the raw token is not stored, only its SHA-256", async () => {
      await open();
      const res = await login({ identifier: voter.voterId, password: PW });
      const raw = res.headers["set-cookie"].find((c) => c.startsWith("vc_voter="));
      assert.match(raw, /HttpOnly/i);
      assert.match(raw, /SameSite=Strict/i);
      assert.match(raw, /Path=\//);
      assert.ok(!/secure/i.test(raw), "not Secure outside production");
      const token = raw.split(";")[0].split("=")[1];
      assert.ok(token.length >= 43);
      for (const secret of [voter.voterId, "asha", String(voter._id), "AUTHENTICATED", voter.email]) assert.ok(!token.includes(secret));
      const row = await mongoose.connection.collection("votersessions").findOne({});
      assert.equal(row.tokenHash, createHash("sha256").update(token).digest("hex"));
      assert.ok(!JSON.stringify(row).includes(token));
    });

    it("production: __Host- prefix and Secure", async () => {
      await open();
      const prod = build({ corsOrigins: [], isProduction: true });
      const res = await login({ identifier: voter.voterId, password: PW }, prod);
      const raw = res.headers["set-cookie"].find((c) => c.startsWith("__Host-vc_voter="));
      assert.ok(raw, res.headers["set-cookie"]?.join());
      assert.match(raw, /Secure/i);
      assert.match(raw, /Path=\//);
      assert.ok(!/Domain=/i.test(raw));
    });
  });

  describe("session lifecycle", () => {
    let cookie;
    beforeEach(async () => {
      await open();
      cookie = cookieOf(await login({ identifier: voter.voterId, password: PW }));
    });

    it("starts AUTHENTICATED with absolute, idle and stage expiries; status recovers it after a refresh", async () => {
      const row = await VoterSession.findOne({});
      assert.equal(row.stage, "AUTHENTICATED");
      assert.equal(row.absoluteExpiresAt - row.createdAt, 15 * 60_000);
      assert.equal(row.stageExpiresAt - row.createdAt, 5 * 60_000);
      assert.equal(+row.lastActivityAt, +row.createdAt);
      const res = await status(cookie);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.stage, "AUTHENTICATED");
      assert.equal(res.body.data.electionPhase, "Open");
      assert.deepEqual(Object.keys(res.body.data).sort(), ["electionPhase", "sessionExpiresAt", "stage", "stageExpiresAt", "voter"]);
    });

    it("logout revokes, clears the cookie, is idempotent; the voter can log in again", async () => {
      const out = await request(app).post("/api/v1/voter/auth/logout").set("Cookie", cookie);
      assert.equal(out.status, 204);
      assert.match(out.headers["set-cookie"].join(), /vc_voter=;/);
      assert.equal((await status(cookie)).status, 401);
      assert.equal((await request(app).post("/api/v1/voter/auth/logout").set("Cookie", cookie)).status, 204);
      assert.equal((await request(app).post("/api/v1/voter/auth/logout")).status, 204);
      assert.equal((await login({ identifier: voter.voterId, password: PW })).status, 200);
    });

    it("passive /status polling does NOT extend the idle window; a meaningful authenticated action does", async () => {
      clock.advance(100);
      assert.equal((await status(cookie)).status, 200);
      assert.equal(+(await VoterSession.findOne({})).lastActivityAt, +(await VoterSession.findOne({})).createdAt, "status must not touch lastActivityAt");
      clock.advance(100); // 200s since login, only polled: idle (120s) has elapsed
      const dead = await status(cookie);
      assert.equal(dead.status, 401);
      assert.equal(dead.body.error.code, "SESSION_EXPIRED");
      assert.equal((await VoterSession.findOne({})).active, false);
      assert.ok(await AuditLog.findOne({ action: "VOTER_SESSION_EXPIRED" }));
    });

    it("a meaningful action (default authenticate) keeps the session alive", async () => {
      const token = cookie.split("=")[1];
      clock.advance(100);
      await auth.authenticate(token); // what a future step endpoint does
      clock.advance(100);
      assert.equal((await status(cookie)).status, 200, "100s since the last meaningful action");
      clock.advance(121);
      assert.equal((await status(cookie)).status, 401);
    });

    it("the AUTHENTICATED stage times out after 5 minutes even with activity; absolute lifetime is 15 minutes", async () => {
      for (let i = 0; i < 4; i++) { clock.advance(60); await auth.authenticate(cookie.split("=")[1]); } // 240s of real activity: still inside the stage window
      clock.advance(61); // 301s total despite constant activity
      assert.equal((await status(cookie)).body.error.code, "SESSION_EXPIRED");
      assert.equal((await status(cookie)).status, 401, "and it stays dead");
    });

    it("a suspended voter loses the session on the next request", async () => {
      await Voter.updateOne({ _id: voter._id }, { status: "SUSPENDED" });
      assert.equal((await status(cookie)).status, 401);
      assert.equal((await VoterSession.findOne({})).active, false);
    });

    it("no cookie, a random cookie and a revoked session are all 401", async () => {
      assert.equal((await status(undefined)).status, 401);
      assert.equal((await status("vc_voter=" + "a".repeat(43))).status, 401);
      await VoterSession.updateMany({}, { active: false });
      assert.equal((await status(cookie)).status, 401);
    });

    it("if the election closes, the next request ends the journey with ELECTION_CLOSED", async () => {
      assert.equal((await status(cookie)).status, 200);
      await (await owner().closeElection()).wait();
      const res = await status(cookie);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ELECTION_CLOSED");
    });
  });

  describe("one active session per voter", () => {
    beforeEach(open);

    it("a second login while one is live is SESSION_ACTIVE; works again after logout or expiry", async () => {
      const first = await login({ identifier: voter.voterId, password: PW });
      const second = await login({ identifier: voter.email, password: PW });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "SESSION_ACTIVE");
      assert.ok(await AuditLog.findOne({ action: "VOTER_SESSION_ACTIVE_REJECTED" }));
      clock.advance(121); // first one is now idle-expired
      assert.equal((await login({ identifier: voter.voterId, password: PW })).status, 200);
      void first;
    });

    it("simultaneous logins race to exactly one active session", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => login({ identifier: voter.voterId, password: PW })));
      const codes = results.map((r) => r.status).sort();
      assert.deepEqual(codes, [200, 409, 409, 409, 409, 409]);
      assert.equal(await VoterSession.countDocuments({ active: true }), 1);
    });
  });

  describe("stage machine", () => {
    let sessionId;
    beforeEach(async () => {
      await open();
      await login({ identifier: voter.voterId, password: PW });
      sessionId = (await VoterSession.findOne({}))._id;
    });
    const later = () => new Date(clock.now() + 60_000);

    it("only the next stage is a legal transition", () => {
      assert.equal(canTransition("AUTHENTICATED", "FACE_VERIFIED"), true);
      for (const [a, b] of [["AUTHENTICATED", "ELIGIBLE"], ["AUTHENTICATED", "COMPLETED"], ["FACE_VERIFIED", "AUTHENTICATED"], ["AUTHENTICATED", "AUTHENTICATED"], ["AUTHENTICATED", "nonsense"]]) assert.equal(canTransition(a, b), false, `${a}->${b}`);
    });

    it("transitions atomically once; a repeat or an illegal jump fails", async () => {
      assert.equal(await auth.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: later() }), true);
      assert.equal((await VoterSession.findById(sessionId)).stage, "FACE_VERIFIED");
      assert.equal(await auth.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: later() }), false);
      await assert.rejects(auth.transitionStage({ sessionId, from: STAGES.FACE_VERIFIED, to: STAGES.COMPLETED, expiresAt: later() }), /illegal/);
    });

    it("competing transitions have exactly one winner", async () => {
      const wins = await Promise.all(Array.from({ length: 8 }, () => auth.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: later() })));
      assert.equal(wins.filter(Boolean).length, 1);
    });

    it("a revoked session cannot transition", async () => {
      await VoterSession.updateOne({ _id: sessionId }, { active: false });
      assert.equal(await auth.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: later() }), false);
    });

    it("requireVoterStage lets AUTHENTICATED through and blocks FACE_VERIFIED", () => {
      const run = (stage, ...allowed) => {
        let outcome;
        requireVoterStage(...allowed)({ voterSession: { stage } }, {}, (err) => (outcome = err));
        return outcome;
      };
      assert.equal(run("AUTHENTICATED", "AUTHENTICATED"), undefined);
      assert.equal(run("AUTHENTICATED", "FACE_VERIFIED").code, "STAGE_REQUIRED");
      assert.equal(run(undefined, "AUTHENTICATED").code, "STAGE_REQUIRED");
    });

    it("no production route performs a transition beyond AUTHENTICATED", async () => {
      const cookie = cookieOf(await login({ identifier: voter.email, password: PW }).catch(() => ({ headers: {} }))); // 409: already active
      void cookie;
      for (const p of ["face-verify", "eligibility", "authorization", "cast"]) assert.equal((await request(app).post(`/api/v1/voter/${p}`)).status, 404);
      assert.equal((await VoterSession.findOne({})).stage, "AUTHENTICATED");
    });
  });

  describe("privacy", () => {
    it("no response, log line or audit row contains uid, password, hash, session token, token hash or secrets", async () => {
      await open();
      const bad = await login({ identifier: voter.voterId, password: "Wrong-password-xyz-1" });
      const good = await login({ identifier: voter.voterId, password: PW });
      const second = await login({ identifier: voter.voterId, password: PW });
      const cookie = cookieOf(good);
      const st = await status(cookie);
      const token = cookie.split("=")[1];
      await request(app).post("/api/v1/voter/auth/logout").set("Cookie", cookie);
      const raw = await mongoose.connection.collection("voters_v2").findOne({});
      const row = await mongoose.connection.collection("votersessions").findOne({});
      const audit = JSON.stringify(await mongoose.connection.collection("auditlogs").find({}).toArray());
      const everything = JSON.stringify([bad.body, good.body, second.body, st.body]) + audit + memory.lines.join("");
      const s = loadEnv(validEnv()).secrets;
      for (const secret of [raw.uid, raw.passwordHash, PW, "Wrong-password-xyz-1", token, row.tokenHash, s.nullifierSecret.toString("hex"), s.ownerPrivateKey, s.jwtAccessSecret.toString("hex")]) {
        assert.ok(!everything.includes(secret), `leaked ${String(secret).slice(0, 8)}...`);
      }
      for (const action of ["VOTER_LOGIN_SUCCESS", "VOTER_LOGIN_FAILURE", "VOTER_SESSION_ACTIVE_REJECTED", "VOTER_LOGOUT"]) assert.ok(audit.includes(action), action);
    });
  });
});
