import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { generateSync } from "otplib";
import mongoose from "mongoose";
import request from "supertest";
import { bootstrap } from "../../src/server.js";
import { describeConfig, loadEnv, secretValuesOf } from "../../src/config/env.js";
import { Admin } from "../../src/models/Admin.js";
import { AdminSession } from "../../src/models/AdminSession.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { FaceChallenge } from "../../src/models/FaceChallenge.js";
import { FaceTemplate } from "../../src/models/FaceTemplate.js";
import { Voter } from "../../src/models/Voter.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { sealTemplate } from "../../src/biometrics/templateBox.js";
import { createAdminAuthService } from "../../src/services/adminAuth.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { assertPristineLocalChain, localChainEnv, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { capture, person, rounded, samplesOf } from "../helpers/face.js";

// ADVERSARIAL checks of the REAL production wiring: src/server.js bootstrap() (real config, real scrubbing logger, real
// rate limits, real admin/voter/face routers in the real mount order). One bootstrap for the whole file, so the production
// rate limits (60 face calls per minute and address, 10 voter logins per 15 minutes) apply exactly as deployed: keep the
// number of calls in the tests before the last one small. Needs the local chain AND a disposable MongoDB (MONGODB_TEST_URI).
const uri = process.env.MONGODB_TEST_URI;
const PW = "a long voter password 123";
const ADMIN_PW = "correct horse battery staple";

const ASHA = person(1);
const BHARAT = person(2);
const CAROL = person(3);
const todayOf = (base, seed) => rounded(capture(base, 0.85, seed));

