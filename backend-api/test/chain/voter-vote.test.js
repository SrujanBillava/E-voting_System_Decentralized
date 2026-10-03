import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import { Wallet } from "ethers";
import mongoose from "mongoose";
import request from "supertest";
import { STAGES } from "../../src/auth/voterStages.js";
import { createApp } from "../../src/app.js";
import { createRelayerQueue } from "../../src/chain/relayerQueue.js";
import { buildBallotAuthorization, signBallotAuthorization } from "../../src/chain/eip712.js";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { deriveNullifier } from "../../src/chain/nullifier.js";
import { loadEnv } from "../../src/config/env.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { Voter } from "../../src/models/Voter.js";
import { VoteTicket } from "../../src/models/VoteTicket.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createAuditService } from "../../src/services/audit.service.js";
import { createAuthorizationService } from "../../src/services/authorization.service.js";
import { createCastService } from "../../src/services/cast.service.js";
import { createEligibilityService } from "../../src/services/eligibility.service.js";
import { createVoterAuthService } from "../../src/services/voterAuth.service.js";
import { generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { hardhatAccount, validEnv } from "../helpers/env.js";

// Needs the local chain AND a disposable MongoDB (MONGODB_TEST_URI). Real castVote transactions happen inside snapshots.
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";
let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${++keySeq}-abcdef`;

describe("authorization + relayer cast (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, memory, auth, app, config, relayerQueue, castSvc, t;
  const clock = { now: () => t, advance: (s) => (t += s * 1000) };
  const owner = () => chain.contract.connect(chain.signers.owner);
  const relayerAddr = () => chain.signers.addresses.relayer;
  const relayerNonce = () => chain.provider.getTransactionCount(relayerAddr(), "latest");
  const tallies = async () => ({ total: await chain.contract.totalBallots(), blr: await chain.contract.constituencyTotal(constituencyIdOf("KA-BLR")), c3: await chain.contract.votesOf(3), c4: await chain.contract.votesOf(4) });
  const mkVoter = async (n = 1, over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: `Voter ${n}`, email: `v${n}@example.org`, passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });

  const withSigners = (over) => {
    const s = Object.create(chain.signers);
    for (const [k, v] of Object.entries(over)) Object.defineProperty(s, k, { value: v });
    return { ...chain, signers: s };
  };
  const withProvider = (overrides) => ({ ...chain, provider: new Proxy(chain.provider, { get: (target, p) => overrides[p] ?? (typeof target[p] === "function" ? target[p].bind(target) : target[p]) }) });

  const build = (castChain = chain, { receiptTimeoutMs = 4000 } = {}) => {
    const audit = createAuditService({ AuditLog, logger: memory.logger, now: clock.now });
    auth = createVoterAuthService({ Voter, VoterSession, chain, audit, now: clock.now, bcryptCost: 4 });
    const common = { Voter, authService: auth, audit, now: clock.now };
    return createApp({
      config,
      logger: memory.logger,
      healthService: { getPublicHealth: async () => ({ status: "ok" }) },
      voter: {
        authService: auth,
        eligibilityService: createEligibilityService({ ...common, chain, nullifierSecret: config.secrets.nullifierSecret }),
        authorizationService: createAuthorizationService({ ...common, VoteTicket, chain: castChain, nullifierSecret: config.secrets.nullifierSecret }),
        castService: (castSvc = createCastService({ ...common, VoteTicket, chain: castChain, relayerQueue, waitNow: Date.now, receiptTimeoutMs, pollMs: 20 })),
      },
      voterLoginRateLimit: { windowMs: 60_000, limit: 10_000 },
    });
  };

  /** A voter session driven through the real endpoints up to ELIGIBLE (FACE_VERIFIED is placed with the trusted primitive). */
  const session = async (voter, upTo = "ELIGIBLE") => {
    const res = await request(app).post("/api/v1/voter/auth/login").send({ identifier: voter.voterId, password: PW });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const token = res.headers["set-cookie"][0].split(";")[0].split("=")[1];
    const row = await VoterSession.findOne({ voterId: voter._id, active: true });
    const s = { token, sessionId: row._id, voter };
    if (upTo === "AUTHENTICATED") return s;
    assert.equal(await auth.transitionStage({ sessionId: row._id, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: new Date(clock.now() + 120_000) }), true);
    if (upTo === "FACE_VERIFIED") return s;
    assert.equal((await call(s, "post", "/eligibility/check")).status, 200);
    return s;
  };
  const call = (s, method, path, body, headers = {}) => {
    const r = request(app)[method](`/api/v1/voter${path}`).set("Cookie", `vc_voter=${s.token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return method === "get" ? r : r.send(body ?? {});
  };
  const authorize = (s, candidateId = "3") => call(s, "post", "/authorization", { candidateId });
  const cast = (s, key = newKey()) => call(s, "post", "/cast", {}, { "Idempotency-Key": key });
  const ready = async (voter, candidateId = "3") => {
    const s = await session(voter);
    assert.equal((await authorize(s, candidateId)).status, 200);
    return s;
  };
  const stageOf = async (s) => (await VoterSession.findById(s.sessionId)).stage;
  const ticketOf = (voter) => VoteTicket.findOne({ voterId: voter._id }).select("+rawTx +candidateId +nullifier");
  const nullifierOf = async (voter) => deriveNullifier({ secret: config.secrets.nullifierSecret, electionId: chain.deployment.electionId, voterUid: (await Voter.findById(voter._id).select("+uid")).uid });
  const castDirect = async (voter, candidateId = 3n) => {
    const nullifier = await nullifierOf(voter);
    const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId, relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
    const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
    return (await chain.contract.connect(chain.signers.relayer).castVote(message.constituencyId, nullifier, candidateId, message.deadline, signature)).wait();
  };

  let voter;
  before(async () => {
    await mongoose.connect(uri);
    chain = localServices();
    await assertPristineLocalChain(chain);
    config = loadEnv(validEnv());
  });
  after(async () => {
    const head = await chain.provider.getBlock("latest");
    const drift = head.timestamp - Math.floor(Date.now() / 1000);
    chain?.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    // Guard for the shared dev chain: a test must never leave its clock shifted (snapshot revert does not undo that).
    assert.ok(drift < 180, `the shared chain clock was left shifted ahead by ${drift}s`);
  });
  beforeEach(async () => {
    snap = await snapshot(chain.provider);
    await mongoose.connection.dropDatabase();
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), VoteTicket.syncIndexes(), AuditLog.syncIndexes()]);
    t = Date.now(); // the signed deadlines are compared with real chain time, so the fake clock starts at real time
    memory = createMemoryLogger();
    relayerQueue = createRelayerQueue();
    app = build();
    voter = await mkVoter();
    await (await owner().openElection()).wait();
  });
  afterEach(() => revertTo(chain.provider, snap));

  describe("authorization", () => {
    it("needs a session and the ELIGIBLE stage", async () => {
      assert.equal((await request(app).post("/api/v1/voter/authorization").send({ candidateId: "3" })).status, 401);
      for (const upTo of ["AUTHENTICATED", "FACE_VERIFIED"]) {
        await VoterSession.updateMany({}, { active: false });
        const s = await session(voter, upTo);
        assert.equal((await authorize(s)).body.error.code, "STAGE_REQUIRED", upTo);
      }
    });

    it("validates candidateId strictly and rejects every client-supplied identity field", async () => {
      const s = await session(voter);
      for (const body of [{ candidateId: 3 }, { candidateId: "03" }, { candidateId: "0" }, { candidateId: "-1" }, { candidateId: "1.5" }, { candidateId: "1e3" }, { candidateId: "" }, { candidateId: { $ne: 1 } }, {}, { candidateId: "3", constituencyCode: "DL-DEL" }, { candidateId: "3", nullifier: "0x" + "1".repeat(64) }, { candidateId: "3", uid: "x" }, { candidateId: "3", constituencyId: "0x1" }]) {
        assert.equal((await call(s, "post", "/authorization", body)).status, 400, JSON.stringify(body));
      }
      assert.equal(await VoteTicket.countDocuments({}), 0);
      assert.equal(await stageOf(s), "ELIGIBLE");
    });

    it("rejects a nonexistent candidate and a candidate from another constituency; no ticket, stage unchanged", async () => {
      const s = await session(voter);
      assert.equal((await authorize(s, "999")).body.error.code, "INVALID_CANDIDATE");
      assert.equal((await authorize(s, "8")).body.error.code, "CANDIDATE_NOT_IN_CONSTITUENCY"); // Delhi
      assert.equal((await authorize(s, "14")).body.error.code, "CANDIDATE_NOT_IN_CONSTITUENCY"); // Mumbai
      assert.equal(await VoteTicket.countDocuments({}), 0);
      assert.equal(await stageOf(s), "ELIGIBLE");
    });

    it("issues a ticket: ELIGIBLE -> AUTH_ISSUED with a 180 s window and a safe response", async () => {
      const s = await session(voter);
      const res = await authorize(s, "3");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), ["expiresAt", "stage", "ticketId"]);
      assert.equal(res.body.data.stage, "AUTH_ISSUED");
      assert.equal(+new Date(res.body.data.expiresAt), clock.now() + 180_000);
      assert.equal(await stageOf(s), "AUTH_ISSUED");
      assert.equal(+(await VoterSession.findById(s.sessionId)).stageExpiresAt, clock.now() + 180_000);
      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "AUTH_ISSUED");
      assert.equal(ticket.candidateId, "3");
      assert.equal(ticket.nullifier, await nullifierOf(voter));
      assert.ok(!JSON.stringify(res.body).match(/signature|nullifier|uid|constituencyId|rawTx/i));
    });

    it("an already-used nullifier is rejected (re-checked at authorization)", async () => {
      const s = await session(voter);
      await castDirect(voter);
      const res = await authorize(s);
      assert.equal(res.body.error.code, "ALREADY_VOTED");
      assert.equal(await VoteTicket.countDocuments({}), 0);
    });

    it("concurrent same-candidate requests create exactly one ticket and agree on it", async () => {
      const s = await session(voter);
      const results = await Promise.all(Array.from({ length: 6 }, () => authorize(s, "3")));
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
      assert.equal(new Set(results.map((r) => r.body.data.ticketId)).size, 1);
      assert.equal(await VoteTicket.countDocuments({}), 1);
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_AUTHORIZATION_ISSUED" }), 1);
      assert.equal(await stageOf(s), "AUTH_ISSUED");
    });

    it("a different candidate after issuance is refused; the confirmed choice never silently changes", async () => {
      const s = await session(voter);
      await authorize(s, "3");
      const res = await authorize(s, "4");
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "AUTHORIZATION_ALREADY_ISSUED");
      assert.equal((await ticketOf(voter)).candidateId, "3");
      assert.equal((await authorize(s, "3")).status, 200, "same candidate stays idempotent");
    });

    it("an expired, never-submitted authorization can be started over with a different candidate", async () => {
      const s = await session(voter);
      await authorize(s, "3");
      clock.advance(181);
      assert.equal((await cast(s)).body.error.code, "SESSION_EXPIRED");
      const s2 = await session(voter);
      const res = await authorize(s2, "4");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await VoteTicket.countDocuments({}), 1);
      assert.equal((await ticketOf(voter)).candidateId, "4");
    });

    it("a closed election ends the flow", async () => {
      const s = await session(voter);
      await (await owner().closeElection()).wait();
      assert.equal((await authorize(s)).body.error.code, "ELECTION_CLOSED");
    });
  });

  describe("cast", () => {
    it("needs AUTH_ISSUED, an Idempotency-Key and an empty body", async () => {
      const s = await session(voter);
      assert.equal((await cast(s)).body.error.code, "STAGE_REQUIRED"); // still ELIGIBLE
      await authorize(s, "3");
      assert.equal((await call(s, "post", "/cast", {})).body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
      assert.equal((await call(s, "post", "/cast", {}, { "Idempotency-Key": "short" })).body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
      for (const body of [{ candidateId: "4" }, { candidateId: "3" }, { signature: "0x" }, { nullifier: "0x1" }]) assert.equal((await call(s, "post", "/cast", body, { "Idempotency-Key": newKey() })).status, 400, JSON.stringify(body));
      assert.deepEqual(await tallies(), { total: 0n, blr: 0n, c3: 0n, c4: 0n });
    });

    it("the backend relayer submits a real castVote: counted exactly once, event matches, ticket CONFIRMED, session SUBMITTED", async () => {
      const s = await ready(voter, "3");
      const nonceBefore = await relayerNonce();
      const res = await cast(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data, { stage: "SUBMITTED", state: "CONFIRMED", txHash: res.body.data.txHash });
      assert.match(res.body.data.txHash, /^0x[0-9a-f]{64}$/);

      assert.deepEqual(await tallies(), { total: 1n, blr: 1n, c3: 1n, c4: 0n });
      const nullifier = await nullifierOf(voter);
      assert.equal(await chain.contract.nullifierUsed(nullifier), true);
      assert.equal(await chain.contract.ballotIndexOf(nullifier), 1n);
      const events = await chain.contract.queryFilter(chain.contract.filters.BallotCast());
      assert.equal(events.length, 1);
      assert.deepEqual([events[0].args.nullifier, events[0].args.constituencyId, events[0].args.candidateId], [nullifier, constituencyIdOf("KA-BLR"), 3n]);
      const receipt = await chain.provider.getTransactionReceipt(res.body.data.txHash);
      assert.equal(receipt.from, relayerAddr(), "sent by the backend relayer");
      assert.equal(await relayerNonce(), nonceBefore + 1);

      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "CONFIRMED");
      assert.equal(ticket.rawTx, null, "raw transaction removed after confirmation");
      assert.equal(ticket.txHash, res.body.data.txHash);
      assert.equal(await stageOf(s), "SUBMITTED");
      assert.ok(!JSON.stringify(res.body).match(/signature|nullifier|candidateId|rawTx|uid/i));
    });

    it("CANDIDATE INTEGRITY: the ticket's candidate is what is counted; the request cannot choose, and a signature for A is useless for B", async () => {
      const s = await ready(voter, "3");
      assert.equal((await call(s, "post", "/cast", { candidateId: "4" }, { "Idempotency-Key": newKey() })).status, 400);
      assert.equal((await cast(s)).status, 200);
      assert.deepEqual(await tallies(), { total: 1n, blr: 1n, c3: 1n, c4: 0n });

      // contract level: an authorization signed for candidate 3 cannot be submitted as candidate 4 by the relayer
      const other = await mkVoter(2);
      const nullifier = await nullifierOf(other);
      const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId: 3n, relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
      const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
      await assert.rejects(chain.contract.connect(chain.signers.relayer).castVote.staticCall(message.constituencyId, nullifier, 4n, message.deadline, signature), (e) => e.revert?.name === "InvalidAuthorizationSignature");
    });

    it("concurrent casts for one voter: exactly one ballot, one BallotCast, one relayer nonce used, every request resolves", async () => {
      const s = await ready(voter);
      const nonceBefore = await relayerNonce();
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => cast(s, i < 3 ? "same-key-for-first-three" : newKey())));
      for (const r of results) assert.ok([200, 202].includes(r.status), JSON.stringify(r.body));
      assert.equal(new Set(results.map((r) => r.body.data.txHash).filter(Boolean)).size, 1);
      assert.deepEqual(await tallies(), { total: 1n, blr: 1n, c3: 1n, c4: 0n });
      assert.equal((await chain.contract.queryFilter(chain.contract.filters.BallotCast())).length, 1);
      assert.equal(await relayerNonce(), nonceBefore + 1);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });

    it("lost HTTP response: the retry (same or different key) returns the same txHash and changes nothing", async () => {
      const s = await ready(voter);
      const first = await cast(s, "the-original-key-001");
      const nonceAfter = await relayerNonce();
      const again = await cast(s, "the-original-key-001");
      const different = await cast(s, "another-key-entirely-2");
      for (const r of [again, different]) {
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.data, first.body.data);
      }
      assert.deepEqual(await tallies(), { total: 1n, blr: 1n, c3: 1n, c4: 0n });
      assert.equal(await relayerNonce(), nonceAfter);
    });

    it("simultaneous voters share the relayer nonce space without collisions", async () => {
      const voters = await Promise.all([2, 3, 4, 5].map((n) => mkVoter(n)));
      const sessions = [];
      for (const v of voters) sessions.push(await ready(v, "3"));
      const nonceBefore = await relayerNonce();
      const results = await Promise.all(sessions.map((s) => cast(s)));
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200]);
      assert.equal(new Set(results.map((r) => r.body.data.txHash)).size, 4);
      assert.equal((await tallies()).total, 4n);
      assert.equal(await relayerNonce(), nonceBefore + 4);
    });

    it("failure BEFORE broadcast (signing fails): nothing on-chain, ticket and session stay retryable, and a retry then succeeds", async () => {
      const broken = new Wallet(hardhatAccount(1).privateKey);
      broken.signTypedData = async () => { throw new Error("hsm unavailable"); };
      app = build(withSigners({ authority: broken }));
      const s = await ready(voter);
      const res = await cast(s);
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.equal(await chain.contract.nullifierUsed(await nullifierOf(voter)), false);
      assert.deepEqual(await tallies(), { total: 0n, blr: 0n, c3: 0n, c4: 0n });
      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "AUTH_ISSUED");
      assert.equal(ticket.txHash, null);
      assert.equal(await stageOf(s), "AUTH_ISSUED");
      app = build(); // healthy again
      assert.equal((await cast(s)).status, 200);
      assert.equal((await tallies()).total, 1n);
    });

    it("wrong authority: the contract's own check rejects (pre-flight simulation), nothing consumed", async () => {
      app = build(withSigners({ authority: new Wallet(hardhatAccount(5).privateKey) }));
      const s = await ready(voter);
      const res = await cast(s);
      assert.equal(res.body.error.code, "AUTHORIZATION_REJECTED");
      assert.equal(await chain.contract.nullifierUsed(await nullifierOf(voter)), false);
      assert.equal((await ticketOf(voter)).status, "AUTH_ISSUED");
    });

    it("wrong relayer (backend signer is not the contract's relayer): refused before any signing", async () => {
      const other = new Wallet(hardhatAccount(7).privateKey, chain.provider);
      const s0 = Object.create(chain.signers);
      Object.defineProperty(s0, "relayer", { value: other });
      Object.defineProperty(s0, "addresses", { value: { ...chain.signers.addresses, relayer: other.address } });
      app = build({ ...chain, signers: s0 });
      const s = await ready(voter);
      const res = await cast(s);
      assert.equal(res.body.error.code, "CONFIGURATION_ERROR");
      assert.equal((await tallies()).total, 0n);
    });

    it("a non-relayer cannot submit a valid authorization directly (the contract enforces the relayer)", async () => {
      const nullifier = await nullifierOf(voter);
      const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId: 3n, relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
      const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
      await assert.rejects(chain.contract.connect(chain.signers.owner).castVote.staticCall(message.constituencyId, nullifier, 3n, message.deadline, signature), (e) => e.revert?.name === "NotRelayer");
    });

    it("an authorization about to expire is not signed (deadline margin), and stays retryable", async () => {
      const s = await ready(voter);
      clock.advance(85);
      await auth.authenticate(s.token);
      clock.advance(90); // 175 s: session alive, but < 10 s of window left
      const res = await cast(s);
      assert.equal(res.body.error.code, "AUTHORIZATION_EXPIRED");
      assert.equal((await ticketOf(voter)).status, "AUTH_ISSUED");
      assert.equal((await tallies()).total, 0n);
    });

    it("an expired AUTH_ISSUED stage cannot cast", async () => {
      const s = await ready(voter);
      clock.advance(181);
      assert.equal((await cast(s)).body.error.code, "SESSION_EXPIRED");
      assert.equal((await tallies()).total, 0n);
    });

    it("the nullifier is re-checked before casting: a pre-used nullifier submits nothing and is NOT treated as success", async () => {
      const s = await ready(voter);
      await castDirect(voter, 4n); // consumed out of band (no ticket evidence)
      const nonce = await relayerNonce();
      const res = await cast(s);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "RECONCILIATION_REQUIRED");
      assert.equal(await relayerNonce(), nonce, "no transaction was sent");
      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "FAILED");
      assert.equal(ticket.txHash, null);
      assert.equal((await cast(s)).body.error.code, "RECONCILIATION_REQUIRED");
    });

    it("closing the election after AUTH_ISSUED stops the cast; nothing counted", async () => {
      const s = await ready(voter);
      await (await owner().closeElection()).wait();
      const res = await cast(s);
      assert.equal(res.body.error.code, "ELECTION_CLOSED");
      assert.equal((await tallies()).total, 0n);
    });
  });

  describe("ambiguous broadcast and crash recovery", () => {
    it("broadcast accepted but the RPC call throws: recovered from the persisted hash, one ballot, no second transaction", async () => {
      app = build(withProvider({ broadcastTransaction: async (raw) => { await chain.provider.broadcastTransaction(raw); throw new Error("connection reset after acceptance"); } }));
      const s = await ready(voter);
      const nonceBefore = await relayerNonce();
      const res = await cast(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await tallies()).total, 1n);
      assert.equal(await relayerNonce(), nonceBefore + 1);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });

    it("the first broadcast fails before reaching the node: the SAME raw transaction is sent again", async () => {
      let calls = 0;
      const seen = [];
      app = build(withProvider({ broadcastTransaction: async (raw) => { seen.push(raw); if (++calls === 1) throw new Error("socket hang up"); return chain.provider.broadcastTransaction(raw); } }));
      const s = await ready(voter);
      assert.equal((await cast(s)).status, 200);
      assert.equal(seen.length, 2);
      assert.equal(seen[0], seen[1], "identical signed bytes were rebroadcast");
      assert.equal((await tallies()).total, 1n);
    });

    it("the RPC stays down for the broadcast: txHash+rawTx are already persisted; a later retry rebroadcasts the same bytes", async () => {
      let down = true;
      app = build(withProvider({ broadcastTransaction: async (raw) => { if (down) throw new Error("rpc down"); return chain.provider.broadcastTransaction(raw); } }));
      const s = await ready(voter);
      const res = await cast(s);
      assert.equal(res.status, 503);
      const mid = await ticketOf(voter);
      assert.equal(mid.status, "SUBMITTING");
      assert.match(mid.txHash, /^0x[0-9a-f]{64}$/);
      assert.match(mid.rawTx, /^0x02/);
      assert.equal((await tallies()).total, 0n);

      down = false;
      clock.advance(61); // the failed holder's lock expires
      await auth.authenticate(s.token);
      const retry = await cast(s);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.data.txHash, mid.txHash, "same transaction, not a new one");
      assert.equal((await tallies()).total, 1n);
      assert.equal((await ticketOf(voter)).rawTx, null);
      assert.equal(await stageOf(s), "SUBMITTED");
    });

    it("a lost transaction whose nonce was taken by another relayer transaction is detected and the vote restarts cleanly", async () => {
      app = build(withProvider({ broadcastTransaction: async () => { throw new Error("rpc down"); } }));
      const s = await ready(voter);
      assert.equal((await cast(s)).status, 503);
      const lost = await ticketOf(voter);
      await (await chain.signers.relayer.sendTransaction({ to: relayerAddr(), value: 0n })).wait(); // some other relayer tx consumes that nonce
      app = build();
      clock.advance(61);
      await auth.authenticate(s.token);
      const retry = await cast(s);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.notEqual(retry.body.data.txHash, lost.txHash, "the dead transaction was replaced");
      assert.equal((await tallies()).total, 1n);
      assert.equal(await chain.contract.queryFilter(chain.contract.filters.BallotCast()).then((e) => e.length), 1);
    });
  });

  describe("review findings (regressions)", () => {
    const automine = (on) => chain.provider.send("evm_setAutomine", [on]);

    it("concurrent authorize calls with DIFFERENT candidates on an expired ticket: exactly one is acknowledged", async () => {
      const s = await session(voter);
      await authorize(s, "3");
      clock.advance(181);
      await VoterSession.updateMany({}, { active: false });
      const s2 = await session(voter);
      const results = await Promise.all([authorize(s2, "4"), authorize(s2, "5")]);
      const ok = results.filter((r) => r.status === 200);
      assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.body)));
      assert.equal(results.find((r) => r.status !== 200).body.error.code, "AUTHORIZATION_ALREADY_ISSUED");
      const stored = (await ticketOf(voter)).candidateId;
      assert.equal(stored, ok[0] === results[0] ? "4" : "5", "the acknowledged candidate is the stored one");
    });

    it("a reset after an admin moved the voter refreshes the constituency, so the new ballot is castable", async () => {
      const s = await session(voter);
      await authorize(s, "3");
      clock.advance(181);
      await VoterSession.updateMany({}, { active: false });
      await Voter.updateOne({ _id: voter._id }, { constituencyCode: "DL-DEL" });
      const s2 = await session(voter);
      assert.equal((await authorize(s2, "8")).status, 200);
      const ticket = await ticketOf(voter);
      assert.equal(ticket.constituencyCode, "DL-DEL");
      const res = await cast(s2);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await chain.contract.votesOf(8), 1n);
    });

    it("only a REVERTED attempt may be started over; a RECONCILIATION_REQUIRED ticket keeps its evidence", async () => {
      const s = await ready(voter);
      await VoteTicket.updateOne({ voterId: voter._id }, { status: "FAILED", failureCode: "RECONCILIATION_REQUIRED", txHash: "0x" + "ab".repeat(32) });
      await VoterSession.updateMany({}, { active: false });
      const s2 = await session(voter);
      const res = await authorize(s2, "4");
      assert.equal(res.body.error.code, "AUTHORIZATION_ALREADY_ISSUED");
      const t = await ticketOf(voter);
      assert.deepEqual([t.status, t.txHash, t.candidateId], ["FAILED", "0x" + "ab".repeat(32), "3"]);
      // ...whereas a reverted attempt can restart
      await VoteTicket.updateOne({ voterId: voter._id }, { failureCode: "TX_REVERTED", txHash: null });
      assert.equal((await authorize(s2, "4")).status, 200);
      void s;
    });

    it("a stale submitter cannot persist or broadcast after its claim was taken over (fencing)", async () => {
      let broadcasts = 0;
      const stall = withProvider({
        estimateGas: async (req) => {
          // while this request is "stalled" inside the relayer queue, the ticket moves to a new claim epoch
          await VoteTicket.updateOne({ voterId: voter._id }, { claimToken: "someone-else", lockUntil: new Date(Date.now() + 60_000) });
          return chain.provider.estimateGas(req);
        },
        broadcastTransaction: async (raw) => { broadcasts++; return chain.provider.broadcastTransaction(raw); },
      });
      app = build(stall);
      const s = await ready(voter);
      const res = await cast(s);
      assert.equal(res.body.error.code, "CAST_IN_PROGRESS");
      assert.equal(broadcasts, 0, "nothing was broadcast by the stale request");
      assert.equal((await tallies()).total, 0n);
      assert.equal((await ticketOf(voter)).txHash, null);
    });

    it("STRANDED VOTER: broadcast failed, the session died, yet the recovery sweep completes the vote; re-login then says ALREADY_VOTED", async () => {
      let down = true;
      app = build(withProvider({ broadcastTransaction: async (raw) => { if (down) throw new Error("rpc down"); return chain.provider.broadcastTransaction(raw); } }));
      const s = await ready(voter);
      assert.equal((await cast(s)).status, 503);
      assert.equal((await ticketOf(voter)).status, "SUBMITTING");
      down = false;
      clock.advance(400); // idle + stage windows long gone: the voter's session is dead
      assert.equal((await cast(s)).body.error.code, "SESSION_EXPIRED");
      assert.equal(await castSvc.recoverPending({ minAgeMs: 0 }), 1);
      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "CONFIRMED");
      assert.equal(ticket.rawTx, null);
      assert.deepEqual(await tallies(), { total: 1n, blr: 1n, c3: 1n, c4: 0n });
      const again = await request(app).post("/api/v1/voter/auth/login").send({ identifier: voter.voterId, password: PW });
      const token = again.headers["set-cookie"][0].split(";")[0].split("=")[1];
      const row = await VoterSession.findOne({ voterId: voter._id, active: true });
      await auth.transitionStage({ sessionId: row._id, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: new Date(clock.now() + 120_000) });
      assert.equal((await call({ token }, "post", "/eligibility/check")).body.error.code, "ALREADY_VOTED");
    });

    it("the sweep resets a claimed-but-never-broadcast ticket so the voter can authorize again", async () => {
      await ready(voter);
      await VoteTicket.updateOne({ voterId: voter._id }, { status: "SUBMITTING", lockUntil: new Date(clock.now() - 1000), claimToken: "dead-holder" });
      assert.equal(await castSvc.recoverPending({ minAgeMs: 0 }), 1);
      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "AUTH_ISSUED");
      assert.equal(ticket.txHash, null);
    });

    it("a PENDING transaction (no block yet) answers 202 in about one receipt timeout, then completes with the same hash", async () => {
      app = build(chain, { receiptTimeoutMs: 600 });
      const s = await ready(voter);
      await automine(false);
      try {
        const started = Date.now();
        const pending = await cast(s);
        const took = Date.now() - started;
        assert.equal(pending.status, 202, JSON.stringify(pending.body));
        assert.deepEqual([pending.body.data.stage, pending.body.data.state], ["SUBMITTED", "SUBMITTED"]);
        assert.ok(took < 1800, `took ${took}ms (should be ~1 timeout, not 3)`);
        assert.equal((await ticketOf(voter)).status, "SUBMITTED");
        assert.equal(await stageOf(s), "SUBMITTED");
        await chain.provider.send("evm_mine", []);
        await automine(true);
        const done = await cast(s);
        assert.equal(done.status, 200);
        assert.equal(done.body.data.txHash, pending.body.data.txHash);
        assert.equal((await tallies()).total, 1n);
        assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 1);
      } finally {
        await automine(true);
      }
    });

    it("the election closing after the vote mined but before it was confirmed: the sweep still confirms it", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter);
      await automine(false);
      try {
        assert.equal((await cast(s)).status, 202);
        await chain.provider.send("evm_mine", []);
      } finally {
        await automine(true);
      }
      await (await owner().closeElection()).wait();
      assert.equal((await cast(s)).body.error.code, "ELECTION_CLOSED", "the voter's own request ends");
      assert.equal(await castSvc.recoverPending({ minAgeMs: 0 }), 1);
      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "CONFIRMED");
      assert.equal(ticket.rawTx, null);
      assert.equal((await tallies()).total, 1n);
    });

    it("deadlines follow the CHAIN clock: a head far ahead of the server clock does not make authorizations expire early", async () => {
      // (Simulated at the provider: evm_increaseTime would shift the shared dev chain's clock permanently.)
      const aheadBy = 400;
      app = build(withProvider({ getBlock: async (tag) => { const real = await chain.provider.getBlock(tag); return tag === "latest" ? { timestamp: real.timestamp + aheadBy, number: real.number } : real; } }));
      const s = await ready(voter);
      const res = await cast(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const head = (await chain.provider.getBlock("latest")).timestamp;
      const events = await chain.contract.queryFilter(chain.contract.filters.BallotCast());
      assert.equal(events.length, 1);
      const tx = await chain.provider.getTransaction(res.body.data.txHash);
      const decoded = chain.contract.interface.parseTransaction({ data: tx.data });
      assert.ok(Number(decoded.args.deadline) >= head + aheadBy, "the signed deadline is relative to the (simulated) chain head, not the server clock");
    });

    it("a false RECONCILIATION_REQUIRED alarm heals once the receipt is visible", async () => {
      const s = await ready(voter);
      const ok = await cast(s);
      await VoteTicket.updateOne({ voterId: voter._id }, { status: "FAILED", failureCode: "RECONCILIATION_REQUIRED" });
      const healed = await cast(s);
      assert.equal(healed.status, 200, JSON.stringify(healed.body));
      assert.equal(healed.body.data.txHash, ok.body.data.txHash);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });

    it("concurrent casts write exactly one VOTE_CONFIRMED audit row", async () => {
      const s = await ready(voter);
      await Promise.all(Array.from({ length: 5 }, () => cast(s)));
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 1);
    });
  });

  describe("privacy", () => {
    it("responses, logs and audit rows never contain uid, nullifier, signature, rawTx, candidate-with-voter data or secrets", async () => {
      let down = true;
      app = build(withProvider({ broadcastTransaction: async (raw) => { if (down) throw new Error("rpc down"); return chain.provider.broadcastTransaction(raw); } }));
      const s = await ready(voter);
      const failed = await cast(s);
      const rawTx = (await ticketOf(voter)).rawTx;
      down = false;
      clock.advance(61);
      await auth.authenticate(s.token);
      const ok = await cast(s);
      const status = await call(s, "get", "/status");
      const raw = await mongoose.connection.collection("voters_v2").findOne({});
      const nullifier = await nullifierOf(voter);
      const audit = JSON.stringify(await mongoose.connection.collection("auditlogs").find({}).toArray());
      const everything = JSON.stringify([failed.body, ok.body, status.body]) + audit + memory.lines.join("");
      const sec = config.secrets;
      for (const secret of [raw.uid, nullifier, rawTx, s.token, sec.nullifierSecret.toString("hex"), sec.authorityPrivateKey, sec.relayerPrivateKey, sec.authorityPrivateKey.slice(2), sec.relayerPrivateKey.slice(2), PW]) assert.ok(!everything.includes(secret), `leaked ${String(secret).slice(0, 10)}...`);
      assert.ok(!/0x[0-9a-f]{130}\b/.test(everything), "a 65-byte signature appears somewhere");
      assert.ok(!/"candidateId"/.test(audit), "audit rows carry no candidate");
      for (const action of ["VOTE_AUTHORIZATION_ISSUED", "VOTE_SUBMISSION_STARTED", "VOTE_SUBMITTED", "VOTE_CONFIRMED"]) assert.ok(audit.includes(action), action);
    });
  });
});
