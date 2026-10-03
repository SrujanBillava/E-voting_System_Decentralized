import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import { Contract, ContractFactory, hexlify, id as keccakId, parseEther, parseUnits, randomBytes } from "ethers";
import mongoose from "mongoose";
import request from "supertest";
import { STAGES } from "../../src/auth/voterStages.js";
import { createApp } from "../../src/app.js";
import { createRelayerQueue } from "../../src/chain/relayerQueue.js";
import { buildBallotAuthorization, buildDomain, signBallotAuthorization } from "../../src/chain/eip712.js";
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
import { BACKEND_ROOT, assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { hardhatAccount, validEnv } from "../helpers/env.js";

// ADVERSARIAL tests for Step 10 (voter receipt, SUBMITTED -> COMPLETED, public verification, Closed-only results, pending-vote recovery).
// Real local chain + disposable Mongo. Every test runs inside an evm snapshot; NOTHING here touches the chain clock.
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";
const API = "/api/v1";
const ARTIFACT = path.resolve(BACKEND_ROOT, "../smart-contract/artifacts/contracts/Voting.sol/Voting.json");
const HAVE_ARTIFACT = fs.existsSync(ARTIFACT);
const SECRET_RPC = "boom secret-rpc http://10.0.0.1:8545/KEY-12345";
const RAW_TEXT = /secret-rpc|10\.0\.0\.1|KEY-12345|ECONN|node_modules|\.js:\d+|stack/i;
let keySeq = 0;
const newKey = () => `adv10-key-${Date.now()}-${++keySeq}-abcdef`;
const rnd32 = () => hexlify(randomBytes(32));

describe("ADVERSARIAL receipt, completion, public verification and results (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, memory, auth, app, config, relayerQueue, castSvc, t, captured;
  const clock = { now: () => t, advance: (s) => (t += s * 1000) };
  const owner = () => chain.contract.connect(chain.signers.owner);
  const relayerAddr = () => chain.signers.addresses.relayer;
  const relayerNonce = () => chain.provider.getTransactionCount(relayerAddr(), "latest");
  const automine = (on) => chain.provider.send("evm_setAutomine", [on]);
  const mine = (n = 1) => Promise.all(Array.from({ length: n }, () => chain.provider.send("evm_mine", []))).then(() => {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mkVoter = async (n = 1, over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: `Voter ${n}`, email: `v${n}@example.org`, passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });
  const proxied = (target, overrides) => new Proxy(target, { get: (tg, p) => (p in overrides ? overrides[p] : typeof tg[p] === "function" ? tg[p].bind(tg) : tg[p]) });
  const withProvider = (overrides) => ({ ...chain, provider: proxied(chain.provider, overrides) });
  const withContract = (overrides) => ({ ...chain, contract: proxied(chain.contract, overrides) });
  const withBoth = (p, c) => ({ ...chain, provider: proxied(chain.provider, p), contract: proxied(chain.contract, c) });
  const boom = async () => { throw new Error(SECRET_RPC); };
  /** A chain whose ONE method fails with a nasty raw RPC error (the rest is healthy). */
  const failing = (kind, fn) => (kind === "provider" ? withProvider({ [fn]: boom }) : withContract({ [fn]: boom }));
  /** A TransactionReceipt look-alike with some fields replaced. */
  const patchReceipt = (r, fields) => new Proxy(r, { get: (tg, p) => (p in fields ? fields[p] : typeof tg[p] === "function" ? tg[p].bind(tg) : tg[p]) });
  const forLogs = (r, fn) => patchReceipt(r, { logs: fn(r.logs) });

  const build = (appChain = chain, { receiptTimeoutMs = 4000, publicReceiptRateLimit = { windowMs: 60_000, limit: 10_000 } } = {}) => {
    const audit = createAuditService({ AuditLog, logger: memory.logger, now: clock.now });
    auth = createVoterAuthService({ Voter, VoterSession, chain: appChain, audit, now: clock.now, bcryptCost: 4 });
    const common = { Voter, authService: auth, audit, now: clock.now };
    const secret = config.secrets.nullifierSecret;
    castSvc = createCastService({ ...common, VoteTicket, chain: appChain, relayerQueue, waitNow: Date.now, receiptTimeoutMs, pollMs: 20 });
    const receiptService = createReceiptService({ ...common, VoteTicket, castService: castSvc, chain: appChain, nullifierSecret: secret });
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
      publicService: createPublicService({ chain: appChain, audit }),
      voterLoginRateLimit: { windowMs: 60_000, limit: 10_000 },
      publicReceiptRateLimit: publicReceiptRateLimit ?? undefined,
    });
  };

  const track = (res, method, p) => {
    captured.push({ method, path: p, status: res.status, headers: Object.fromEntries(Object.entries(res.headers).filter(([k]) => k !== "set-cookie")), text: res.text ?? "" });
    return res;
  };
  const login = async (voter) => {
    const res = track(await request(app).post(`${API}/voter/auth/login`).send({ identifier: voter.voterId, password: PW }), "POST", "/auth/login");
    if (res.status !== 200) return { res };
    const token = res.headers["set-cookie"][0].split(";")[0].split("=")[1];
    const row = await VoterSession.findOne({ voterId: voter._id, active: true });
    return { res, token, sessionId: row._id, voter };
  };
  const loginOk = async (voter) => {
    const s = await login(voter);
    assert.equal(s.res.status, 200, JSON.stringify(s.res.body));
    return s;
  };
  const toFaceVerified = async (s) => assert.equal(await auth.transitionStage({ sessionId: s.sessionId, from: STAGES.AUTHENTICATED, to: STAGES.FACE_VERIFIED, expiresAt: new Date(clock.now() + 120_000) }), true);
  const call = async (s, method, p, body, headers = {}) => {
    const r = request(app)[method](`${API}/voter${p}`).set("Cookie", `vc_voter=${s.token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return track(await (method === "get" ? r : r.send(body ?? {})), method, p);
  };
  const session = async (voter, upTo = "ELIGIBLE") => {
    const s = await loginOk(voter);
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
  const vote = async (voter, candidateId = "3") => {
    const s = await ready(voter, candidateId);
    const res = await cast(s);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { s, txHash: res.body.data.txHash };
  };
  /** A voter whose vote is MINED but not yet confirmed by the backend: ticket SUBMITTED, session SUBMITTED. */
  const mined = async (voter, candidateId = "3") => {
    app = build(chain, { receiptTimeoutMs: 200 });
    const s = await ready(voter, candidateId);
    await automine(false);
    const res = await cast(s);
    assert.equal(res.status, 202, JSON.stringify(res.body));
    await mine();
    await automine(true);
    assert.equal((await ticketOf(voter)).status, "SUBMITTED");
    return { s, txHash: res.body.data.txHash };
  };
  const receipt = (s) => call(s, "get", "/receipt");
  const stageOf = async (s) => (await VoterSession.findById(s.sessionId)).stage;
  const setStage = (s, stage, ttlMs = 600_000) => VoterSession.updateOne({ _id: s.sessionId }, { $set: { stage, stageExpiresAt: new Date(clock.now() + ttlMs) } });
  const ticketOf = (voter) => VoteTicket.findOne({ voterId: voter._id }).select("+rawTx +candidateId +nullifier +constituencyId");
  const nullifierOf = async (voter) => deriveNullifier({ secret: config.secrets.nullifierSecret, electionId: chain.deployment.electionId, voterUid: (await Voter.findById(voter._id).select("+uid")).uid });
  const pub = async (p, opts = {}) => track(await request(app).get(`${API}/public${p}`).set(opts.headers ?? {}), "GET", `/public${p}`);
  const publicReceipt = (txHash) => pub(`/receipts/${txHash}`);
  const closeElection = async () => (await owner().closeElection()).wait();
  const auditRows = () => mongoose.connection.collection("auditlogs").find({}).toArray();
  const count = (action) => AuditLog.countDocuments({ action });
  const noRaw = (res, label = "") => assert.ok(!RAW_TEXT.test(res.text ?? JSON.stringify(res.body)), `${label} raw RPC text leaked: ${res.text}`);
  const castDirect = async (voter, candidateId = 3n) => {
    const nullifier = await nullifierOf(voter);
    const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId, relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
    const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
    return (await chain.contract.connect(chain.signers.relayer).castVote(message.constituencyId, nullifier, candidateId, message.deadline, signature)).wait();
  };

  // ---- a SECOND Voting deployment / foreign contracts ----------------------------------------------------------------
  const deployVoting = async ({ electionId, seed = [] }) => {
    const art = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
    const factory = new ContractFactory(art.abi, art.bytecode, chain.signers.owner);
    const c = await factory.deploy(chain.signers.addresses.owner, electionId, chain.signers.addresses.authority, relayerAddr());
    await c.waitForDeployment();
    for (const [code, name, candidates] of seed) {
      await (await c.addConstituency(code, name)).wait();
      for (const cand of candidates) await (await c.addCandidate(constituencyIdOf(code), cand)).wait();
    }
    return c;
  };
  const chainOf = async (c, electionId) => {
    const address = await c.getAddress();
    return { ...chain, contract: new Contract(address, chain.contract.interface, chain.provider), deployment: { ...chain.deployment, contractAddress: address, electionId }, domain: buildDomain({ chainId: chain.deployment.chainId, verifyingContract: address }) };
  };
  const castOn = async (c, electionId, code, candidateId, nullifier = rnd32()) => {
    const address = await c.getAddress();
    const message = buildBallotAuthorization({ electionId, constituencyId: constituencyIdOf(code), nullifier, candidateId: BigInt(candidateId), relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
    const signature = await signBallotAuthorization(chain.signers.authority, buildDomain({ chainId: chain.deployment.chainId, verifyingContract: address }), message);
    return (await c.connect(chain.signers.relayer).castVote(message.constituencyId, nullifier, message.candidateId, message.deadline, signature)).wait();
  };
  /** Hand-assembled bytecode that LOGs a BallotCast look-alike (same topic0, any indexed args). Runs either as a deployed contract or in its constructor. */
  const emitterCode = ({ nullifier, constituencyId, candidateId }, { creation }) => {
    const topic0 = chain.contract.interface.getEvent("BallotCast").topicHash;
    const p32 = (h) => "7f" + h.slice(2);
    const log = "6001" + "6000" + "52" + p32(candidateId) + p32(constituencyId) + p32(nullifier) + p32(topic0) + "6020" + "6000" + "a4";
    if (creation) return "0x" + log + "6000" + "6000" + "f3";
    const runtime = log + "00";
    const len = (runtime.length / 2).toString(16).padStart(2, "0");
    return "0x" + "60" + len + "80" + "600b" + "6000" + "39" + "6000" + "f3" + runtime;
  };

  let voter;
  before(async () => {
    await mongoose.connect(uri);
    chain = localServices();
    await assertPristineLocalChain(chain);
    config = loadEnv(validEnv());
  });
  after(async () => {
    const probe = await snapshot(chain.provider);
    await chain.provider.send("evm_mine", []);
    const head = await chain.provider.getBlock("latest");
    await revertTo(chain.provider, probe);
    const drift = head.timestamp - Math.floor(Date.now() / 1000);
    await automine(true);
    chain?.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    assert.ok(Math.abs(drift) < 180, `the shared chain clock was left shifted by ${drift}s`);
  });
  beforeEach(async () => {
    await automine(true);
    snap = await snapshot(chain.provider);
    await mongoose.connection.dropDatabase();
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), VoteTicket.syncIndexes(), AuditLog.syncIndexes()]);
    t = Date.now();
    captured = [];
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

  // ================================================================================================================
  describe("A. evidence from the wrong place", () => {
    it("random / unknown transaction hashes: public 404; a forged SUBMITTED ticket pointing at one never yields a receipt or a ballot", async () => {
      for (let i = 0; i < 5; i++) {
        const res = await publicReceipt(rnd32());
        assert.equal(res.status, 404);
        assert.equal(res.body.error.code, "RECEIPT_NOT_FOUND");
      }
      const s = await ready(voter, "3");
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { status: "SUBMITTED", txHash: rnd32() } });
      await setStage(s, "SUBMITTED");
      const res = await receipt(s);
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.ok(["VOTE_NOT_RECORDED", "CHAIN_UNAVAILABLE"].includes(res.body.error.code), JSON.stringify(res.body));
      assert.equal(await chain.contract.totalBallots(), 0n);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      assert.equal(await stageOf(s), "SUBMITTED");
    });

    it("a successful transaction to a DIFFERENT contract (plain transfer): never a ballot, public 422 and voter RECEIPT_INVALID", async () => {
      const { s } = await vote(voter, "3");
      const transfer = await (await chain.signers.owner.sendTransaction({ to: hardhatAccount(9).address, value: parseEther("0.01") })).wait();
      assert.equal((await publicReceipt(transfer.hash)).body.error.code, "RECEIPT_INVALID");
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { txHash: transfer.hash } });
      const res = await receipt(s);
      assert.equal(res.body.error.code, "RECEIPT_INVALID");
      assert.equal((await ticketOf(voter)).status, "CONFIRMED", "a rejected receipt does not damage the ticket");
    });

    it("a SECOND Voting contract (even with the SAME election id) casting a perfectly valid ballot is not accepted as a ballot of THIS election", { skip: HAVE_ARTIFACT ? false : "needs smart-contract/artifacts" }, async () => {
      const seed = [["KA-BLR", "Bengaluru", ["Amit Sharma", "Rahul Verma", "Neha Joshi"]]];
      for (const electionId of [chain.deployment.electionId, keccakId("ADV-OTHER-ELECTION")]) {
        const second = await deployVoting({ electionId, seed });
        await (await second.openElection()).wait();
        const nullifier = await nullifierOf(voter); // the very same nullifier the real voter would have
        const foreign = await castOn(second, electionId, "KA-BLR", 3, nullifier);
        assert.equal(foreign.status, 1);
        assert.equal(await second.nullifierUsed(nullifier), true);
        const res = await publicReceipt(foreign.hash);
        assert.equal(res.status, 422, JSON.stringify(res.body));
        assert.equal(res.body.error.code, "RECEIPT_INVALID");
        // a voter whose ticket is pointed at that transaction (same nullifier, same candidate, same constituency) still gets nothing
        const s = await ready(voter, "3");
        await VoteTicket.updateOne({ voterId: voter._id }, { $set: { status: "CONFIRMED", txHash: foreign.hash } });
        await setStage(s, "SUBMITTED");
        const mine1 = await receipt(s);
        assert.equal(mine1.body?.error?.code, "RECEIPT_INVALID", JSON.stringify(mine1.body));
        assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
        assert.equal(await chain.contract.totalBallots(), 0n, "and the real election has no ballot");
        await VoterSession.updateMany({}, { active: false });
        await VoteTicket.deleteMany({});
      }
    });

    it("a hand-assembled contract that LOGs an identical BallotCast topic (called, or in its constructor) is rejected by public verification and by the voter receipt", async () => {
      const nullifier = await nullifierOf(voter);
      const args = { nullifier, constituencyId: constituencyIdOf("KA-BLR"), candidateId: "0x" + "00".repeat(31) + "03" };
      const deployed = await (await chain.signers.owner.sendTransaction({ data: emitterCode(args, { creation: false }) })).wait();
      assert.ok(deployed.contractAddress, "emitter deployed");
      const viaCall = await (await chain.signers.owner.sendTransaction({ to: deployed.contractAddress })).wait();
      assert.equal(viaCall.status, 1);
      assert.equal(viaCall.logs.length, 1);
      assert.equal(viaCall.logs[0].topics[0], chain.contract.interface.getEvent("BallotCast").topicHash, "it really is the same event signature");
      const viaCtor = await (await chain.signers.owner.sendTransaction({ data: emitterCode(args, { creation: true }) })).wait();
      assert.equal(viaCtor.logs.length, 1);
      // also called by the relayer EOA itself
      const byRelayer = await (await chain.signers.relayer.sendTransaction({ to: deployed.contractAddress })).wait();

      const s = await ready(voter, "3");
      for (const h of [viaCall.hash, viaCtor.hash, byRelayer.hash]) {
        const res = await publicReceipt(h);
        assert.equal(res.status, 422, h);
        assert.equal(res.body.error.code, "RECEIPT_INVALID");
        assert.equal(res.body.data, undefined);
        await VoteTicket.updateOne({ voterId: voter._id }, { $set: { status: "CONFIRMED", txHash: h } });
        await setStage(s, "SUBMITTED");
        assert.equal((await receipt(s)).body.error.code, "RECEIPT_INVALID", h);
      }
      assert.equal(await chain.contract.nullifierUsed(nullifier), false);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
    });

    it("reverted VoteChain calls (non-relayer caller, expired deadline) and non-ballot calls to the real contract are RECEIPT_INVALID", async () => {
      await vote(voter, "3");
      const nullifier = rnd32();
      const message = buildBallotAuthorization({ electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId: 3n, relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) });
      const signature = await signBallotAuthorization(chain.signers.authority, chain.domain, message);
      // the OWNER (not the relayer) forces a castVote onto the chain: it reverts NotRelayer
      const hash = await chain.contract.connect(chain.signers.owner).castVote(message.constituencyId, nullifier, 3n, message.deadline, signature, { gasLimit: 400_000 }).then((tx) => tx.hash, (e) => e.error?.data?.txHash);
      assert.match(hash, /^0x[0-9a-f]{64}$/);
      assert.equal((await chain.provider.getTransactionReceipt(hash)).status, 0);
      assert.equal((await publicReceipt(hash)).body.error.code, "RECEIPT_INVALID");
      const open = await (await owner().setAuthoritySigner(chain.signers.addresses.authority)).wait();
      assert.equal((await publicReceipt(open.hash)).body.error.code, "RECEIPT_INVALID");
    });

    it("a lying RPC that edits the receipt (duplicate BallotCast, foreign log address, wrong target, foreign block hash, null block) never produces a verified ballot", async () => {
      const { s, txHash } = await vote(voter, "3");
      const real = await chain.provider.getTransactionReceipt(txHash);
      const FOREIGN = hardhatAccount(8).address;
      const lies = {
        "duplicated BallotCast log": (r) => forLogs(r, (logs) => [...logs, ...logs]),
        "BallotCast log claimed by a foreign address": (r) => forLogs(r, (logs) => logs.map((l) => new Proxy(l, { get: (tg, p) => (p === "address" ? FOREIGN : typeof tg[p] === "function" ? tg[p].bind(tg) : tg[p]) }))),
        "all logs removed": (r) => forLogs(r, () => []),
        "receipt.to is somebody else": (r) => patchReceipt(r, { to: FOREIGN }),
        "receipt status is 0": (r) => patchReceipt(r, { status: 0 }),
      };
      for (const [label, lie] of Object.entries(lies)) {
        app = build(withProvider({ getTransactionReceipt: async (h) => { const r = await chain.provider.getTransactionReceipt(h); return r && lie(r); } }));
        const pubRes = await publicReceipt(txHash);
        assert.equal(pubRes.status, 422, `${label}: ${pubRes.text}`);
        assert.equal(pubRes.body.error.code, "RECEIPT_INVALID", label);
        await setStage(s, "SUBMITTED");
        const mine1 = await receipt(s);
        assert.equal(mine1.status, 409, `${label}: ${mine1.text}`);
        assert.equal(mine1.body.error.code, "RECEIPT_INVALID", label);
        assert.equal((await ticketOf(voter)).status, "CONFIRMED", `${label}: ticket must not be damaged`);
        assert.equal(await stageOf(s), "SUBMITTED", `${label}: session must not move`);
      }
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      // a block whose hash disagrees with the receipt: treated as 'not canonical' (reorg)
      app = build(withProvider({ getBlock: async (n) => { const b = await chain.provider.getBlock(n); return b && new Proxy(b, { get: (tg, p) => (p === "hash" ? rnd32() : typeof tg[p] === "function" ? tg[p].bind(tg) : tg[p]) }); } }));
      assert.equal((await publicReceipt(txHash)).body.error.code, "RECEIPT_INVALID");
      // the healthy node then serves the genuine receipt again
      app = build();
      assert.equal((await receipt(s)).status, 200);
      assert.equal(real.status, 1);
    });

    it("DEFECT? an RPC that momentarily returns a NULL block for a genuine ballot must not produce a final 'not a recorded ballot' verdict", async () => {
      const { s, txHash } = await vote(voter, "3");
      app = build(withProvider({ getBlock: async () => null }));
      const pubRes = await publicReceipt(txHash);
      // acceptable: 503 CHAIN_UNAVAILABLE or 202 CONFIRMING. NOT acceptable: 422 RECEIPT_INVALID ("this is not a ballot")
      assert.notEqual(pubRes.body.error?.code, "RECEIPT_INVALID", `public: ${pubRes.text}`);
      const mine1 = await receipt(s);
      assert.notEqual(mine1.body.error?.code, "RECEIPT_INVALID", `voter: ${mine1.text}`);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });
  });

  // ================================================================================================================
  describe("B. forged / altered local tickets", () => {
    it("txHash swapped to another voter's valid ballot, with that voter's candidate and nullifier copied as well: still RECEIPT_INVALID", async () => {
      const mineVote = await vote(voter, "3");
      const other = await mkVoter(2);
      const theirs = await vote(other, "4");
      const theirTicket = await ticketOf(other);
      await VoteTicket.deleteOne({ voterId: other._id }); // frees the unique indexes so the forgery can be total
      await VoterSession.updateMany({ voterId: voter._id }, { active: false });
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { nullifier: theirTicket.nullifier, candidateId: "4", constituencyId: theirTicket.constituencyId, txHash: theirs.txHash, status: "CONFIRMED" } });
      const s = await loginOk(voter);
      await setStage(s, "SUBMITTED");
      const res = await receipt(s);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "RECEIPT_INVALID");
      assert.ok(!res.text.includes(theirs.txHash));
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      void mineVote;
    });

    it("a SUBMITTED (not yet CONFIRMED) ticket with someone else's txHash, or an altered candidate / nullifier, ends in RECONCILIATION_REQUIRED, never a receipt", async () => {
      const mineVote = await vote(voter, "3");
      const theirs = await vote(await mkVoter(2), "4");
      const base = await ticketOf(voter);
      const variants = {
        "other voter's tx": { txHash: theirs.txHash },
        "altered candidate": { candidateId: "4", txHash: mineVote.txHash },
        "altered nullifier": { nullifier: "0x" + "5a".repeat(32), txHash: mineVote.txHash },
      };
      for (const [label, patch] of Object.entries(variants)) {
        await VoterSession.updateMany({ voterId: voter._id }, { active: false });
        await VoteTicket.updateOne({ voterId: voter._id }, { $set: { nullifier: base.nullifier, candidateId: base.candidateId, constituencyId: base.constituencyId, status: "SUBMITTED", failureCode: null, rawTx: null, txHash: mineVote.txHash } });
        await VoteTicket.updateOne({ voterId: voter._id }, { $set: { ...patch, status: "SUBMITTED" } });
        const s = await loginOk(voter);
        await setStage(s, "SUBMITTED");
        const res = await receipt(s);
        assert.ok(res.status >= 400, `${label}: ${res.text}`);
        assert.equal(res.body.error.code, "RECONCILIATION_REQUIRED", label);
        assert.equal(await stageOf(s), "SUBMITTED", label);
        assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0, label);
      }
    });

    it("status forced to CONFIRMED with no transaction at all (with and without a real on-chain ballot of that voter) never gives a receipt", async () => {
      const s = await ready(voter, "3");
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { status: "CONFIRMED" } });
      await setStage(s, "SUBMITTED");
      assert.equal((await receipt(s)).body.error.code, "RECEIPT_INVALID");
      await castDirect(voter, 3n); // the voter really did vote on chain, but via a path this server cannot prove
      const res = await receipt(s);
      assert.equal(res.body.error.code, "RECEIPT_INVALID");
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      // and re-login recovery makes no claim either
      await VoterSession.updateMany({}, { active: false });
      const s2 = await session(voter, "FACE_VERIFIED");
      const elig = await call(s2, "post", "/eligibility/check");
      assert.equal(elig.body.error.code, "ALREADY_VOTED");
      assert.deepEqual(elig.body.error.details, { receiptAvailable: false });
      assert.equal(await stageOf(s2), "FACE_VERIFIED");
    });

    it("a SUBMITTED ticket whose nullifier was really used by the voter's own direct ballot, but with a fake txHash: RECONCILIATION_REQUIRED, no receipt", async () => {
      const s = await ready(voter, "3");
      await castDirect(voter, 3n);
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { status: "SUBMITTED", txHash: rnd32(), nonce: 0 } });
      await setStage(s, "SUBMITTED");
      const res = await receipt(s);
      assert.equal(res.body.error.code, "RECONCILIATION_REQUIRED", res.text);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
    });

    it("the txHash of somebody else's still-PENDING ballot on my SUBMITTED ticket: PENDING while unmined, never a receipt once it mines", async () => {
      app = build(chain, { receiptTimeoutMs: 200 });
      const other = await mkVoter(2);
      const so = await ready(other, "4");
      const mineS = await ready(voter, "3");
      await automine(false);
      const theirs = await cast(so);
      assert.equal(theirs.status, 202);
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { status: "SUBMITTED", txHash: theirs.body.data.txHash } });
      await setStage(mineS, "SUBMITTED");
      const pending = await receipt(mineS);
      assert.equal(pending.status, 202, pending.text);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      await mine();
      await automine(true);
      const done = await receipt(mineS);
      assert.equal(done.status, 409, done.text);
      assert.equal(done.body.error.code, "RECONCILIATION_REQUIRED");
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      assert.equal(await chain.contract.totalBallots(), 1n, "only the other voter's own ballot exists");
    });

    it("an RPC that answers the ticket's hash with ANOTHER voter's receipt cannot mint a receipt; the false alarm heals once the RPC is honest", async () => {
      const mineVote = await mined(voter, "3");
      const other = await mkVoter(2);
      const theirs = await vote(other, "4");
      app = build(withProvider({ getTransactionReceipt: async (h) => chain.provider.getTransactionReceipt(h.toLowerCase() === mineVote.txHash.toLowerCase() ? theirs.txHash : h) }), { receiptTimeoutMs: 200 });
      const lied = await receipt(mineVote.s);
      assert.ok(lied.status >= 400, lied.text);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      app = build();
      const healed = await receipt(mineVote.s);
      assert.equal(healed.status, 200, healed.text);
      assert.equal(healed.body.data.receipt.txHash, mineVote.txHash);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });
  });

  // ================================================================================================================
  describe("C. the election closes while a receipt is outstanding", () => {
    it("MINED but unconfirmed at close: the receipt completes the session after close (no sweep needed)", async () => {
      const { s, txHash } = await mined(voter, "3");
      await closeElection();
      const res = await receipt(s);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.receipt.txHash, txHash);
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal((await call(s, "get", "/status")).body.data.electionPhase, "Closed");
    });

    it("DROPPED at close: VOTE_NOT_RECORDED every time (stable), nothing is re-broadcast, no cast possible, session unchanged", async () => {
      app = build(chain, { receiptTimeoutMs: 200 });
      const s = await ready(voter, "3");
      await automine(false);
      const sub = await cast(s);
      await chain.provider.send("hardhat_dropTransaction", [sub.body.data.txHash]);
      await automine(true);
      await closeElection();
      const nonce = await relayerNonce();
      for (let i = 0; i < 3; i++) {
        const res = await receipt(s);
        assert.equal(res.status, 409, res.text);
        assert.equal(res.body.error.code, "VOTE_NOT_RECORDED");
      }
      assert.equal((await cast(s)).body.error.code, "ELECTION_CLOSED");
      assert.equal(await castSvc.recoverPending({ minAgeMs: 0 }), 0);
      assert.equal(await relayerNonce(), nonce, "the relayer sent nothing");
      assert.equal(await chain.contract.totalBallots(), 0n);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      assert.equal(await stageOf(s), "SUBMITTED");
    });

    it("MEMPOOL at close, the close wins the block: the late castVote REVERTS and the voter is told TX_REVERTED (consistently), never given a receipt", async () => {
      app = build(chain, { receiptTimeoutMs: 200 });
      const s = await ready(voter, "3");
      await automine(false);
      const sub = await cast(s);
      assert.equal(sub.status, 202);
      await owner().closeElection({ maxPriorityFeePerGas: parseUnits("50", "gwei"), maxFeePerGas: parseUnits("200", "gwei") });
      await mine();
      await automine(true);
      const r = await chain.provider.getTransactionReceipt(sub.body.data.txHash);
      assert.ok(r, "the cast transaction was mined");
      assert.equal(r.status, 0, "the close is ordered first, so the vote reverts");
      assert.equal(await chain.contract.totalBallots(), 0n);
      const first = await receipt(s);
      assert.ok([409, 502].includes(first.status), first.text);
      assert.equal(first.body.error.code, "TX_REVERTED");
      const second = await receipt(s);
      assert.equal(second.body.error.code, "TX_REVERTED");
      assert.equal((await ticketOf(voter)).status, "FAILED");
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      assert.equal(await stageOf(s), "SUBMITTED");
    });

    it("MEMPOOL at close, both still pending: the receipt answers PENDING (no verdict, no state change) until a block decides", async () => {
      app = build(chain, { receiptTimeoutMs: 200 });
      const s = await ready(voter, "3");
      await automine(false);
      const sub = await cast(s);
      await owner().closeElection();
      const pending = await receipt(s);
      assert.equal(pending.status, 202, "nothing is mined yet, so there is no verdict: " + pending.text);
      assert.equal((await ticketOf(voter)).status, "SUBMITTED");
      await mine(); // cast (nonce order) lands first, then the close
      await automine(true);
      const done = await receipt(s);
      assert.equal(done.status, 200, done.text);
      assert.equal(await chain.contract.totalBallots(), 1n);
      assert.equal(await stageOf(s), "COMPLETED");
    });

    it("an AUTH_ISSUED session whose ticket already has a broadcast, mined transaction when the election closes: the receipt promotes it to SUBMITTED then COMPLETED", async () => {
      const { s, txHash } = await mined(voter, "3");
      await setStage(s, "AUTH_ISSUED", 180_000); // the SUBMITTED promotion never made it to the session row
      await closeElection();
      const res = await receipt(s);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.receipt.txHash, txHash);
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 1);
    });

    it("an AUTH_ISSUED session whose ticket is already CONFIRMED (stage write lost) completes correctly after close too", async () => {
      const { s, txHash } = await vote(voter, "3");
      await setStage(s, "AUTH_ISSUED", 180_000);
      await closeElection();
      const res = await receipt(s);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.data.receipt.txHash, txHash);
      assert.equal(await stageOf(s), "COMPLETED");
    });

    it("confirmations > 1 and the head does NOT advance: the receipt stays PENDING forever without failing anything; the close block counts as a confirmation; the final block completes it", async () => {
      app = build({ ...chain, confirmations: 3 }, { receiptTimeoutMs: 200 });
      const s = await ready(voter, "3");
      const sub = await cast(s);
      assert.equal(sub.status, 202);
      for (let i = 0; i < 4; i++) {
        const res = await receipt(s);
        assert.equal(res.status, 202, res.text);
        assert.deepEqual(res.body.data, { stage: "SUBMITTED", state: "PENDING", txHash: sub.body.data.txHash });
      }
      const pubRes = await publicReceipt(sub.body.data.txHash);
      assert.equal(pubRes.status, 202);
      assert.equal(pubRes.body.data.status, "CONFIRMING");
      assert.equal(pubRes.body.data.confirmations, 1);
      assert.equal((await ticketOf(voter)).status, "SUBMITTED");
      await closeElection(); // 2 of 3
      assert.equal((await receipt(s)).status, 202);
      assert.equal((await publicReceipt(sub.body.data.txHash)).body.data.confirmations, 2);
      await mine(); // 3 of 3
      const done = await receipt(s);
      assert.equal(done.status, 200, done.text);
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal((await publicReceipt(sub.body.data.txHash)).body.data.status, "CONFIRMED");
    });

    it("a LAGGING RPC (head behind the receipt's block) and getBlockNumber() = 0: CONFIRMING / PENDING, never an error verdict, never COMPLETED", async () => {
      const { s, txHash } = await vote(voter, "3");
      const behind = withProvider({ getBlockNumber: async () => 0 });
      app = build(behind);
      const pubRes = await publicReceipt(txHash);
      assert.equal(pubRes.status, 202, pubRes.text);
      assert.equal(pubRes.body.data.status, "CONFIRMING");
      assert.equal(pubRes.body.data.confirmations, 0, "never negative");
      await setStage(s, "SUBMITTED");
      const mine1 = await receipt(s);
      assert.equal(mine1.status, 202, mine1.text);
      assert.equal(await stageOf(s), "SUBMITTED");
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
      app = build();
      assert.equal((await receipt(s)).status, 200);
    });
  });

  // ================================================================================================================
  describe("D. the voter comes back", () => {
    it("browser closed while the session is still alive: login is refused (SESSION_ACTIVE) but the old cookie can still fetch the receipt; once COMPLETED lapses, password -> face -> eligibility -> the SAME receipt", async () => {
      const first = await vote(voter, "3");
      clock.advance(30);
      const again = await login(voter);
      assert.equal(again.res.status, 409);
      assert.equal(again.res.body.error.code, "SESSION_ACTIVE");
      assert.ok(!again.res.text.includes(first.s.token));
      const r1 = await receipt(first.s);
      assert.equal(r1.status, 200);
      assert.equal((await login(voter)).res.body.error.code, "SESSION_ACTIVE", "COMPLETED is still alive");
      clock.advance(61);
      assert.equal((await receipt(first.s)).status, 401, "the 60 s COMPLETED window lapsed");

      const s = await loginOk(voter);
      assert.equal((await receipt(first.s)).status, 401, "the old cookie stays dead");
      assert.equal((await receipt(s)).body.error.code, "STAGE_REQUIRED", "no face -> no receipt");
      await toFaceVerified(s);
      assert.equal((await call(s, "post", "/authorization", { candidateId: "4" })).body.error.code, "STAGE_REQUIRED");
      const elig = await call(s, "post", "/eligibility/check");
      assert.equal(elig.body.error.code, "ALREADY_VOTED");
      assert.deepEqual(elig.body.error.details, { receiptAvailable: true, stage: "COMPLETED" });
      const r2 = await receipt(s);
      assert.equal(r2.status, 200);
      assert.deepEqual(r2.body.data.receipt, r1.body.data.receipt, "the identical portable receipt");
      assert.deepEqual(r2.body.data.recordedSelection, r1.body.data.recordedSelection);
      assert.equal(await chain.contract.totalBallots(), 1n);
      assert.equal(await VoteTicket.countDocuments({}), 1);
    });

    it("a lapsed SUBMITTED session (10 min) and a stranded mined ticket: login -> face -> eligibility reconciles and hands back the receipt", async () => {
      const { txHash } = await mined(voter, "3");
      clock.advance(10 * 60 + 5);
      const s = await loginOk(voter);
      await toFaceVerified(s);
      const elig = await call(s, "post", "/eligibility/check");
      assert.equal(elig.body.error.code, "ALREADY_VOTED");
      assert.equal(elig.body.error.details.receiptAvailable, true);
      assert.equal((await receipt(s)).body.data.receipt.txHash, txHash);
      assert.equal(await count("VOTER_RECEIPT_RECOVERED"), 1);
    });

    it("returning while the vote is STILL PENDING in the mempool: safe (no second vote, no swap); the voter is eligible-but-blocked until it mines, then recovers", async () => {
      const { txHash } = await (async () => {
        app = build(chain, { receiptTimeoutMs: 200 });
        const s = await ready(voter, "3");
        await automine(false);
        const sub = await cast(s);
        assert.equal(sub.status, 202);
        return { txHash: sub.body.data.txHash };
      })();
      clock.advance(10 * 60 + 5);
      const s = await loginOk(voter);
      await toFaceVerified(s);
      const elig = await call(s, "post", "/eligibility/check");
      assert.equal(elig.status, 409);
      assert.equal(elig.body.error.code, "VOTE_IN_FLIGHT", "the voter is told the vote is being confirmed instead of being offered a ballot");
      assert.deepEqual(elig.body.error.details, { voteInFlight: true });
      for (const candidateId of ["3", "4"]) {
        const res = await call(s, "post", "/authorization", { candidateId });
        assert.equal(res.body.error.code, "STAGE_REQUIRED", "no new authorization, no swap: " + candidateId);
      }
      assert.equal((await cast(s)).body.error.code, "STAGE_REQUIRED");
      assert.equal((await receipt(s)).body.error.code, "STAGE_REQUIRED");
      assert.equal(await VoteTicket.countDocuments({}), 1);
      await mine();
      await automine(true);
      const elig2 = await call(s, "post", "/eligibility/check");
      assert.equal(elig2.body.error.code, "ALREADY_VOTED");
      assert.equal(elig2.body.error.details.receiptAvailable, true);
      assert.equal((await receipt(s)).body.data.receipt.txHash, txHash);
      assert.equal(await chain.contract.totalBallots(), 1n);
    });

    it("after the election CLOSES a voter whose session lapsed cannot log in again (ELECTION_CLOSED): the public txHash endpoint is the only way back", async () => {
      const first = await vote(voter, "3");
      clock.advance(10 * 60 + 5);
      await closeElection();
      const res = await login(voter);
      assert.equal(res.res.status, 409);
      assert.equal(res.res.body.error.code, "ELECTION_CLOSED");
      assert.equal((await publicReceipt(first.txHash)).status, 200);
    });

    it("repeated retrieval is stable across five calls and across an intervening re-login; one VOTER_RECEIPT_ISSUED, one RECOVERED", async () => {
      const { s } = await vote(voter, "3");
      const seen = [];
      for (let i = 0; i < 5; i++) seen.push(JSON.stringify((await receipt(s)).body.data.receipt));
      assert.equal(new Set(seen).size, 1);
      clock.advance(61);
      const s2 = await session(voter, "FACE_VERIFIED");
      assert.equal((await call(s2, "post", "/eligibility/check")).body.error.code, "ALREADY_VOTED");
      assert.equal((await call(s2, "post", "/eligibility/check")).body.error.code, "STAGE_REQUIRED", "COMPLETED sessions no longer run the voting steps");
      assert.equal(JSON.stringify((await receipt(s2)).body.data.receipt), seen[0]);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 1);
      assert.equal(await count("VOTER_RECEIPT_RECOVERED"), 1);
    });
  });

  // ================================================================================================================
  describe("E. races", () => {
    it("receipt calls racing the recoverPending sweep: one confirmation, one receipt, one COMPLETED, whoever wins", async () => {
      const { s, txHash } = await mined(voter, "3");
      const outcomes = await Promise.all([receipt(s), receipt(s), castSvc.recoverPending({ minAgeMs: 0 }), receipt(s), castSvc.recoverPending({ minAgeMs: 0 })]);
      for (const r of [outcomes[0], outcomes[1], outcomes[3]]) assert.ok([200, 202].includes(r.status), r.text);
      let last = await receipt(s);
      for (let i = 0; i < 5 && last.status !== 200; i++) last = await receipt(s);
      assert.equal(last.status, 200, last.text);
      assert.equal(last.body.data.receipt.txHash, txHash);
      assert.equal(await count("VOTE_CONFIRMED"), 1);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 1);
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal(await chain.contract.totalBallots(), 1n);
    });

    it("a sweep that HOLDS the takeover lock makes the receipt answer PENDING (never an error, never a double confirm); it completes after the lock is released", async () => {
      const { s } = await mined(voter, "3");
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { lockUntil: new Date(Date.now() + 60_000), claimToken: "sweep" } });
      const res = await receipt(s);
      assert.equal(res.status, 202, res.text);
      assert.equal(res.body.data.state, "PENDING");
      assert.equal(await stageOf(s), "SUBMITTED");
      await VoteTicket.updateOne({ voterId: voter._id }, { $set: { lockUntil: null } });
      assert.equal((await receipt(s)).status, 200);
    });

    it("receipt racing /cast on the same voter: statuses stay within {200, 202, STAGE_REQUIRED}; exactly one ballot, one confirmation", async () => {
      const { s } = await mined(voter, "3");
      const res = await Promise.all([cast(s), receipt(s), cast(s), receipt(s), receipt(s), cast(s)]);
      for (const r of res) assert.ok([200, 202].includes(r.status) || r.body.error?.code === "STAGE_REQUIRED", r.text);
      await receipt(s);
      assert.equal(await chain.contract.totalBallots(), 1n);
      assert.equal(await count("VOTE_CONFIRMED"), 1);
      assert.equal(await VoteTicket.countDocuments({}), 1);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 1);
    });

    it("concurrent re-login recoveries (eligibility x4 + receipt x2) end in ONE COMPLETED session and one RECOVERED event", async () => {
      await vote(voter, "3");
      clock.advance(10 * 60 + 5);
      const s = await session(voter, "FACE_VERIFIED");
      const res = await Promise.all([call(s, "post", "/eligibility/check"), call(s, "post", "/eligibility/check"), receipt(s), call(s, "post", "/eligibility/check"), receipt(s), call(s, "post", "/eligibility/check")]);
      for (const r of res) assert.ok([200, 409].includes(r.status), r.text);
      assert.equal(await stageOf(s), "COMPLETED");
      assert.equal(await count("VOTER_RECEIPT_RECOVERED"), 1);
      assert.equal(await count("VOTER_RECEIPT_ISSUED"), 0);
      assert.equal((await receipt(s)).status, 200);
    });
  });

  // ================================================================================================================
  describe("F. results", () => {
    it("Setup and Open (with ballots in several constituencies): 403 everywhere, bodies AND headers carry no candidate/tally data", async () => {
      await revertTo(chain.provider, snap);
      snap = await snapshot(chain.provider);
      let res = await pub("/results");
      assert.equal(res.status, 403);
      await (await owner().openElection()).wait();
      await vote(await mkVoter(5, { constituencyCode: "KA-BLR" }), "3");
      await vote(await mkVoter(6, { constituencyCode: "DL-DEL" }), "8");
      await vote(await mkVoter(7, { constituencyCode: "MH-MUM" }), "14");
      res = await pub("/results");
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "RESULTS_NOT_AVAILABLE");
      assert.equal(res.headers["cache-control"], "no-store", "a 403 must not be cacheable as results");
      assert.ok(!/Neha|Rohan|votes|tally|total/i.test(res.text + JSON.stringify(res.headers)));
      for (const variant of ["/results/", "/results?x=1", "/RESULTS", "/results/%2e", "/results/1"]) {
        const r = await pub(variant);
        assert.ok(r.status === 400 || r.status === 404 || r.status === 403, `${variant} -> ${r.status}`);
        if (r.status === 200) assert.fail(variant);
      }
    });

    it("MIXED CONSTITUENCIES on a second deployment with EQUAL candidate names and an equal constituency name: grouping, per-constituency and global totals are exact", { skip: HAVE_ARTIFACT ? false : "needs smart-contract/artifacts" }, async () => {
      const electionId = keccakId("ADV-MIXED-RESULTS");
      const second = await deployVoting({
        electionId,
        seed: [
          ["X-A", "Central", ["Alex Kumar", "Sam Rao"]], // 1, 2
          ["X-B", "Beta", ["Alex Kumar", "Sam Rao", "Priya N"]], // 3, 4, 5
          ["X-C", "Gamma", ["Alex Kumar"]], // 6
          ["X-D", "Central", ["Alex Kumar", "Sam Rao"]], // 7, 8   (same display name as X-A)
        ],
      });
      const chain2 = await chainOf(second, electionId);
      await (await second.openElection()).wait();
      app = build(chain2);
      assert.equal((await pub("/results")).status, 403);
      const plan = [["X-A", 1], ["X-A", 1], ["X-A", 2], ["X-B", 3], ["X-B", 5], ["X-B", 5], ["X-B", 5], ["X-C", 6], ["X-D", 8]];
      for (const [code, cand] of plan) await castOn(second, electionId, code, cand);
      assert.equal((await pub("/results")).status, 403, "still Open");
      await (await second.closeElection()).wait();
      const res = await pub("/results");
      assert.equal(res.status, 200, res.text);
      const { data } = res.body;
      assert.equal(data.totalBallots, "9");
      const by = Object.fromEntries(data.constituencies.map((c) => [c.code, c]));
      assert.deepEqual(Object.keys(by).sort(), ["X-A", "X-B", "X-C", "X-D"]);
      const tally = (code) => Object.fromEntries(by[code].candidates.map((c) => [c.candidateId, c.votes]));
      assert.deepEqual(tally("X-A"), { 1: "2", 2: "1" });
      assert.deepEqual(tally("X-B"), { 3: "1", 4: "0", 5: "3" });
      assert.deepEqual(tally("X-C"), { 6: "1" });
      assert.deepEqual(tally("X-D"), { 7: "0", 8: "1" });
      assert.deepEqual(["X-A", "X-B", "X-C", "X-D"].map((c) => by[c].totalVotes), ["3", "4", "1", "1"]);
      assert.equal(by["X-A"].name, "Central");
      assert.equal(by["X-D"].name, "Central");
      assert.equal(data.constituencies.reduce((a, c) => a + BigInt(c.totalVotes), 0n), 9n);
      for (const c of data.constituencies) assert.equal(c.candidates.reduce((a, x) => a + BigInt(x.votes), 0n), BigInt(c.totalVotes), c.code);
      assert.ok(!("winner" in data));
    });

    it("a lying contract (duplicated constituency, duplicated candidate, swapped totals) can never make the service publish numbers that do not add up", async () => {
      await vote(await mkVoter(5), "3");
      await closeElection();
      const realIds = await chain.contract.getConstituencyIds(0n, 100n);
      const cases = {
        "the constituency list repeats one constituency": withContract({ getConstituencyIds: async (...a) => [...(await chain.contract.getConstituencyIds(...a)), realIds[0]], constituencyCount: async () => (await chain.contract.constituencyCount()) + 1n }),
        "one constituency total is reported as zero": withContract({ constituencyTotal: async (cid) => (cid === realIds[0] ? 0n : chain.contract.constituencyTotal(cid)) }),
        "totalBallots is zero while constituencies are not": withContract({ totalBallots: async () => 0n }),
      };
      for (const [label, lying] of Object.entries(cases)) {
        app = build(lying);
        const res = await pub("/results");
        assert.equal(res.status, 500, `${label}: ${res.text}`);
        assert.equal(res.body.error.code, "RESULT_INCONSISTENCY", label);
        assert.ok(!/\d{2,}|Neha/.test(res.body.error.message), label);
        assert.equal(res.body.data, undefined);
      }
      assert.equal(await count("RESULTS_PUBLISHED"), 0);
      app = build();
      assert.equal((await pub("/results")).status, 200);
    });

    it("Closed results are served identically from one service, publication is audited once, and a flapping chain afterwards still serves the immutable result (no partial data)", async () => {
      await vote(await mkVoter(5), "3");
      await closeElection();
      const first = await pub("/results");
      const second = await pub("/results");
      assert.deepEqual(second.body, first.body);
      assert.match(first.headers["cache-control"], /public/);
      assert.equal(await count("RESULTS_PUBLISHED"), 1);
      assert.equal(first.body.data.totalBallots, "1");
    });
  });

  // ================================================================================================================
  describe("G. the chain is unavailable, endpoint by endpoint (raw RPC error with a secret URL)", () => {
    const PROVIDER_FNS = ["getTransactionReceipt", "getTransaction", "getBlock", "getBlockNumber", "getTransactionCount"];
    const CONTRACT_FNS = ["nullifierUsed", "ballotIndexOf", "getCandidate", "getConstituency", "queryFilter"];
    const matrix = [...PROVIDER_FNS.map((f) => ["provider", f]), ...CONTRACT_FNS.map((f) => ["contract", f])];

    it("GET /voter/receipt, CONFIRMED ticket: each single failing RPC method gives 200 or a safe CHAIN_UNAVAILABLE; no state damage; a healthy node then completes", async () => {
      const { s, txHash } = await vote(voter, "3");
      for (const [kind, fn] of matrix) {
        await setStage(s, "SUBMITTED");
        app = build(failing(kind, fn));
        const res = await receipt(s);
        const label = `${kind}.${fn}: ${res.text}`;
        assert.ok(res.status === 200 || (res.status === 503 && res.body.error.code === "CHAIN_UNAVAILABLE"), label);
        noRaw(res, label);
        assert.equal((await ticketOf(voter)).status, "CONFIRMED", label);
        if (res.status === 503) assert.equal(await stageOf(s), "SUBMITTED", label);
      }
      app = build();
      await setStage(s, "SUBMITTED");
      assert.equal((await receipt(s)).body.data.receipt.txHash, txHash);
      assert.ok(!memory.lines.join("").match(RAW_TEXT), "raw RPC text reached the logs");
    });

    it("GET /voter/receipt, SUBMITTED-but-mined ticket: a transient RPC failure never flips the ticket to FAILED/AUTH_ISSUED; the next healthy call finishes", async () => {
      let n = 10;
      for (const [kind, fn] of matrix) {
        const v = await mkVoter(n++);
        const { s, txHash } = await mined(v, "3");
        app = build(failing(kind, fn), { receiptTimeoutMs: 200 });
        const res = await receipt(s);
        const label = `${kind}.${fn}: ${res.text}`;
        assert.ok([200, 202, 503].includes(res.status), label);
        if (res.status === 503) assert.equal(res.body.error.code, "CHAIN_UNAVAILABLE", label);
        noRaw(res, label);
        const after = await ticketOf(v);
        assert.ok(["SUBMITTED", "CONFIRMED"].includes(after.status), `${label} -> ticket ${after.status}/${after.failureCode}`);
        assert.equal(after.txHash, txHash, label);
        app = build();
        const ok = await receipt(s);
        assert.equal(ok.status, 200, `${label} then ${ok.text}`);
        assert.equal(await VoteTicket.countDocuments({ status: "CONFIRMED", voterId: v._id }), 1);
      }
      assert.equal(await count("VOTE_CONFIRMED"), matrix.length);
      assert.equal(await chain.contract.totalBallots(), BigInt(matrix.length));
    });

    it("POST /voter/eligibility/check, ALREADY_VOTED recovery: failing RPC gives ALREADY_VOTED(receiptAvailable:false) or CHAIN_UNAVAILABLE, no mutation; healthy retry recovers", async () => {
      let n = 30;
      for (const [kind, fn] of matrix) {
        const v = await mkVoter(n++);
        app = build();
        const { txHash } = await vote(v, "3");
        await VoterSession.updateMany({ voterId: v._id }, { active: false });
        const s = await session(v, "FACE_VERIFIED");
        app = build(failing(kind, fn));
        const res = await call(s, "post", "/eligibility/check");
        const label = `${kind}.${fn}: ${res.text}`;
        assert.ok(res.body.error.code === "ALREADY_VOTED" || res.body.error.code === "CHAIN_UNAVAILABLE", label);
        noRaw(res, label);
        assert.equal((await ticketOf(v)).status, "CONFIRMED", label);
        if (res.body.error.code === "ALREADY_VOTED" && res.body.error.details.receiptAvailable === false) assert.equal(await stageOf(s), "FACE_VERIFIED", label);
        app = build();
        const ok = await call(s, "post", "/eligibility/check");
        if (res.body.error.details?.receiptAvailable === true) assert.equal(ok.body.error.code, "STAGE_REQUIRED", label); // already completed by the first call
        else {
          assert.equal(ok.body.error.code, "ALREADY_VOTED", label);
          assert.equal(ok.body.error.details.receiptAvailable, true, label);
        }
        assert.equal((await receipt(s)).body.data.receipt.txHash, txHash);
      }
    });

    it("public endpoints (receipt, election, results): 200 or a safe CHAIN_UNAVAILABLE for every single failing method, never partial data or raw text", async () => {
      const { txHash } = await vote(voter, "3");
      await closeElection();
      for (const [kind, fn] of matrix) {
        app = build(failing(kind, fn));
        for (const p of [`/receipts/${txHash}`, "/election", "/results"]) {
          if (fn === "getConstituency" && p.startsWith("/receipts")) continue; // DEFECT test below
          const res = await pub(p);
          const label = `${kind}.${fn} ${p}: ${res.text}`;
          assert.ok(res.status === 200 || (res.status === 503 && res.body.error.code === "CHAIN_UNAVAILABLE"), label);
          noRaw(res, label);
          if (res.status === 200 && p === "/results") assert.equal(res.body.data.totalBallots, "1", label);
        }
      }
      assert.ok(!memory.lines.join("").match(RAW_TEXT), "raw RPC text reached the logs");
    });
  });

  describe("G1. the contract phase read itself fails (every endpoint)", () => {
    it("every voter and public endpoint answers a plain 503 CHAIN_UNAVAILABLE with no raw RPC text and changes nothing", async () => {
      const { s, txHash } = await vote(voter, "3");
      const other = await mkVoter(2);
      const sOther = await session(other, "FACE_VERIFIED");
      app = build(failing("contract", "phase"));
      const nonce = await relayerNonce();
      const hits = [
        ["get", "/status"], ["get", "/receipt"], ["post", "/eligibility/check"], ["get", "/ballot"], ["post", "/authorization", { candidateId: "3" }],
      ];
      for (const [method, p, body] of hits) {
        const res = await call(method === "post" && p === "/eligibility/check" ? sOther : s, method, p, body);
        assert.equal(res.status, 503, `${p}: ${res.text}`);
        assert.equal(res.body.error.code, "CHAIN_UNAVAILABLE", p);
        noRaw(res, p);
      }
      assert.equal((await cast(s)).body.error.code, "CHAIN_UNAVAILABLE");
      const lg = await login(other);
      assert.equal(lg.res.status, 503, "login fails closed too");
      assert.equal(lg.res.body.error.code, "CHAIN_UNAVAILABLE");
      noRaw(lg.res);
      for (const p of ["/election", "/results", `/receipts/${txHash}`]) {
        const res = await pub(p);
        assert.ok(res.status === 503 || (p.startsWith("/receipts") && res.status === 200), `${p}: ${res.text}`);
        if (res.status === 503) assert.equal(res.body.error.code, "CHAIN_UNAVAILABLE");
        noRaw(res, p);
      }
      assert.equal(await relayerNonce(), nonce);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
      assert.equal(await stageOf(s), "SUBMITTED");
      assert.equal(await stageOf(sOther), "FACE_VERIFIED");
      app = build();
      assert.equal((await receipt(s)).status, 200);
    });
  });

  describe("G3. caching and audit noise", () => {
    it("voter responses are no-store; only a successful Closed result is cacheable; public receipts are not", async () => {
      const { s, txHash } = await vote(voter, "3");
      const r = await receipt(s);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.equal((await call(s, "get", "/status")).headers["cache-control"], "no-store");
      assert.equal((await publicReceipt(txHash)).headers["cache-control"], "no-store");
      assert.equal((await pub("/election")).headers["cache-control"], "no-store");
      assert.equal((await pub("/results")).headers["cache-control"], "no-store");
      assert.equal((await pub(`/receipts/${rnd32()}`)).headers["cache-control"], "no-store");
      await closeElection();
      assert.match((await pub("/results")).headers["cache-control"], /^public, max-age=\d+$/);
      assert.equal((await receipt(s)).headers["cache-control"], "no-store");
    });

    it("a burst of first-time Closed /results requests publishes (and audits) the result once", async () => {
      await vote(voter, "3");
      await closeElection();
      app = build();
      const burst = await Promise.all(Array.from({ length: 12 }, () => pub("/results")));
      for (const r of burst) assert.equal(r.status, 200);
      assert.equal(new Set(burst.map((r) => JSON.stringify(r.body))).size, 1);
      assert.equal(await count("RESULTS_PUBLISHED"), 1, "RESULTS_PUBLISHED audited once per publication");
    });
  });

  describe("G2. transient failures must not become final verdicts", () => {
    it("DEFECT? a transient getConstituency() RPC failure on a GENUINE ballot must not answer 422 'not a recorded ballot'", async () => {
      const { txHash } = await vote(voter, "3");
      app = build(failing("contract", "getConstituency"));
      const res = await publicReceipt(txHash);
      assert.notEqual(res.body.error?.code, "RECEIPT_INVALID", res.text);
      assert.equal(res.status, 503, res.text);
      noRaw(res);
    });
  });

  // ================================================================================================================
  describe("H. allowClosed cannot be abused", () => {
    it("after Close, the six stages see exactly: AUTHENTICATED/FACE/ELIGIBLE nothing; AUTH_ISSUED only /status and STAGE_REQUIRED on /receipt; SUBMITTED/COMPLETED only receipt+status", async () => {
      const mk = (n) => mkVoter(100 + n);
      const sAuth = await session(await mk(1), "AUTHENTICATED");
      const sFace = await session(await mk(2), "FACE_VERIFIED");
      const sElig = await session(await mk(3), "ELIGIBLE");
      const sIssued = await ready(await mk(4), "3");
      const vSub = await mk(5);
      const { s: sSub } = await mined(vSub, "3");
      const { s: sDone } = await vote(await mk(6), "3");
      await receipt(sDone);
      await closeElection();
      const nonce = await relayerNonce();
      const voting = [["post", "/eligibility/check"], ["get", "/ballot"], ["post", "/authorization", { candidateId: "3" }]];

      for (const s of [sAuth, sFace, sElig]) {
        for (const [method, p, body] of [...voting, ["get", "/receipt"], ["get", "/status"]]) assert.equal((await call(s, method, p, body)).body.error.code, "ELECTION_CLOSED", `${s.voter.name} ${p}`);
        assert.equal((await cast(s)).body.error.code, "ELECTION_CLOSED");
      }
      const issuedReceipt = await receipt(sIssued);
      assert.equal(issuedReceipt.status, 409);
      assert.equal(issuedReceipt.body.error.code, "STAGE_REQUIRED");
      assert.equal((await call(sIssued, "get", "/status")).body.data.electionPhase, "Closed");
      for (const [method, p, body] of voting) assert.equal((await call(sIssued, method, p, body)).body.error.code, "ELECTION_CLOSED", p);
      assert.equal((await cast(sIssued)).body.error.code, "ELECTION_CLOSED");
      assert.equal((await ticketOf((await Voter.findOne({ name: "Voter 104" })))).status, "AUTH_ISSUED", "nothing was submitted");

      for (const s of [sSub, sDone]) {
        for (const [method, p, body] of voting) assert.equal((await call(s, method, p, body)).body.error.code, "ELECTION_CLOSED", p);
        assert.equal((await cast(s)).body.error.code, "ELECTION_CLOSED");
        assert.equal((await receipt(s)).status, 200);
        assert.equal((await call(s, "get", "/status")).status, 200);
      }
      assert.equal(await relayerNonce(), nonce, "no transaction was sent after close");
      assert.equal(await chain.contract.totalBallots(), 2n);
    });
  });

  // ================================================================================================================
  describe("I. HTTP abuse", () => {
    it("public receipt path abuse: odd, huge, double-encoded, 0X prefix, trailing slash, repeated/array query", async () => {
      const { txHash } = await vote(voter, "3");
      const bad = [txHash.replace("0x", "0X"), "%250x" + txHash.slice(2), encodeURIComponent(txHash) + "%00", txHash + "%20", "%20" + txHash, txHash.slice(2), "0x" + "A".repeat(64) + "/..", "..%5c..%5c" + txHash, "%e0%a4%a", "0x" + "ff".repeat(33), "{{7*7}}", "%24ne", "__proto__", "constructor"];
      for (const b of bad) {
        const res = await pub(`/receipts/${b}`);
        assert.ok([400, 404].includes(res.status), `${b} -> ${res.status} ${res.text}`);
        assert.ok(res.body.error, b);
        noRaw(res, b);
      }
      const trailing = await pub(`/receipts/${txHash}/`);
      assert.ok([200, 404].includes(trailing.status));
      for (const q of ["?a=1&a=2", "?a[]=1", "?txHash=0x1", "?__proto__[x]=1", "?x"]) assert.equal((await pub(`/receipts/${txHash}${q}`)).status, 400, q);
      assert.equal((await pub(`/receipts/${txHash.toUpperCase().replace("0X", "0x")}`)).status, 200, "hex case");
      let status;
      try {
        status = (await request(app).get(`${API}/public/receipts/` + "a".repeat(40_000))).status;
      } catch {
        status = "closed";
      }
      assert.ok(status === "closed" || (status >= 400 && status < 500), `huge path -> ${status}`);
      assert.equal((await pub(`/receipts`)).status, 404);
      assert.equal((await pub(`/receipts/`)).status, 404);
    });

    it("method abuse: only GET works on /public/*, /voter/receipt; others are JSON 404/405 with no data", async () => {
      const { s, txHash } = await vote(voter, "3");
      const targets = [`${API}/public/receipts/${txHash}`, `${API}/public/election`, `${API}/public/results`, `${API}/voter/receipt`];
      for (const target of targets) {
        for (const method of ["post", "put", "patch", "delete"]) {
          const res = await request(app)[method](target).set("Cookie", `vc_voter=${s.token}`).send({});
          assert.ok([404, 405].includes(res.status), `${method} ${target} -> ${res.status}`);
          assert.ok(res.body.error, `${method} ${target}`);
          assert.equal(res.body.data, undefined);
        }
      }
      const head = await request(app).head(`${API}/public/results`);
      assert.equal(head.status, 403, "HEAD takes the GET path and honours the Closed-only rule");
      assert.equal((await request(app).get(`${API}/voter/cast`).set("Cookie", `vc_voter=${s.token}`)).status, 404);
      assert.equal(await VoteTicket.countDocuments({}), 1);
    });

    it("/voter/receipt authentication: no cookie, junk cookies, NoSQL/JSON cookies, another voter's cookie, a revoked cookie", async () => {
      const a = await vote(voter, "3");
      const other = await mkVoter(2);
      const b = await ready(other, "4");
      assert.equal((await request(app).get(`${API}/voter/receipt`)).status, 401);
      for (const cookie of ["vc_voter=", "vc_voter=short", `vc_voter=${"x".repeat(5000)}`, 'vc_voter=j:{"$ne":"x"}', "vc_voter[$ne]=x", `vc_voter=${a.s.token}x`, `vc_voter=${a.s.token.toUpperCase()}`, "vc_voter=null", `x=${a.s.token}`]) {
        const res = await request(app).get(`${API}/voter/receipt`).set("Cookie", cookie);
        assert.equal(res.status, 401, cookie.slice(0, 40));
        assert.equal(res.body.error.code, "UNAUTHENTICATED");
      }
      // B's cookie, with every trick to name A, still only ever speaks about B
      for (const extra of ["?voterId=" + voter.voterId, "?txHash=" + a.txHash]) assert.equal((await call(b, "get", "/receipt" + extra)).status, 400);
      const asB = await call(b, "get", "/receipt", undefined, { "X-Voter-Id": voter.voterId, "X-Forwarded-For": "1.2.3.4" });
      assert.equal(asB.status, 409);
      assert.equal(asB.body.error.code, "STAGE_REQUIRED");
      assert.ok(!asB.text.includes(a.txHash));
      // two cookies of the same name: whichever the server picks must be consistent with its owner
      const dup = await request(app).get(`${API}/voter/receipt`).set("Cookie", `vc_voter=${b.token}; vc_voter=${a.s.token}`);
      assert.equal(dup.status, 409, "the first cookie wins and it is B's");
      assert.equal((await call(a.s, "post", "/auth/logout", {})).status, 204);
      assert.equal((await receipt(a.s)).status, 401);
    });

    it("rate limiting of /public/receipts is per socket address: spoofed X-Forwarded-For does not buy a fresh budget; election/results are not limited by it", async () => {
      app = build(chain, { publicReceiptRateLimit: null });
      const bad = rnd32();
      let blocked = 0;
      for (let i = 0; i < 40; i++) {
        const res = await request(app).get(`${API}/public/receipts/${bad}`).set("X-Forwarded-For", `10.0.${i}.${i}`);
        if (res.status === 429) {
          blocked++;
          assert.equal(res.body.error.code, "RATE_LIMITED");
          assert.ok(!/Neha|candidate|votes/i.test(res.text));
        }
      }
      assert.ok(blocked >= 9, `only ${blocked} requests were limited`);
      assert.equal((await pub("/election")).status, 200);
    });
  });

  // ================================================================================================================
  describe("J. public API before Closed", () => {
    it("no body (200/202/4xx/5xx/429) or header from any public route contains candidate choice or tally data before Closed", async () => {
      const { txHash } = await vote(voter, "3");
      const other = await mkVoter(2);
      const pendingVote = await (async () => {
        app = build(chain, { receiptTimeoutMs: 200 });
        const s = await ready(other, "4");
        await automine(false);
        const r = await cast(s);
        return r.body.data.txHash;
      })();
      const probes = [
        `/receipts/${txHash}`, `/receipts/${pendingVote}`, `/receipts/${rnd32()}`, "/receipts/0x12", "/results", "/election", "/election?x=1", "/results?x=1",
      ];
      const results = [];
      for (const p of probes) results.push([p, await pub(p)]);
      await mine();
      await automine(true);
      results.push(["mined", await publicReceipt(pendingVote)]);
      const transfer = await (await chain.signers.owner.sendTransaction({ to: hardhatAccount(9).address, value: 1n })).wait();
      results.push(["transfer", await publicReceipt(transfer.hash)]);
      const statuses = results.map(([, r]) => r.status);
      assert.ok(statuses.includes(202) && statuses.includes(200) && statuses.includes(404) && statuses.includes(400) && statuses.includes(403) && statuses.includes(422), statuses.join());
      for (const [p, res] of results) {
        const everything = res.text + JSON.stringify(res.headers);
        const label = `${p} (${res.status})`;
        if (p !== "/election") assert.ok(!/Neha|Amit|Rahul|Rakesh|Anjali|Kiran|Megha|Rohan|Priya/.test(everything), `${label} names a candidate`);
        assert.ok(!/"votes"|"totalVotes"|"totalBallots"|"candidate"\s*:|"candidateId"\s*:\s*"(3|4)"[^}]*"votes"/.test(everything), `${label} carries a tally/choice`);
        assert.ok(!/nullifier|voterId|uid/i.test(everything), label);
      }
      const electionBody = JSON.stringify(results.find(([p]) => p === "/election")[1].body);
      assert.ok(!/votes|total|tally|ballots|count/i.test(electionBody));
    });
  });

  // ================================================================================================================
  describe("K. privacy scan across a hostile scenario", () => {
    it("no response, header, log line or audit row holds uid, nullifier, signature, rawTx, keys, tokens or the RPC secret; audit rows never link a voter to a candidate or tx", async () => {
      const first = await vote(voter, "3");
      const r1 = await receipt(first.s);
      await receipt(first.s);
      clock.advance(61);
      const s2 = await session(voter, "FACE_VERIFIED");
      await call(s2, "post", "/eligibility/check");
      await receipt(s2);
      await call(s2, "get", "/status");
      await pub("/election");
      await pub("/results");
      await publicReceipt(first.txHash);
      // failure paths with a raw secret error
      const downApp = build(failing("provider", "getTransactionReceipt"));
      app = downApp;
      await publicReceipt(first.txHash);
      await call(s2, "get", "/receipt");
      app = build(failing("contract", "nullifierUsed"));
      await call(s2, "post", "/eligibility/check");
      app = build();
      // a foreign/reverted tx and a forged ticket
      const transfer = await (await chain.signers.owner.sendTransaction({ to: hardhatAccount(9).address, value: 1n })).wait();
      await publicReceipt(transfer.hash);
      const v2 = await mkVoter(2);
      const s3 = await ready(v2, "4");
      await VoteTicket.updateOne({ voterId: v2._id }, { $set: { status: "CONFIRMED", txHash: first.txHash } });
      await setStage(s3, "SUBMITTED");
      await receipt(s3);
      await closeElection();
      await publicReceipt(first.txHash);
      await pub("/results");
      app = build(withContract({ votesOf: async (x) => (await chain.contract.votesOf(x)) + 1n }));
      await pub("/results");

      const raw = await mongoose.connection.collection("voters_v2").findOne({ _id: voter._id });
      const nullifier = await nullifierOf(voter);
      const rows = await auditRows();
      const audit = JSON.stringify(rows);
      const wire = captured.map((c) => c.text + JSON.stringify(c.headers)).join("\n");
      const everything = wire + audit + memory.lines.join("");
      const sec = config.secrets;
      const ticket = await ticketOf(voter);
      for (const secret of [raw.uid, nullifier, first.s.token, s2.token, s3.token, sec.nullifierSecret.toString("hex"), sec.authorityPrivateKey, sec.relayerPrivateKey, sec.ownerPrivateKey, sec.authorityPrivateKey.slice(2), sec.relayerPrivateKey.slice(2), PW, "secret-rpc", "10.0.0.1", "KEY-12345"]) {
        assert.ok(!everything.includes(secret), `leaked ${String(secret).slice(0, 10)}...`);
      }
      assert.ok(!/0x[0-9a-fA-F]{130}\b/.test(everything), "a 65-byte signature appears somewhere");
      assert.ok(!/rawTx|"signature"/i.test(wire));
      assert.ok(!/0x02f[0-9a-f]{200,}/i.test(everything), "a raw transaction appears somewhere");
      assert.equal(ticket.rawTx, null, "the raw transaction is dropped at confirmation");
      assert.ok(!wire.includes(await nullifierOf(v2)), "second voter's nullifier");
      for (const row of rows) {
        assert.equal(row.meta?.candidateId, undefined, `${row.action} carries a candidate id`);
        assert.ok(!/Neha|Rahul|Amit/.test(JSON.stringify(row)), `${row.action} names a candidate`);
        if (row.meta?.voterId !== undefined) assert.equal(row.txHash, null, `${row.action} links a voter to a tx`);
        if (["VOTER_RECEIPT_ISSUED", "VOTER_RECEIPT_RECOVERED", "RESULTS_PUBLISHED", "RESULT_INCONSISTENCY"].includes(row.action)) {
          assert.equal(row.txHash, null);
          assert.equal(row.meta?.voterId, undefined);
        }
      }
      // the voter's own response is the ONLY place the name appears, and only in recordedSelection
      assert.equal(r1.body.data.recordedSelection.name, "Neha Joshi");
      for (const c of captured) {
        if (c.path === "/receipt" || c.path === "/eligibility/check") continue;
        if (c.path.startsWith("/public/results") && c.status === 200) continue;
        if (c.path === "/public/election" || c.path.endsWith("/ballot")) continue;
        assert.ok(!/Neha Joshi/.test(c.text), `${c.method} ${c.path} (${c.status}) names the recorded candidate`);
      }
    });
  });
});