describe("ADVERSARIAL biometrics: the production wiring of src/server.js (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, ready, app, memory, config, token, env, totpSecret;
  let asha, bharat, carol; // { id, voterId }

  const adminCall = (method, path, body, tok = token) => {
    const r = request(app)[method](`/api/v1/admin${path}`);
    if (tok) r.set("Authorization", `Bearer ${tok}`);
    return body === undefined ? r : r.send(body);
  };
  const cookieOf = (res) => (res.headers["set-cookie"] ?? []).find((c) => /vc_voter=/.test(c))?.split(";")[0];
  const login = async (voter) => {
    const res = await request(app).post("/api/v1/voter/auth/login").send({ identifier: voter.voterId, password: PW });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return cookieOf(res);
  };
  const voterCall = (method, path, cookie) => request(app)[method](`/api/v1/voter${path}`).set("Cookie", cookie ?? "");
  const issue = async (cookie) => {
    const res = await voterCall("post", "/face/challenge", cookie);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data.challenge;
  };
  const verify = async (cookie, descriptor, extra = {}) => voterCall("post", "/face/verify", cookie).send({ challenge: await issue(cookie), descriptor, ...extra });
  const codeOf = (res) => [res.status, res.body.error?.code];

  before(async () => {
    chain = localServices();
    await assertPristineLocalChain(chain);
    snap = await snapshot(chain.provider);
    env = localChainEnv({ MONGODB_URI: uri, NODE_ENV: "test" });
    config = loadEnv(env);
    memory = createMemoryLogger({ level: "debug", secrets: secretValuesOf(config) }); // exactly what main() builds, but in memory
    ready = await bootstrap({ env, deps: { logger: memory.logger } });
    app = ready.app;
    await mongoose.connection.dropDatabase();
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), FaceTemplate.syncIndexes(), FaceChallenge.syncIndexes(), Admin.syncIndexes(), AdminSession.syncIndexes(), AuditLog.syncIndexes()]);

    // An admin, through the real login route (password + TOTP).
    const service = createAdminAuthService({ Admin, AdminSession, audit: { record: async () => {} }, secrets: config.secrets, bcryptCost: 4 });
    ({ totpSecret } = await service.createAdmin({ email: "root@example.org", name: "Root", password: ADMIN_PW }));
    const res = await request(app).post("/api/v1/admin/auth/login").send({ email: "root@example.org", password: ADMIN_PW, totp: generateSync({ secret: totpSecret }) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    token = res.body.data.accessToken;

    // Three voters through the real admin API, three enrolments, then the election is opened.
    const mk = async (name, email, base) => {
      const created = await adminCall("post", "/voters", { name, email, password: PW, constituencyCode: "KA-BLR" });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const voter = created.body.data.voter;
      const enrolled = await adminCall("put", `/voters/${voter.id}/face`, { descriptors: samplesOf(base, 3).map(rounded) });
      assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
      return voter;
    };
    asha = await mk("Asha", "asha@example.org", ASHA);
    bharat = await mk("Bharat", "bharat@example.org", BHARAT);
    carol = await mk("Carol", "carol@example.org", CAROL);
  });
  after(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await ready?.close();
    if (chain) await revertTo(chain.provider, snap);
    chain?.destroy();
  });

  it("the election CANNOT be opened while an enrolled voter's template is unreadable with the configured key (enrolment cannot be repaired once Open)", async () => {
    // Carol's template was sealed with some other key (what a rotated, mistyped or lost FACE_TEMPLATE_ENCRYPTION_KEY looks like).
    const coll = mongoose.connection.collection("facetemplates");
    const row = await coll.findOne({ voterId: new mongoose.Types.ObjectId(carol.id) });
    await coll.updateOne({ _id: row._id }, { $set: { box: sealTemplate(Buffer.alloc(32, 7), carol.id, samplesOf(CAROL, 3)) } });
    await Admin.updateMany({}, { $set: { lastUsedTotpStep: null } }); // allow a fresh step-up code inside the same 30 s window
    const res = await adminCall("post", "/election/open", { confirmation: "OPEN ELECTION", totp: generateSync({ secret: totpSecret }) });
    const phase = Number(await chain.contract.phase());
    await coll.updateOne({ _id: row._id }, { $set: { box: row.box } }); // put the genuine template back for the other tests
    if (phase === 0) await (await chain.contract.connect(chain.signers.owner).openElection()).wait();
    assert.ok(phase === 0 && res.status === 409 && res.body?.error?.code === "PREFLIGHT_FAILED", `opening was ${res.status} ${res.body?.error?.code ?? "accepted"}`);
    assert.match(res.body.error.message, /face\.templates/);
  });

  it("the merged app boots with the face service wired on BOTH sides, and every face route is guarded", async () => {
    for (const [method, path] of [["get", "/face/status"], ["post", "/face/challenge"], ["post", "/face/verify"]]) assert.deepEqual(codeOf(await voterCall(method, path, "")), [401, "UNAUTHENTICATED"], path);
    for (const method of ["get", "put", "delete"]) assert.deepEqual(codeOf(await adminCall(method, `/voters/${asha.id}/face`, undefined, null)), [401, "UNAUTHENTICATED"], method);
    assert.equal((await adminCall("get", `/voters/${asha.id}/face`)).body.data.enrolled, true);
    const election = (await adminCall("get", "/election")).body.data;
    assert.deepEqual(election.voters, { registered: 3, faceEnrolled: 3 });
    // the credentials and key never reach the config object that is logged or serialised
    assert.ok(!JSON.stringify(ready.config).includes(config.secrets.faceTemplateKey.toString("hex")));
    assert.ok(!JSON.stringify(describeConfig(ready.config)).includes(config.secrets.faceTemplateKey.toString("hex")));
    assert.ok(!memory.lines.join("").includes(config.secrets.faceTemplateKey.toString("hex")));
  });

  it("the whole journey through production wiring: login -> wrong face -> right face -> eligibility -> ballot; nothing before the face step works", async () => {
    const cookie = await login(asha);
    // Direct access at AUTHENTICATED is refused at every later step.
    assert.deepEqual(codeOf(await voterCall("post", "/eligibility/check", cookie).send({})), [409, "STAGE_REQUIRED"]);
    assert.deepEqual(codeOf(await voterCall("get", "/ballot", cookie)), [409, "STAGE_REQUIRED"]);
    assert.deepEqual(codeOf(await voterCall("post", "/authorization", cookie).send({ candidateId: "3" })), [409, "STAGE_REQUIRED"]);
    assert.deepEqual(codeOf(await voterCall("get", "/receipt", cookie)), [409, "STAGE_REQUIRED"]);

    assert.deepEqual(codeOf(await verify(cookie, rounded(CAROL))), [403, "FACE_MISMATCH"]);
    assert.deepEqual((await voterCall("get", "/face/status", cookie)).body.data, { enrolled: true, verified: false, attemptsLeft: 2, locked: false });
    const ok = await verify(cookie, todayOf(ASHA, 70));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.stage, "FACE_VERIFIED");
    assert.equal((await voterCall("get", "/status", cookie)).body.data.stage, "FACE_VERIFIED");
    const check = await voterCall("post", "/eligibility/check", cookie).send({});
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.equal(check.body.data.stage, "ELIGIBLE");
    assert.equal((await voterCall("get", "/ballot", cookie)).status, 200);
    assert.deepEqual(codeOf(await voterCall("post", "/face/challenge", cookie)), [409, "STAGE_REQUIRED"], "the face step is closed once the voter moved on");
  });

  it("a locked voter stays at AUTHENTICATED with the later steps refused (production wiring)", async () => {
    const cookie = await login(bharat);
    for (let i = 0; i < 3; i++) assert.equal((await verify(cookie, rounded(person(800 + i)))).status, 403);
    assert.deepEqual(codeOf(await voterCall("post", "/face/challenge", cookie)), [423, "FACE_LOCKED"]);
    assert.deepEqual(codeOf(await voterCall("post", "/eligibility/check", cookie).send({})), [409, "STAGE_REQUIRED"]);
    assert.equal((await VoterSession.findOne({ voterId: bharat.id, active: true })).stage, "AUTHENTICATED");
  });

  it("a 500 provoked with a real descriptor and challenge in the body leaves no descriptor, challenge, template or key in the logs or the response", async () => {
    const cookie = await login(carol);
    // Corrupt Carol's stored template so that verify throws a non-AppError (the generic 500 path).
    const coll = mongoose.connection.collection("facetemplates");
    const row = await coll.findOne({ voterId: new mongoose.Types.ObjectId(carol.id) });
    await coll.updateOne({ _id: row._id }, { $set: { "box.ct": row.box.ct.slice(0, -8) } });
    const descriptor = todayOf(CAROL, 71);
    const challenge = await issue(cookie);
    const before = memory.lines.length;
    const res = await voterCall("post", "/face/verify", cookie).send({ challenge, descriptor });
    assert.deepEqual(codeOf(res), [500, "INTERNAL_ERROR"]);
    const newLogs = memory.lines.slice(before).join("");
    assert.ok(newLogs.includes("unhandled error"), "the fault is logged");
    const secrets = [challenge, descriptor[0], descriptor[100], descriptor[511], row.box.ct.slice(0, 40), row.box.iv, row.box.tag, config.secrets.faceTemplateKey.toString("hex"), config.secrets.faceTemplateKey.toString("base64"), config.secrets.nullifierSecret.toString("hex"), cookie.split("=")[1]].map(String);
    for (const secret of secrets) {
      assert.ok(!newLogs.includes(secret), `log leaked ${secret.slice(0, 12)}`);
      assert.ok(!res.text.includes(secret), `response leaked ${secret.slice(0, 12)}`);
    }
    assert.ok(!memory.lines.join("").includes(config.secrets.faceTemplateKey.toString("hex")));
    assert.equal((await FaceChallenge.findOne({ voterId: carol.id })).attempts, 0, "a server-side fault does not cost the voter an attempt");
    // and the audit rows of every outcome so far hold only whitelisted, primitive facts
    const allowed = new Set(["voterDbId", "voterId", "reason", "attempt", "score", "sampleCount", "liveness", "constituencyCode", "phase", "email", "name", "changedFields", "failedChecks"]);
    const rows = await AuditLog.find({}).lean();
    for (const entry of rows) for (const [key, value] of Object.entries(entry.meta ?? {})) {
      assert.ok(allowed.has(key), `${entry.action}.${key}`);
      assert.ok(typeof value !== "object" || value === null || (Array.isArray(value) && value.every((x) => typeof x === "string")), `${entry.action}.${key} is not a primitive (or a list of names)`);
    }
    const text = JSON.stringify(rows);
    for (const secret of secrets) assert.ok(!text.includes(secret), `audit leaked ${secret.slice(0, 12)}`);
  });

  it("every response and every log line of the whole run is free of biometric material", async () => {
    const lines = memory.lines.map((l) => JSON.parse(l));
    for (const line of lines.filter((l) => l.msg === "request")) assert.deepEqual(Object.keys(line).sort(), ["durationMs", "level", "method", "msg", "path", "requestId", "status", "time"]);
    const text = memory.lines.join("");
    for (const needle of ["tokenHash", '"box"', '"descriptor"', '"challenge"', "faceTemplateKey", "FACE_TEMPLATE_ENCRYPTION_KEY"]) assert.ok(!text.includes(needle), needle);
    // no run of 20 or more consecutive numbers that look like a descriptor
    assert.ok(!/(?:-?\d\.\d{4,}[,\s]+){20,}/.test(text));
  });

  it("the face rate limit counts per ADDRESS, ignores spoofed forwarding headers, and counts unauthenticated calls too", async () => {
    // production default: 60 per minute across /face/challenge and /face/verify; everything above is answered 429
    const forwarded = (i) => ({ "X-Forwarded-For": `203.0.113.${i % 250}`, "X-Real-IP": `198.51.100.${i % 250}`, Forwarded: `for=192.0.2.${i % 250}`, "X-Client-IP": `10.0.0.${i % 250}` });
    const statuses = [];
    for (let i = 0; i < 80; i++) {
      const res = await request(app).post("/api/v1/voter/face/verify").set(forwarded(i)).send({});
      statuses.push(res.status);
    }
    const limited = statuses.filter((s) => s === 429).length;
    assert.ok(limited > 0, "the limiter engaged although every request pretended to come from another address");
    assert.ok(statuses.filter((s) => s === 401).length <= 60, "no more than the limit got through to the session check");
    // the limiter runs BEFORE the session check, so unauthenticated noise spends the budget every voter behind the same address shares
    const res = await voterCall("post", "/face/challenge", "vc_voter=whatever");
    assert.equal(res.status, 429);
    // status polling is deliberately not limited
    assert.notEqual((await voterCall("get", "/face/status", "vc_voter=whatever")).status, 429);
  });
});
