import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import { parseEther } from "ethers";
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
import { createPublicService } from "../../src/services/public.service.js";
import { createReceiptService } from "../../src/services/receipt.service.js";
import { createVoterAuthService } from "../../src/services/voterAuth.service.js";
import { generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { hardhatAccount, validEnv } from "../helpers/env.js";

// Step 10: voter receipt, SUBMITTED -> COMPLETED, public verification, Closed-only results. Real chain + disposable Mongo.
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";
let keySeq = 0;
const newKey = () => `test-key-${Date.now()}-${++keySeq}-abcdef`;
const API = "/api/v1";

describe("receipt, completion, public verification and results (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, memory, auth, app, config, relayerQueue, castSvc, publicSvc, t;
  const clock = { now: () => t, advance: (s) => (t += s * 1000) };
  const owner = () => chain.contract.connect(chain.signers.owner);
  const relayerAddr = () => chain.signers.addresses.relayer;
  const automine = (on) => chain.provider.send("evm_setAutomine", [on]);
  const mine = (n = 1) => Promise.all(Array.from({ length: n }, () => chain.provider.send("evm_mine", []))).then(() => {});
  const mkVoter = async (n = 1, over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: `Voter ${n}`, email: `v${n}@example.org`, passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });
  const withProvider = (overrides) => ({ ...chain, provider: new Proxy(chain.provider, { get: (target, p) => overrides[p] ?? (typeof target[p] === "function" ? target[p].bind(target) : target[p]) }) });
  const withContract = (overrides) => ({ ...chain, contract: new Proxy(chain.contract, { get: (target, p) => overrides[p] ?? (typeof target[p] === "function" ? target[p].bind(target) : target[p]) }) });

  const build = (appChain = chain, { receiptTimeoutMs = 4000, publicReceiptRateLimit = { windowMs: 60_000, limit: 10_000 } } = {}) => {
    const audit = createAuditService({ AuditLog, logger: memory.logger, now: clock.now });
    auth = createVoterAuthService({ Voter, VoterSession, chain: appChain, audit, now: clock.now, bcryptCost: 4 });
    const common = { Voter, authService: auth, audit, now: clock.now };
    const secret = config.secrets.nullifierSecret;
    castSvc = createCastService({ ...common, VoteTicket, chain: appChain, relayerQueue, waitNow: Date.now, receiptTimeoutMs, pollMs: 20 });
    const receiptService = createReceiptService({ ...common, VoteTicket, castService: castSvc, chain: appChain, nullifierSecret: secret });
    publicSvc = createPublicService({ chain: appChain, audit });
    return createApp({
      config,
      logger: memory.logger,
      healthService: { getPublicHealth: async () => ({ status: "ok" }) },
      voter: {
        authService: auth,
        eligibilityService: createEligibilityService({ ...common, chain: appChain, nullifierSecret: secret, receiptService }),
        authorizationService: createAuthorizationService({ ...common, VoteTicket, chain: appChain, nullifierSecret: secret }),
        castService: castSvc,
        receiptService,
      },
      publicService: publicSvc,
      voterLoginRateLimit: { windowMs: 60_000, limit: 10_000 },
      publicReceiptRateLimit: publicReceiptRateLimit ?? undefined, // null = the route default
    });
  };

  const login = async (voter) => {
    const res = await request(app).post(`${API}/voter/auth/login`).send({ identifier: voter.voterId, password: PW });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const token = res.headers["set-cookie"][0].split(";")[0].split("=")[1];
    const row = await VoterSession.findOne({ voterId: voter._id, active: true });
    return { token, sessionId: row._id, voter };
  };
  const toFaceVerified = async (s) => assert.equal(await auth.transitionStage({ sessionId: s.sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: new Date(clock.now() + 120_000) }), true);
  const call = (s, method, path, body, headers = {}) => {
    const r = request(app)[method](`${API}/voter${path}`).set("Cookie", `vc_voter=${s.token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return method === "get" ? r : r.send(body ?? {});
  };
  const session = async (voter, upTo = "ELIGIBLE") => {
    const s = await login(voter);
    if (upTo === "AUTHENTICATED") return s;
    await toFaceVerified(s);
    if (upTo === "FACE_VERIFIED") return s;
    assert.equal((await call(s, "post", "/eligibility/check")).status, 200);
    return s;
  };
  const cast = (s) => call(s, "post", "/cast", {}, { "Idempotency-Key": newKey() });
  const ready = async (voter, candidateId = "3") => {
    const s = await session(voter);
    assert.equal((await call(s, "post", "/authorization", { candidateId })).status, 200);
    return s;
  };
  /** A voter who has voted: a SUBMITTED session with a CONFIRMED ticket. */
  const vote = async (voter, candidateId = "3") => {
    const s = await ready(voter, candidateId);
    const res = await cast(s);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { s, txHash: res.body.data.txHash };
  };
  const receipt = (s) => call(s, "get", "/receipt");
  const stageOf = async (s) => (await VoterSession.findById(s.sessionId)).stage;
  const ticketOf = (voter) => VoteTicket.findOne({ voterId: voter._id }).select("+rawTx +candidateId +nullifier");
  const nullifierOf = async (voter) => deriveNullifier({ secret: config.secrets.nullifierSecret, electionId: chain.deployment.electionId, voterUid: (await Voter.findById(voter._id).select("+uid")).uid });
  const castDirect = async (voter, candidateId = 3n) => {
    const nullifier = await nullifierOf(voter);
    const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId, relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
    const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
    return (await chain.contract.connect(chain.signers.relayer).castVote(message.constituencyId, nullifier, candidateId, message.deadline, signature)).wait();
  };
  const pub = (path) => request(app).get(`${API}/public${path}`);
  const publicReceipt = (txHash) => pub(`/receipts/${txHash}`);
  const closeElection = async () => (await owner().closeElection()).wait();
  const auditRows = () => mongoose.connection.collection("auditlogs").find({}).toArray();

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
    assert.ok(drift < 180, `the shared chain clock was left shifted ahead by ${drift}s`);
  });
  beforeEach(async () => {
    snap = await snapshot(chain.provider);
    await mongoose.connection.dropDatabase();
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), VoteTicket.syncIndexes(), AuditLog.syncIndexes()]);
    t = Date.now();
    memory = createMemoryLogger();
    relayerQueue = createRelayerQueue();
    app = build();
    voter = await mkVoter();
    await (await owner().openElection()).wait();
  });
  afterEach(async () => {
    await automine(true);
    await revertTo(chain.provider, snap);
  });

  describe("voter receipt", () => {
    it("needs a session and a stage that has reached (or may have reached) the chain", async () => {
      assert.equal((await request(app).get(`${API}/voter/receipt`)).status, 401);
      for (const upTo of ["AUTHENTICATED", "FACE_VERIFIED", "ELIGIBLE"]) {
        await VoterSession.updateMany({}, { active: false });
        const s = await session(voter, upTo);
        assert.equal((await receipt(s)).body.error.code, "STAGE_REQUIRED", upTo);
      }
      await VoterSession.updateMany({}, { active: false });
      const s = await ready(voter); // AUTH_ISSUED, nothing submitted
      const res = await receipt(s);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "STAGE_REQUIRED");
      assert.equal(await stageOf(s), "AUTH_ISSUED");
    });

    it("a confirmed vote yields the canonical receipt and SUBMITTED -> COMPLETED (60 s window)", async () => {
      const { s, txHash } = await vote(voter, "3");
      assert.equal(await stageOf(s), "SUBMITTED");
      const res = await receipt(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { data } = res.body;
      assert.equal(data.stage, "COMPLETED");
      assert.equal(data.state, "CONFIRMED");
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal(+new Date(data.stageExpiresAt), clock.now() + 60_000);

      const chainReceipt = await chain.provider.getTransactionReceipt(txHash);
      const nullifier = await nullifierOf(voter);
      assert.deepEqual(Object.keys(data.receipt).sort(), ["ballotIndex", "blockHash", "blockNumber", "chainId", "confirmedAt", "contractAddress", "electionId", "txHash", "verifyUrl"]);
      assert.deepEqual(
        { ...data.receipt, confirmedAt: undefined },
        {
          txHash,
          blockNumber: chainReceipt.blockNumber,
          blockHash: chainReceipt.blockHash,
          ballotIndex: String(await chain.contract.ballotIndexOf(nullifier)),
          contractAddress: chain.deployment.contractAddress,
          chainId: chain.deployment.chainId,
          electionId: chain.deployment.electionId,
          confirmedAt: undefined,
          verifyUrl: `/api/v1/public/receipts/${txHash}`,
        },
      );
      assert.equal(data.receipt.confirmedAt, new Date((await chain.provider.getBlock(chainReceipt.blockNumber)).timestamp * 1000).toISOString());
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_RECEIPT_ISSUED" }), 1);
    });

    it("the portable receipt holds no candidate, nullifier, uid or voter data; recordedSelection is a separate, name-only field", async () => {
      const { s } = await vote(voter, "3");
      const { data } = (await receipt(s)).body;
      const portable = JSON.stringify(data.receipt);
      const secrets = [await nullifierOf(voter), (await Voter.findById(voter._id).select("+uid")).uid, voter.voterId, voter.email, "Neha Joshi", s.token];
      for (const secret of secrets) assert.ok(!portable.includes(secret), `receipt leaks ${String(secret).slice(0, 8)}`);
      assert.ok(!/candidate|nullifier|uid|voter|signature|rawTx|session|constituency/i.test(portable));
      assert.deepEqual(data.recordedSelection, { name: "Neha Joshi" }, "candidate 3 in Bengaluru; the name only, never the id");
      const outside = JSON.stringify({ ...data, receipt: undefined, recordedSelection: undefined });
      assert.ok(!outside.includes("Neha"));
      assert.ok(!JSON.stringify(data).match(/signature|rawTx|"candidateId"|nullifier/i));
    });

    it("repeated retrieval is idempotent: the same receipt, COMPLETED stays COMPLETED, one issue event", async () => {
      const { s } = await vote(voter);
      const first = (await receipt(s)).body.data;
      const second = (await receipt(s)).body.data;
      const third = (await receipt(s)).body.data;
      assert.deepEqual(second.receipt, first.receipt);
      assert.deepEqual(third.receipt, first.receipt);
      assert.deepEqual(third.recordedSelection, first.recordedSelection);
      assert.equal(+new Date(third.stageExpiresAt), +new Date(first.stageExpiresAt), "re-reading does not extend the completed window");
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_RECEIPT_ISSUED" }), 1);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });

    it("the COMPLETED window is short: after 60 s the session is gone, and logout from COMPLETED ends it at once", async () => {
      const { s } = await vote(voter);
      await receipt(s);
      clock.advance(61);
      const expired = await receipt(s);
      assert.equal(expired.status, 401);
      assert.equal(expired.body.error.code, "SESSION_EXPIRED");

      await VoterSession.updateMany({}, { active: false });
      const again = await vote(await mkVoter(2));
      await receipt(again.s);
      assert.equal((await request(app).post(`${API}/voter/auth/logout`).set("Cookie", `vc_voter=${again.s.token}`)).status, 204);
      assert.equal((await receipt(again.s)).status, 401);
    });

    it("works after the election CLOSES, while every voting action stays closed", async () => {
      const { s, txHash } = await vote(voter, "3");
      await closeElection();
      const res = await receipt(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.receipt.txHash, txHash);
      assert.equal(res.body.data.stage, "COMPLETED");
      // the same COMPLETED session is still served, and /status shows the phase
      assert.equal((await receipt(s)).status, 200);
      const status = await call(s, "get", "/status");
      assert.equal(status.status, 200);
      assert.equal(status.body.data.electionPhase, "Closed");
      // ...but nothing that votes works any more
      for (const [method, path, body] of [["post", "/eligibility/check"], ["get", "/ballot"], ["post", "/authorization", { candidateId: "3" }]]) {
        assert.equal((await call(s, method, path, body)).body.error.code, "ELECTION_CLOSED", path);
      }
      assert.equal((await cast(s)).body.error.code, "ELECTION_CLOSED");
      assert.equal((await request(app).post(`${API}/voter/auth/login`).send({ identifier: voter.voterId, password: PW })).body.error.code, "ELECTION_CLOSED");
    });

    it("a session that never voted gets nothing from a Closed election (receipt and status both refuse)", async () => {
      const early = await session(voter, "ELIGIBLE");
      const authenticated = await login(await mkVoter(2));
      await closeElection();
      for (const s of [early, authenticated]) {
        assert.equal((await receipt(s)).body.error.code, "ELECTION_CLOSED");
        assert.equal((await call(s, "get", "/status")).body.error.code, "ELECTION_CLOSED");
      }
    });

    it("a SUBMITTED session whose vote was confirmed by the sweep can fetch its receipt after close", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      await automine(false);
      assert.equal((await cast(s)).status, 202);
      await mine();
      await automine(true);
      await closeElection();
      assert.equal(await castSvc.recoverPending({ minAgeMs: 0 }), 1);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
      const res = await receipt(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await stageOf(s), "COMPLETED");
    });

    it("a PENDING transaction answers with a safe pending state, then completes once mined", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      await automine(false);
      const submitted = await cast(s);
      assert.equal(submitted.status, 202);
      const pending = await receipt(s);
      assert.equal(pending.status, 202, JSON.stringify(pending.body));
      assert.deepEqual(pending.body.data, { stage: "SUBMITTED", state: "PENDING", txHash: submitted.body.data.txHash });
      assert.equal(await stageOf(s), "SUBMITTED", "not completed while pending");
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_RECEIPT_ISSUED" }), 0);
      await mine();
      await automine(true);
      const done = await receipt(s);
      assert.equal(done.status, 200);
      assert.equal(done.body.data.receipt.txHash, submitted.body.data.txHash);
      assert.equal(await stageOf(s), "COMPLETED");
    });

    it("a lost transaction in a Closed election is reported as NOT RECORDED, never as a receipt", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      await automine(false);
      const submitted = await cast(s);
      assert.equal(submitted.status, 202);
      await chain.provider.send("hardhat_dropTransaction", [submitted.body.data.txHash]);
      await automine(true);
      await closeElection();
      const res = await receipt(s);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "VOTE_NOT_RECORDED");
      assert.equal(await chain.contract.totalBallots(), 0n);
      assert.equal(await stageOf(s), "SUBMITTED");
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_RECEIPT_ISSUED" }), 0);
    });

    it("not final before the configured confirmations; then final", async () => {
      const slow = { ...chain, confirmations: 3 };
      app = build(slow, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      const submitted = await cast(s);
      assert.equal(submitted.status, 202, "mined once, but only 1 of 3 confirmations");
      assert.equal((await ticketOf(voter)).status, "SUBMITTED");
      assert.equal((await receipt(s)).status, 202);
      assert.equal((await publicReceipt(submitted.body.data.txHash)).body.data.status, "CONFIRMING");
      await mine(2);
      const done = await receipt(s);
      assert.equal(done.status, 200, JSON.stringify(done.body));
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
      assert.equal((await publicReceipt(submitted.body.data.txHash)).body.data.status, "CONFIRMED");
    });

    it("FALSE RECEIPTS REFUSED: a ticket pointing at somebody else's valid ballot, or an altered choice, never yields a receipt", async () => {
      const mine1 = await vote(voter, "3");
      const other = await mkVoter(2);
      const theirs = await vote(other, "4");
      assert.equal((await receipt(mine1.s)).status, 200);

      // 1) ticket.txHash replaced with the other voter's (genuine, confirmed) ballot transaction
      await VoterSession.updateMany({}, { active: false });
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { txHash: theirs.txHash } });
      const s1 = await login(voter);
      await VoterSession.updateOne({ _id: s1.sessionId }, { $set: { stage: "SUBMITTED", stageExpiresAt: new Date(clock.now() + 60_000) } });
      assert.equal((await receipt(s1)).body.error.code, "RECEIPT_INVALID");

      // 2) ticket rewritten to the other voter's candidate and a foreign nullifier (the unique index forbids reusing theirs): the chain event disagrees
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { nullifier: "0x" + "5a".repeat(32), candidateId: "4", txHash: theirs.txHash } });
      assert.equal((await receipt(s1)).body.error.code, "RECEIPT_INVALID");

      // 3) an altered candidate on an otherwise genuine ticket
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { nullifier: await nullifierOf(voter), candidateId: "4", txHash: mine1.txHash } });
      assert.equal((await receipt(s1)).body.error.code, "RECEIPT_INVALID");

      // 4) an unknown transaction hash on a CONFIRMED ticket
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { candidateId: "3", txHash: "0x" + "ab".repeat(32) } });
      assert.equal((await receipt(s1)).body.error.code, "RECEIPT_NOT_FOUND");
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_RECEIPT_ISSUED" }), 1, "only the genuine first receipt was ever issued");
    });

    it("a reverted or no-event transaction hash on a CONFIRMED ticket is refused", async () => {
      const { s } = await vote(voter, "3");
      const wrong = await (await chain.signers.owner.sendTransaction({ to: hardhatAccount(9).address, value: parseEther("0.01") })).wait();
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { txHash: wrong.hash } });
      assert.equal((await receipt(s)).body.error.code, "RECEIPT_INVALID");
    });
  });

  describe("recovery", () => {
    it("lost response: the vote was counted but the client never saw it; the receipt call recovers everything", async () => {
      const { s, txHash } = await vote(voter, "3"); // pretend the 200 never arrived
      const res = await receipt(s);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.receipt.txHash, txHash);
    });

    it("backend restart while the vote is in flight: a brand-new service instance finishes it from the persisted ticket", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      await automine(false);
      assert.equal((await cast(s)).status, 202);
      await mine();
      await automine(true);
      relayerQueue = createRelayerQueue();
      app = build(); // "restart": nothing in memory survives
      const res = await receipt(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(await chain.contract.totalBallots(), 1n);
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 1);
    });

    it("browser closed, session expired, voter returns: password + face lead to ALREADY_VOTED that points at the existing receipt", async () => {
      const first = await vote(voter, "3");
      clock.advance(10 * 60 + 1); // the old session is dead
      assert.equal((await receipt(first.s)).status, 401);

      const s = await login(voter);
      // face verification is NOT skipped: before it, neither eligibility nor the receipt is reachable
      assert.equal((await call(s, "post", "/eligibility/check")).body.error.code, "STAGE_REQUIRED");
      assert.equal((await receipt(s)).body.error.code, "STAGE_REQUIRED");
      await toFaceVerified(s);
      const eligibility = await call(s, "post", "/eligibility/check");
      assert.equal(eligibility.status, 409);
      assert.equal(eligibility.body.error.code, "ALREADY_VOTED");
      assert.deepEqual(eligibility.body.error.details, { receiptAvailable: true, stage: "COMPLETED" });
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_RECEIPT_RECOVERED" }), 1);

      const res = await receipt(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.receipt.txHash, first.txHash);
      assert.equal(res.body.data.recordedSelection.name, "Neha Joshi");
      assert.equal((await chain.contract.totalBallots()), 1n, "and no second vote is possible");
      assert.equal((await call(s, "post", "/authorization", { candidateId: "4" })).body.error.code, "STAGE_REQUIRED");
    });

    it("re-login with a stranded SUBMITTED ticket (mined, never confirmed): eligibility reconciles it and recovers the receipt", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const first = await ready(voter, "3");
      await automine(false);
      assert.equal((await cast(first)).status, 202);
      await mine();
      await automine(true);
      assert.equal((await ticketOf(voter)).status, "SUBMITTED");
      clock.advance(10 * 60 + 1);

      const s = await login(voter);
      await toFaceVerified(s);
      const eligibility = await call(s, "post", "/eligibility/check");
      assert.equal(eligibility.body.error.code, "ALREADY_VOTED");
      assert.equal(eligibility.body.error.details.receiptAvailable, true);
      assert.equal((await receipt(s)).status, 200);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });

    it("ALREADY_VOTED with NO local evidence claims no receipt: nothing is fabricated and the session does not advance", async () => {
      await castDirect(voter, 3n); // on-chain, but this server has no ticket for it
      const s = await login(voter);
      await toFaceVerified(s);
      const eligibility = await call(s, "post", "/eligibility/check");
      assert.equal(eligibility.status, 409);
      assert.equal(eligibility.body.error.code, "ALREADY_VOTED");
      assert.deepEqual(eligibility.body.error.details, { receiptAvailable: false });
      assert.equal(await stageOf(s), "FACE_VERIFIED");
      assert.equal((await receipt(s)).body.error.code, "STAGE_REQUIRED");
      assert.equal(await AuditLog.countDocuments({ action: { $in: ["VOTER_RECEIPT_RECOVERED", "VOTER_RECEIPT_ISSUED"] } }), 0);
    });

    it("ALREADY_VOTED where the local ticket is not this voter's ballot (altered) claims no receipt", async () => {
      const mine1 = await vote(voter, "3");
      const theirs = await vote(await mkVoter(2), "4");
      void mine1;
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { txHash: theirs.txHash } });
      await VoterSession.updateMany({}, { active: false });
      const s = await login(voter);
      await toFaceVerified(s);
      const eligibility = await call(s, "post", "/eligibility/check");
      assert.equal(eligibility.body.error.code, "ALREADY_VOTED");
      assert.equal(eligibility.body.error.details.receiptAvailable, false);
      assert.equal(await stageOf(s), "FACE_VERIFIED");
    });

    it("returning while the vote is still in the mempool: VOTE_IN_FLIGHT, no ballot offered; after it mines the receipt is recoverable", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const first = await ready(voter, "3");
      await automine(false);
      const submitted = await cast(first);
      assert.equal(submitted.status, 202);
      clock.advance(10 * 60 + 1);
      const s = await login(voter);
      await toFaceVerified(s);
      const res = await call(s, "post", "/eligibility/check");
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "VOTE_IN_FLIGHT");
      assert.equal(await stageOf(s), "FACE_VERIFIED");
      await mine();
      await automine(true);
      const again = await call(s, "post", "/eligibility/check");
      assert.equal(again.body.error.code, "ALREADY_VOTED");
      assert.equal(again.body.error.details.receiptAvailable, true);
      assert.equal((await receipt(s)).body.data.receipt.txHash, submitted.body.data.txHash);
    });

    it("a voter who has NOT voted never gets receipt details from eligibility", async () => {
      const s = await session(voter, "FACE_VERIFIED");
      const res = await call(s, "post", "/eligibility/check");
      assert.equal(res.status, 200);
      assert.equal(res.body.data.eligible, true);
    });
  });

  describe("public receipt verification", () => {
    it("recognises a VoteChain ballot without any login, and hides the candidate before Closed", async () => {
      const { txHash } = await vote(voter, "3");
      const res = await publicReceipt(txHash);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { data } = res.body;
      const chainReceipt = await chain.provider.getTransactionReceipt(txHash);
      assert.equal(data.found, true);
      assert.equal(data.status, "CONFIRMED");
      assert.equal(data.txHash, txHash);
      assert.equal(data.blockNumber, chainReceipt.blockNumber);
      assert.equal(data.ballotIndex, "1");
      assert.equal(data.electionId, chain.deployment.electionId);
      assert.deepEqual(data.constituency, { code: "KA-BLR", name: "Bengaluru" });
      assert.match(data.statement, /does not identify the voter/);
      assert.match(data.statement, /canonical chain/);
      const text = JSON.stringify(res.body);
      assert.ok(!("candidate" in data));
      assert.ok(!/Neha|candidateId|nullifier|votes|tally|voterId|uid/i.test(text), text);
      assert.ok(!text.includes(await nullifierOf(voter)));
      assert.equal((await pub(`/receipts/${txHash.toUpperCase().replace("0X", "0x")}`)).status, 200, "hash case does not matter");
    });

    it("even after Closed the public receipt NEVER returns the candidate (nor any voter identity)", async () => {
      const { txHash } = await vote(voter, "3");
      await closeElection();
      const res = await publicReceipt(txHash);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, "CONFIRMED");
      assert.ok(!("candidate" in res.body.data));
      assert.ok(!JSON.stringify(res.body).match(/Neha|candidate|nullifier|voterId|email|uid/i), res.text);
    });

    it("rejects malformed hashes (400), unknown hashes (404), extra query (400)", async () => {
      for (const bad of ["0x1234", "nothex", "0x" + "g".repeat(64), "0x" + "a".repeat(63), "0x" + "a".repeat(65), "%00", "..%2f..", "0x" + "a".repeat(64) + "x"]) {
        const res = await pub(`/receipts/${bad}`);
        assert.equal(res.status, 400, bad);
        assert.equal(res.body.error.code, "VALIDATION_FAILED", bad);
      }
      const unknown = await publicReceipt("0x" + "ab".repeat(32));
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error.code, "RECEIPT_NOT_FOUND");
      assert.equal((await pub(`/receipts/${"0x" + "ab".repeat(32)}?x=1`)).status, 400);
    });

    it("rejects a successful transaction to a DIFFERENT address, a reverted VoteChain call and a call that emits no BallotCast", async () => {
      await vote(voter, "3");
      const transfer = await (await chain.signers.owner.sendTransaction({ to: hardhatAccount(9).address, value: parseEther("0.01") })).wait();
      const wrongContract = await publicReceipt(transfer.hash);
      assert.equal(wrongContract.status, 422);
      assert.equal(wrongContract.body.error.code, "RECEIPT_INVALID");

      // a reverted castVote (expired deadline), forced onto the chain with an explicit gas limit
      const nullifier = "0x" + "77".repeat(32);
      const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId: 3n, relayer: relayerAddr(), deadline: 1n });
      const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
      // (the dev node mines it and reports the revert as an error that carries the hash)
      const revertedHash = await chain.contract.connect(chain.signers.relayer).castVote(message.constituencyId, nullifier, 3n, 1n, signature, { gasLimit: 400_000 }).then((tx) => tx.hash, (e) => e.error?.data?.txHash);
      assert.match(revertedHash, /^0x[0-9a-f]{64}$/);
      assert.equal((await chain.provider.getTransactionReceipt(revertedHash)).status, 0);
      const r = await publicReceipt(revertedHash);
      assert.equal(r.status, 422);
      assert.equal(r.body.error.code, "RECEIPT_INVALID");

      // a successful call to the real contract that is not a ballot
      const admin = await (await owner().setAuthoritySigner(chain.signers.addresses.authority)).wait();
      assert.equal(admin.status, 1);
      const noEvent = await publicReceipt(admin.hash);
      assert.equal(noEvent.status, 422);
      assert.equal(noEvent.body.error.code, "RECEIPT_INVALID");
    });

    it("a transaction that is still pending is reported as such (no verdict yet)", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      await automine(false);
      const submitted = await cast(s);
      assert.equal(submitted.status, 202);
      const res = await publicReceipt(submitted.body.data.txHash);
      assert.equal(res.status, 202);
      assert.deepEqual(res.body.data, { found: true, status: "PENDING", txHash: submitted.body.data.txHash });
    });

    it("is rate limited per IP (default 30 per minute) and survives a chain outage with a safe error", async () => {
      app = build(chain, { publicReceiptRateLimit: null });
      const bad = "0x" + "ab".repeat(32);
      let last;
      for (let i = 0; i < 31; i++) last = await publicReceipt(bad);
      assert.equal(last.status, 429);
      assert.equal(last.body.error.code, "RATE_LIMITED");

      app = build(withProvider({ getTransaction: async () => { throw new Error("secret rpc detail http://10.0.0.1:8545/KEY"); } }));
      const down = await publicReceipt(bad);
      assert.equal(down.status, 503);
      assert.equal(down.body.error.code, "CHAIN_UNAVAILABLE");
      assert.ok(!JSON.stringify(down.body).match(/secret|10\.0\.0\.1|KEY/));
    });
  });

  describe("public election", () => {
    it("serves safe public information without authentication and never any count", async () => {
      await vote(voter, "3");
      const res = await pub("/election");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { data } = res.body;
      assert.equal(data.phase, "Open");
      assert.equal(data.electionId, chain.deployment.electionId);
      assert.equal(data.contractAddress, chain.deployment.contractAddress);
      assert.equal(data.chainId, chain.deployment.chainId);
      const blr = data.constituencies.find((c) => c.code === "KA-BLR");
      assert.equal(blr.name, "Bengaluru");
      assert.deepEqual(blr.candidates[2], { candidateId: "3", name: "Neha Joshi" });
      assert.equal(blr.candidates.length, 7);
      const keys = JSON.stringify(res.body);
      assert.ok(!/votes|total|tally|ballots|count/i.test(keys), keys);
      assert.ok(!/owner|relayer|signer|private|mongo|rpc/i.test(keys));
      assert.equal((await pub("/election?x=1")).status, 400);
    });

    it("works in Setup too (before the election opens)", async () => {
      await revertTo(chain.provider, snap); // back to Setup
      snap = await snapshot(chain.provider);
      const res = await pub("/election");
      assert.equal(res.body.data.phase, "Setup");
      assert.ok(res.body.data.constituencies.length >= 3);
    });
  });

  describe("closed-only results", () => {
    const voteIn = async (n, constituencyCode, candidateId) => vote(await mkVoter(n, { constituencyCode }), String(candidateId));

    it("403 RESULTS_NOT_AVAILABLE in Setup and in Open (even with ballots cast); no partial tally", async () => {
      await revertTo(chain.provider, snap);
      snap = await snapshot(chain.provider);
      let res = await pub("/results");
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "RESULTS_NOT_AVAILABLE");

      await (await owner().openElection()).wait();
      await voteIn(5, "KA-BLR", 3);
      res = await pub("/results");
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "RESULTS_NOT_AVAILABLE");
      assert.deepEqual(Object.keys(res.body), ["error"]);
      assert.deepEqual(Object.keys(res.body.error).sort(), ["code", "message", "requestId"]);
    });

    it("200 when Closed: grouped BY CONSTITUENCY with correct votes, constituency totals and totalBallots (no cross-constituency mixing)", async () => {
      await voteIn(5, "KA-BLR", 3);
      await voteIn(6, "KA-BLR", 3);
      await voteIn(7, "KA-BLR", 4);
      await voteIn(8, "DL-DEL", 8);
      await closeElection();
      const res = await pub("/results");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { data } = res.body;
      assert.equal(data.phase, "Closed");
      assert.equal(data.electionId, chain.deployment.electionId);
      assert.equal(data.totalBallots, "4");
      assert.match(res.headers["cache-control"], /public/);
      assert.match(data.notice, /an external observer can derive interim counts/);

      const byCode = Object.fromEntries(data.constituencies.map((c) => [c.code, c]));
      assert.equal(byCode["KA-BLR"].totalVotes, "3");
      assert.equal(byCode["DL-DEL"].totalVotes, "1");
      const votes = (code) => Object.fromEntries(byCode[code].candidates.map((c) => [c.candidateId, c.votes]));
      assert.equal(votes("KA-BLR")["3"], "2");
      assert.equal(votes("KA-BLR")["4"], "1");
      assert.equal(votes("DL-DEL")["8"], "1");
      // grouping: a candidate id only ever appears inside its own constituency
      assert.ok(!("8" in votes("KA-BLR")) && !("3" in votes("DL-DEL")));
      const sum = (code) => byCode[code].candidates.reduce((a, c) => a + BigInt(c.votes), 0n);
      for (const c of data.constituencies) assert.equal(sum(c.code), BigInt(c.totalVotes), c.code);
      assert.equal(data.constituencies.reduce((a, c) => a + BigInt(c.totalVotes), 0n), BigInt(data.totalBallots));
      assert.equal(byCode["KA-BLR"].candidates.length, 7, "candidates without votes are listed with 0");
      assert.equal(byCode["KA-BLR"].candidates.find((c) => c.candidateId === "1").votes, "0");
      assert.equal(byCode["KA-BLR"].candidates.find((c) => c.candidateId === "3").name, "Neha Joshi");
      assert.ok(!("winner" in data) && !data.constituencies.some((c) => "winner" in c), "no global winner is declared");
      assert.ok(Object.values(data).every((v) => typeof v !== "bigint"));
      assert.ok(!JSON.stringify(data).match(/nullifier|voterId|uid|txHash/i));
    });

    it("a Closed election with no ballots publishes zeros; repeated reads are identical and the publication is audited once", async () => {
      await closeElection();
      const first = await pub("/results");
      const second = await pub("/results");
      assert.equal(first.status, 200);
      assert.deepEqual(second.body, first.body);
      assert.equal(first.body.data.totalBallots, "0");
      assert.ok(first.body.data.constituencies.every((c) => c.totalVotes === "0" && c.candidates.every((x) => x.votes === "0")));
      assert.equal(await AuditLog.countDocuments({ action: "RESULTS_PUBLISHED" }), 1);
    });

    it("INCONSISTENT tallies are never served: RESULT_INCONSISTENCY, audited (rate limited), safe body", async () => {
      await voteIn(5, "KA-BLR", 3);
      await closeElection();
      const lying = (name, value) => withContract({ [name]: async (...args) => value(await chain.contract[name](...args)) });
      for (const [label, patched] of [
        ["a candidate tally is off by one", lying("votesOf", (v) => v + 1n)],
        ["a constituency total is off", lying("constituencyTotal", (v) => v + 1n)],
        ["totalBallots is off", lying("totalBallots", (v) => v + 1n)],
      ]) {
        app = build(patched);
        const res = await pub("/results");
        assert.equal(res.status, 500, label);
        assert.equal(res.body.error.code, "RESULT_INCONSISTENCY", label);
        assert.ok(!res.body.data, label);
        assert.ok(!/\d{2,}|votes|Neha/.test(res.body.error.message), "no numbers in the error");
      }
      assert.equal(await AuditLog.countDocuments({ action: "RESULT_INCONSISTENCY" }), 3, "one per service instance within the window");
      app = build(lying("votesOf", (v) => v + 1n));
      await pub("/results");
      await pub("/results");
      assert.equal(await AuditLog.countDocuments({ action: "RESULT_INCONSISTENCY" }), 4, "repeated failures inside the window audit once");
      assert.equal(await AuditLog.countDocuments({ action: "RESULTS_PUBLISHED" }), 0);
    });

    it("a burst of first-time requests shares one build: one RESULTS_PUBLISHED row; a bad tally is not re-assembled on every request", async () => {
      await voteIn(5, "KA-BLR", 3);
      await closeElection();
      const burst = await Promise.all(Array.from({ length: 10 }, () => pub("/results")));
      assert.ok(burst.every((r) => r.status === 200));
      assert.equal(await AuditLog.countDocuments({ action: "RESULTS_PUBLISHED" }), 1);

      let reads = 0;
      app = build(withContract({ votesOf: async (id) => { reads++; return (await chain.contract.votesOf(id)) + 1n; } }));
      assert.equal((await pub("/results")).body.error.code, "RESULT_INCONSISTENCY");
      const afterFirst = reads;
      for (let i = 0; i < 5; i++) assert.equal((await pub("/results")).body.error.code, "RESULT_INCONSISTENCY");
      assert.equal(reads, afterFirst, "no further RPC work inside the negative-cache window");
    });

    it("concurrent /election requests share one structure read and the structure is then served from memory", async () => {
      let calls = 0;
      app = build(withContract({ getConstituency: async (id) => { calls++; return chain.contract.getConstituency(id); } }));
      assert.ok((await Promise.all(Array.from({ length: 10 }, () => pub("/election")))).every((r) => r.status === 200));
      const first = calls;
      assert.ok(first <= 10, `one build, not ten (${first} constituency reads)`);
      await pub("/election");
      assert.equal(calls, first, "cached once the election is no longer in Setup");
    });

    it("an unreachable chain gives a safe CHAIN_UNAVAILABLE, never partial data", async () => {
      await closeElection();
      app = build(withContract({ phase: async () => { throw new Error("ECONNREFUSED 127.0.0.1:8545"); } }));
      const res = await pub("/results");
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, "CHAIN_UNAVAILABLE");
      assert.ok(!JSON.stringify(res.body).includes("ECONNREFUSED"));
    });
  });

  describe("completion", () => {
    it("concurrent receipt calls complete the session exactly once and agree on one canonical receipt", async () => {
      const { s } = await vote(voter, "3");
      const results = await Promise.all(Array.from({ length: 8 }, () => receipt(s)));
      for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(new Set(results.map((r) => JSON.stringify(r.body.data.receipt))).size, 1);
      assert.equal(new Set(results.map((r) => r.body.data.recordedSelection.name)).size, 1);
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal(await AuditLog.countDocuments({ action: "VOTER_RECEIPT_ISSUED" }), 1);
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 1);
      assert.equal(await chain.contract.totalBallots(), 1n);
      assert.equal(await VoteTicket.countDocuments({}), 1);
    });

    it("COMPLETED sessions cannot vote again: nothing at the voting endpoints works", async () => {
      const { s } = await vote(voter, "3");
      await receipt(s);
      for (const [method, path, body] of [["post", "/eligibility/check"], ["get", "/ballot"], ["post", "/authorization", { candidateId: "4" }]]) {
        assert.equal((await call(s, method, path, body)).body.error.code, "STAGE_REQUIRED", path);
      }
      assert.equal((await cast(s)).body.error.code, "STAGE_REQUIRED");
      assert.equal(await chain.contract.totalBallots(), 1n);
    });
  });

  describe("privacy", () => {
    it("no response, log or audit row mixes voter identity with a candidate, and none holds uid, nullifier, signature, rawTx, keys or tokens", async () => {
      const first = await vote(voter, "3");
      const r1 = await receipt(first.s);
      const r2 = await receipt(first.s);
      // recovery path too
      clock.advance(10 * 60 + 1);
      const s2 = await login(voter);
      await toFaceVerified(s2);
      const eligibility = await call(s2, "post", "/eligibility/check");
      const r3 = await receipt(s2);
      const status = await call(s2, "get", "/status");
      const pubReceipt = await publicReceipt(first.txHash);
      const election = await pub("/election");
      const results = await pub("/results");
      await closeElection();
      const closedReceipt = await publicReceipt(first.txHash);
      const closedResults = await pub("/results");

      const raw = await mongoose.connection.collection("voters_v2").findOne({});
      const nullifier = await nullifierOf(voter);
      const rows = await auditRows();
      const audit = JSON.stringify(rows);
      const wire = JSON.stringify([r1.body, r2.body, r3.body, eligibility.body, status.body, pubReceipt.body, election.body, results.body, closedReceipt.body, closedResults.body]);
      const everything = wire + audit + memory.lines.join("");
      const sec = config.secrets;
      for (const secret of [raw.uid, nullifier, first.s.token, s2.token, sec.nullifierSecret.toString("hex"), sec.authorityPrivateKey, sec.relayerPrivateKey, sec.ownerPrivateKey, sec.authorityPrivateKey.slice(2), sec.relayerPrivateKey.slice(2), PW]) {
        assert.ok(!everything.includes(secret), `leaked ${String(secret).slice(0, 10)}...`);
      }
      assert.ok(!/0x[0-9a-f]{130}\b/.test(everything), "a 65-byte signature appears somewhere");
      assert.ok(!/rawTx|signature/i.test(wire));

      // audit rows: a voter id never appears next to a candidate or a transaction in the receipt/recovery events
      for (const row of rows) {
        assert.ok(!(row.meta?.candidateId !== undefined), `${row.action} carries a candidate`);
        if (["VOTER_RECEIPT_ISSUED", "VOTER_RECEIPT_RECOVERED", "RESULTS_PUBLISHED", "RESULT_INCONSISTENCY"].includes(row.action)) {
          assert.equal(row.txHash, null, row.action);
          assert.equal(row.meta?.voterId, undefined, row.action);
          assert.equal(row.adminId, null, row.action);
        }
      }
      for (const action of ["VOTER_RECEIPT_ISSUED", "VOTER_RECEIPT_RECOVERED", "RESULTS_PUBLISHED"]) assert.ok(audit.includes(action), action);
      assert.ok(!audit.includes("Neha Joshi"));
      assert.equal(results.status, 403, "Open-phase results were refused");
      assert.ok(!JSON.stringify([pubReceipt.body, results.body]).includes("Neha"), "no Open-phase receipt/results response names the recorded candidate");
    });

    it("before Closed, the public API exposes no candidate choice and no tally anywhere", async () => {
      const { txHash } = await vote(voter, "3");
      await vote(await mkVoter(2), "4");
      const open = [await pub("/election"), await pub("/results"), await publicReceipt(txHash)];
      for (const res of open) {
        const body = JSON.stringify(res.body);
        assert.ok(!/"votes"|"totalVotes"|"totalBallots"|"candidate"\s*:/.test(body), body.slice(0, 200));
      }
      // the ballot index is public but reveals no choice and no count of a candidate
      assert.equal(open[2].body.data.ballotIndex, "1");
    });
  });
});
