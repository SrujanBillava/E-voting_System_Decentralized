import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import request from "supertest";
import { capture, person, rounded } from "../../../backend-api/test/helpers/face.js";
import { secretValuesOf } from "../../src/config/env.js";
import { composeIdentity, MODELS } from "../../src/compose.js";
import { STAGES } from "../../src/auth/voterStages.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { closeDb, connectTestDb, dumpDb, resetDb, skipWithoutMongo } from "../helpers/db.js";
import { configFor } from "../helpers/env.js";
import { API, clearedCookie, commitmentOf, cookieOf, createVoter, eligibility, login, passFace, pollCredential, requestCredential, status, toEligible } from "../helpers/journey.js";
import { assertNoLeaks } from "../helpers/leak.js";
import { CLOSE_GRACE, contractsCompiled, newWorld } from "../helpers/world.js";

const { CredentialIssuance, CommitmentBatch, VoterSession } = MODELS;
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");

describe("identity-v3: voter journey and credential issuance (real chain + real MongoDB)", { skip }, () => {
  let world;
  let config;
  let identity;
  let app;
  let memory;
  let snap;

  before(async () => {
    await connectTestDb();
    world = await newWorld();
    config = configFor(world);
  });
  after(async () => {
    world?.stop();
    await closeDb();
  });
  beforeEach(async () => {
    snap = await world.snapshot();
    await resetDb();
    memory = createMemoryLogger({ level: "info", secrets: secretValuesOf(config) });
    identity = composeIdentity({ config, logger: memory.logger, provider: world.provider, clock: world.clock, bcryptCost: 4, rateLimits: { login: { windowMs: 60_000, limit: 10_000 }, face: { windowMs: 60_000, limit: 10_000 } } });
    await identity.chain.init();
    app = identity.app;
  });
  afterEach(async () => {
    await world.revert(snap);
  });

  const reserveAndIssue = async (voter, label) => {
    const cookie = await toEligible(app, voter);
    const res = await requestCredential(app, cookie, { commitment: commitmentOf(label) });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await world.nextEpoch();
    await identity.batcher.tick();
    return cookie;
  };

  describe("the happy path", () => {
    it("login -> face -> eligibility -> commitment -> epoch batch -> CREDENTIAL_ISSUED, then the identity session ENDS", async () => {
      const voter = await createVoter(config, { n: 1 });
      const loginRes = await login(app, voter);
      assert.equal(loginRes.status, 200);
      assert.equal(loginRes.body.data.stage, STAGES.AUTHENTICATED);
      const cookie = cookieOf(loginRes);
      assert.match(cookie, /^vc3_voter=/);

      const face = await passFace(app, cookie, voter);
      assert.equal(face.body.data.verified, true);
      assert.equal(face.body.data.stage, STAGES.FACE_VERIFIED);
      const el = await eligibility(app, cookie);
      assert.equal(el.body.data.stage, STAGES.ELIGIBLE);
      assert.deepEqual(el.body.data.constituency.code, "KA-BLR");

      const commitment = commitmentOf("happy-1");
      const res = await requestCredential(app, cookie, { commitment });
      assert.equal(res.status, 202);
      assert.deepEqual(res.body.data, { state: "PENDING" });
      assert.equal((await status(app, cookie)).body.data.stage, STAGES.COMMITMENT_PENDING);

      // the same epoch: nothing is sent (the cohort of this epoch is not closed yet)
      const early = await identity.batcher.tick();
      assert.deepEqual(early.formed.map((f) => f.status), ["NOTHING_DUE"]);
      assert.equal((await pollCredential(app, cookie)).body.data.state, "PENDING");
      assert.deepEqual(await world.groupLeaves("KA-BLR"), []);

      await world.nextEpoch();
      const report = await identity.batcher.tick();
      assert.equal(report.formed[0].status, "FORMED");
      assert.equal(report.formed[0].outcome, "FINALIZED");
      assert.deepEqual(await world.groupLeaves("KA-BLR"), [BigInt(commitment)], "the commitment is in the public group");

      const poll = await pollCredential(app, cookie);
      assert.equal(poll.status, 200);
      assert.equal(poll.body.data.state, STAGES.CREDENTIAL_ISSUED);
      assert.equal(poll.body.data.constituency.code, "KA-BLR");
      assert.equal(poll.body.data.group.size, 1);
      assert.equal(poll.body.data.group.merkleTreeDepth, 20);
      assert.ok(BigInt(poll.body.data.group.root) > 0n);
      assert.ok(clearedCookie(poll), "the authentication cookie is cleared");
      assert.deepEqual(Object.keys(poll.body.data).sort(), ["constituency", "group", "state"], "nothing but public group data");

      // the session is GONE: the old cookie authenticates nothing
      assert.equal((await status(app, cookie)).status, 401);
      assert.equal((await pollCredential(app, cookie)).status, 401);
      assert.equal(await VoterSession.countDocuments({}), 0);
      // and the voter cannot start again
      const again = await login(app, voter);
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, "CREDENTIAL_ALREADY_ISSUED");
      assert.equal(cookieOf(again), undefined, "no session is created");
    });

    it("there is no V2 stage and no ballot, receipt, cast or result route: the identity service knows nothing about ballots", async () => {
      assert.deepEqual(Object.values(STAGES), ["AUTHENTICATED", "FACE_VERIFIED", "ELIGIBLE", "COMMITMENT_PENDING", "CREDENTIAL_ISSUED"]);
      const voter = await createVoter(config, { n: 2 });
      const cookie = await toEligible(app, voter);
      for (const [method, path] of [["get", "/ballot"], ["post", "/authorization"], ["post", "/cast"], ["get", "/receipt"], ["post", "/ballots"], ["get", "/results"], ["get", "/ballot/status"]]) {
        const res = await request(app)[method](`${API}${path}`).set("Cookie", cookie).send({});
        assert.equal(res.status, 404, `${method} ${path}`);
      }
    });
  });

  describe("who may ask, and for what", () => {
    it("unauthenticated, wrong-cookie and forged-cookie requests are refused on every route", async () => {
      const bogus = "vc3_voter=" + "x".repeat(43);
      for (const cookie of [undefined, "", bogus, "vc_voter=" + "y".repeat(43)]) {
        for (const [method, path] of [["get", "/status"], ["post", "/face/challenge"], ["post", "/eligibility/check"], ["post", "/credential"], ["get", "/credential"]]) {
          const res = await request(app)[method](`${API}${path}`).set("Cookie", cookie ?? "").send({ commitment: commitmentOf("nobody") });
          assert.equal(res.status, 401, `${method} ${path} with ${cookie}`);
        }
      }
      assert.equal(await CredentialIssuance.countDocuments({}), 0);
    });

    it("no credential is possible before the face is verified, or before eligibility", async () => {
      const voter = await createVoter(config, { n: 3 });
      const cookie = cookieOf(await login(app, voter));
      let res = await requestCredential(app, cookie, { commitment: commitmentOf("early") });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "STAGE_REQUIRED");
      res = await eligibility(app, cookie);
      assert.equal(res.status, 409, "eligibility needs FACE_VERIFIED");
      await passFace(app, cookie, voter);
      res = await requestCredential(app, cookie, { commitment: commitmentOf("early") });
      assert.equal(res.status, 409, "FACE_VERIFIED is not ELIGIBLE");
      assert.equal(await CredentialIssuance.countDocuments({}), 0);
    });

    it("an ineligible voter is refused: suspended, constituency not on the contract, wrong face", async () => {
      const suspended = await createVoter(config, { n: 4, status: "SUSPENDED" });
      const res = await login(app, suspended);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "VOTER_SUSPENDED");

      const lost = await createVoter(config, { n: 5, constituencyCode: "XX-NONE" });
      const cookie = cookieOf(await login(app, lost));
      await passFace(app, cookie, lost);
      const el = await eligibility(app, cookie);
      assert.equal(el.status, 409);
      assert.equal(el.body.error.code, "CONSTITUENCY_NOT_CONFIGURED");

      const stranger = await createVoter(config, { n: 6 });
      const c2 = cookieOf(await login(app, stranger));
      const wrong = await passFace(app, c2, { faceSeed: 999 });
      assert.equal(wrong.body.data.verified, false);
      assert.equal((await eligibility(app, c2)).status, 409, "a failed face does not make anybody eligible");
    });

    it("the caller cannot choose a constituency (or any other field): the commitment is the ONLY accepted input, and the voter's OWN group receives it", async () => {
      const voter = await createVoter(config, { n: 7, constituencyCode: "KA-BLR" });
      const cookie = await toEligible(app, voter);
      for (const body of [
        { commitment: commitmentOf("c1"), constituency: "MH-MUM" },
        { commitment: commitmentOf("c1"), constituencyId: world.ids["MH-MUM"] },
        { commitment: commitmentOf("c1"), voterId: "VC-AAAAAAAAAA" },
        { commitment: commitmentOf("c1"), groupId: 2 },
        { commitment: commitmentOf("c1"), identity: "private" },
        { commitment: commitmentOf("c1"), nullifier: "1" },
      ]) {
        const res = await requestCredential(app, cookie, body);
        assert.equal(res.status, 400, JSON.stringify(Object.keys(body)));
        assert.equal(res.body.error.code, "VALIDATION_FAILED");
      }
      assert.equal(await CredentialIssuance.countDocuments({}), 0);

      assert.equal((await requestCredential(app, cookie, { commitment: commitmentOf("c1") })).status, 202);
      await world.nextEpoch();
      await identity.batcher.tick();
      assert.deepEqual(await world.groupLeaves("KA-BLR"), [BigInt(commitmentOf("c1"))]);
      assert.deepEqual(await world.groupLeaves("MH-MUM"), []);
    });

    it("malformed commitments are refused before anything is stored: not a string, empty, zero, negative, hex, leading zero, non-numeric, >= the field prime, huge", async () => {
      const voter = await createVoter(config, { n: 8 });
      const cookie = await toEligible(app, voter);
      const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      for (const bad of [undefined, null, 5, [], {}, "", "0", "-1", "0x1234", "01", "1.5", "1e9", " 12", "12 ", "abc", P.toString(), (P + 1n).toString(), "9".repeat(80), "٣"]) {
        const res = await requestCredential(app, cookie, { commitment: bad });
        assert.equal(res.status, 400, `commitment ${JSON.stringify(bad)}`);
        assert.equal(res.body.error.code, "VALIDATION_FAILED");
      }
      assert.equal((await requestCredential(app, cookie, { commitment: (P - 1n).toString() })).status, 202, "p - 1 is the largest valid commitment");
      assert.equal(await CredentialIssuance.countDocuments({}), 1);
    });
  });

  describe("one credential per voter, one voter per commitment", () => {
    it("the same request again is idempotent; a DIFFERENT commitment for the same voter is refused", async () => {
      const voter = await createVoter(config, { n: 9 });
      const cookie = await toEligible(app, voter);
      const commitment = commitmentOf("v9");
      assert.equal((await requestCredential(app, cookie, { commitment })).status, 202);
      assert.equal((await requestCredential(app, cookie, { commitment })).status, 202);
      const other = await requestCredential(app, cookie, { commitment: commitmentOf("v9-other") });
      assert.equal(other.status, 409);
      assert.equal(other.body.error.code, "CREDENTIAL_ALREADY_RESERVED");
      assert.equal(await CredentialIssuance.countDocuments({}), 1);
    });

    it("the same commitment cannot be reserved for a second voter (in flight), nor registered again once issued", async () => {
      const a = await createVoter(config, { n: 10 });
      const b = await createVoter(config, { n: 11 });
      const ca = await toEligible(app, a);
      const cb = await toEligible(app, b);
      const shared = commitmentOf("shared");
      assert.equal((await requestCredential(app, ca, { commitment: shared })).status, 202);
      const dup = await requestCredential(app, cb, { commitment: shared });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, "COMMITMENT_ALREADY_RESERVED");

      await world.nextEpoch();
      await identity.batcher.tick(); // a's commitment is now on-chain
      const later = await requestCredential(app, cb, { commitment: shared });
      assert.equal(later.status, 409);
      assert.equal(later.body.error.code, "COMMITMENT_ALREADY_REGISTERED");
      assert.equal(await CredentialIssuance.countDocuments({ state: "ISSUED" }), 1);
      assert.equal(await CredentialIssuance.countDocuments({}), 1, "b never got a record");
    });

    it("exactly ONE of many concurrent requests (same voter, different commitments) wins; the rest are refused", async () => {
      const voter = await createVoter(config, { n: 12 });
      const cookie = await toEligible(app, voter);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => requestCredential(app, cookie, { commitment: commitmentOf(`race-${i}`) })));
      assert.equal(results.filter((r) => r.status === 202).length, 1, results.map((r) => r.status).join());
      assert.ok(results.filter((r) => r.status !== 202).every((r) => r.status === 409));
      assert.equal(await CredentialIssuance.countDocuments({}), 1);
    });

    it("a voter who already holds a credential is refused at login, a voter with a request in flight is told to wait", async () => {
      const voter = await createVoter(config, { n: 13 });
      const cookie = await toEligible(app, voter);
      await requestCredential(app, cookie, { commitment: commitmentOf("v13") });
      const waiting = await login(app, voter);
      assert.equal(waiting.status, 409);
      assert.equal(waiting.body.error.code, "CREDENTIAL_IN_PROGRESS");
    });
  });

  describe("election and issuance state, and the voter cap", () => {
    it("issuance after closeIssuance is refused (login, eligibility and request), and a pending reservation is cancelled instead of being sent", async () => {
      const a = await createVoter(config, { n: 14 });
      const b = await createVoter(config, { n: 15 });
      const ca = await toEligible(app, a);
      const cb = await toEligible(app, b);
      assert.equal((await requestCredential(app, ca, { commitment: commitmentOf("v14") })).status, 202);
      await (await world.voteChain.closeIssuance()).wait();

      const res = await login(app, await createVoter(config, { n: 16 }));
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ISSUANCE_CLOSED");
      assert.equal((await eligibility(app, cb)).status, 409);
      assert.equal((await requestCredential(app, cb, { commitment: commitmentOf("v15") })).status, 409);

      await world.nextEpoch();
      const report = await identity.batcher.tick();
      assert.equal(report.formed[0].status, "CLOSED");
      assert.deepEqual(await world.groupLeaves("KA-BLR"), [], "nothing was sent");
      assert.equal((await CredentialIssuance.findOne({}))?.state, "CANCELLED");
      assert.equal((await CredentialIssuance.findOne({})).commitment, undefined, "a cancelled record keeps no commitment");
    });

    it("a Closed election refuses everything", async () => {
      const voter = await createVoter(config, { n: 17 });
      await (await world.voteChain.closeIssuance()).wait();
      await world.mineAt((await world.clock.nowSeconds()) + CLOSE_GRACE + 5);
      await (await world.voteChain.closeElection()).wait();
      const res = await login(app, voter);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ELECTION_CLOSED");
    });

    it("an election still in Setup refuses login", async () => {
      const setup = await newWorld({ open: false });
      try {
        const cfg = configFor(setup);
        const other = composeIdentity({ config: cfg, logger: memory.logger, provider: setup.provider, clock: setup.clock, bcryptCost: 4 });
        await other.chain.init();
        const voter = await createVoter(cfg, { n: 18 });
        const res = await login(other.app, voter);
        assert.equal(res.status, 409);
        assert.equal(res.body.error.code, "ELECTION_NOT_OPEN");
      } finally {
        setup.stop();
      }
    });

    it("the voter cap: with the cap filled by reservations nobody else is accepted, and the cohort fills the cap exactly", async () => {
      const voters = await Promise.all([20, 21, 22].map((n) => createVoter(config, { n, constituencyCode: "CAP-TWO" })));
      const cookies = [];
      for (const v of voters) cookies.push(await toEligible(app, v));
      assert.equal((await requestCredential(app, cookies[0], { commitment: commitmentOf("cap-0") })).status, 202);
      assert.equal((await requestCredential(app, cookies[1], { commitment: commitmentOf("cap-1") })).status, 202);
      const third = await requestCredential(app, cookies[2], { commitment: commitmentOf("cap-2") });
      assert.equal(third.status, 409);
      assert.equal(third.body.error.code, "CONSTITUENCY_CAP_REACHED");
      await world.nextEpoch();
      const report = await identity.batcher.tick();
      assert.equal(report.formed[0].outcome, "FINALIZED");
      assert.equal((await world.groupLeaves("CAP-TWO")).length, 2);
    });

    it("an overflow that slipped past the request check (a race) is cancelled by the batcher, never sent: the cohort never exceeds the contract's cap", async () => {
      const voters = await Promise.all([30, 31, 32].map((n) => createVoter(config, { n, constituencyCode: "CAP-TWO" })));
      const now = await world.clock.nowSeconds();
      for (const [i, v] of voters.entries()) {
        await CredentialIssuance.create({ _id: `r-${i}`, electionId: world.electionId, voterId: v.doc._id, state: "RESERVED", commitment: commitmentOf(`ovf-${i}`), constituencyId: world.ids["CAP-TWO"], reservedAt: now + i, reservedEpoch: Math.floor(now / 30), failures: 0 });
      }
      await world.nextEpoch();
      const report = await identity.batcher.tick();
      assert.equal(report.formed[0].outcome, "FINALIZED");
      assert.equal((await world.groupLeaves("CAP-TWO")).length, 2);
      const states = (await CredentialIssuance.find({}).sort({ _id: 1 })).map((r) => r.state);
      assert.deepEqual(states, ["ISSUED", "ISSUED", "CANCELLED"], "the oldest two are issued, the third can never be");
    });
  });

  describe("failed reservations and the face step", () => {
    it("a reservation that never reached the chain and was cancelled ends the session; the voter logs in again and requests again on the SAME record", async () => {
      const voter = await createVoter(config, { n: 60 });
      const cookie = await toEligible(app, voter);
      const stolen = commitmentOf("v60-stolen");
      assert.equal((await requestCredential(app, cookie, { commitment: stolen })).status, 202);
      const record = await CredentialIssuance.findOne({});
      // somebody registers that very commitment out of band: the cohort can never include it, so the reservation is cancelled before anything is signed
      await (await world.voteChain.connect(world.issuer).registerCommitmentBatch(world.ids["TN-CHE"], [BigInt(stolen)])).wait();
      await world.nextEpoch();
      assert.equal((await identity.batcher.tick()).formed[0].status, "NOTHING_DUE");
      const poll = await pollCredential(app, cookie);
      assert.equal(poll.status, 409);
      assert.equal(poll.body.error.code, "CREDENTIAL_CANCELLED");
      assert.ok(clearedCookie(poll), "the cancelled journey ends the session too");
      assert.equal(await VoterSession.countDocuments({}), 0);

      const again = await toEligible(app, voter); // allowed: nothing of theirs ever reached the chain
      assert.equal((await requestCredential(app, again, { commitment: stolen })).body.error.code, "COMMITMENT_ALREADY_REGISTERED");
      assert.equal((await requestCredential(app, again, { commitment: commitmentOf("v60-fresh") })).status, 202);
      assert.equal(await CredentialIssuance.countDocuments({}), 1, "still ONE record for this voter");
      assert.equal((await CredentialIssuance.findOne({}))._id, record._id);
      await world.nextEpoch();
      assert.equal((await identity.batcher.tick()).formed[0].outcome, "FINALIZED");
      assert.equal((await CredentialIssuance.findOne({})).state, "ISSUED");
    });

    it("three failed face comparisons lock the session; a face challenge works once; a replayed or foreign challenge is refused", async () => {
      const voter = await createVoter(config, { n: 61 });
      const cookie = cookieOf(await login(app, voter));
      const impostor = { faceSeed: 4242 };
      for (const left of [2, 1]) {
        const res = await passFace(app, cookie, impostor);
        assert.equal(res.body.data.verified, false);
        assert.equal(res.body.data.attemptsLeft, left);
      }
      const last = await passFace(app, cookie, impostor);
      assert.equal(last.body.data.locked, true);
      const locked = await passFace(app, cookie, voter);
      assert.equal(locked.status, 423, "even the right face is refused once locked");
      assert.equal(locked.body.error.code, "FACE_LOCKED");

      const other = await createVoter(config, { n: 62 });
      const c2 = cookieOf(await login(app, other));
      const challenge = (await request(app).post(`${API}/face/challenge`).set("Cookie", c2).send({})).body.data.challenge;
      const descriptor = rounded(capture(person(62), 0.9, 1));
      const first = await request(app).post(`${API}/face/verify`).set("Cookie", c2).send({ challenge, descriptor });
      assert.equal(first.body.data.verified, true);
      const replay = await request(app).post(`${API}/face/verify`).set("Cookie", c2).send({ challenge, descriptor });
      assert.equal(replay.status, 409, "the stage moved on, and the challenge was used");
      const c3 = cookieOf(await login(app, await createVoter(config, { n: 63 })));
      const foreign = await request(app).post(`${API}/face/verify`).set("Cookie", c3).send({ challenge, descriptor });
      assert.equal(foreign.body.error.code, "FACE_CHALLENGE_INVALID", "a challenge belongs to ONE session");
    });
  });

  describe("data minimisation after issuance", () => {
    it("the durable record is {electionId, voterId, state} and nothing else; no commitment, batch, tx, root, nullifier or timestamp survives anywhere in the identity store or its logs", async () => {
      const voter = await createVoter(config, { n: 40 });
      const commitment = commitmentOf("minimal");
      const cookie = await reserveAndIssue(voter, "minimal");
      const poll = await pollCredential(app, cookie);
      assert.equal(poll.body.data.state, STAGES.CREDENTIAL_ISSUED);

      const raw = await mongoose.connection.db.collection("credentialissuances_v3").find({}).toArray();
      assert.equal(raw.length, 1);
      assert.deepEqual(Object.keys(raw[0]).sort(), ["_id", "electionId", "state", "voterId"]);
      assert.equal(raw[0].state, "ISSUED");
      assert.equal(typeof raw[0]._id, "string", "a random UUID, not an ObjectId (which embeds its creation time)");
      assert.match(raw[0]._id, /^[0-9a-f-]{36}$/);

      const batches = await mongoose.connection.db.collection("commitmentbatches_v3").find({}).toArray();
      assert.equal(batches.length, 1);
      assert.equal(batches[0].state, "FINALIZED");
      assert.equal(batches[0].commitments, undefined, "the batch record keeps no commitments");
      assert.equal(batches[0].rawTx, undefined);
      assert.ok(batches[0].txHash && batches[0].merkleRoot, "operational chain data stays, and it is not linked to any voter");
      assert.equal(JSON.stringify(batches[0]).includes(String(voter.doc._id)), false, "no voter id in the batch record");

      // No VOTER-LINKED record keeps the commitment. (The batch record is not voter-linked and keeps the public chain data of the batch: for a cohort of ONE the
      // Merkle root of a one-leaf tree IS its only leaf, so the root equals the commitment: public data that points at no voter.)
      for (const name of ["credentialissuances_v3", "votersessions_v3", "facechallenges_v3", "voters_v2", "facetemplates"]) {
        assertNoLeaks(`the ${name} collection`, JSON.stringify(await mongoose.connection.db.collection(name).find({}).toArray()), [commitment]);
      }
      assertNoLeaks("the identity logs", memory.lines.join("\n"), [commitment, String(voter.doc._id), voter.id, voter.email]);
      assert.ok((await dumpDb()).length > 100, "the dump read something");
      assert.equal(await VoterSession.countDocuments({}), 0, "the session is gone, not kept as a revoked record");
    });

    it("the face-challenge row of an issued voter is deleted AT issuance, and a session whose result was never fetched is swept at its (short) expiry: no voter-linked timestamp lingers", async () => {
      const voter = await createVoter(config, { n: 41 });
      await reserveAndIssue(voter, "sweep");
      const faceRows = await mongoose.connection.db.collection("facechallenges_v3").countDocuments({ voterId: voter.doc._id });
      assert.equal(faceRows, 0, "the challenge row (voter id and timestamps) is gone the moment the credential is issued");
      const session = await VoterSession.findOne({});
      assert.equal(session.stage, STAGES.CREDENTIAL_ISSUED, "the terminal stage, kept only so the result can be fetched once");
      assert.ok(session.stageExpiresAt.getTime() - Date.now() <= 61_000, "and only for about a minute");
      await VoterSession.updateOne({}, { $set: { stageExpiresAt: new Date(Date.now() - 1000) } });
      const swept = await identity.batcher.sweepSessions();
      assert.equal(swept.sessions, 1);
      assert.equal(await VoterSession.countDocuments({}), 0, "nothing voter-linked with a timestamp is left");
      const left = await dumpDb();
      assert.equal(JSON.parse(left).credentialissuances_v3.every((r) => !("createdAt" in r) && !("reservedAt" in r)), true);
    });
  });
});
