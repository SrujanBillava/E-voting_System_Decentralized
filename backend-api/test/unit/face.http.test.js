import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { DESCRIPTOR_LENGTH } from "../../src/biometrics/constants.js";
import { loadEnv } from "../../src/config/env.js";
import { AppError } from "../../src/utils/errors.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { validEnv } from "../helpers/env.js";
import { person, rounded, samplesOf } from "../helpers/face.js";

// Offline: the HTTP layer of the face routes with stand-in services (no MongoDB, no chain).
// The real behaviour behind these routes is tested in test/chain/face.test.js.

const COOKIE = "vc_voter=" + "s".repeat(43);
const ADMIN = { Authorization: "Bearer admin.token-1" };
const VOTER_ID = "64b7f0c2a1d3e4f5a6b7c8d9";
const CHALLENGE = "c".repeat(43);
const face = rounded(person(21));

function build({ stage = "AUTHENTICATED", faceService: overrides = {}, withFace = true, faceRateLimit = { windowMs: 60_000, limit: 100_000 } } = {}) {
  const config = loadEnv(validEnv());
  const memory = createMemoryLogger();
  const calls = { authenticate: [], face: [] };
  const principal = { sessionId: "a".repeat(24), voterDbId: VOTER_ID, stage, stageExpiresAt: new Date(0), sessionExpiresAt: new Date(0), voter: { voterId: "VC-ABCDEFGHJK", name: "Asha Rao", constituencyCode: "KA-BLR", faceEnrolled: true }, electionPhase: "Open" };
  const voterAuth = {
    async authenticate(token, options) {
      calls.authenticate.push(options);
      if (token !== "s".repeat(43)) throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
      return principal;
    },
  };
  const adminAuth = {
    async authenticate(token) {
      if (token !== "admin.token-1") throw new AppError(401, "UNAUTHENTICATED", "Authentication required");
      return { adminId: "b".repeat(24), sessionId: "c".repeat(24), admin: { id: "b".repeat(24) } };
    },
  };
  const record = (name, result) => async (...args) => {
    calls.face.push([name, ...args]);
    return typeof result === "function" ? result(...args) : result;
  };
  const faceService = {
    status: record("status", { enrolled: true, verified: false, attemptsLeft: 3, locked: false }),
    issueChallenge: record("issueChallenge", { challenge: CHALLENGE, action: "BLINK", expiresAt: new Date(30_000), attemptsLeft: 3 }),
    verify: record("verify", { verified: true, stage: "FACE_VERIFIED", stageExpiresAt: new Date(180_000) }),
    enroll: record("enroll", { voter: { id: VOTER_ID, voterId: "VC-ABCDEFGHJK", faceEnrolled: true }, face: { sampleCount: 3, enrolledAt: new Date(0), algorithm: "x" } }),
    remove: record("remove", undefined),
    info: record("info", { voterId: "VC-ABCDEFGHJK", enrolled: true, sampleCount: 3, enrolledAt: new Date(0), algorithm: "x", needsReenrolment: false }),
    ...Object.fromEntries(Object.entries(overrides).map(([name, fn]) => [name, record(name, fn)])),
  };
  const app = createApp({
    config,
    logger: memory.logger,
    healthService: { getPublicHealth: async () => ({ status: "ok" }) },
    admin: { authService: adminAuth, electionService: {}, ...(withFace ? { faceService } : {}) },
    voter: { authService: voterAuth, ...(withFace ? { faceService, faceRateLimit } : {}) },
  });
  const voter = (method, path) => request(app)[method](`/api/v1/voter/face${path}`).set("Cookie", COOKIE);
  const admin = (method, path) => request(app)[method](`/api/v1/admin${path}`).set(ADMIN);
  return { app, calls, memory, voter, admin };
}

const error = (res) => [res.status, res.body.error?.code];

