import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { CHALLENGE_TTL_MS, DESCRIPTOR_LENGTH, FACE_METHOD, FACE_MODEL, FACE_VERIFIED_TTL_MS, LIVENESS_ACTIONS, MATCH_THRESHOLD, MAX_CHALLENGES_PER_SESSION, MAX_FAILED_ATTEMPTS } from "../../src/biometrics/constants.js";
import { openTemplate } from "../../src/biometrics/templateBox.js";
import { loadEnv } from "../../src/config/env.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { FaceChallenge } from "../../src/models/FaceChallenge.js";
import { FaceTemplate } from "../../src/models/FaceTemplate.js";
import { Voter } from "../../src/models/Voter.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createFaceService } from "../../src/services/face.service.js";
import { generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { createVoterAuthService } from "../../src/services/voterAuth.service.js";
import { adminWorld } from "../helpers/admin.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { validEnv } from "../helpers/env.js";
import { capture, cosine, person, rounded, samplesOf } from "../helpers/face.js";

// Needs the local chain AND a disposable MongoDB (MONGODB_TEST_URI). Enrolment happens in Setup; the election
// is opened inside a snapshot for verification, and the chain is reverted after every test.
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";
const KEY = loadEnv(validEnv()).secrets.faceTemplateKey;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Imaginary people (see test/helpers/face.js). ASHA is enrolled; STRANGER is somebody else.
const ASHA = person(1);
const BHARAT = person(2);
const STRANGER = person(3);
const ashaSamples = (count = 3) => samplesOf(ASHA, count).map(rounded);
const ashaToday = (seed = 60) => rounded(capture(ASHA, 0.85, seed));

describe("biometrics: AUTHENTICATED -> FACE_VERIFIED (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, w, voterAuth, faceService, voterApp, token, admin, asha;

  const owner = () => chain.contract.connect(chain.signers.owner);
  const open = async () => (await owner().openElection()).wait();
  const close = async () => (await owner().closeElection()).wait();
  const mkVoter = async (over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: "Asha Rao", email: "asha@example.org", passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });

  const adminCall = (method, path, body, tok = token) => {
    const r = w.request()[method](`/api/v1/admin${path}`);
    if (tok) r.set(w.bearer(tok));
    return body === undefined ? r : r.send(body);
  };
  const enrol = (voter, descriptors = ashaSamples()) => adminCall("put", `/voters/${voter._id}/face`, { descriptors });

  const cookieOf = (res) => (res.headers["set-cookie"] ?? []).find((c) => /vc_voter=/.test(c))?.split(";")[0];
  const login = async (voter = asha) => {
    const res = await request(voterApp).post("/api/v1/voter/auth/login").send({ identifier: voter.voterId, password: PW });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return cookieOf(res);
  };
  const voterCall = (method, path, cookie) => request(voterApp)[method](`/api/v1/voter${path}`).set("Cookie", cookie ?? "");
  const challenge = (cookie) => voterCall("post", "/face/challenge", cookie);
  const verify = (cookie, body) => voterCall("post", "/face/verify", cookie).send(body);
  const faceStatus = async (cookie) => (await voterCall("get", "/face/status", cookie)).body.data;
  /** A full attempt: fresh challenge, then verify with `descriptor`. */
  const attempt = async (cookie, descriptor, extra = {}) => {
    const issued = await challenge(cookie);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    return verify(cookie, { challenge: issued.body.data.challenge, descriptor, ...extra });
  };
  const sessionOf = (voter = asha) => VoterSession.findOne({ voterId: voter._id, active: true });
  const audits = (action) => AuditLog.find(action ? { action } : {}).sort({ at: 1, _id: 1 });
  const codeOf = (res) => [res.status, res.body.error?.code];

  /** Enrol ASHA while the election is in Setup, open it, log her in. Returns her session cookie. */
  const enrolledAndLoggedIn = async () => {
    assert.equal((await enrol(asha)).status, 200);
    await open();
    return login();
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
    w = await adminWorld({
      extras: ({ audit, clock }) => {
        voterAuth = createVoterAuthService({ Voter, VoterSession, chain, audit, now: clock.now, bcryptCost: 4 });
        faceService = createFaceService({ Voter, VoterSession, FaceTemplate, FaceChallenge, authService: voterAuth, chain, audit, templateKey: KEY, now: clock.now });
        return { faceService };
      },
    });
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), FaceTemplate.syncIndexes(), FaceChallenge.syncIndexes()]);
    voterApp = createApp({ config: w.config, logger: w.memory.logger, healthService: { getPublicHealth: async () => ({ status: "ok" }) }, voter: { authService: voterAuth, faceService, faceRateLimit: { windowMs: 60_000, limit: 100_000 } }, voterLoginRateLimit: { windowMs: 60_000, limit: 1000 } });
    admin = await w.createAdmin();
    token = (await w.loginAs(admin)).body.data.accessToken;
    asha = await mkVoter();
  });
  afterEach(() => revertTo(chain.provider, snap));

  // ============================================================================================ enrolment

  describe("enrolment (admin, Setup phase)", () => {
    it("is admin-only: no token and a voter session are both refused", async () => {
      for (const method of ["get", "put", "delete"]) assert.deepEqual(codeOf(await adminCall(method, `/voters/${asha._id}/face`, method === "put" ? { descriptors: ashaSamples() } : undefined, null)), [401, "UNAUTHENTICATED"], method);
      await open();
      const cookie = await login();
      const res = await request(voterApp).put(`/api/v1/admin/voters/${asha._id}/face`).set("Cookie", cookie).send({ descriptors: ashaSamples() });
      assert.equal(res.status, 404, "the voter application does not even mount the admin routes");
      assert.equal(await FaceTemplate.countDocuments({}), 0);
      assert.equal((await Voter.findById(asha._id)).faceEnrolled, false);
    });

    it("stores ONE encrypted template, marks the voter enrolled, and audits it", async () => {
      const sent = ashaSamples();
      const res = await enrol(asha, sent);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data.voter, { id: String(asha._id), voterId: asha.voterId, faceEnrolled: true });
      assert.deepEqual(Object.keys(res.body.data.face).sort(), ["algorithm", "enrolledAt", "sampleCount"]);
      assert.equal(res.body.data.face.sampleCount, 3);
      assert.equal(res.body.data.face.algorithm, FACE_MODEL);
      assert.equal((await Voter.findById(asha._id)).faceEnrolled, true);

      // The stored row: facts in clear, the samples only as AES-GCM ciphertext, hidden from ordinary queries.
      assert.equal(await FaceTemplate.countDocuments({}), 1);
      const row = await FaceTemplate.findOne({ voterId: asha._id });
      assert.equal(row.box, undefined, "select:false");
      assert.equal(row.sampleCount, 3);
      assert.equal(row.dimension, DESCRIPTOR_LENGTH);
      assert.equal(row.algorithm, FACE_MODEL);
      assert.equal(String(row.enrolledBy), admin.admin.id);
      assert.equal(+row.enrolledAt, w.clock.now());
      const raw = await mongoose.connection.collection("facetemplates").findOne({});
      assert.deepEqual(Object.keys(raw.box).sort(), ["ct", "iv", "tag", "v"]);
      assert.deepEqual(Object.keys(raw).sort(), ["_id", "algorithm", "box", "dimension", "enrolledAt", "enrolledBy", "sampleCount", "templateVersion", "voterId"]);

      // Only the right key AND the right voter id open it, and what comes out is what was enrolled.
      const samples = openTemplate(KEY, String(asha._id), raw.box);
      assert.equal(samples.length, 3);
      samples.forEach((sample, i) => assert.ok(cosine(Array.from(sample), sent[i]) > 0.999999));
      assert.throws(() => openTemplate(KEY, String(new mongoose.Types.ObjectId()), raw.box));

      const [entry] = await audits("FACE_ENROLLED");
      assert.equal(entry.result, "success");
      assert.equal(String(entry.adminId), admin.admin.id);
      assert.deepEqual(entry.meta, { voterDbId: String(asha._id), voterId: asha.voterId, sampleCount: 3 });
    });

    it("accepts 3 to 5 samples and nothing else", async () => {
      for (const count of [3, 4, 5]) {
        const res = await enrol(asha, ashaSamples(count));
        assert.equal(res.status, 200, `${count}`);
        assert.equal(res.body.data.face.sampleCount, count);
        assert.equal((await FaceTemplate.findOne({ voterId: asha._id })).sampleCount, count);
      }
      assert.equal(await FaceTemplate.countDocuments({}), 1, "enrolling again replaces the template");
      for (const count of [0, 1, 2, 6, 7]) assert.deepEqual(codeOf(await enrol(asha, ashaSamples(count))), [400, "VALIDATION_FAILED"], `${count}`);
      assert.equal((await FaceTemplate.findOne({ voterId: asha._id })).sampleCount, 5, "a refused request changes nothing");
    });

    it("validates the dimension and the numbers of every sample; a refused enrolment stores nothing", async () => {
      const good = ashaSamples();
      const bad = [
        [good[0], good[1], good[2].slice(1)],
        [good[0], good[1], [...good[2], 0.1]],
        [good[0], good[1], Array(1024).fill(0.01)],
        [good[0], good[1], Array(DESCRIPTOR_LENGTH).fill(0)],
        [good[0], good[1], [...good[2].slice(1), 1e9]],
        [good[0], good[1], [...good[2].slice(1), "0.1"]],
        [good[0], good[1], "x"],
      ];
      for (const descriptors of bad) assert.deepEqual(codeOf(await enrol(asha, descriptors)), [400, "VALIDATION_FAILED"]);
      assert.equal(await FaceTemplate.countDocuments({}), 0);
      assert.equal((await Voter.findById(asha._id)).faceEnrolled, false);
    });

    it("refuses samples that are not the same face (two people in one template)", async () => {
      const mixed = [...ashaSamples(2), rounded(STRANGER)];
      const res = await enrol(asha, mixed);
      assert.deepEqual(codeOf(res), [422, "FACE_SAMPLES_INCONSISTENT"]);
      assert.equal(await FaceTemplate.countDocuments({}), 0);
      assert.equal((await Voter.findById(asha._id)).faceEnrolled, false);
      const [entry] = await audits("FACE_ENROLMENT_REJECTED");
      assert.deepEqual(entry.meta, { voterDbId: String(asha._id), voterId: asha.voterId, reason: "inconsistent_samples" });
    });

    it("is Setup-only: once the election is Open or Closed every change is refused", async () => {
      assert.equal((await enrol(asha)).status, 200);
      await open();
      assert.deepEqual(codeOf(await enrol(asha, samplesOf(BHARAT).map(rounded))), [409, "ELECTION_LOCKED"]);
      assert.deepEqual(codeOf(await adminCall("delete", `/voters/${asha._id}/face`)), [409, "ELECTION_LOCKED"]);
      const late = await mkVoter({ email: "late@example.org" });
      assert.deepEqual(codeOf(await enrol(late)), [409, "ELECTION_LOCKED"]);
      assert.equal((await adminCall("get", `/voters/${asha._id}/face`)).status, 200, "reading stays possible");
      await close();
      assert.deepEqual(codeOf(await enrol(asha)), [409, "ELECTION_LOCKED"]);
      assert.deepEqual(codeOf(await adminCall("delete", `/voters/${asha._id}/face`)), [409, "ELECTION_LOCKED"]);
      const samples = openTemplate(KEY, String(asha._id), (await mongoose.connection.collection("facetemplates").findOne({})).box);
      assert.ok(cosine(Array.from(samples[0]), ashaSamples()[0]) > 0.999999, "the template enrolled in Setup is untouched");
      assert.equal((await Voter.findById(late._id)).faceEnrolled, false);
    });

    it("an unknown voter is 404 and a malformed id is 400", async () => {
      assert.deepEqual(codeOf(await enrol({ _id: new mongoose.Types.ObjectId() })), [404, "NOT_FOUND"]);
      assert.deepEqual(codeOf(await enrol({ _id: "nope" })), [400, "VALIDATION_FAILED"]);
      assert.deepEqual(codeOf(await adminCall("get", `/voters/${new mongoose.Types.ObjectId()}/face`)), [404, "NOT_FOUND"]);
    });

    it("GET shows facts only; DELETE removes the template and the flag", async () => {
      const before = (await adminCall("get", `/voters/${asha._id}/face`)).body.data;
      assert.deepEqual(before, { voterId: asha.voterId, enrolled: false, sampleCount: 0, enrolledAt: null, algorithm: null, needsReenrolment: false });
      await enrol(asha, ashaSamples(4));
      const info = (await adminCall("get", `/voters/${asha._id}/face`)).body.data;
      assert.deepEqual({ ...info, enrolledAt: null }, { voterId: asha.voterId, enrolled: true, sampleCount: 4, enrolledAt: null, algorithm: FACE_MODEL, needsReenrolment: false });

      const gone = await adminCall("delete", `/voters/${asha._id}/face`);
      assert.equal(gone.status, 204);
      assert.equal(await FaceTemplate.countDocuments({}), 0);
      assert.equal((await Voter.findById(asha._id)).faceEnrolled, false);
      assert.equal((await adminCall("get", `/voters/${asha._id}/face`)).body.data.enrolled, false);
      assert.equal((await audits("FACE_ENROLMENT_REMOVED")).length, 1);
      assert.equal((await adminCall("delete", `/voters/${asha._id}/face`)).status, 204, "deleting twice is harmless");
    });

    it("parallel enrolments of one voter leave exactly one template", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => enrol(asha, ashaSamples(3 + (i % 3)))));
      assert.deepEqual(results.map((r) => r.status), Array(6).fill(200));
      assert.equal(await FaceTemplate.countDocuments({}), 1);
      const raw = await mongoose.connection.collection("facetemplates").findOne({});
      assert.equal(openTemplate(KEY, String(asha._id), raw.box).length, raw.sampleCount, "the stored row is one complete enrolment, not a mix");
    });
  });

  // ============================================================================================ challenge

  describe("challenge", () => {
    it("needs a voter session", async () => {
      await enrol(asha);
      await open();
      assert.deepEqual(codeOf(await challenge(undefined)), [401, "UNAUTHENTICATED"]);
      assert.deepEqual(codeOf(await challenge("vc_voter=" + "a".repeat(43))), [401, "UNAUTHENTICATED"]);
      assert.deepEqual(codeOf(await verify(undefined, { challenge: "c".repeat(43), descriptor: ashaToday() })), [401, "UNAUTHENTICATED"]);
    });

    it("is random, bound to the session, expires in 30 seconds, and only its hash is stored", async () => {
      const cookie = await enrolledAndLoggedIn();
      const res = await challenge(cookie);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { challenge: issued, action, expiresAt, attemptsLeft } = res.body.data;
      assert.deepEqual(Object.keys(res.body.data).sort(), ["action", "attemptsLeft", "challenge", "expiresAt"]);
      assert.match(issued, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(LIVENESS_ACTIONS.includes(action));
      assert.equal(CHALLENGE_TTL_MS, 30_000);
      assert.equal(Date.parse(expiresAt), w.clock.now() + CHALLENGE_TTL_MS);
      assert.equal(attemptsLeft, MAX_FAILED_ATTEMPTS);

      const session = await sessionOf();
      const raw = await mongoose.connection.collection("facechallenges").findOne({});
      assert.equal(String(raw.sessionId), String(session._id));
      assert.equal(String(raw.voterId), String(asha._id));
      assert.equal(raw.tokenHash, sha256(issued));
      assert.equal(raw.usedAt, null);
      assert.equal(+raw.purgeAt, +session.absoluteExpiresAt);
      assert.ok(!JSON.stringify(raw).includes(issued), "the challenge itself is not stored");
      for (const secret of [asha.voterId, String(asha._id), String(session._id)]) assert.ok(!issued.includes(secret));

      const second = (await challenge(cookie)).body.data.challenge;
      assert.notEqual(second, issued);
    });

    it("a voter who is not enrolled is stopped with FACE_NOT_ENROLLED, at the challenge and at verify", async () => {
      await open();
      const cookie = await login();
      assert.deepEqual(codeOf(await challenge(cookie)), [409, "FACE_NOT_ENROLLED"]);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: "c".repeat(43), descriptor: ashaToday() })), [409, "FACE_NOT_ENROLLED"]);
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");
      assert.deepEqual(await faceStatus(cookie), { enrolled: false, verified: false, attemptsLeft: 3, locked: false });
      const failures = await audits("FACE_VERIFY_FAILURE");
      assert.equal(failures.length, 2);
      for (const entry of failures) assert.deepEqual(entry.meta, { voterId: asha.voterId, reason: "not_enrolled" });
    });

    it("expires: usable at 29 seconds, refused after 30, and an expired challenge costs no attempt", async () => {
      const cookie = await enrolledAndLoggedIn();
      const late = (await challenge(cookie)).body.data.challenge;
      w.clock.advance(31);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: late, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await faceStatus(cookie)).attemptsLeft, 3);
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");

      const inTime = (await challenge(cookie)).body.data.challenge;
      w.clock.advance(29);
      assert.equal((await verify(cookie, { challenge: inTime, descriptor: ashaToday() })).status, 200);
    });

    it("works once: a used challenge is refused, even with the right face", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = (await challenge(cookie)).body.data.challenge;
      assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: rounded(STRANGER) })), [403, "FACE_MISMATCH"]);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");
      assert.equal((await faceStatus(cookie)).attemptsLeft, 2, "the refused replay did not cost a second attempt");
      assert.ok((await mongoose.connection.collection("facechallenges").findOne({})).usedAt instanceof Date);
    });

    it("asking for a new challenge cancels the previous one", async () => {
      const cookie = await enrolledAndLoggedIn();
      const first = (await challenge(cookie)).body.data.challenge;
      const second = (await challenge(cookie)).body.data.challenge;
      assert.deepEqual(codeOf(await verify(cookie, { challenge: first, descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await verify(cookie, { challenge: second, descriptor: ashaToday() })).status, 200);
      assert.equal(await FaceChallenge.countDocuments({}), 1, "one row per session");
    });

    it("is bound to its session: another voter's challenge is useless, and stays valid for its owner", async () => {
      const bharat = await mkVoter({ name: "Bharat Kumar", email: "bharat@example.org" });
      await enrol(asha);
      await enrol(bharat, samplesOf(BHARAT).map(rounded));
      await open();
      const ashaCookie = await login(asha);
      const bharatCookie = await login(bharat);
      const ashaChallenge = (await challenge(ashaCookie)).body.data.challenge;
      await challenge(bharatCookie);

      const stolen = await verify(bharatCookie, { challenge: ashaChallenge, descriptor: rounded(capture(BHARAT, 0.85)) });
      assert.deepEqual(codeOf(stolen), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await faceStatus(bharatCookie)).attemptsLeft, 3);
      assert.equal((await sessionOf(bharat)).stage, "AUTHENTICATED");

      assert.equal((await verify(ashaCookie, { challenge: ashaChallenge, descriptor: ashaToday() })).status, 200);
      assert.equal((await sessionOf(asha)).stage, "FACE_VERIFIED");
      assert.equal((await sessionOf(bharat)).stage, "AUTHENTICATED", "one voter's success never moves another session");
    });

    it("a made-up or missing challenge is refused and costs no attempt", async () => {
      const cookie = await enrolledAndLoggedIn();
      assert.deepEqual(codeOf(await verify(cookie, { challenge: "z".repeat(43), descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"], "no challenge was ever issued");
      await challenge(cookie);
      for (let i = 0; i < 5; i++) assert.deepEqual(codeOf(await verify(cookie, { challenge: String(i).repeat(43), descriptor: ashaToday() })), [409, "FACE_CHALLENGE_INVALID"]);
      assert.equal((await faceStatus(cookie)).attemptsLeft, 3);
      assert.equal((await audits("FACE_VERIFY_FAILURE")).filter((a) => a.meta.reason === "bad_challenge").length, 6);
    });

    it("a session may request a limited number of challenges", async () => {
      const cookie = await enrolledAndLoggedIn();
      for (let i = 0; i < MAX_CHALLENGES_PER_SESSION; i++) assert.equal((await challenge(cookie)).status, 200, `challenge ${i + 1}`);
      assert.deepEqual(codeOf(await challenge(cookie)), [429, "FACE_CHALLENGE_LIMIT"]);
      assert.equal((await FaceChallenge.findOne({})).challengesIssued, MAX_CHALLENGES_PER_SESSION);
    });

    it("parallel challenge requests leave one row, and exactly the last issued challenge is valid", async () => {
      const cookie = await enrolledAndLoggedIn();
      const results = await Promise.all(Array.from({ length: 6 }, () => challenge(cookie)));
      assert.deepEqual(results.map((r) => r.status), Array(6).fill(200));
      assert.equal(await FaceChallenge.countDocuments({}), 1);
      const row = await FaceChallenge.findOne({});
      assert.equal(row.challengesIssued, 6);
      const valid = results.map((r) => r.body.data.challenge).filter((c) => sha256(c) === row.tokenHash);
      assert.equal(valid.length, 1);
      assert.equal((await verify(cookie, { challenge: valid[0], descriptor: ashaToday() })).status, 200);
    });
  });

  // =========================================================================================== comparison

  describe("comparison (the server decides)", () => {
    it("the enrolled voter's face moves the session to FACE_VERIFIED", async () => {
      const cookie = await enrolledAndLoggedIn();
      const res = await attempt(cookie, ashaToday(), { liveness: { passed: true, real: 0.81, live: 0.93 } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), ["stage", "stageExpiresAt"]);
      assert.equal(res.body.data.stage, "FACE_VERIFIED");
      assert.equal(Date.parse(res.body.data.stageExpiresAt), w.clock.now() + FACE_VERIFIED_TTL_MS);

      const session = await sessionOf();
      assert.equal(session.stage, "FACE_VERIFIED");
      assert.equal(session.faceMethod, FACE_METHOD);
      assert.equal(+session.stageExpiresAt, w.clock.now() + FACE_VERIFIED_TTL_MS);
      assert.equal(+session.lastActivityAt, w.clock.now());
      assert.ok((await FaceChallenge.findOne({})).verifiedAt instanceof Date);

      const status = await voterCall("get", "/status", cookie);
      assert.equal(status.body.data.stage, "FACE_VERIFIED");
      assert.deepEqual(await faceStatus(cookie), { enrolled: true, verified: true, attemptsLeft: 2, locked: false });

      const [entry] = await audits("FACE_VERIFY_SUCCESS");
      assert.equal(entry.result, "success");
      assert.equal(entry.adminId, null);
      assert.deepEqual(Object.keys(entry.meta).sort(), ["attempt", "liveness", "score", "voterId"]);
      assert.equal(entry.meta.voterId, asha.voterId);
      assert.equal(entry.meta.attempt, 1);
      assert.equal(entry.meta.liveness, "reported_pass");
      assert.ok(entry.meta.score > MATCH_THRESHOLD && entry.meta.score <= 1);
    });

    it("someone else's face is refused: 403 FACE_MISMATCH, the stage does not move", async () => {
      const cookie = await enrolledAndLoggedIn();
      const res = await attempt(cookie, rounded(STRANGER));
      assert.deepEqual(codeOf(res), [403, "FACE_MISMATCH"]);
      assert.deepEqual(res.body.error.details, { attemptsLeft: 2, locked: false });
      const session = await sessionOf();
      assert.equal(session.stage, "AUTHENTICATED");
      assert.equal(session.faceMethod, null);
      assert.equal((await audits("FACE_VERIFY_SUCCESS")).length, 0);
      const [entry] = await audits("FACE_VERIFY_FAILURE");
      assert.deepEqual(Object.keys(entry.meta).sort(), ["attempt", "liveness", "reason", "score", "voterId"]);
      assert.equal(entry.meta.reason, "mismatch");
      assert.equal(entry.meta.attempt, 1);
      assert.equal(entry.meta.liveness, "not_reported");
      assert.ok(entry.meta.score < MATCH_THRESHOLD);
    });

    it("threshold edge: just above the threshold passes, just below it fails", async () => {
      const sent = ashaSamples();
      const above = rounded(capture(sent[0], MATCH_THRESHOLD + 0.01, 71));
      const below = rounded(capture(sent[0], MATCH_THRESHOLD - 0.01, 72));
      assert.ok(Math.max(...sent.map((s) => cosine(above, s))) > MATCH_THRESHOLD);
      assert.ok(Math.max(...sent.map((s) => cosine(below, s))) < MATCH_THRESHOLD);

      await enrol(asha, sent);
      await open();
      const cookie = await login();
      assert.deepEqual(codeOf(await attempt(cookie, below)), [403, "FACE_MISMATCH"]);
      assert.equal((await attempt(cookie, above)).status, 200);
      const failure = (await audits("FACE_VERIFY_FAILURE"))[0].meta.score;
      const success = (await audits("FACE_VERIFY_SUCCESS"))[0].meta.score;
      assert.ok(Math.abs(failure - (MATCH_THRESHOLD - 0.01)) < 1e-3 && Math.abs(success - (MATCH_THRESHOLD + 0.01)) < 1e-3, `${failure} / ${success}`);
    });

    it("the best enrolled sample decides, whichever one it is", async () => {
      const sent = ashaSamples(5);
      // Close enough to the LAST sample only: every other sample is below the threshold.
      const nearLast = rounded(capture(sent[4], MATCH_THRESHOLD + 0.03, 73));
      assert.ok(cosine(nearLast, sent[4]) > MATCH_THRESHOLD);
      for (const other of sent.slice(0, 4)) assert.ok(cosine(nearLast, other) < MATCH_THRESHOLD);
      await enrol(asha, sent);
      await open();
      const cookie = await login();
      assert.equal((await attempt(cookie, nearLast)).status, 200);
    });

    it("the descriptor may be sent at any scale: only its direction matters", async () => {
      const cookie = await enrolledAndLoggedIn();
      const rawModelOutput = capture(ASHA, 0.85, 74).map((x) => x * 31.5);
      assert.equal((await attempt(cookie, rawModelOutput)).status, 200);
    });

    it("the browser's liveness report can only refuse: it never helps a face to pass", async () => {
      const cookie = await enrolledAndLoggedIn();
      assert.deepEqual(codeOf(await attempt(cookie, rounded(STRANGER), { liveness: { passed: true, real: 1, live: 1 } })), [403, "FACE_MISMATCH"], "a 'live' stranger is still a stranger");

      const issued = (await challenge(cookie)).body.data.challenge;
      assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: ashaToday(), liveness: { passed: false } })), [422, "FACE_LIVENESS_FAILED"]);
      assert.equal((await faceStatus(cookie)).attemptsLeft, 2, "a self-reported failure is not a comparison");
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");
      assert.equal((await verify(cookie, { challenge: issued, descriptor: ashaToday(), liveness: { passed: true } })).status, 200, "the challenge was not consumed by the refused request");

      const failures = (await audits("FACE_VERIFY_FAILURE")).map((a) => [a.meta.reason, a.meta.liveness]);
      assert.deepEqual(failures, [["mismatch", "reported_pass"], ["liveness_reported_fail", undefined]]);
      assert.equal((await audits("FACE_VERIFY_SUCCESS"))[0].meta.liveness, "reported_pass");
    });

    it("a template enrolled again is the one that counts", async () => {
      await enrol(asha, ashaSamples());
      await enrol(asha, samplesOf(BHARAT).map(rounded)); // the admin corrects a wrong enrolment
      await open();
      const cookie = await login();
      assert.deepEqual(codeOf(await attempt(cookie, ashaToday())), [403, "FACE_MISMATCH"]);
      assert.equal((await attempt(cookie, rounded(capture(BHARAT, 0.85)))).status, 200);
    });

    it("a template row copied from another voter does not open (it is bound to its voter)", async () => {
      const bharat = await mkVoter({ name: "Bharat Kumar", email: "bharat@example.org" });
      await enrol(asha);
      await enrol(bharat, samplesOf(BHARAT).map(rounded));
      const templates = mongoose.connection.collection("facetemplates");
      const ashaRow = await templates.findOne({ voterId: asha._id });
      await templates.updateOne({ voterId: bharat._id }, { $set: { box: ashaRow.box } }); // an attacker with database access swaps the rows
      await open();
      const cookie = await login(bharat);
      const res = await attempt(cookie, ashaToday());
      assert.deepEqual(codeOf(res), [500, "INTERNAL_ERROR"]);
      assert.equal(res.body.error.message, "Internal server error");
      assert.equal((await sessionOf(bharat)).stage, "AUTHENTICATED");
      assert.equal((await faceStatus(cookie)).attemptsLeft, 3, "a server-side fault costs the voter nothing");
      assert.ok((await audits("FACE_VERIFY_FAILURE")).some((a) => a.meta.reason === "template_unreadable"));
    });

    it("a template made with another model or dimension must be enrolled again", async () => {
      const cookie = await enrolledAndLoggedIn();
      await mongoose.connection.collection("facetemplates").updateOne({}, { $set: { algorithm: "some-older-model" } });
      assert.deepEqual(codeOf(await attempt(cookie, ashaToday())), [409, "FACE_REENROLMENT_REQUIRED"]);
      assert.equal((await faceStatus(cookie)).attemptsLeft, 3);
      assert.equal((await adminCall("get", `/voters/${asha._id}/face`)).body.data.needsReenrolment, true);
    });

    it("the flag without a template (inconsistent data) is treated as not enrolled", async () => {
      const cookie = await enrolledAndLoggedIn();
      await mongoose.connection.collection("facetemplates").deleteMany({});
      assert.deepEqual(codeOf(await attempt(cookie, ashaToday())), [409, "FACE_NOT_ENROLLED"]);
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");
    });
  });

  // ======================================================================================== attempt limit

  describe("attempt limit and lockout", () => {
    it("three failed attempts lock the face step for the session", async () => {
      assert.equal(MAX_FAILED_ATTEMPTS, 3);
      const cookie = await enrolledAndLoggedIn();
      const left = [];
      for (let i = 0; i < 3; i++) {
        const res = await attempt(cookie, rounded(person(500 + i)));
        assert.deepEqual(codeOf(res), [403, "FACE_MISMATCH"]);
        left.push(res.body.error.details);
      }
      assert.deepEqual(left, [{ attemptsLeft: 2, locked: false }, { attemptsLeft: 1, locked: false }, { attemptsLeft: 0, locked: true }]);

      // Locked: no new challenge, no verification, not even with the right face.
      assert.deepEqual(codeOf(await challenge(cookie)), [423, "FACE_LOCKED"]);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: "c".repeat(43), descriptor: ashaToday() })), [423, "FACE_LOCKED"]);
      assert.deepEqual(await faceStatus(cookie), { enrolled: true, verified: false, attemptsLeft: 0, locked: true });

      const session = await sessionOf();
      assert.equal(session.stage, "AUTHENTICATED");
      assert.equal(session.active, true, "the session itself stays; only this step is locked");
      const row = await FaceChallenge.findOne({});
      assert.equal(row.attempts, 3);
      assert.ok(row.lockedAt instanceof Date);
      assert.equal(row.verifiedAt, null);

      const failures = await audits("FACE_VERIFY_FAILURE");
      assert.deepEqual(failures.filter((a) => a.meta.reason === "mismatch").map((a) => a.meta.attempt), [1, 2, 3]);
      assert.equal(failures.filter((a) => a.meta.reason === "locked").length, 1);
      const lockedRows = await audits("FACE_LOCKED");
      assert.equal(lockedRows.length, 1, "the lockout is audited exactly once");
      assert.deepEqual(lockedRows[0].meta, { voterId: asha.voterId, attempt: 3 });
    });

    it("the right face on the third attempt still passes", async () => {
      const cookie = await enrolledAndLoggedIn();
      await attempt(cookie, rounded(person(500)));
      await attempt(cookie, rounded(person(501)));
      assert.equal((await attempt(cookie, ashaToday())).status, 200);
      assert.equal((await sessionOf()).stage, "FACE_VERIFIED");
      assert.equal((await audits("FACE_VERIFY_SUCCESS"))[0].meta.attempt, 3);
      assert.equal((await audits("FACE_LOCKED")).length, 0);
      assert.deepEqual(await faceStatus(cookie), { enrolled: true, verified: true, attemptsLeft: 0, locked: false });
    });

    it("requests that are not a face comparison never use up an attempt", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = (await challenge(cookie)).body.data.challenge;
      for (let i = 0; i < 4; i++) {
        assert.equal((await verify(cookie, { challenge: issued, descriptor: ashaToday().slice(1) })).status, 400);
        assert.equal((await verify(cookie, { challenge: issued })).status, 400);
        assert.equal((await verify(cookie, { challenge: "w".repeat(43), descriptor: ashaToday() })).status, 409);
      }
      assert.equal((await faceStatus(cookie)).attemptsLeft, 3);
      assert.equal((await verify(cookie, { challenge: issued, descriptor: ashaToday() })).status, 200, "the challenge was not consumed by the malformed requests either");
    });

    it("the limit is enforced at the comparison itself, not only when a challenge is issued", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = (await challenge(cookie)).body.data.challenge; // valid and unused...
      await mongoose.connection.collection("facechallenges").updateOne({}, { $set: { attempts: MAX_FAILED_ATTEMPTS } }); // ...but the attempts are spent
      assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: ashaToday() })), [423, "FACE_LOCKED"]);
      const row = await FaceChallenge.findOne({});
      assert.equal(row.attempts, MAX_FAILED_ATTEMPTS, "no fourth comparison was counted");
      assert.equal(row.usedAt, null, "the challenge was not even consumed");
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");
      assert.equal((await audits("FACE_VERIFY_SUCCESS")).length, 0);
    });

    it("the limit is per session: a new login starts again with three attempts", async () => {
      const cookie = await enrolledAndLoggedIn();
      for (let i = 0; i < 3; i++) await attempt(cookie, rounded(person(500 + i)));
      assert.deepEqual(codeOf(await challenge(cookie)), [423, "FACE_LOCKED"]);
      await voterCall("post", "/auth/logout", cookie);
      const again = await login();
      assert.equal((await faceStatus(again)).attemptsLeft, 3);
      assert.equal((await attempt(again, ashaToday())).status, 200);
      assert.equal(await FaceChallenge.countDocuments({}), 2, "one row per session");
    });
  });

  // ========================================================================================== concurrency

  describe("concurrency", () => {
    it("parallel verifies with the same challenge: exactly one is processed and exactly one transition happens", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = (await challenge(cookie)).body.data.challenge;
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => verify(cookie, { challenge: issued, descriptor: ashaToday(80 + i) })));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) assert.ok(["FACE_CHALLENGE_INVALID", "STAGE_REQUIRED"].includes(r.body.error.code), r.body.error.code);
      assert.equal((await sessionOf()).stage, "FACE_VERIFIED");
      assert.equal((await audits("FACE_VERIFY_SUCCESS")).length, 1);
      assert.equal((await FaceChallenge.findOne({})).attempts, 1);
    });

    it("parallel wrong faces with one challenge cost exactly one attempt", async () => {
      const cookie = await enrolledAndLoggedIn();
      const principal = await voterAuth.authenticate(cookie.split("=")[1]);
      const issued = (await challenge(cookie)).body.data.challenge;
      const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => faceService.verify({ session: principal, challenge: issued, descriptor: rounded(person(600 + i)) }, { ip: "127.0.0.1", requestId: `r${i}` })));
      const processed = outcomes.filter((o) => o.status === "fulfilled");
      assert.equal(processed.length, 1);
      assert.deepEqual(processed[0].value, { verified: false, attemptsLeft: 2, locked: false });
      for (const o of outcomes.filter((x) => x.status === "rejected")) assert.equal(o.reason.code, "FACE_CHALLENGE_INVALID");
      assert.equal((await FaceChallenge.findOne({})).attempts, 1);
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");
    });

    it("no interleaving of challenges and wrong faces ever allows more than three comparisons", async () => {
      const cookie = await enrolledAndLoggedIn();
      const round = async (i) => {
        const issued = await challenge(cookie);
        if (issued.status !== 200) return issued.status;
        return (await verify(cookie, { challenge: issued.body.data.challenge, descriptor: rounded(person(700 + i)) })).status;
      };
      const statuses = await Promise.all(Array.from({ length: 9 }, (_, i) => round(i)));
      const compared = (await audits("FACE_VERIFY_FAILURE")).filter((a) => a.meta.reason === "mismatch").length;
      assert.ok(compared <= MAX_FAILED_ATTEMPTS, `${compared} comparisons`);
      assert.ok((await FaceChallenge.findOne({})).attempts <= MAX_FAILED_ATTEMPTS);
      assert.equal(statuses.filter((s) => s === 200).length, 0);
      assert.equal((await sessionOf()).stage, "AUTHENTICATED");
    });

    it("if the session leaves AUTHENTICATED while the face is compared, nothing is granted", async () => {
      const cookie = await enrolledAndLoggedIn();
      const principal = await voterAuth.authenticate(cookie.split("=")[1]);
      const raced = createFaceService({ Voter, VoterSession, FaceTemplate, FaceChallenge, authService: { transitionStage: async () => false }, chain, audit: w.audit, templateKey: KEY, now: w.clock.now });
      const issued = (await challenge(cookie)).body.data.challenge;
      await assert.rejects(raced.verify({ session: principal, challenge: issued, descriptor: ashaToday() }, { ip: "127.0.0.1", requestId: "r" }), (err) => err.status === 409 && err.code === "STAGE_REQUIRED");
      const session = await sessionOf();
      assert.equal(session.stage, "AUTHENTICATED");
      assert.equal(session.faceMethod, null);
      assert.equal((await audits("FACE_VERIFY_SUCCESS")).length, 0);
      assert.ok((await audits("FACE_VERIFY_FAILURE")).some((a) => a.meta.reason === "stage_lost"));
    });
  });

  // ================================================================================ stage transition + TTL

  describe("stage transition and its lifetime", () => {
    it("FACE_VERIFIED lasts 3 minutes, even with activity", async () => {
      assert.equal(FACE_VERIFIED_TTL_MS, 180_000);
      const cookie = await enrolledAndLoggedIn();
      assert.equal((await attempt(cookie, ashaToday())).status, 200);
      const rawToken = cookie.split("=")[1];
      w.clock.advance(100);
      await voterAuth.authenticate(rawToken); // a meaningful action keeps the idle timer away
      w.clock.advance(79); // 179 seconds after verification
      const alive = await voterCall("get", "/status", cookie);
      assert.equal(alive.status, 200);
      assert.equal(alive.body.data.stage, "FACE_VERIFIED");
      w.clock.advance(2); // 181 seconds
      assert.deepEqual(codeOf(await voterCall("get", "/status", cookie)), [401, "SESSION_EXPIRED"]);
      assert.equal((await VoterSession.findOne({ voterId: asha._id })).active, false);
    });

    it("once verified, the face routes are closed for that session", async () => {
      const cookie = await enrolledAndLoggedIn();
      assert.equal((await attempt(cookie, ashaToday())).status, 200);
      assert.deepEqual(codeOf(await challenge(cookie)), [409, "STAGE_REQUIRED"]);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: "c".repeat(43), descriptor: ashaToday() })), [409, "STAGE_REQUIRED"]);
      assert.equal((await audits("FACE_VERIFY_SUCCESS")).length, 1);
    });

    it("the face step itself must finish inside the AUTHENTICATED window (5 minutes)", async () => {
      const cookie = await enrolledAndLoggedIn();
      const rawToken = cookie.split("=")[1];
      for (let i = 0; i < 4; i++) {
        w.clock.advance(70);
        await voterAuth.authenticate(rawToken);
      }
      w.clock.advance(21); // 301 seconds after login
      assert.deepEqual(codeOf(await challenge(cookie)), [401, "SESSION_EXPIRED"]);
    });

    it("a logged-out or revoked session cannot verify", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = (await challenge(cookie)).body.data.challenge;
      await voterCall("post", "/auth/logout", cookie);
      assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: ashaToday() })), [401, "UNAUTHENTICATED"]);
      assert.equal((await VoterSession.findOne({ voterId: asha._id })).stage, "AUTHENTICATED");
    });

    it("verification is possible only while the election is Open", async () => {
      await enrol(asha);
      await open();
      const cookie = await login();
      const issued = (await challenge(cookie)).body.data.challenge;
      await close();
      assert.deepEqual(codeOf(await verify(cookie, { challenge: issued, descriptor: ashaToday() })), [409, "ELECTION_CLOSED"]);
      assert.equal((await VoterSession.findOne({ voterId: asha._id })).stage, "AUTHENTICATED");
    });

    it("a suspended voter cannot verify", async () => {
      const cookie = await enrolledAndLoggedIn();
      const issued = (await challenge(cookie)).body.data.challenge;
      await Voter.updateOne({ _id: asha._id }, { status: "SUSPENDED" });
      assert.equal((await verify(cookie, { challenge: issued, descriptor: ashaToday() })).status, 401);
      assert.equal((await VoterSession.findOne({ voterId: asha._id })).stage, "AUTHENTICATED");
    });
  });

  // =============================================================================================== privacy

  describe("privacy", () => {
    it("no descriptor, template, key or challenge appears in any response, log line or audit row", async () => {
      const sent = ashaSamples();
      const probes = [rounded(STRANGER), ashaToday()];
      const responses = [];
      const keep = async (promise) => {
        const res = await promise;
        responses.push(res.body);
        return res;
      };

      await keep(enrol(asha, sent));
      await keep(enrol(asha, [...sent.slice(0, 2), rounded(BHARAT)])); // refused: inconsistent
      await keep(adminCall("get", `/voters/${asha._id}/face`));
      await open();
      const cookie = await login();
      await keep(voterCall("get", "/face/status", cookie));
      const first = (await challenge(cookie)).body.data.challenge; // the ONE response that must carry a challenge
      await keep(verify(cookie, { challenge: first, descriptor: probes[0] }));
      await keep(verify(cookie, { challenge: first, descriptor: probes[1] })); // replay: refused
      await keep(verify(cookie, { challenge: "q".repeat(43), descriptor: probes[1].slice(1) })); // malformed
      const second = (await challenge(cookie)).body.data.challenge;
      await keep(verify(cookie, { challenge: second, descriptor: probes[1], liveness: { passed: true } }));
      await keep(voterCall("get", "/status", cookie));
      await keep(voterCall("get", "/face/status", cookie));

      const db = mongoose.connection;
      const template = await db.collection("facetemplates").findOne({});
      const challengeRow = await db.collection("facechallenges").findOne({});
      const auditText = JSON.stringify(await db.collection("auditlogs").find({}).toArray());
      const responseText = JSON.stringify(responses);
      const logText = w.memory.lines.join("");
      const everything = responseText + auditText + logText;

      const numbers = [...sent.flatMap((s) => [s[0], s[100], s[511]]), ...probes.flatMap((p) => [p[0], p[100], p[511]])].map(String);
      for (const n of numbers) assert.ok(!everything.includes(n), `descriptor value ${n} leaked`);
      for (const secret of [template.box.ct, template.box.ct.slice(0, 32), template.box.iv, template.box.tag, KEY.toString("hex"), KEY.toString("base64"), first, second, challengeRow.tokenHash, sha256(first)]) {
        assert.ok(!everything.includes(secret), `leaked ${secret.slice(0, 10)}...`);
      }
      assert.ok(!/"box"|"ct"|tokenHash/.test(responseText + auditText));

      // What the database holds: ciphertext for the template, a hash for the challenge, never the plain values.
      const stored = JSON.stringify([template, challengeRow, await db.collection("votersessions").find({}).toArray(), await db.collection("voters_v2").find({}).toArray()]);
      for (const n of numbers) assert.ok(!stored.includes(n), `descriptor value ${n} is stored in clear`);
      for (const c of [first, second]) assert.ok(!stored.includes(c), "a challenge is stored in clear");

      // Face audit rows carry only small, whitelisted facts.
      const allowed = new Set(["voterDbId", "voterId", "reason", "attempt", "score", "sampleCount", "liveness"]);
      const faceAudit = (await audits()).filter((a) => a.action.startsWith("FACE_"));
      assert.deepEqual([...new Set(faceAudit.map((a) => a.action))].sort(), ["FACE_ENROLLED", "FACE_ENROLMENT_REJECTED", "FACE_VERIFY_FAILURE", "FACE_VERIFY_SUCCESS"]);
      for (const entry of faceAudit) for (const key of Object.keys(entry.meta)) assert.ok(allowed.has(key), `${entry.action}.${key}`);

      // Request log lines contain the path only.
      for (const line of w.memory.lines.map((l) => JSON.parse(l)).filter((l) => l.msg === "request")) assert.deepEqual(Object.keys(line).sort(), ["durationMs", "level", "method", "msg", "path", "requestId", "status", "time"]);
    });

    it("the voter and admin views of a voter gain nothing but the existing faceEnrolled flag", async () => {
      await enrol(asha);
      await open();
      const res = await request(voterApp).post("/api/v1/voter/auth/login").send({ identifier: asha.voterId, password: PW });
      assert.deepEqual(res.body.data.voter, { voterId: asha.voterId, name: "Asha Rao", constituencyCode: "KA-BLR", faceEnrolled: true });
    });
  });
});
