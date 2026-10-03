import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { runPreflight } from "../../src/chain/preflight.js";
import { Voter } from "../../src/models/Voter.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { createBallotConfigService } from "../../src/services/ballotConfig.service.js";
import { createElectionService } from "../../src/services/election.service.js";
import { createHealthService } from "../../src/services/health.service.js";
import { createVoterService, VOTER_ID_PATTERN } from "../../src/services/voter.service.js";
import { adminWorld, PASSWORD } from "../helpers/admin.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";

// Needs the local chain AND a disposable MongoDB (MONGODB_TEST_URI). Chain state is snapshot/reverted per test.
const uri = process.env.MONGODB_TEST_URI;
const VOTER_PW = "initial voter password 1";

describe("admin voter / constituency / candidate management (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain;
  let w;
  let snap;
  let token;
  let admin;
  const phase = async () => Number(await chain.contract.phase());
  const owner = () => chain.contract.connect(chain.signers.owner);
  const call = (method, path, body, tok = token) => {
    const r = w.request()[method](`/api/v1/admin${path}`);
    if (tok) r.set(w.bearer(tok));
    return body === undefined ? r : r.send(body);
  };
  const newVoter = (over = {}) => ({ name: "Asha Rao", email: "Asha.Rao@Example.org", password: VOTER_PW, constituencyCode: "KA-BLR", ...over });
  const createVoter = async (over) => (await call("post", "/voters", newVoter(over))).body.data?.voter;

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
    const healthService = createHealthService({ runPreflight: ({ deep }) => runPreflight({ deployment: chain.deployment, provider: chain.provider, contract: chain.contract, signers: chain.signers, mongo: { ping: async () => {} }, deep }) });
    w = await adminWorld({
      electionFactory: ({ auth, audit, ownerQueue }) => createElectionService({ chain, healthService, auth, audit, ownerQueue, voterStats: () => voterService().stats() }),
      extras: ({ audit, ownerQueue }) => ({ voterService: (voterSvc = createVoterService({ Voter, chain, audit, bcryptCost: 4 })), configService: createBallotConfigService({ chain, audit, ownerQueue }) }),
    });
    await Voter.syncIndexes();
    admin = await w.createAdmin();
    token = (await w.loginAs(admin)).body.data.accessToken;
  });
  let voterSvc;
  const voterService = () => voterSvc;
  afterEach(() => revertTo(chain.provider, snap));

  describe("RBAC", () => {
    it("every data route needs an ADMIN token", async () => {
      const t = Math.floor(w.clock.now() / 1000);
      const voterTok = jwt.sign({ sub: "x", sid: "y", role: "VOTER", jti: "j", iat: t, exp: t + 900, iss: "votechain-api", aud: "votechain-admin" }, w.config.secrets.jwtAccessSecret);
      for (const [m, p] of [["get", "/voters"], ["post", "/voters"], ["get", "/voters/" + "a".repeat(24)], ["patch", "/voters/" + "a".repeat(24)], ["delete", "/voters/" + "a".repeat(24)], ["post", "/voters/" + "a".repeat(24) + "/password-reset"], ["get", "/constituencies"], ["post", "/constituencies"], ["get", "/candidates"], ["post", "/candidates"]]) {
        assert.equal((await call(m, p, {}, null)).status, 401, `${m} ${p} anonymous`);
        assert.equal((await call(m, p, {}, voterTok)).status, 403, `${m} ${p} non-admin`);
      }
      assert.equal((await call("get", "/voters")).status, 200);
    });
  });

  describe("create voter", () => {
    it("creates a voter with generated uid/voterId, normalised email, hashed password, faceEnrolled=false", async () => {
      const res = await call("post", "/voters", newVoter());
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const dto = res.body.data.voter;
      assert.deepEqual(Object.keys(dto).sort(), ["constituencyCode", "createdAt", "email", "faceEnrolled", "id", "name", "status", "updatedAt", "voterId"]);
      assert.match(dto.voterId, VOTER_ID_PATTERN);
      assert.equal(dto.email, "asha.rao@example.org");
      assert.equal(dto.faceEnrolled, false);
      assert.equal(dto.status, "ACTIVE");
      const raw = await mongoose.connection.collection("voters_v2").findOne({});
      assert.match(raw.uid, /^[0-9a-f]{32}$/);
      assert.ok(!raw.uid.includes(dto.voterId.slice(3)) && raw.uid !== dto.voterId);
      assert.match(raw.passwordHash, /^\$2[aby]\$/);
      assert.equal(await bcrypt.compare(VOTER_PW, raw.passwordHash), true);
      assert.ok(!JSON.stringify(raw).includes(VOTER_PW));
    });

    it("uids and voterIds are unique across many voters", async () => {
      for (let i = 0; i < 12; i++) await createVoter({ email: `v${i}@example.org` });
      const raws = await mongoose.connection.collection("voters_v2").find({}).toArray();
      assert.equal(new Set(raws.map((r) => r.uid)).size, 12);
      assert.equal(new Set(raws.map((r) => r.voterId)).size, 12);
    });

    it("rejects an unknown constituency, an invalid code, and a duplicate email", async () => {
      assert.equal((await call("post", "/voters", newVoter({ constituencyCode: "XX-NOPE" }))).body.error.code, "UNKNOWN_CONSTITUENCY");
      assert.equal((await call("post", "/voters", newVoter({ constituencyCode: "bad code!" }))).status, 400);
      assert.equal((await call("post", "/voters", newVoter())).status, 201);
      const dup = await call("post", "/voters", newVoter({ email: "ASHA.RAO@example.org" }));
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, "EMAIL_TAKEN");
    });

    it("canonicalises the constituency code (lowercase input is stored as KA-BLR)", async () => {
      const v = await createVoter({ constituencyCode: " ka-blr " });
      assert.equal(v.constituencyCode, "KA-BLR");
    });

    it("rejects client-supplied uid, voterId, passwordHash, faceEnrolled and any extra field", async () => {
      for (const extra of [{ uid: "a".repeat(32) }, { voterId: "VC-AAAAAAAAAA" }, { passwordHash: "x" }, { faceEnrolled: true }, { status: "ACTIVE" }, { _id: "a".repeat(24) }, { role: "ADMIN" }]) {
        const res = await call("post", "/voters", newVoter(extra));
        assert.equal(res.status, 400, JSON.stringify(extra));
        assert.equal(res.body.error.code, "VALIDATION_FAILED");
      }
      assert.equal(await Voter.countDocuments({}), 0);
    });

    it("rejects NoSQL operator payloads and short passwords", async () => {
      assert.equal((await call("post", "/voters", newVoter({ email: { $ne: null } }))).status, 400);
      assert.equal((await call("post", "/voters", newVoter({ constituencyCode: { $gt: "" } }))).status, 400);
      assert.equal((await call("post", "/voters", newVoter({ password: "short" }))).status, 400);
    });

    it("is refused once the election is Open or Closed (live contract phase)", async () => {
      await (await owner().openElection()).wait();
      const open = await call("post", "/voters", newVoter());
      assert.equal(open.status, 409);
      assert.equal(open.body.error.code, "ELECTION_LOCKED");
      await (await owner().closeElection()).wait();
      assert.equal((await call("post", "/voters", newVoter())).body.error.code, "ELECTION_LOCKED");
      assert.equal(await Voter.countDocuments({}), 0);
    });
  });

  describe("list / get", () => {
    beforeEach(async () => {
      await createVoter({ name: "Asha Rao", email: "asha@example.org" });
      await createVoter({ name: "Karan (Malhotra)", email: "karan+x@example.org", constituencyCode: "DL-DEL" });
      await createVoter({ name: "Pooja Verma", email: "pooja@example.org", constituencyCode: "DL-DEL" });
      await Voter.updateOne({ email: "pooja@example.org" }, { status: "SUSPENDED" });
    });
    const list = async (q) => (await call("get", "/voters" + q)).body.data;

    it("paginates and caps the limit at 100", async () => {
      const p = await list("?limit=2&page=2");
      assert.equal(p.voters.length, 1);
      assert.deepEqual([p.page, p.limit, p.total, p.totalPages], [2, 2, 3, 2]);
      assert.equal((await call("get", "/voters?limit=101")).status, 400);
      assert.equal((await call("get", "/voters?limit=0")).status, 400);
    });
    it("searches name, email and voterId", async () => {
      assert.equal((await list("?search=asha")).total, 1);
      assert.equal((await list("?search=POOJA@")).total, 1);
      const id = (await list("")).voters[0].voterId;
      assert.equal((await list("?search=" + id)).voters[0].voterId, id);
    });
    it("filters by constituency and status", async () => {
      assert.equal((await list("?constituencyCode=dl-del")).total, 2);
      assert.equal((await list("?status=SUSPENDED")).total, 1);
      assert.equal((await list("?constituencyCode=DL-DEL&status=ACTIVE")).total, 1);
    });
    it("treats regex metacharacters literally and rejects operator payloads", async () => {
      assert.equal((await list("?search=.*")).total, 0, ".* must not match everything");
      assert.equal((await list("?search=" + encodeURIComponent("(Malhotra)"))).total, 1);
      assert.equal((await call("get", "/voters?search[$ne]=x")).status, 400);
      assert.equal((await call("get", "/voters?email[$ne]=x")).status, 400);
      assert.equal((await call("get", "/voters?status=ACTIVE&status=SUSPENDED")).status, 400);
    });
    it("get returns the safe DTO, 404 for unknown, 400 for malformed ids", async () => {
      const first = (await list("")).voters[0];
      const res = await call("get", "/voters/" + first.id);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data.voter, first);
      assert.equal((await call("get", "/voters/" + "0".repeat(24))).status, 404);
      assert.equal((await call("get", "/voters/not-an-id")).status, 400);
    });
  });

  describe("update / delete / password reset", () => {
    let v;
    beforeEach(async () => {
      v = await createVoter();
    });

    it("updates allowed fields; changing constituency is validated on-chain", async () => {
      const ok = await call("patch", "/voters/" + v.id, { name: "New Name", email: "NEW@example.org", constituencyCode: "mh-mum", status: "SUSPENDED" });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.data.voter.name, ok.body.data.voter.email, ok.body.data.voter.constituencyCode, ok.body.data.voter.status], ["New Name", "new@example.org", "MH-MUM", "SUSPENDED"]);
      const bad = await call("patch", "/voters/" + v.id, { constituencyCode: "XX-NOPE" });
      assert.equal(bad.body.error.code, "UNKNOWN_CONSTITUENCY");
      assert.equal((await Voter.findById(v.id)).constituencyCode, "MH-MUM");
    });

    it("cannot change uid, voterId, passwordHash, faceEnrolled, timestamps or _id (mass assignment rejected)", async () => {
      const before = await mongoose.connection.collection("voters_v2").findOne({});
      for (const evil of [{ uid: "f".repeat(32) }, { voterId: "VC-ZZZZZZZZZZ" }, { passwordHash: "x" }, { faceEnrolled: true }, { createdAt: "2000-01-01" }, { _id: "a".repeat(24) }, { $set: { status: "SUSPENDED" } }, {}]) {
        assert.equal((await call("patch", "/voters/" + v.id, evil)).status, 400, JSON.stringify(evil));
      }
      assert.deepEqual(await mongoose.connection.collection("voters_v2").findOne({}), before);
    });

    it("duplicate email on update is 409", async () => {
      await createVoter({ email: "other@example.org" });
      assert.equal((await call("patch", "/voters/" + v.id, { email: "other@example.org" })).body.error.code, "EMAIL_TAKEN");
    });

    it("delete works in Setup, 404 afterwards", async () => {
      assert.equal((await call("delete", "/voters/" + v.id)).status, 204);
      assert.equal((await call("get", "/voters/" + v.id)).status, 404);
    });

    it("password reset changes the hash; the old password no longer matches; nothing is returned", async () => {
      const oldHash = (await Voter.findById(v.id).select("+passwordHash")).passwordHash;
      const res = await call("post", `/voters/${v.id}/password-reset`, { newPassword: "a brand new password 99" });
      assert.equal(res.status, 204);
      assert.equal(res.text, "");
      const newHash = (await Voter.findById(v.id).select("+passwordHash")).passwordHash;
      assert.notEqual(newHash, oldHash);
      assert.equal(await bcrypt.compare(VOTER_PW, newHash), false);
      assert.equal(await bcrypt.compare("a brand new password 99", newHash), true);
      assert.equal((await call("post", `/voters/${v.id}/password-reset`, { newPassword: "short" })).status, 400);
      assert.equal((await call("post", `/voters/${v.id}/password-reset`, { newPassword: "a brand new password 99", extra: 1 })).status, 400);
    });

    it("update, delete and password reset are all refused after Open and after Closed", async () => {
      await (await owner().openElection()).wait();
      for (let round = 0; round < 2; round++) {
        for (const res of [await call("patch", "/voters/" + v.id, { name: "X" }), await call("delete", "/voters/" + v.id), await call("post", `/voters/${v.id}/password-reset`, { newPassword: "a brand new password 99" })]) {
          assert.equal(res.status, 409);
          assert.equal(res.body.error.code, "ELECTION_LOCKED");
        }
        if (round === 0) await (await owner().closeElection()).wait();
      }
      assert.equal(await Voter.countDocuments({}), 1);
    });
  });

  describe("constituencies", () => {
    it("lists the real deployed constituencies", async () => {
      const list = (await call("get", "/constituencies")).body.data.constituencies;
      assert.deepEqual(list.map((c) => c.code), ["KA-BLR", "DL-DEL", "MH-MUM"]);
      assert.deepEqual(list.map((c) => c.candidateCount), [7, 6, 5]);
      for (const c of list) assert.equal(c.constituencyId, constituencyIdOf(c.code));
    });

    it("adds one in Setup: normalised code, id == keccak256(code), confirmed tx, event parsed, state read back", async () => {
      const res = await call("post", "/constituencies", { code: " ka-mys ", name: "Mysuru" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const { txHash, constituency } = res.body.data;
      assert.deepEqual(constituency, { code: "KA-MYS", name: "Mysuru", constituencyId: constituencyIdOf("KA-MYS"), candidateCount: 0 });
      assert.equal((await chain.provider.getTransactionReceipt(txHash)).from, chain.signers.addresses.owner);
      assert.deepEqual([...(await chain.contract.getConstituency(constituencyIdOf("KA-MYS")))], ["KA-MYS", "Mysuru"]);
      assert.equal(await chain.contract.constituencyCount(), 4n);
      assert.ok(await AuditLog.findOne({ action: "CONSTITUENCY_ADDED", txHash }));
    });

    it("rejects duplicates (even differently cased), invalid codes/names, extra fields; no edit/delete routes", async () => {
      assert.equal((await call("post", "/constituencies", { code: "ka-blr", name: "Dup" })).body.error.code, "CONSTITUENCY_EXISTS");
      for (const body of [{ code: "", name: "x" }, { code: "BAD CODE", name: "x" }, { code: "A--B", name: "x" }, { code: "-A", name: "x" }, { code: "KA-OK", name: "" }, { code: "KA-OK", name: "x", constituencyId: "0x1" }, { code: { $ne: 1 }, name: "x" }]) {
        assert.equal((await call("post", "/constituencies", body)).status, 400, JSON.stringify(body));
      }
      assert.equal(await chain.contract.constituencyCount(), 3n);
      assert.equal((await call("patch", "/constituencies/KA-BLR", { name: "x" })).status, 404);
      assert.equal((await call("delete", "/constituencies/KA-BLR")).status, 404);
    });

    it("adding is refused after Open", async () => {
      await (await owner().openElection()).wait();
      const res = await call("post", "/constituencies", { code: "KA-MYS", name: "Mysuru" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ELECTION_LOCKED");
      assert.equal(await chain.contract.constituencyCount(), 3n);
    });
  });

  describe("candidates", () => {
    it("lists all 18 real candidates, filterable by constituency; no tallies", async () => {
      const all = (await call("get", "/candidates")).body.data.candidates;
      assert.equal(all.length, 18);
      assert.deepEqual(Object.keys(all[0]).sort(), ["candidateId", "constituencyCode", "constituencyId", "name"]);
      const del = (await call("get", "/candidates?constituencyCode=dl-del")).body.data.candidates;
      assert.deepEqual(del.map((c) => c.candidateId), [8, 9, 10, 11, 12, 13]);
      assert.equal((await call("get", "/candidates/1")).body.data.candidate.name, "Amit Sharma");
      assert.equal((await call("get", "/candidates/999")).status, 404);
    });

    it("adds a candidate in Setup: contract assigns the id; correct constituency; listed; duplicates allowed", async () => {
      const res = await call("post", "/candidates", { name: "Amit Sharma", constituencyCode: "ka-blr" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(res.body.data.candidate, { candidateId: 19, name: "Amit Sharma", constituencyCode: "KA-BLR", constituencyId: constituencyIdOf("KA-BLR") });
      const [name, cid] = await chain.contract.getCandidate(19);
      assert.deepEqual([name, cid], ["Amit Sharma", constituencyIdOf("KA-BLR")]);
      assert.equal((await call("get", "/candidates?constituencyCode=KA-BLR")).body.data.candidates.filter((c) => c.name === "Amit Sharma").length, 2);
      assert.ok(await AuditLog.findOne({ action: "CANDIDATE_ADDED", txHash: res.body.data.txHash }));
    });

    it("a brand-new constituency can receive candidates", async () => {
      await call("post", "/constituencies", { code: "KA-MYS", name: "Mysuru" });
      const res = await call("post", "/candidates", { name: "New Person", constituencyCode: "KA-MYS" });
      assert.equal(res.body.data.candidate.candidateId, 19);
      assert.equal((await call("get", "/constituencies")).body.data.constituencies.find((c) => c.code === "KA-MYS").candidateCount, 1);
    });

    it("rejects unknown constituency, empty name, client-supplied ids, extra fields; no edit/delete routes", async () => {
      assert.equal((await call("post", "/candidates", { name: "X", constituencyCode: "XX-NOPE" })).body.error.code, "UNKNOWN_CONSTITUENCY");
      for (const body of [{ name: "", constituencyCode: "KA-BLR" }, { name: "X", constituencyCode: "KA-BLR", candidateId: 99 }, { name: "X", constituencyCode: "KA-BLR", constituencyId: "0x" + "1".repeat(64) }, { name: { $ne: 1 }, constituencyCode: "KA-BLR" }]) {
        assert.equal((await call("post", "/candidates", body)).status, 400, JSON.stringify(body));
      }
      assert.equal(await chain.contract.candidateCount(), 18n);
      assert.equal((await call("patch", "/candidates/1", { name: "x" })).status, 404);
      assert.equal((await call("delete", "/candidates/1")).status, 404);
    });

    it("concurrent additions are serialised (no nonce race) and all succeed with distinct ids", async () => {
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call("post", "/candidates", { name: `Parallel ${i}`, constituencyCode: "MH-MUM" })));
      assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201, 201]);
      assert.equal(new Set(results.map((r) => r.body.data.candidate.candidateId)).size, 5);
      assert.equal(await chain.contract.candidateCount(), 23n);
    });

    it("adding is refused after Open", async () => {
      await (await owner().openElection()).wait();
      const res = await call("post", "/candidates", { name: "Late", constituencyCode: "KA-BLR" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ELECTION_LOCKED");
      assert.equal(await chain.contract.candidateCount(), 18n);
    });
  });

  describe("dashboard + privacy", () => {
    it("GET /admin/election includes real voter counts", async () => {
      await createVoter();
      await createVoter({ email: "b@example.org" });
      await Voter.updateOne({ email: "b@example.org" }, { faceEnrolled: true });
      const d = (await call("get", "/election")).body.data;
      assert.deepEqual(d.voters, { registered: 2, faceEnrolled: 1 });
      assert.equal(d.phase, "Setup");
    });

    it("no response, log line or audit row ever contains uid, passwords, hashes, keys, TOTP or tokens", async () => {
      const v = await createVoter();
      await call("patch", "/voters/" + v.id, { name: "Renamed" });
      await call("post", `/voters/${v.id}/password-reset`, { newPassword: "a brand new password 99" });
      const responses = JSON.stringify([
        (await call("get", "/voters")).body,
        (await call("get", "/voters/" + v.id)).body,
        (await call("get", "/constituencies")).body,
        (await call("get", "/candidates")).body,
        (await call("get", "/election")).body,
        (await call("post", "/voters", newVoter({ email: "x@example.org", uid: "a".repeat(32) }))).body,
      ]);
      const raw = await mongoose.connection.collection("voters_v2").findOne({ voterId: v.voterId });
      const audit = JSON.stringify(await mongoose.connection.collection("auditlogs").find({}).toArray());
      const everything = responses + audit + w.memory.lines.join("");
      const s = w.config.secrets;
      for (const secret of [raw.uid, raw.passwordHash, VOTER_PW, "a brand new password 99", PASSWORD, s.ownerPrivateKey, s.authorityPrivateKey, s.relayerPrivateKey, s.ownerPrivateKey.slice(2), s.nullifierSecret.toString("hex"), s.jwtAccessSecret.toString("hex"), s.adminTotpKey.toString("hex"), admin.totpSecret, token]) {
        assert.ok(!everything.includes(secret), `leaked ${String(secret).slice(0, 8)}...`);
      }
      for (const key of ['"uid"', '"passwordHash"', '"nullifier"', '"password"']) assert.ok(!responses.includes(key), `response contains ${key}`);
      for (const action of ["VOTER_CREATED", "VOTER_UPDATED", "VOTER_PASSWORD_RESET"]) assert.ok(audit.includes(action), action);
    });
  });
});