describe("face http: mounting", () => {
  it("the routes exist only when a face service is wired", async () => {
    const off = build({ withFace: false });
    assert.equal((await off.voter("post", "/challenge")).status, 404);
    assert.equal((await off.voter("post", "/verify").send({})).status, 404);
    assert.equal((await off.admin("put", `/voters/${VOTER_ID}/face`).send({})).status, 404);
    const on = build();
    assert.equal((await on.voter("post", "/challenge")).status, 200);
  });

  it("only GET /status, POST /challenge and POST /verify exist on the voter side", async () => {
    const { voter } = build();
    for (const [method, path] of [["get", "/challenge"], ["get", "/verify"], ["post", "/status"], ["put", "/verify"], ["post", "/enrol"], ["delete", "/challenge"], ["post", "/"]]) {
      assert.equal((await voter(method, path)).status, 404, `${method} ${path}`);
    }
  });
});

describe("face http: voter session and stage", () => {
  it("every voter face route needs a valid session cookie", async () => {
    const { app, calls } = build();
    for (const [method, path] of [["get", "/status"], ["post", "/challenge"], ["post", "/verify"]]) {
      assert.deepEqual(error(await request(app)[method](`/api/v1/voter/face${path}`)), [401, "UNAUTHENTICATED"], path);
      assert.deepEqual(error(await request(app)[method](`/api/v1/voter/face${path}`).set("Cookie", "vc_voter=" + "x".repeat(43))), [401, "UNAUTHENTICATED"], path);
    }
    assert.equal(calls.face.length, 0);
  });

  it("challenge and verify are refused unless the session is AUTHENTICATED; the service is never reached", async () => {
    for (const stage of ["FACE_VERIFIED", "ELIGIBLE", "AUTH_ISSUED", "SUBMITTED", "COMPLETED"]) {
      const { voter, calls } = build({ stage });
      assert.deepEqual(error(await voter("post", "/challenge")), [409, "STAGE_REQUIRED"], stage);
      assert.deepEqual(error(await voter("post", "/verify").send({ challenge: CHALLENGE, descriptor: face })), [409, "STAGE_REQUIRED"], stage);
      assert.equal((await voter("get", "/status")).status, 200, "status can still be read");
      assert.deepEqual(calls.face.map((c) => c[0]), ["status"]);
    }
  });

  it("status is passive (must not extend the idle window); challenge and verify are real activity", async () => {
    const { voter, calls } = build();
    await voter("get", "/status");
    await voter("post", "/challenge");
    await voter("post", "/verify").send({ challenge: CHALLENGE, descriptor: face });
    assert.deepEqual(calls.authenticate.map((o) => o.touch), [false, true, true]);
  });
});

describe("face http: challenge", () => {
  it("returns what the service issued and accepts no input at all", async () => {
    const { voter, calls } = build();
    const res = await voter("post", "/challenge");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.data).sort(), ["action", "attemptsLeft", "challenge", "expiresAt"]);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal((await voter("post", "/challenge").send({})).status, 200);
    assert.deepEqual(error(await voter("post", "/challenge").send({ action: "BLINK" })), [400, "VALIDATION_FAILED"]);
    assert.deepEqual(error(await voter("post", "/challenge?sessionId=abc")), [400, "VALIDATION_FAILED"]);
    assert.equal(calls.face.filter((c) => c[0] === "issueChallenge").length, 2);
  });
});

