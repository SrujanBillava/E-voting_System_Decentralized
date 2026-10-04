import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { signAccessToken } from "../../src/auth/tokens.js";
import { STAGES } from "../../src/auth/voterStages.js";
import { createOwnerQueue } from "../../src/chain/ownerQueue.js";
import { createRelayerQueue } from "../../src/chain/relayerQueue.js";
import { CHALLENGE_TTL_MS, MAX_CHALLENGES_PER_SESSION, MAX_FAILED_ATTEMPTS } from "../../src/biometrics/constants.js";
import { sealTemplate } from "../../src/biometrics/templateBox.js";
import { loadEnv } from "../../src/config/env.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { FaceChallenge } from "../../src/models/FaceChallenge.js";
import { FaceTemplate } from "../../src/models/FaceTemplate.js";
import { Voter } from "../../src/models/Voter.js";
import { VoteTicket } from "../../src/models/VoteTicket.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createAuthorizationService } from "../../src/services/authorization.service.js";
import { createBallotConfigService } from "../../src/services/ballotConfig.service.js";
import { createCastService } from "../../src/services/cast.service.js";
import { createEligibilityService } from "../../src/services/eligibility.service.js";
import { createFaceService } from "../../src/services/face.service.js";
import { createPublicService } from "../../src/services/public.service.js";
import { createReceiptService } from "../../src/services/receipt.service.js";
import { createVoterService, generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { createVoterAuthService } from "../../src/services/voterAuth.service.js";
import { adminWorld } from "../helpers/admin.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { validEnv } from "../helpers/env.js";
import { capture, person, rounded, samplesOf } from "../helpers/face.js";

// ADVERSARIAL tests for AUTHENTICATED -> FACE_VERIFIED (Step 12), run against the MERGED wiring: ONE Express app that mounts
// the face routes, the voter routes, the journey routes and the admin routes together, exactly like src/server.js does.
// Needs the local chain AND a disposable MongoDB (MONGODB_TEST_URI). Adversarial review of AUTHENTICATED -> FACE_VERIFIED.
// Defects this review found (voter-delete cleanup, enrolment overtaken by a delete, unreadable templates at Open) are fixed and covered
// here. One finding is a documented design limit and is asserted as such ("KNOWN LIMITATION").
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";
const KEY = loadEnv(validEnv()).secrets.faceTemplateKey;
const OTHER_KEY = Buffer.alloc(32, 7);

const ASHA = person(1);
const BHARAT = person(2);
const ashaSamples = (count = 3) => samplesOf(ASHA, count).map(rounded);
const bharatSamples = (count = 3) => samplesOf(BHARAT, count).map(rounded);
const ashaToday = (seed = 60) => rounded(capture(ASHA, 0.85, seed));
const bharatToday = (seed = 61) => rounded(capture(BHARAT, 0.85, seed));
const stranger = (seed) => rounded(person(900 + seed));

describe("ADVERSARIAL biometrics: AUTHENTICATED -> FACE_VERIFIED on the merged wiring (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, w, voterAuth, faceService, app, token, admin, asha, bharat;

  const owner = () => chain.contract.connect(chain.signers.owner);
  const open = async () => (await owner().openElection()).wait();
  const close = async () => (await owner().closeElection()).wait();
  const mkVoter = async (over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: "Asha Rao", email: `v${Math.random().toString(36).slice(2)}@example.org`, passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });

  /** The merged application, wired like src/server.js (face service shared by the admin and the voter side). */
  const buildApp = ({ faceKey = KEY, faceRateLimit = { windowMs: 60_000, limit: 100_000 }, faceChain = chain, voterServiceOverrides = {}, faceTemplateModel = FaceTemplate } = {}) => {
    voterAuth = createVoterAuthService({ Voter, VoterSession, chain, audit: w.audit, now: w.clock.now, bcryptCost: 4 });
    faceService = createFaceService({ Voter, VoterSession, FaceTemplate: faceTemplateModel, FaceChallenge, authService: voterAuth, chain: faceChain, audit: w.audit, templateKey: faceKey, now: w.clock.now });
    const common = { Voter, authService: voterAuth, audit: w.audit, now: w.clock.now };
    const nullifierSecret = w.config.secrets.nullifierSecret;
    const castService = createCastService({ ...common, VoteTicket, chain, relayerQueue: createRelayerQueue() });
    const receiptService = createReceiptService({ ...common, VoteTicket, castService, chain, nullifierSecret });
    return createApp({
      config: w.config,
      logger: w.memory.logger,
      healthService: { getPublicHealth: async () => ({ status: "ok" }) },
      admin: {
        authService: w.auth,
        electionService: { getElection: async () => ({ stub: true }), open: async () => ({}), close: async () => ({}) },
        voterService: createVoterService({ Voter, chain, audit: w.audit, bcryptCost: 4, FaceTemplate, FaceChallenge, ...voterServiceOverrides }),
        configService: createBallotConfigService({ chain, audit: w.audit, ownerQueue: createOwnerQueue() }),
        faceService,
      },
      voter: {
        authService: voterAuth,
        faceService,
        faceRateLimit,
        eligibilityService: createEligibilityService({ ...common, chain, nullifierSecret, receiptService }),
        authorizationService: createAuthorizationService({ ...common, VoteTicket, chain, nullifierSecret }),
        castService,
        receiptService,
      },
      publicService: createPublicService({ chain, audit: w.audit }),
      loginRateLimit: { windowMs: 60_000, limit: 100_000 },
      voterLoginRateLimit: { windowMs: 60_000, limit: 100_000 },
    });
  };

  const adminCall = (method, path, body, tok = token) => {
    const r = request(app)[method](`/api/v1/admin${path}`);
    if (tok) r.set("Authorization", `Bearer ${tok}`);
    return body === undefined ? r : r.send(body);
  };
  const enrol = (voter, descriptors = ashaSamples()) => adminCall("put", `/voters/${voter._id}/face`, { descriptors });
  const cookieOf = (res) => (res.headers["set-cookie"] ?? []).find((c) => /vc_voter=/.test(c))?.split(";")[0];
  const login = async (voter = asha) => {
    const res = await request(app).post("/api/v1/voter/auth/login").send({ identifier: voter.voterId, password: PW });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return cookieOf(res);
  };
  const voterCall = (method, path, cookie) => request(app)[method](`/api/v1/voter${path}`).set("Cookie", cookie ?? "");
  const challenge = (cookie) => voterCall("post", "/face/challenge", cookie);
  const verify = (cookie, body) => voterCall("post", "/face/verify", cookie).send(body);
  const rawVerify = (cookie, raw, type = "application/json") => voterCall("post", "/face/verify", cookie).set("Content-Type", type).send(raw);
  const faceStatus = async (cookie) => (await voterCall("get", "/face/status", cookie)).body.data;
  const issue = async (cookie) => {
    const res = await challenge(cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.challenge;
  };
  const attempt = async (cookie, descriptor, extra = {}) => verify(cookie, { challenge: await issue(cookie), descriptor, ...extra });
  const sessionOf = (voter = asha) => VoterSession.findOne({ voterId: voter._id, active: true });
  const stageOf = async (voter = asha) => (await VoterSession.findOne({ voterId: voter._id }).sort({ active: -1, _id: -1 })).stage;
  const audits = (action) => AuditLog.find(action ? { action } : {}).sort({ at: 1, _id: 1 });
  const codeOf = (res) => [res.status, res.body.error?.code];
  const rowOf = (voter = asha) => FaceChallenge.findOne({ voterId: voter._id }).sort({ _id: -1 });
  /** Enrol several voters while the election is in Setup, then open it. */
  const enrolAll = async (pairs) => {
    for (const [voter, samples] of pairs) assert.equal((await enrol(voter, samples)).status, 200);
    await open();
  };
  const enrolledAndLoggedIn = async (voter = asha, samples = ashaSamples()) => {
    assert.equal((await enrol(voter, samples)).status, 200);
    if ((await chain.contract.phase()) === 0n) await open();
    return login(voter);
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
    w = await adminWorld();
    w.clock.advance((Date.now() - w.clock.now()) / 1000); // the fake clock starts at the real time, so Mongo TTL housekeeping cannot touch live rows
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), VoteTicket.syncIndexes(), FaceTemplate.syncIndexes(), FaceChallenge.syncIndexes()]);
    app = buildApp();
    admin = await w.createAdmin();
    token = (await w.loginAs(admin)).body.data.accessToken;
    asha = await mkVoter({ email: "asha@example.org" });
    bharat = await mkVoter({ name: "Bharat", email: "bharat@example.org" });
  });
  afterEach(() => revertTo(chain.provider, snap));

  // ===================================================================================================================
  // 1. Reaching FACE_VERIFIED (or anything after it) without a server-side match
  // ===================================================================================================================
  describe("no path to FACE_VERIFIED without a server-side match", () => {
    it("a session still at AUTHENTICATED (also a LOCKED one) is refused by every later step with STAGE_REQUIRED, and nothing moves", async () => {
      const cookie = await enrolledAndLoggedIn();
      const later = () => [
        voterCall("post", "/eligibility/check", cookie).send({}),
        voterCall("get", "/ballot", cookie),
        voterCall("post", "/authorization", cookie).send({ candidateId: "3" }),
        voterCall("post", "/cast", cookie).set("Idempotency-Key", "abcdefgh12345678").send({}),
        voterCall("get", "/receipt", cookie),
        // hints that try to talk the server into a different stage must be refused too
        voterCall("post", "/eligibility/check?stage=FACE_VERIFIED", cookie).send({}),
        voterCall("post", "/eligibility/check", cookie).send({ stage: "FACE_VERIFIED" }),
      ];
      const expectAllRefused = async (label) => {
        const results = await Promise.all(later());
        for (const [i, res] of results.entries()) assert.ok(res.status === 409 || res.status === 400, `${label} #${i}: ${res.status} ${JSON.stringify(res.body)}`);
        for (const res of results.slice(0, 5)) assert.deepEqual(codeOf(res), [409, "STAGE_REQUIRED"], label);
        assert.equal(await stageOf(), "AUTHENTICATED", label);
        assert.equal(await VoteTicket.countDocuments({}), 0);
        assert.equal(await chain.contract.totalBallots(), 0n);
      };
      await expectAllRefused("fresh session");
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) assert.equal((await attempt(cookie, stranger(i))).status, 403);
      assert.equal((await faceStatus(cookie)).locked, true);
      await expectAllRefused("locked session");
    });

    it("a voter without an enrolment cannot be waved through: no challenge, no verification, and the flag alone (no template) is not enough", async () => {
      await open();
      const cookie = await login();
      assert.deepEqual(codeOf(await challenge(cookie)), [409, "FACE_NOT_ENROLLED"]);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: "a".repeat(43), descriptor: ashaToday() })), [409, "FACE_NOT_ENROLLED"]);
      await Voter.updateOne({ _id: asha._id }, { faceEnrolled: true }); // the flag alone, with no template behind it
      const issued = await issue(cookie);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: ashaToday() })), [409, "FACE_NOT_ENROLLED"]);
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.equal((await rowOf()).attempts, 0);
    });

    it("a challenge minted for one voter is useless in another voter's session, for the right face of either, and stays valid for its owner", async () => {
      await enrolAll([[asha, ashaSamples()], [bharat, bharatSamples()]]);
      const cookieA = await login(asha);
      const cookieB = await login(bharat);
      const challengeA = await issue(cookieA);
      const challengeB = await issue(cookieB);
      assert.deepEqual(codeOf(await verify(cookieA, { challenge: challengeB, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.deepEqual(codeOf(await verify(cookieB, { challenge: challengeA, descriptor: bharatToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await rowOf(asha)).attempts, 0);
      assert.equal((await rowOf(bharat)).attempts, 0);
      assert.equal(await stageOf(asha), "AUTHENTICATED");
      assert.equal(await stageOf(bharat), "AUTHENTICATED");
      // A's face against B's template inside B's own session is a mismatch for B (and costs B an attempt), never a pass.
      assert.deepEqual(codeOf(await verify(cookieB, { challenge: challengeB, descriptor: ashaToday() })), [403, "FACE_MISMATCH"]);
      assert.equal(await stageOf(bharat), "AUTHENTICATED");
      assert.equal((await verify(cookieA, { challenge: challengeA, descriptor: ashaToday() })).status, 200, "A's own challenge was untouched");
    });

    it("a used or old challenge cannot be replayed in a later session of the same voter, or after verification", async () => {
      const cookie = await enrolledAndLoggedIn();
      const first = await issue(cookie);
      assert.equal((await verify(cookie, { challenge: first, descriptor: ashaToday() })).status, 200);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: first, descriptor: ashaToday() })), [409, "STAGE_REQUIRED"]);
      await voterCall("post", "/auth/logout", cookie);
      const again = await login();
      assert.deepEqual(codeOf(await verify(again, { challenge: first, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"], "bound to the old session");
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.equal(await FaceChallenge.countDocuments({ voterId: asha._id }), 1, "the replay created no row for the new session");
      assert.equal(await FaceChallenge.countDocuments({ sessionId: (await sessionOf())._id }), 0);
    });

    it("an expired challenge never helps, not even with the right face, and costs no attempt; a challenge one second before expiry still works exactly once", async () => {
      const cookie = await enrolledAndLoggedIn();
      const expired = await issue(cookie);
      w.clock.advance(CHALLENGE_TTL_MS / 1000 + 1);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: expired, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await rowOf()).attempts, 0);
      const live = await issue(cookie);
      w.clock.advance(CHALLENGE_TTL_MS / 1000 - 1);
      assert.equal((await verify(cookie, { challenge: live, descriptor: ashaToday() })).status, 200);
    });

    it("a verified session (and every later stage) cannot go back to the face step to collect a second FACE_VERIFIED window", async () => {
      const cookie = await enrolledAndLoggedIn();
      assert.equal((await attempt(cookie, ashaToday())).status, 200);
      const before = await sessionOf();
      for (const stage of [STAGES.FACE_VERIFIED, STAGES.ELIGIBLE]) {
        await VoterSession.updateOne({ _id: before._id }, { $set: { stage } });
        assert.deepEqual(codeOf(await challenge(cookie)), [409, "STAGE_REQUIRED"], stage);
        assert.deepEqual(codeOf(await verify(cookie, { challenge: "z".repeat(43), descriptor: ashaToday() })), [409, "STAGE_REQUIRED"], stage);
      }
      const after = await sessionOf();
      assert.equal(+after.stageExpiresAt, +before.stageExpiresAt, "no new window was granted");
    });

    it("tampered, forged, typed and duplicated cookies never authenticate (including cookie-parser's j: JSON cookies)", async () => {
      const cookie = await enrolledAndLoggedIn();
      const tokenValue = cookie.split("=")[1];
      const issued = await issue(cookie);
      const body = { challenge: issued, descriptor: ashaToday() };
      const forged = [
        "",
        "vc_voter=",
        `vc_voter=${tokenValue.slice(0, -1)}${tokenValue.endsWith("B") ? "C" : "B"}`,
        `vc_voter=${tokenValue.toUpperCase()}`,
        `vc_voter=${tokenValue}x`,
        `vc_voter=${"A".repeat(5000)}`,
        `vc_voter=j:{"$ne":null}`,
        `vc_voter=j:["${tokenValue}"]`,
        `vc_voter=j:{"toString":1,"length":99}`,
        `vc_voter=s:${tokenValue}.AAAA`,
        `vc_voter_x=${tokenValue}`,
        `__Host-vc_voter=${tokenValue}`, // the production cookie name must not be accepted by a development server
        "vc_voter=null",
        "vc_voter=undefined",
        `vc_voter=${tokenValue.slice(0, 10)}`,
        `vc_voter=%00${tokenValue}`,
      ];
      for (const c of forged) {
        for (const res of [await verify(c, body), await challenge(c), await voterCall("get", "/face/status", c)]) assert.deepEqual(codeOf(res), [401, "UNAUTHENTICATED"], c.slice(0, 60));
      }
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.equal((await rowOf()).attempts, 0);
      assert.equal((await verify(cookie, body)).status, 200, "the genuine cookie still works, nothing was consumed");
    });

    it("an admin token is not a voter session, and a voter token is not an admin bearer token", async () => {
      const cookie = await enrolledAndLoggedIn();
      const voterToken = cookie.split("=")[1];
      const asVoter = `vc_voter=${token}`;
      assert.deepEqual(codeOf(await challenge(asVoter)), [401, "UNAUTHENTICATED"]);
      for (const method of ["get", "put", "delete"]) {
        const res = await request(app)[method](`/api/v1/admin/voters/${asha._id}/face`).set("Authorization", `Bearer ${voterToken}`).send(method === "put" ? { descriptors: ashaSamples() } : undefined);
        assert.deepEqual(codeOf(res), [401, "UNAUTHENTICATED"], method);
      }
      const viaCookie = await request(app).put(`/api/v1/admin/voters/${asha._id}/face`).set("Cookie", cookie).send({ descriptors: ashaSamples() });
      assert.equal(viaCookie.status, 401);
    });
  });

  // ===================================================================================================================
  // 2. The attempt counter
  // ===================================================================================================================
  describe("the attempt counter and the lock", () => {
    it("40 parallel challenge+verify flows (half of them with the RIGHT face) never exceed three comparisons and grant the step at most once", async () => {
      const cookie = await enrolledAndLoggedIn();
      const flow = async (i) => {
        const issued = await challenge(cookie);
        if (issued.status !== 200) return issued.status;
        const right = i % 2 === 0;
        return (await verify(cookie, { challenge: issued.body.data.challenge, descriptor: right ? ashaToday(100 + i) : stranger(i) })).status;
      };
      const statuses = await Promise.all(Array.from({ length: 40 }, (_, i) => flow(i)));
      const row = await rowOf();
      assert.ok(row.attempts <= MAX_FAILED_ATTEMPTS, `attempts ${row.attempts}`);
      const compared = (await audits("FACE_VERIFY_FAILURE")).filter((a) => a.meta.reason === "mismatch").length + (await audits("FACE_VERIFY_SUCCESS")).length;
      assert.ok(compared <= MAX_FAILED_ATTEMPTS, `${compared} comparisons`);
      assert.ok((await audits("FACE_VERIFY_SUCCESS")).length <= 1);
      assert.ok(statuses.filter((s) => s === 200).length <= 1);
      assert.equal(await stageOf(), statuses.includes(200) ? "FACE_VERIFIED" : "AUTHENTICATED");
    });

    it("40 parallel verifies of ONE challenge with a wrong face cost exactly one attempt and one comparison", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = await issue(cookie);
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => verify(cookie, { challenge: issued, descriptor: stranger(i) })));
      assert.equal(results.filter((r) => r.status === 403).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 39);
      assert.equal((await rowOf()).attempts, 1);
    });

    it("the lock is sticky: repeated challenge requests, status polling and an earlier-looking challenge string never reopen it", async () => {
      const cookie = await enrolledAndLoggedIn();
      const last = [];
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) last.push(await issue(cookie));
      // every challenge but the newest was replaced when the next one was issued
      for (const old of last.slice(0, -1)) assert.deepEqual(codeOf(await verify(cookie, { challenge: old, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await rowOf()).attempts, 0);
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) assert.equal((await attempt(cookie, stranger(i))).status, 403);
      for (let i = 0; i < 5; i++) {
        assert.deepEqual(codeOf(await challenge(cookie)), [423, "FACE_LOCKED"]);
        assert.deepEqual(await faceStatus(cookie), { enrolled: true, verified: false, attemptsLeft: 0, locked: true });
      }
      // raw database tampering of a challenge-only field is not enough either: the counter decides
      await FaceChallenge.updateOne({ voterId: asha._id }, { $set: { tokenHash: "f".repeat(64), expiresAt: new Date(w.clock.now() + 60_000), usedAt: null } });
      assert.equal((await rowOf()).attempts, 3);
      assert.deepEqual(codeOf(await challenge(cookie)), [423, "FACE_LOCKED"]);
      assert.equal(await stageOf(), "AUTHENTICATED");
    });

    it("at most MAX_CHALLENGES_PER_SESSION challenges are issued, even when requested in parallel, and the budget is not refilled by a failed request", async () => {
      const cookie = await enrolledAndLoggedIn();
      const results = await Promise.all(Array.from({ length: MAX_CHALLENGES_PER_SESSION * 3 }, () => challenge(cookie)));
      assert.equal(results.filter((r) => r.status === 200).length, MAX_CHALLENGES_PER_SESSION);
      assert.equal(results.filter((r) => r.status === 429 && r.body.error.code === "FACE_CHALLENGE_LIMIT").length, MAX_CHALLENGES_PER_SESSION * 2);
      assert.equal((await rowOf()).challengesIssued, MAX_CHALLENGES_PER_SESSION);
    });

    it("two live sessions of one voter cannot exist: the second login is refused, the first keeps its own counter", async () => {
      const first = await enrolledAndLoggedIn();
      assert.equal((await attempt(first, stranger(1))).status, 403);
      const second = await request(app).post("/api/v1/voter/auth/login").send({ identifier: asha.voterId, password: PW });
      assert.deepEqual(codeOf(second), [409, "SESSION_ACTIVE"]);
      assert.equal(second.headers["set-cookie"], undefined);
      assert.equal(await VoterSession.countDocuments({ voterId: asha._id, active: true }), 1);
      assert.equal((await faceStatus(first)).attemptsLeft, 2);
    });

    it("an idle-expired session is dead for the face routes, and its replacement starts from a different counter row", async () => {
      const first = await enrolledAndLoggedIn();
      const issued = await issue(first);
      w.clock.advance(121); // idle window is 120 s
      assert.deepEqual(codeOf(await verify(first, { challenge: issued, descriptor: ashaToday() })), [401, "SESSION_EXPIRED"]);
      const second = await login();
      assert.deepEqual(codeOf(await verify(second, { challenge: issued, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal(await FaceChallenge.countDocuments({ voterId: asha._id }), 1, "the old row stays (housekeeping only), the new session has none yet");
    });

    it("KNOWN LIMITATION (as specified in docs/BIOMETRICS.md): the three-attempt lock is per SESSION; the real brake is the voter login rate limit", async () => {
      const cookie0 = await enrolledAndLoggedIn();
      let cookie = cookie0;
      let comparisons = 0;
      for (let round = 0; round < 2; round++) {
        const left = (await faceStatus(cookie)).attemptsLeft;
        assert.equal(left, MAX_FAILED_ATTEMPTS, `round ${round}: a new session starts with the full budget`);
        for (let i = 0; i < left; i++) {
          const res = await attempt(cookie, stranger(round * 10 + i));
          if (res.status === 403) comparisons++;
        }
        assert.equal((await faceStatus(cookie)).locked, true, "locked for THIS session");
        await voterCall("post", "/auth/logout", cookie);
        cookie = await login();
      }
      // Documented: logging in again resets the budget. An impostor who already has the voter's password is therefore limited by the
      // login rate limiter (and by the supervising officer), not by this counter. A per-voter lock needs an officer-only unlock route.
      assert.equal(comparisons, MAX_FAILED_ATTEMPTS * 2);
    });
  });

  // ===================================================================================================================
  // 3. Hostile request bodies
  // ===================================================================================================================
  describe("hostile request bodies change nothing", () => {
    const stateIsUntouched = async (cookie, issued) => {
      const row = await rowOf();
      assert.equal(row.attempts, 0, "no attempt was counted");
      assert.equal(row.usedAt, null, "the challenge was not consumed");
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.equal((await audits("FACE_VERIFY_SUCCESS")).length, 0);
      assert.equal((await verify(cookie, { challenge: issued, descriptor: ashaToday() })).status, 200, "the very same challenge still works");
    };
    const json = (arr) => JSON.stringify(arr);
    const flat = (n, v = 0.5) => Array.from({ length: n }, () => v);

    it("descriptors of the wrong shape are refused with 400 before anything is consumed", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = await issue(cookie);
      const good = ashaToday();
      const withAt = (i, v) => good.map((x, k) => (k === i ? v : x));
      const bad = [
        json([]), json([0.1]), json(good.slice(1)), json([...good, 0.1]), json(flat(511)), json(flat(513)), json(flat(1024)), json(flat(15_000)),
        json(good.map(String)), json(good.map((x) => [x])), json(good.map((x) => ({ v: x }))), json(withAt(7, null)), json(withAt(7, true)), json(withAt(7, "0.1")), json(withAt(7, [])), json(withAt(7, {})),
        json(flat(512, 0)), json(flat(512, -0)), json(flat(512, 1e-9)), json(flat(512, 1e-200)), json(withAt(0, 100.0001)), json(withAt(0, -100.0001)), json(withAt(0, 1e308)),
        `[${good.slice(0, 511).join(",")},1e999]`, `[${good.slice(0, 511).join(",")},-1e999]`, `[${good.slice(0, 511).join(",")},NaN]`, `[${good.slice(0, 511).join(",")},Infinity]`, `[${good.slice(0, 511).join(",")},-Infinity]`, `[${good.slice(0, 511).join(",")},]`,
        json({ length: 512, 0: 1 }), json({ ...good }), "null", "true", "512", '"descriptor"', "[[" + good.join(",") + "]]",
        "[".repeat(40_000) + "]".repeat(40_000), // a nesting bomb that still fits the body limit
      ];
      for (const descriptorJson of bad) {
        const res = await rawVerify(cookie, `{"challenge":"${issued}","descriptor":${descriptorJson}}`);
        assert.equal(res.status, 400, `${descriptorJson.slice(0, 60)} -> ${res.status} ${JSON.stringify(res.body)}`);
        assert.ok(["VALIDATION_FAILED", "INVALID_JSON"].includes(res.body.error.code), res.body.error.code);
        assert.ok(!JSON.stringify(res.body).includes("0.5"), "no value is echoed");
      }
      await stateIsUntouched(cookie, issued);
    });

    it("boundary values that ARE valid are compared like any other face: they cost an attempt and never pass by accident", async () => {
      const cookie = await enrolledAndLoggedIn();
      const odd = [json(flat(512, 100)), json(flat(512, -100)), json(flat(512, 1e-7))];
      for (const descriptorJson of odd) {
        const issued = await issue(cookie);
        assert.deepEqual(codeOf(await rawVerify(cookie, `{"challenge":"${issued}","descriptor":${descriptorJson}}`)), [403, "FACE_MISMATCH"], descriptorJson.slice(0, 30));
      }
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.equal((await audits("FACE_VERIFY_SUCCESS")).length, 0);
      assert.equal((await faceStatus(cookie)).locked, true);
    });

    it("a descriptor that differs from the enrolled face by a global sign flip, or is its exact negative, is a mismatch", async () => {
      const cookie = await enrolledAndLoggedIn();
      const res = await attempt(cookie, ashaToday().map((x) => -x));
      assert.deepEqual(codeOf(res), [403, "FACE_MISMATCH"]);
    });

    it("unknown, duplicated or pollution-style keys are refused; Object.prototype stays clean", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = await issue(cookie);
      const d = json(ashaToday());
      const bodies = [
        `{"challenge":"${issued}","descriptor":${d},"__proto__":{"polluted":"yes"}}`,
        `{"__proto__":{"polluted":"yes"},"challenge":"${issued}","descriptor":${d}}`,
        `{"challenge":"${issued}","descriptor":${d},"constructor":{"prototype":{"polluted":"yes"}}}`,
        `{"challenge":"${issued}","descriptor":${d},"stage":"FACE_VERIFIED"}`,
        `{"challenge":"${issued}","descriptor":${d},"score":1}`,
        `{"challenge":"${issued}","descriptor":${d},"voterId":"${bharat.voterId}"}`,
        `{"challenge":"${issued}","descriptor":${d},"threshold":0}`,
        `{"challenge":["${issued}"],"descriptor":${d}}`,
        `{"challenge":{"$ne":null},"descriptor":${d}}`,
        `{"challenge":{"$gt":""},"descriptor":${d}}`,
        `{"challenge":"${issued}","descriptor":${d},"liveness":{"passed":true,"__proto__":{"passed":false}}}`,
        `{"challenge":"${issued}","descriptor":${d},"liveness":{"passed":true,"constructor":1}}`,
        `[{"challenge":"${issued}","descriptor":${d}}]`,
        `"${issued}"`,
        "null",
        "{}",
      ];
      for (const raw of bodies) {
        const res = await rawVerify(cookie, raw);
        assert.ok(res.status === 400, `${raw.slice(0, 70)} -> ${res.status}`);
      }
      assert.equal({}.polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
      await stateIsUntouched(cookie, issued);
    });

    it("liveness abuse: malformed reports are 400, a reported failure is 422 and free, a reported pass cannot help a wrong face", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = await issue(cookie);
      const d = json(ashaToday());
      for (const liveness of ['{"passed":"true"}', '{"passed":1}', '{"passed":null}', "{}", '{"real":1}', '{"passed":true,"real":1.0001}', '{"passed":true,"real":-0.1}', '{"passed":true,"live":"0.5"}', '{"passed":true,"live":1e999}', '{"passed":true,"extra":1}', "null", "[]", "true", '"passed"', "1"]) {
        const res = await rawVerify(cookie, `{"challenge":"${issued}","descriptor":${d},"liveness":${liveness}}`);
        assert.equal(res.status, 400, liveness);
      }
      for (let i = 0; i < 5; i++) {
        assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: ashaToday(), liveness: { passed: false, real: 1, live: 1 } })), [422, "FACE_LIVENESS_FAILED"]);
      }
      assert.deepEqual(codeOf(await verify(cookie, { challenge: "n".repeat(43), descriptor: ashaToday(), liveness: { passed: false } })), [422, "FACE_LIVENESS_FAILED"]);
      await stateIsUntouched(cookie, issued);
    });

    it("a reported liveness pass with perfect scores cannot rescue a wrong face; with zero scores it cannot block the right face (the report is advisory)", async () => {
      const cookie = await enrolledAndLoggedIn();
      assert.deepEqual(codeOf(await attempt(cookie, stranger(1), { liveness: { passed: true, real: 1, live: 1 } })), [403, "FACE_MISMATCH"]);
      assert.equal((await attempt(cookie, ashaToday(), { liveness: { passed: true, real: 0, live: 0 } })).status, 200);
    });

    it("duplicate JSON keys: the server validates and compares the same (last) value, so there is no parser differential", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = await issue(cookie);
      const wrong = json(stranger(2));
      const right = json(ashaToday());
      assert.deepEqual(codeOf(await rawVerify(cookie, `{"challenge":"${issued}","descriptor":${right},"descriptor":${wrong}}`)), [403, "FACE_MISMATCH"]);
      const second = await issue(cookie);
      assert.equal((await rawVerify(cookie, `{"challenge":"${"x".repeat(43)}","challenge":"${second}","descriptor":${wrong},"descriptor":${right}}`)).status, 200);
    });

    it("oversized, mistyped and mis-encoded bodies answer 4xx, never 5xx, and the server keeps serving", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = await issue(cookie);
      const d = json(ashaToday());
      const big = `{"challenge":"${issued}","descriptor":${d},"pad":"${"x".repeat(101 * 1024)}"}`;
      assert.deepEqual(codeOf(await rawVerify(cookie, big)), [413, "PAYLOAD_TOO_LARGE"]);
      const plain = `{"challenge":"${issued}","descriptor":${d}}`;
      assert.equal((await rawVerify(cookie, plain, "text/plain")).status, 400);
      assert.equal((await rawVerify(cookie, `challenge=${issued}&descriptor=${d}`, "application/x-www-form-urlencoded")).status, 400);
      assert.equal((await rawVerify(cookie, plain, "application/json; charset=latin1")).status, 415);
      assert.ok([400, 415].includes((await voterCall("post", "/face/verify", cookie).set("Content-Type", "application/json").set("Content-Encoding", "gzip").send(plain)).status));
      assert.ok([400, 415].includes((await voterCall("post", "/face/verify", cookie).set("Content-Type", "application/json").set("Content-Encoding", "br").send(plain)).status));
      assert.equal((await rawVerify(cookie, "{")).status, 400);
      assert.equal((await rawVerify(cookie, `{"challenge":"${issued}","descriptor":${d}`)).status, 400);
      assert.equal((await rawVerify(cookie, "\u0000")).status, 400);
      assert.equal((await rawVerify(cookie, `{"challenge":"${issued}","descriptor":${d}}\u0000`)).status, 400);
      assert.equal((await voterCall("post", "/face/verify?descriptor=1", cookie).send({ challenge: issued, descriptor: ashaToday() })).status, 400);
      assert.equal((await voterCall("post", "/face/challenge?x=1", cookie).send({})).status, 400);
      assert.equal((await voterCall("post", "/face/challenge", cookie).send({ forceAction: "BLINK" })).status, 400);
      assert.equal((await voterCall("get", "/face/status?locked=false", cookie)).status, 400);
      for (const method of ["get", "put", "patch", "delete"]) assert.equal((await voterCall(method, "/face/verify", cookie)).status, 404, method);
      assert.equal((await voterCall("post", "/face/enrol", cookie).send({})).status, 404);
      await stateIsUntouched(cookie, issued);
    });

    it("every refusal uses the normal error envelope and never echoes input", async () => {
      const cookie = await enrolledAndLoggedIn();
      const marker = "MARKER-7f3a9c-do-not-echo";
      const res = await rawVerify(cookie, `{"challenge":"${marker}","descriptor":[${marker}]}`);
      assert.equal(res.status, 400);
      assert.ok(!res.text.includes(marker));
      assert.deepEqual(Object.keys(res.body.error).sort(), ["code", "message", "requestId"]);
    });
  });

  // ===================================================================================================================
  // 4. The template box at rest, and what a broken key does
  // ===================================================================================================================
  describe("the template box in the database", () => {
    it("a template row copied onto another voter, truncated, corrupted or re-signed with another key never matches and never passes", async () => {
      await enrolAll([[asha, ashaSamples()], [bharat, bharatSamples()]]);
      const cookieA = await login(asha);
      const coll = mongoose.connection.collection("facetemplates");
      const rowA = await coll.findOne({ voterId: asha._id });
      const rowB = await coll.findOne({ voterId: bharat._id });
      let cookieB = await login(bharat);

      const attackB = async () => {
        await voterCall("post", "/auth/logout", cookieB);
        cookieB = await login(bharat); // a fresh session per variant keeps the 10-challenge budget out of the way
        return attempt(cookieB, ashaToday()); // A's face against B's account
      };
      const variants = {
        "A's box copied onto B": rowA.box,
        "ciphertext truncated": { ...rowB.box, ct: rowB.box.ct.slice(0, rowB.box.ct.length - 8) },
        "ciphertext extended": { ...rowB.box, ct: rowB.box.ct + "AAAA" },
        "tag cut to 4 bytes": { ...rowB.box, tag: Buffer.from(rowB.box.tag, "base64").subarray(0, 4).toString("base64") },
        "tag cut to 15 bytes": { ...rowB.box, tag: Buffer.from(rowB.box.tag, "base64").subarray(0, 15).toString("base64") },
        "iv cut to 8 bytes": { ...rowB.box, iv: Buffer.from(rowB.box.iv, "base64").subarray(0, 8).toString("base64") },
        "iv extended": { ...rowB.box, iv: rowB.box.iv + "AAAA" },
        "version 2": { ...rowB.box, v: 2 },
        "box emptied": { ct: "", iv: "", tag: "", v: 1 },
        "sealed by another key": sealTemplate(OTHER_KEY, String(bharat._id), samplesOf(person(2), 3)),
        "sealed for the wrong voter id": sealTemplate(KEY, String(asha._id), samplesOf(person(2), 3)),
      };
      for (const [label, box] of Object.entries(variants)) {
        await coll.updateOne({ voterId: bharat._id }, { $set: { box } });
        const res = await attackB();
        assert.ok(res.status === 500 || res.status === 403, `${label}: ${res.status}`);
        assert.notEqual(res.status, 200, label);
        if (label === "A's box copied onto B") assert.equal(res.status, 500, "the AAD binding makes the copied box unreadable instead of readable-and-matching");
        assert.equal(await stageOf(bharat), "AUTHENTICATED", label);
        // a server-side fault must not cost the voter an attempt
        if (res.status === 500) assert.equal((await rowOf(bharat)).attempts, 0, label);
      }
      // A is unaffected throughout.
      assert.equal((await attempt(cookieA, ashaToday())).status, 200);
      assert.ok(!JSON.stringify(await audits()).includes(rowA.box.ct), "the ciphertext is not in the audit trail");
    });

    it("a service started with the WRONG key fails closed: every verify is a generic 500, no attempt is spent, nothing is granted, nothing sensitive is logged", async () => {
      const cookie = await enrolledAndLoggedIn();
      app = buildApp({ faceKey: OTHER_KEY });
      const sent = ashaToday();
      for (let i = 0; i < 5; i++) {
        const issued = await issue(cookie);
        const res = await verify(cookie, { challenge: issued, descriptor: sent });
        assert.deepEqual(codeOf(res), [500, "INTERNAL_ERROR"]);
        assert.equal(res.body.error.message, "Internal server error");
        assert.ok(!res.text.includes(issued));
      }
      assert.equal((await rowOf()).attempts, 0, "template faults are not the voter's fault");
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.equal((await audits("FACE_VERIFY_FAILURE")).filter((a) => a.meta.reason === "template_unreadable").length, 5);
      const logs = w.memory.lines.join("");
      assert.ok(logs.includes("unhandled error"), "the fault is logged");
      for (const secret of [KEY.toString("hex"), OTHER_KEY.toString("hex"), OTHER_KEY.toString("base64"), String(sent[0]), String(sent[100]), String(sent[511])]) assert.ok(!logs.includes(secret), `leaked ${secret.slice(0, 8)}`);
      assert.ok(!/"box"|"ct"|"descriptor"|"challenge"|tokenHash/.test(logs));
    });
  });

  // ===================================================================================================================
  // 5. Admin enrolment
  // ===================================================================================================================
  describe("admin enrolment on the merged app", () => {
    it("every face admin route and every pre-existing admin route is guarded exactly once and not shadowed", async () => {
      const id = String(asha._id);
      const routes = [
        ["get", `/voters/${id}/face`], ["put", `/voters/${id}/face`], ["delete", `/voters/${id}/face`],
        ["get", "/voters"], ["post", "/voters"], ["get", `/voters/${id}`], ["patch", `/voters/${id}`], ["delete", `/voters/${id}`], ["post", `/voters/${id}/password-reset`],
        ["get", "/constituencies"], ["post", "/constituencies"], ["get", "/candidates"], ["get", "/candidates/1"], ["post", "/candidates"],
        ["get", "/election"], ["post", "/election/open"], ["post", "/election/close"], ["get", "/auth/me"],
      ];
      const attackers = [undefined, "garbage", "a.b.c", `${token}x`, token.split(".").slice(0, 2).join("."), "Bearer"];
      for (const [method, path] of routes) {
        for (const bearer of attackers) {
          const r = request(app)[method](`/api/v1/admin${path}`);
          if (bearer !== undefined) r.set("Authorization", bearer === "Bearer" ? "Bearer" : `Bearer ${bearer}`);
          const res = await r.send(method === "get" || method === "delete" ? undefined : {});
          assert.deepEqual(codeOf(res), [401, "UNAUTHENTICATED"], `${method} ${path} with ${bearer}`);
        }
      }
      // And with a valid token the pre-existing routes still answer with their own handlers (no shadowing in either direction).
      assert.equal((await adminCall("get", `/voters/${asha._id}`)).body.data.voter.voterId, asha.voterId);
      assert.equal((await adminCall("get", "/voters")).status, 200);
      assert.equal((await adminCall("get", `/voters/${asha._id}/face`)).status, 200);
      assert.deepEqual(codeOf(await adminCall("post", `/voters/${asha._id}/face`, {})), [404, "NOT_FOUND"], "unsupported verbs on the face path fall through to a plain 404");
      assert.deepEqual(codeOf(await adminCall("patch", `/voters/${asha._id}/face`, { status: "SUSPENDED" })), [404, "NOT_FOUND"]);
      assert.deepEqual(codeOf(await adminCall("get", "/voters/face")), [400, "VALIDATION_FAILED"], "'face' is not a voter id");
      assert.equal((await adminCall("get", `/voters/${asha._id}/FACE/`)).status, 200, "case/trailing-slash variants reach the same guarded handler");
      assert.equal((await adminCall("get", `/voters/${asha._id}/face/extra`)).status, 404);
      const noAuthVariants = await request(app).get(`/api/v1/admin/voters/${asha._id}/FACE/`);
      assert.equal(noAuthVariants.status, 401);
    });

    it("expired, foreign-secret, alg=none and wrong-audience admin tokens never reach the enrolment", async () => {
      const sess = await mongoose.connection.collection("adminsessions").findOne({});
      const claims = { adminId: sess.adminId, sessionId: sess._id, jti: "attack-1" };
      const secret = w.config.secrets.jwtAccessSecret;
      const tokens = {
        expired: signAccessToken({ secret, ...claims, nowMs: w.clock.now() - 3_600_000 }),
        otherSecret: signAccessToken({ secret: Buffer.alloc(32, 9), ...claims, nowMs: w.clock.now() }),
        none: `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${token.split(".")[1]}.`,
        noneUpper: `${Buffer.from('{"alg":"None","typ":"JWT"}').toString("base64url")}.${token.split(".")[1]}.`,
        tamperedPayload: `${token.split(".")[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(token.split(".")[1], "base64url")), sub: String(new mongoose.Types.ObjectId()) })).toString("base64url")}.${token.split(".")[2]}`,
      };
      for (const [label, t] of Object.entries(tokens)) {
        for (const method of ["get", "put", "delete"]) assert.deepEqual(codeOf(await adminCall(method, `/voters/${asha._id}/face`, method === "put" ? { descriptors: ashaSamples() } : undefined, t)), [401, "UNAUTHENTICATED"], `${label} ${method}`);
      }
      assert.equal(await FaceTemplate.countDocuments({}), 0);
    });

    it("the enrolment body is strict: mass-assignment fields, wrong counts and malformed ids change nothing", async () => {
      const s = ashaSamples();
      const bad = [
        { descriptors: s, faceEnrolled: true }, { descriptors: s, enrolledBy: String(new mongoose.Types.ObjectId()) }, { descriptors: s, algorithm: "x" }, { descriptors: s, voterId: String(bharat._id) },
        { descriptors: s.slice(0, 2) }, { descriptors: [...s, ...s].slice(0, 6) }, { descriptors: { length: 3, 0: s[0], 1: s[1], 2: s[2] } }, { descriptors: "x" }, { descriptor: s[0] }, {}, [], null,
        { descriptors: [s[0], s[1], [...s[2].slice(1), "0.1"]] }, { descriptors: [s[0], s[1], s[2].map(() => 0)] }, { descriptors: [s[0], s[1], s[2].map((x) => (x > 0 ? 1e6 : x))] },
      ];
      for (const body of bad) assert.equal((await adminCall("put", `/voters/${asha._id}/face`, body)).status, 400, JSON.stringify(body).slice(0, 80));
      for (const id of ["nope", "123", "g".repeat(24), "a".repeat(23), "a".repeat(25), `${asha._id}%00`, `${asha._id}/..`, "%24ne", "null", "undefined"]) {
        const res = await adminCall("put", `/voters/${id}/face`, { descriptors: s });
        assert.ok([400, 404].includes(res.status), `${id} -> ${res.status}`);
      }
      assert.deepEqual(codeOf(await adminCall("put", `/voters/${new mongoose.Types.ObjectId()}/face`, { descriptors: s })), [404, "NOT_FOUND"]);
      assert.equal(await FaceTemplate.countDocuments({}), 0);
      assert.equal(await Voter.countDocuments({ faceEnrolled: true }), 0);
      assert.equal({}.polluted, undefined);
    });

    it("the consistency threshold is enforced on EVERY pair at exactly 0.45: 0.46 passes, 0.44 is refused, and a chain a-b-c with a weak a-c pair is refused", async () => {
      // v_i = sqrt(c) * m + sqrt(1-c) * n_i with m, n_i orthonormal  =>  every pair has cosine exactly c
      const dim = 512;
      const base = [person(11), person(12), person(13), person(14)];
      const dot = (a, b) => a.reduce((acc, x, i) => acc + x * b[i], 0);
      const ortho = [];
      for (const v of base) {
        let u = v.slice();
        for (const o of ortho) {
          const k = dot(u, o);
          u = u.map((x, i) => x - k * o[i]);
        }
        const n = Math.sqrt(dot(u, u));
        ortho.push(u.map((x) => x / n));
      }
      const [m, n1, n2, n3] = ortho;
      const family = (c) => [n1, n2, n3].map((n) => rounded(m.map((x, i) => Math.sqrt(c) * x + Math.sqrt(1 - c) * n[i])));
      assert.equal(dim, m.length);
      assert.equal((await enrol(asha, family(0.46))).status, 200);
      assert.deepEqual(codeOf(await enrol(bharat, family(0.44))), [422, "FACE_SAMPLES_INCONSISTENT"]);
      assert.equal((await Voter.findById(bharat._id)).faceEnrolled, false);
      // a-b = 0.9, b-c = 0.9 but a-c lower than 0.45
      const a = person(21);
      const orth = (x, y) => {
        const k = dot(x, y);
        const u = x.map((v, i) => v - k * y[i]);
        const n = Math.sqrt(dot(u, u));
        return u.map((v) => v / n);
      };
      const e1 = orth(person(22), a);
      const th = (deg) => (deg * Math.PI) / 180;
      const at = (deg) => rounded(a.map((x, i) => Math.cos(th(deg)) * x + Math.sin(th(deg)) * e1[i]));
      const chainSamples = [at(0), at(25), at(50)]; // adjacent cos(25deg)=0.906, ends cos(50deg)=0.643 > 0.45 -> accepted control
      assert.equal((await enrol(bharat, chainSamples)).status, 200);
      const wide = [at(0), at(40), at(80)]; // ends cos(80deg)=0.17 < 0.45 although adjacent cos(40deg)=0.77
      assert.deepEqual(codeOf(await enrol(asha, wide)), [422, "FACE_SAMPLES_INCONSISTENT"]);
      assert.equal((await audits("FACE_ENROLMENT_REJECTED")).length, 2);
    });

    it("enrolment is Setup-only, read live from the chain on every call: it is refused the moment the election opens, and when the chain cannot be read it fails closed", async () => {
      assert.equal((await enrol(asha)).status, 200);
      const before = await FaceTemplate.findOne({ voterId: asha._id }).select("+box");
      await open();
      assert.deepEqual(codeOf(await enrol(asha, bharatSamples())), [409, "ELECTION_LOCKED"]);
      assert.deepEqual(codeOf(await adminCall("delete", `/voters/${asha._id}/face`)), [409, "ELECTION_LOCKED"]);
      assert.deepEqual(codeOf(await enrol(bharat)), [409, "ELECTION_LOCKED"]);
      const after = await FaceTemplate.findOne({ voterId: asha._id }).select("+box");
      assert.equal(after.box.ct, before.box.ct, "an Open election cannot have its template swapped");
      assert.equal(await FaceTemplate.countDocuments({}), 1);
      await close();
      assert.deepEqual(codeOf(await enrol(asha, bharatSamples())), [409, "ELECTION_LOCKED"]);

      // Chain unreadable -> 503, and nothing is written (fail closed, not "assume Setup").
      const down = { ...chain, contract: { phase: async () => { throw new Error("rpc down"); } } };
      const flaky = buildApp({ faceChain: down });
      const res = await request(flaky).put(`/api/v1/admin/voters/${bharat._id}/face`).set("Authorization", `Bearer ${token}`).send({ descriptors: bharatSamples() });
      assert.deepEqual(codeOf(res), [503, "CHAIN_UNAVAILABLE"]);
      assert.equal(await FaceTemplate.countDocuments({ voterId: bharat._id }), 0);
      assert.equal((await Voter.findById(bharat._id)).faceEnrolled, false);
    });

    it("parallel PUT/DELETE/PUT of one voter never leave two templates, or a template for a voter flagged as not enrolled", async () => {
      for (let round = 0; round < 8; round++) {
        await Promise.all([enrol(asha, ashaSamples(3)), adminCall("delete", `/voters/${asha._id}/face`), enrol(asha, ashaSamples(5)), adminCall("delete", `/voters/${asha._id}/face`), enrol(asha, bharatSamples(4))]);
        const voter = await Voter.findById(asha._id);
        const templates = await FaceTemplate.countDocuments({ voterId: asha._id });
        assert.ok(templates <= 1);
        if (templates === 1) assert.equal(voter.faceEnrolled, true, `round ${round}: a template exists although the voter is flagged as not enrolled`);
      }
    });

    it("enrolling a SUSPENDED voter is accepted but such a voter can never log in, so it cannot lead to FACE_VERIFIED", async () => {
      assert.equal((await adminCall("patch", `/voters/${asha._id}`, { status: "SUSPENDED" })).status, 200);
      assert.equal((await enrol(asha)).status, 200);
      await open();
      const res = await request(app).post("/api/v1/voter/auth/login").send({ identifier: asha.voterId, password: PW });
      assert.deepEqual(codeOf(res), [403, "VOTER_SUSPENDED"]);
    });
  });

  // ===================================================================================================================
  // 6. Voter deletion
  // ===================================================================================================================
  describe("voter deletion removes biometric data", () => {
    const seedRows = async (voter, sessions = 2) => {
      const ids = [];
      for (let i = 0; i < sessions; i++) {
        const t = new Date();
        const s = await VoterSession.create({ voterId: voter._id, tokenHash: `h-${voter.voterId}-${i}-${Math.random()}`, active: false, createdAt: t, lastActivityAt: t, absoluteExpiresAt: new Date(+t + 900_000), stageExpiresAt: new Date(+t + 300_000) });
        await FaceChallenge.create({ sessionId: s._id, voterId: voter._id, tokenHash: "a".repeat(64), action: "BLINK", expiresAt: new Date(+t + 30_000), purgeAt: new Date(+t + 900_000), challengesIssued: 1 });
        ids.push(s._id);
      }
      return ids;
    };

    it("deleting one voter removes exactly that voter's template and challenge rows and nobody else's (no cascade)", async () => {
      assert.equal((await enrol(asha, ashaSamples())).status, 200);
      assert.equal((await enrol(bharat, bharatSamples())).status, 200);
      const carol = await mkVoter({ name: "Carol", email: "carol@example.org" });
      assert.equal((await enrol(carol, samplesOf(person(3), 3).map(rounded))).status, 200);
      await seedRows(asha, 3);
      await seedRows(bharat, 2);
      await seedRows(carol, 1);
      assert.equal((await adminCall("delete", `/voters/${asha._id}`)).status, 204);
      assert.equal(await FaceTemplate.countDocuments({ voterId: asha._id }), 0);
      assert.equal(await FaceChallenge.countDocuments({ voterId: asha._id }), 0);
      assert.equal(await FaceTemplate.countDocuments({}), 2);
      assert.equal(await FaceChallenge.countDocuments({ voterId: bharat._id }), 2);
      assert.equal(await FaceChallenge.countDocuments({ voterId: carol._id }), 1);
      assert.ok(await Voter.findById(bharat._id));
      assert.equal(await mongoose.connection.collection("facetemplates").countDocuments({ voterId: { $nin: [bharat._id, carol._id] } }), 0, "no orphan templates");
      assert.deepEqual(codeOf(await adminCall("delete", `/voters/${asha._id}`)), [404, "NOT_FOUND"]);
      assert.deepEqual(codeOf(await adminCall("get", `/voters/${asha._id}/face`)), [404, "NOT_FOUND"]);
      assert.deepEqual(codeOf(await enrol(asha)), [404, "NOT_FOUND"]);
    });

    it("when the template cleanup fails, the voter's challenge rows must still be removed (the two cleanups are independent)", async () => {
      assert.equal((await enrol(asha)).status, 200);
      await seedRows(asha, 2);
      const flakyTemplates = new Proxy(FaceTemplate, { get: (target, p) => (p === "deleteOne" ? () => Promise.reject(new Error("template store down")) : typeof target[p] === "function" ? target[p].bind(target) : target[p]) });
      app = buildApp({ voterServiceOverrides: { FaceTemplate: flakyTemplates } });
      assert.equal((await adminCall("delete", `/voters/${asha._id}`)).status, 204, "the voter is already gone, so the call completes");
      assert.equal((await audits("VOTER_FACE_CLEANUP_FAILED")).length, 1, "and the failure is audited");
      assert.equal(await FaceChallenge.countDocuments({ voterId: asha._id }), 0, "challenge rows of a deleted voter are left behind because the template delete threw first");
    });

    it("an enrolment that is overtaken by the deletion of the same voter must not leave an encrypted template for a voter that no longer exists", async () => {
      // Deterministic replay of the interleaving "enroll() has loaded the voter, then DELETE /voters/:id completes, then enroll() writes":
      // the delete is issued from inside the enrolment's own template write.
      const victim = await mkVoter({ email: "victim@example.org" });
      let overtaken = false;
      const overtaking = new Proxy(FaceTemplate, {
        get: (target, p) => {
          if (p === "updateOne") {
            return async (...args) => {
              if (!overtaken) {
                overtaken = true;
                assert.equal((await adminCall("delete", `/voters/${victim._id}`)).status, 204);
              }
              return target.updateOne(...args);
            };
          }
          return typeof target[p] === "function" ? target[p].bind(target) : target[p];
        },
      });
      app = buildApp({ faceTemplateModel: overtaking });
      await enrol(victim);
      assert.equal(await Voter.findById(victim._id), null, "the voter is gone");
      assert.equal(await FaceTemplate.countDocuments({ voterId: victim._id }), 0, "but the enrolment that was already in flight wrote a template for the dead voter id");
    });
  });

  // ===================================================================================================================
  // 7. Stages, lifetimes and the closed election
  // ===================================================================================================================
  describe("stage machine and election phase", () => {
    it("FACE_VERIFIED is a real 3-minute window: the next step works inside it, and an expired window kills the whole session", async () => {
      await enrolAll([[asha, ashaSamples()], [bharat, bharatSamples()]]);
      const cookie = await login(asha);
      assert.equal((await attempt(cookie, ashaToday())).status, 200);
      w.clock.advance(60);
      const check = await voterCall("post", "/eligibility/check", cookie).send({});
      assert.equal(check.status, 200, JSON.stringify(check.body));
      assert.equal(await stageOf(), "ELIGIBLE");

      const bharatCookie = await login(bharat);
      assert.equal((await attempt(bharatCookie, bharatToday())).status, 200);
      w.clock.advance(181);
      assert.deepEqual(codeOf(await voterCall("post", "/eligibility/check", bharatCookie).send({})), [401, "SESSION_EXPIRED"]);
      assert.equal((await VoterSession.findOne({ voterId: bharat._id })).active, false);
      assert.equal(await stageOf(bharat), "FACE_VERIFIED", "an expired stage is not silently promoted");
    });

    it("recoverToCompleted and transitionStage cannot be used to skip the face step", async () => {
      const cookie = await enrolledAndLoggedIn();
      const session = await sessionOf();
      const sessionId = session._id;
      assert.equal(await voterAuth.recoverToCompleted({ sessionId, expiresAt: new Date(w.clock.now() + 60_000) }), false);
      for (const to of [STAGES.ELIGIBLE, STAGES.AUTH_ISSUED, STAGES.SUBMITTED, STAGES.COMPLETED, STAGES.AUTHENTICATED]) {
        await assert.rejects(voterAuth.transitionStage({ sessionId, from: STAGES.AUTHENTICATED, to, expiresAt: new Date(w.clock.now() + 60_000) }), /illegal stage transition/, to);
      }
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.equal((await voterCall("get", "/status", cookie)).body.data.stage, "AUTHENTICATED");
    });

    it("after the election is Closed no face call works, for AUTHENTICATED or FACE_VERIFIED sessions, including the routes that allow Closed for receipts", async () => {
      const cookieA = await enrolledAndLoggedIn(asha, ashaSamples());
      assert.deepEqual(codeOf(await enrol(bharat, bharatSamples())), [409, "ELECTION_LOCKED"], "Open: enrolment is locked");
      const issued = await issue(cookieA);
      await close();
      for (const res of [await challenge(cookieA), await verify(cookieA, { challenge: issued, descriptor: ashaToday() }), await voterCall("get", "/face/status", cookieA), await voterCall("get", "/status", cookieA), await voterCall("get", "/receipt", cookieA)]) {
        assert.equal(res.status, 409);
        assert.ok(["ELECTION_CLOSED", "STAGE_REQUIRED"].includes(res.body.error.code), res.body.error.code);
      }
      assert.equal(await stageOf(), "AUTHENTICATED");
      assert.deepEqual(codeOf(await request(app).post("/api/v1/voter/auth/login").send({ identifier: bharat.voterId, password: PW })), [409, "ELECTION_CLOSED"]);
    });

    it("the closed-election exemption covers only sessions that already reached the chain: a FACE_VERIFIED session is cut off at close", async () => {
      const cookie = await enrolledAndLoggedIn();
      assert.equal((await attempt(cookie, ashaToday())).status, 200);
      await close();
      assert.deepEqual(codeOf(await voterCall("get", "/status", cookie)), [409, "ELECTION_CLOSED"]);
      assert.deepEqual(codeOf(await voterCall("get", "/receipt", cookie)), [409, "ELECTION_CLOSED"]);
      assert.deepEqual(codeOf(await voterCall("post", "/eligibility/check", cookie).send({})), [409, "ELECTION_CLOSED"]);
    });
  });
});