describe("face http: verify", () => {
  it("a match answers 200 with the new stage and nothing else", async () => {
    const { voter, calls } = build();
    const res = await voter("post", "/verify").send({ challenge: CHALLENGE, descriptor: face, liveness: { passed: true, real: 0.8, live: 0.9 } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.data).sort(), ["stage", "stageExpiresAt"]);
    assert.equal(res.body.data.stage, "FACE_VERIFIED");
    const [, args, ctx] = calls.face.find((c) => c[0] === "verify");
    assert.equal(args.challenge, CHALLENGE);
    assert.equal(args.descriptor.length, DESCRIPTOR_LENGTH);
    assert.deepEqual(args.liveness, { passed: true, real: 0.8, live: 0.9 });
    assert.equal(args.session.voterDbId, VOTER_ID, "identity comes from the session, never from the request");
    assert.deepEqual(Object.keys(ctx).sort(), ["ip", "requestId"]);
  });

  it("a mismatch answers 403 FACE_MISMATCH with the attempts that are left", async () => {
    const { voter } = build({ faceService: { verify: () => ({ verified: false, attemptsLeft: 2, locked: false }) } });
    const res = await voter("post", "/verify").send({ challenge: CHALLENGE, descriptor: face });
    assert.equal(res.status, 403);
    assert.deepEqual(Object.keys(res.body), ["error"]);
    assert.equal(res.body.error.code, "FACE_MISMATCH");
    assert.deepEqual(res.body.error.details, { attemptsLeft: 2, locked: false });
    assert.equal(res.body.error.requestId, res.headers["x-request-id"]);
  });

  it("rejects malformed bodies with field names only, and never reaches the service", async () => {
    const { voter, calls } = build();
    const tooShort = face.slice(1);
    const tooLong = [...face, 0.1];
    const withText = [...face.slice(1), "0.5"];
    const withNull = [...face.slice(1), null];
    const nested = [...face.slice(1), [0.5]];
    const huge = [...face.slice(1), 1e6];
    const cases = [
      [{}, "challenge"],
      [{ challenge: CHALLENGE }, "descriptor"],
      [{ descriptor: face }, "challenge"],
      [{ challenge: CHALLENGE, descriptor: tooShort }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: tooLong }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: Array(1024).fill(0.1) }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: withText }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: withNull }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: nested }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: huge }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: "not an array" }, "descriptor"],
      [{ challenge: CHALLENGE, descriptor: { 0: 0.1, length: DESCRIPTOR_LENGTH } }, "descriptor"],
      [{ challenge: { $ne: null }, descriptor: face }, "challenge"],
      [{ challenge: "short", descriptor: face }, "challenge"],
      [{ challenge: CHALLENGE + "!", descriptor: face }, "challenge"],
      [{ challenge: CHALLENGE, descriptor: face, voterId: "VC-AAAAAAAAAA" }, "voterId"],
      [{ challenge: CHALLENGE, descriptor: face, liveness: { passed: "yes" } }, "liveness.passed"],
      [{ challenge: CHALLENGE, descriptor: face, liveness: { passed: true, real: 1.5 } }, "liveness.real"],
      [{ challenge: CHALLENGE, descriptor: face, liveness: { passed: true, score: 1 } }, "score"],
    ];
    for (const [body, field] of cases) {
      const res = await voter("post", "/verify").send(body);
      assert.deepEqual(error(res), [400, "VALIDATION_FAILED"], JSON.stringify(body).slice(0, 80));
      assert.ok(res.body.error.message.includes(field), `${res.body.error.message} should name ${field}`);
      assert.ok(res.body.error.message.length < 120, "one field name, not one entry per number");
      assert.ok(!/0\.\d{4}/.test(res.body.error.message), "no descriptor values in the message");
    }
    assert.deepEqual(error(await voter("post", "/verify?debug=1").send({ challenge: CHALLENGE, descriptor: face })), [400, "VALIDATION_FAILED"]);
    assert.equal(calls.face.length, 0);
  });

  it("a number written as 1e999 in the raw JSON (which parses to Infinity) is rejected", async () => {
    const { voter, calls } = build();
    const raw = JSON.stringify({ challenge: CHALLENGE, descriptor: face }).replace(/\[[^,]+,/, "[1e999,");
    const res = await voter("post", "/verify").set("Content-Type", "application/json").send(raw);
    assert.deepEqual(error(res), [400, "VALIDATION_FAILED"]);
    assert.equal(calls.face.length, 0);
  });

  it("errors raised by the service keep their own code; unexpected ones become a generic 500", async () => {
    const thrown = [
      [new AppError(423, "FACE_LOCKED", "locked"), [423, "FACE_LOCKED"]],
      [new AppError(409, "FACE_NOT_ENROLLED", "no"), [409, "FACE_NOT_ENROLLED"]],
      [new AppError(409, "FACE_CHALLENGE_INVALID", "no"), [409, "FACE_CHALLENGE_INVALID"]],
      [new Error("face template could not be decrypted"), [500, "INTERNAL_ERROR"]],
    ];
    for (const [err, expected] of thrown) {
      const { voter } = build({ faceService: { verify: () => Promise.reject(err) } });
      const res = await voter("post", "/verify").send({ challenge: CHALLENGE, descriptor: face });
      assert.deepEqual(error(res), expected);
      if (expected[0] === 500) assert.equal(res.body.error.message, "Internal server error");
    }
  });
});

describe("face http: rate limit", () => {
  it("challenge and verify share one limit per address; status is not limited", async () => {
    const { voter, calls } = build({ faceRateLimit: { windowMs: 60_000, limit: 4 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await voter("post", "/challenge")).status);
    for (let i = 0; i < 3; i++) statuses.push((await voter("post", "/verify").send({ challenge: CHALLENGE, descriptor: face })).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
    const limited = await voter("post", "/challenge");
    assert.deepEqual(error(limited), [429, "RATE_LIMITED"]);
    assert.equal(calls.face.length, 4, "a limited request never reaches the service");
    for (let i = 0; i < 6; i++) assert.equal((await voter("get", "/status")).status, 200);
  });

  it("the default allows a normal face step many times over", async () => {
    const config = loadEnv(validEnv());
    const app = createApp({
      config,
      logger: createMemoryLogger().logger,
      healthService: { getPublicHealth: async () => ({ status: "ok" }) },
      voter: { authService: { authenticate: async () => { throw new AppError(401, "UNAUTHENTICATED", "Authentication required"); } }, faceService: {} },
    });
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await request(app).post("/api/v1/voter/face/challenge")).status);
    assert.deepEqual([...new Set(statuses.slice(0, 60))], [401]);
    assert.equal(statuses[60], 429);
  });
});

describe("face http: admin enrolment", () => {
  const body = () => ({ descriptors: samplesOf(person(31), 3).map(rounded) });

  it("every enrolment route needs an admin bearer token", async () => {
    const { app, calls } = build();
    for (const [method, send] of [["get"], ["put", body()], ["delete"]]) {
      const anonymous = request(app)[method](`/api/v1/admin/voters/${VOTER_ID}/face`);
      assert.deepEqual(error(await (send ? anonymous.send(send) : anonymous)), [401, "UNAUTHENTICATED"], method);
      const wrong = request(app)[method](`/api/v1/admin/voters/${VOTER_ID}/face`).set("Authorization", "Bearer someone.else");
      assert.deepEqual(error(await (send ? wrong.send(send) : wrong)), [401, "UNAUTHENTICATED"], method);
    }
    // A voter session cookie is not an admin credential.
    assert.deepEqual(error(await request(app).put(`/api/v1/admin/voters/${VOTER_ID}/face`).set("Cookie", COOKIE).send(body())), [401, "UNAUTHENTICATED"]);
    assert.equal(calls.face.length, 0);
  });

  it("PUT stores the samples for the voter in the URL, on behalf of the admin in the token", async () => {
    const { admin, calls } = build();
    const res = await admin("put", `/voters/${VOTER_ID}/face`).send(body());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [, args, ctx] = calls.face.find((c) => c[0] === "enroll");
    assert.equal(args.voterDbId, VOTER_ID);
    assert.equal(args.descriptors.length, 3);
    assert.equal(ctx.adminId, "b".repeat(24));
  });

  it("accepts 3, 4 and 5 samples and refuses 0, 1, 2 and 6", async () => {
    const { admin } = build();
    for (const count of [3, 4, 5]) assert.equal((await admin("put", `/voters/${VOTER_ID}/face`).send({ descriptors: samplesOf(person(31), count).map(rounded) })).status, 200, `${count}`);
    for (const count of [0, 1, 2, 6]) assert.deepEqual(error(await admin("put", `/voters/${VOTER_ID}/face`).send({ descriptors: samplesOf(person(31), count).map(rounded) })), [400, "VALIDATION_FAILED"], `${count}`);
  });

  it("validates the dimension of every sample, the id, and refuses extra fields", async () => {
    const { admin, calls } = build();
    const good = body().descriptors;
    const cases = [
      [`/voters/${VOTER_ID}/face`, {}],
      [`/voters/${VOTER_ID}/face`, { descriptors: "x" }],
      [`/voters/${VOTER_ID}/face`, { descriptors: [good[0], good[1], good[2].slice(1)] }],
      [`/voters/${VOTER_ID}/face`, { descriptors: [good[0], good[1], Array(1024).fill(0.1)] }],
      [`/voters/${VOTER_ID}/face`, { descriptors: [good[0], good[1], null] }],
      [`/voters/${VOTER_ID}/face`, { descriptors: good, faceEnrolled: true }],
      [`/voters/${VOTER_ID}/face`, { descriptors: good, voterId: "VC-AAAAAAAAAA" }],
      [`/voters/not-an-id/face`, { descriptors: good }],
      [`/voters/${VOTER_ID}0/face`, { descriptors: good }],
    ];
    for (const [path, payload] of cases) assert.deepEqual(error(await admin("put", path).send(payload)), [400, "VALIDATION_FAILED"], path + JSON.stringify(payload).slice(0, 60));
    assert.equal(calls.face.length, 0);
  });

  it("5 samples fit in the 100 kb JSON body limit, rounded or at full precision", async () => {
    const { admin } = build();
    const full = samplesOf(person(31), 5);
    for (const descriptors of [full.map(rounded), full]) {
      const size = Buffer.byteLength(JSON.stringify({ descriptors }));
      assert.ok(size < 100 * 1024, `${size} bytes`);
      assert.equal((await admin("put", `/voters/${VOTER_ID}/face`).send({ descriptors })).status, 200);
    }
  });

  it("GET returns facts about the enrolment and DELETE answers 204", async () => {
    const { admin, calls } = build();
    const info = await admin("get", `/voters/${VOTER_ID}/face`);
    assert.equal(info.status, 200);
    assert.deepEqual(Object.keys(info.body.data).sort(), ["algorithm", "enrolled", "enrolledAt", "needsReenrolment", "sampleCount", "voterId"]);
    const gone = await admin("delete", `/voters/${VOTER_ID}/face`);
    assert.equal(gone.status, 204);
    assert.deepEqual(calls.face.map((c) => c[0]), ["info", "remove"]);
    assert.deepEqual(error(await admin("delete", "/voters/zzz/face")), [400, "VALIDATION_FAILED"]);
  });

  it("the existing admin routes still answer", async () => {
    const { app } = build();
    assert.equal((await request(app).get("/api/v1/admin/auth/me")).status, 401);
    assert.equal((await request(app).get("/api/v1/admin/auth/me").set(ADMIN)).status, 200);
  });
});

describe("face http: nothing biometric is logged", () => {
  it("no log line contains the challenge, a descriptor value or a request body", async () => {
    const marker = 0.123457;
    const descriptor = [...face.slice(1), marker];
    const samples = samplesOf(person(31), 3).map((s) => [...rounded(s).slice(1), marker]);
    const failing = build({ faceService: { verify: () => Promise.reject(new Error("unexpected")) } });
    for (const world of [build(), build({ faceService: { verify: () => ({ verified: false, attemptsLeft: 1, locked: false }) } }), failing]) {
      await world.voter("post", "/challenge");
      await world.voter("post", "/verify").send({ challenge: CHALLENGE, descriptor });
      await world.voter("post", "/verify").send({ challenge: CHALLENGE, descriptor: descriptor.slice(2) });
      await world.admin("put", `/voters/${VOTER_ID}/face`).send({ descriptors: samples });
      await world.admin("put", `/voters/${VOTER_ID}/face`).send({ descriptors: samples.slice(1) });
      const text = world.memory.lines.join("");
      assert.ok(world.memory.lines.length >= 5, "the requests were logged");
      assert.ok(!text.includes(CHALLENGE), "challenge");
      assert.ok(!text.includes(String(marker)), "descriptor value");
      assert.ok(!text.includes(String(face[5])), "descriptor value");
      assert.ok(!/descriptor/i.test(text) || /REDACTED/.test(text), "no descriptor field is ever written in clear");
      for (const line of world.memory.lines.map((l) => JSON.parse(l))) assert.ok(line.msg !== "request" || Object.keys(line).sort().join() === "durationMs,level,method,msg,path,requestId,status,time");
    }
    assert.ok(failing.memory.lines.some((l) => JSON.parse(l).msg === "unhandled error"));
  });
});
