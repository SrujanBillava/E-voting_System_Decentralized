import assert from "node:assert/strict";
import http from "node:http";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import { Transaction, Wallet, concat, getBytes, hexlify, toBeHex } from "ethers";
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

// Adversarial integration tests for ELIGIBLE -> AUTH_ISSUED -> SUBMITTED. Needs the local chain AND a disposable MongoDB
// (MONGODB_TEST_URI). Every test runs inside an evm snapshot; no test touches the chain clock.
const uri = process.env.MONGODB_TEST_URI;
const PW = "voter password number 1";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const BLR = [1n, 2n, 3n, 4n, 5n, 6n, 7n];
let keySeq = 0;
const newKey = () => `adv-key-${Date.now()}-${++keySeq}-abcdef`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("ADVERSARIAL voting flow (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, memory, auth, app, config, relayerQueue, castSvc, t, captured;
  const clock = { now: () => t, advance: (s) => (t += s * 1000) };
  const owner = () => chain.contract.connect(chain.signers.owner);
  const relayerAddr = () => chain.signers.addresses.relayer;
  const relayerNonce = () => chain.provider.getTransactionCount(relayerAddr(), "latest");
  const automine = (on) => chain.provider.send("evm_setAutomine", [on]);
  const votes = async (...ids) => Promise.all(ids.map((id) => chain.contract.votesOf(id)));
  const total = () => chain.contract.totalBallots();
  const mkVoter = async (n = 1, over = {}) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name: `Voter ${n}`, email: `v${n}@example.org`, passwordHash: await bcrypt.hash(PW, 4), constituencyCode: "KA-BLR", ...over });

  const withProvider = (overrides) => ({ ...chain, provider: new Proxy(chain.provider, { get: (target, p) => overrides[p] ?? (typeof target[p] === "function" ? target[p].bind(target) : target[p]) }) });
  const withSigners = (over) => {
    const s = Object.create(chain.signers);
    for (const [k, v] of Object.entries(over)) Object.defineProperty(s, k, { value: v });
    return { ...chain, signers: s };
  };

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

  // Every response the "network attacker" could see is recorded for the privacy scan.
  const record = (res, method, path) => {
    captured.push({ method, path, status: res.status, headers: Object.fromEntries(Object.entries(res.headers).filter(([k]) => k !== "set-cookie")), text: res.text ?? "" });
    return res;
  };
  const login = async (voter) => {
    const res = record(await request(app).post("/api/v1/voter/auth/login").send({ identifier: voter.voterId, password: PW }), "POST", "/auth/login");
    return res;
  };
  const session = async (voter, upTo = "ELIGIBLE") => {
    const res = await login(voter);
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
  const call = async (s, method, path, body, headers = {}) => {
    const r = request(app)[method](`/api/v1/voter${path}`).set("Cookie", `vc_voter=${s.token}`);
    for (const [k, v] of Object.entries(headers)) r.set(k, v);
    return record(await (method === "get" ? r : r.send(body ?? {})), method, path);
  };
  /** A request with full control over content type, raw body, headers and query string. */
  const rawPost = async (s, path, { body, type, headers = {} } = {}) => {
    let r = request(app).post(`/api/v1/voter${path}`).set("Cookie", `vc_voter=${s.token}`);
    if (type) r = r.set("Content-Type", type);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return record(await (body === undefined ? r : r.send(body)), "POST", path);
  };
  const authorize = (s, candidateId = "3") => call(s, "post", "/authorization", { candidateId });
  const cast = (s, key = newKey()) => call(s, "post", "/cast", {}, { "Idempotency-Key": key });
  const ready = async (voter, candidateId = "3") => {
    const s = await session(voter);
    const res = await authorize(s, candidateId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return s;
  };
  const stageOf = async (s) => (await VoterSession.findById(s.sessionId)).stage;
  const ticketOf = (voter) => VoteTicket.findOne({ voterId: voter._id }).select("+rawTx +candidateId +nullifier +constituencyId");
  const nullifierOf = async (voter) => deriveNullifier({ secret: config.secrets.nullifierSecret, electionId: chain.deployment.electionId, voterUid: (await Voter.findById(voter._id).select("+uid")).uid });
  const argsOfRaw = (rawTx) => chain.contract.interface.parseTransaction({ data: Transaction.from(rawTx).data }).args; // [constituencyId, nullifier, candidateId, deadline, signature]
  const relayerContract = () => chain.contract.connect(chain.signers.relayer);
  const revertsWith = (name) => (e) => e.revert?.name === name;
  const ballotEvents = () => chain.contract.queryFilter(chain.contract.filters.BallotCast());
  const waitFor = async (fn, ms = 5000) => {
    const stop = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      assert.ok(Date.now() < stop, "condition not reached in time");
      await sleep(25);
    }
  };
  const noTransactionSent = async (nonceBefore) => assert.equal(await relayerNonce(), nonceBefore, "the relayer sent a transaction");
  const rpcDown = () => {
    const state = { down: true };
    return { state, chain: withProvider({ broadcastTransaction: async (raw) => { if (state.down) throw new Error("rpc down"); return chain.provider.broadcastTransaction(raw); } }) };
  };

  let voter;
  before(async () => {
    await mongoose.connect(uri);
    chain = localServices();
    await assertPristineLocalChain(chain);
    config = loadEnv(validEnv());
  });
  after(async () => {
    // The head block of an idle dev chain is legitimately old, so measure the clock with a throw-away block.
    const probe = await snapshot(chain.provider);
    await chain.provider.send("evm_mine", []);
    const head = await chain.provider.getBlock("latest");
    await revertTo(chain.provider, probe);
    const drift = head.timestamp - Math.floor(Date.now() / 1000);
    await automine(true);
    chain?.destroy();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    assert.ok(Math.abs(drift) < 120, `the shared chain clock was left shifted by ${drift}s`);
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

  // ------------------------------------------------------------------------------------------------------------------
  describe("a signed authorization in the hands of the relayer key holder (contract level)", () => {
    it("the captured castVote for candidate A cannot be bent to B, another voter, another constituency, another deadline, a non-relayer or a malleated signature; the replay after counting is refused", async () => {
      const net = rpcDown();
      app = build(net.chain);
      const s = await ready(voter, "3");
      assert.equal((await cast(s)).status, 503);
      const [constituencyId, nullifier, candidateId, deadline, signature] = argsOfRaw((await ticketOf(voter)).rawTx);
      assert.equal(candidateId, 3n);
      const attacker = relayerContract(); // the compromised relayer key
      const other = await mkVoter(2);
      const otherNullifier = await nullifierOf(other);

      for (const wrong of [1n, 2n, 4n, 5n, 6n, 7n]) await assert.rejects(attacker.castVote.staticCall(constituencyId, nullifier, wrong, deadline, signature), revertsWith("InvalidAuthorizationSignature"), `candidate ${wrong}`);
      for (const foreign of [8n, 14n]) await assert.rejects(attacker.castVote.staticCall(constituencyId, nullifier, foreign, deadline, signature), revertsWith("CandidateConstituencyMismatch"));
      await assert.rejects(attacker.castVote.staticCall(constituencyIdOf("DL-DEL"), nullifier, 8n, deadline, signature), revertsWith("InvalidAuthorizationSignature"), "foreign constituency with a matching candidate");
      await assert.rejects(attacker.castVote.staticCall(constituencyId, otherNullifier, candidateId, deadline, signature), revertsWith("InvalidAuthorizationSignature"), "another voter's nullifier");
      await assert.rejects(attacker.castVote.staticCall(constituencyId, nullifier, candidateId, deadline + 1n, signature), revertsWith("InvalidAuthorizationSignature"), "a longer deadline");
      const bytes = getBytes(signature);
      const malleated = concat([bytes.slice(0, 32), toBeHex(SECP256K1_N - BigInt(hexlify(bytes.slice(32, 64))), 32), new Uint8Array([bytes[64] === 27 ? 28 : 27])]);
      await assert.rejects(attacker.castVote.staticCall(constituencyId, nullifier, candidateId, deadline, malleated), revertsWith("InvalidAuthorizationSignature"), "high-s malleated signature");
      for (const w of [chain.signers.owner, chain.signers.authority, new Wallet(hardhatAccount(9).privateKey, chain.provider)]) await assert.rejects(chain.contract.connect(w).castVote.staticCall(constituencyId, nullifier, candidateId, deadline, signature), revertsWith("NotRelayer"));
      assert.equal(await total(), 0n);

      net.state.down = false; // the backend finishes the vote with the very same bytes
      const ok = await cast(s);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
      await assert.rejects(attacker.castVote.staticCall(constituencyId, nullifier, candidateId, deadline, signature), revertsWith("NullifierAlreadyUsed"), "replay after counting");
      await assert.rejects(attacker.castVote.staticCall(constituencyId, nullifier, 4n, deadline, signature), revertsWith("NullifierAlreadyUsed"));
    });

    it("authorizations that are expired, signed by the wrong key, for the wrong relayer, for another chain or contract, or for a zero nullifier are all refused by the contract", async () => {
      const nullifier = await nullifierOf(voter);
      const base = { electionId: chain.deployment.electionId, constituencyId: constituencyIdOf("KA-BLR"), nullifier, candidateId: 3n, relayer: relayerAddr(), deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
      const attacker = relayerContract();
      const send = async (message, signer = chain.signers.authority, domain = chain.domain) => {
        const sig = await signBallotAuthorization(signer, domain, message);
        return attacker.castVote.staticCall(message.constituencyId, message.nullifier, message.candidateId, message.deadline, sig);
      };
      await send(buildBallotAuthorization(base)); // control: a correct authorization passes the simulation
      await assert.rejects(send(buildBallotAuthorization({ ...base, deadline: BigInt(Math.floor(Date.now() / 1000) - 5000) })), revertsWith("AuthorizationExpired"), "expired");
      await assert.rejects(send(buildBallotAuthorization(base), new Wallet(hardhatAccount(5).privateKey)), revertsWith("InvalidAuthorizationSignature"), "signed by a non-authority key");
      await assert.rejects(send(buildBallotAuthorization(base), chain.signers.relayer), revertsWith("InvalidAuthorizationSignature"), "signed by the relayer key itself");
      await assert.rejects(send(buildBallotAuthorization({ ...base, relayer: new Wallet(hardhatAccount(6).privateKey).address })), revertsWith("InvalidAuthorizationSignature"), "authorized for a different relayer");
      await assert.rejects(send(buildBallotAuthorization({ ...base, electionId: "0x" + "11".repeat(32) })), revertsWith("InvalidAuthorizationSignature"), "another election id");
      await assert.rejects(send(buildBallotAuthorization(base), chain.signers.authority, { ...chain.domain, chainId: 1n }), revertsWith("InvalidAuthorizationSignature"), "another chain");
      await assert.rejects(send(buildBallotAuthorization(base), chain.signers.authority, { ...chain.domain, verifyingContract: relayerAddr() }), revertsWith("InvalidAuthorizationSignature"), "another contract");
      await assert.rejects(attacker.castVote.staticCall(base.constituencyId, nullifier, 3n, base.deadline, "0x"), revertsWith("InvalidAuthorizationSignature"), "empty signature");
      await assert.rejects(attacker.castVote.staticCall(base.constituencyId, "0x" + "00".repeat(32), 3n, base.deadline, await signBallotAuthorization(chain.signers.authority, chain.domain, buildBallotAuthorization(base))), revertsWith("ZeroId"));
      assert.equal(await total(), 0n);
    });

    it("the relayer key holder front-runs the identical ballot: exactly one ballot, for the authorized candidate, and the voter is never told it was confirmed by a foreign transaction", async () => {
      let front = null;
      app = build(withProvider({
        broadcastTransaction: async (raw) => {
          if (!front) front = await (await relayerContract().castVote(...argsOfRaw(raw))).wait(); // takes the nonce the backend chose
          return chain.provider.broadcastTransaction(raw);
        },
      }));
      const s = await ready(voter, "3");
      const first = await cast(s);
      assert.ok(first.status >= 400, JSON.stringify(first.body));
      const second = await cast(s);
      assert.equal(second.status, 409, JSON.stringify(second.body));
      assert.equal(second.body.error.code, "RECONCILIATION_REQUIRED");
      assert.equal(await total(), 1n);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
      const ticket = await ticketOf(voter);
      assert.equal(ticket.status, "FAILED");
      assert.notEqual(ticket.status, "CONFIRMED");
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 0);
      assert.notEqual(ticket.txHash, front.hash);
      assert.equal((await cast(s)).status, 409, "stays refused");
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("authorization input", () => {
    it("rejects every malformed or out-of-range candidateId without creating a ticket or moving the stage", async () => {
      const s = await session(voter);
      const validation = [
        3, 3.5, null, true, false, [], ["3"], [3], {}, { $ne: "" }, { $gt: "" }, { toString: "3" }, { candidateId: "3" },
        "", " ", "0", "00", "03", "003", "+3", "-3", "-0", "3.0", "3e0", "1e1", "0x3", "0b11", "0o3", "3n", " 3", "3 ", "\t3", "3\t", "\n3", "3\n", "3\r\n", "3\u0000", "3​", "​3", "3 ", " 3",
        "٣", "３", "³", "③", "𝟑", "३", "3,4", "3 4", "3;4", "3&candidateId=4", "3%0a", "3/*", "3--", "3'", '3"', "NaN", "Infinity", "undefined", "null", "true",
        "1000000000000000000", "18446744073709551616", "9".repeat(19), "9".repeat(78), "1".repeat(400),
      ];
      for (const candidateId of validation) {
        const res = await call(s, "post", "/authorization", { candidateId });
        assert.equal(res.status, 400, `${JSON.stringify(candidateId)} -> ${res.status} ${res.text}`);
        assert.equal(res.body.error.code, "VALIDATION_FAILED");
        assert.match(res.body.error.message, /^Invalid request: candidateId$/, "only the field name is reported, never the submitted value");
      }
      const onChain = [["19", "INVALID_CANDIDATE"], ["999999999999999999", "INVALID_CANDIDATE"], ["100000000000000000", "INVALID_CANDIDATE"], ["18", "CANDIDATE_NOT_IN_CONSTITUENCY"], ["8", "CANDIDATE_NOT_IN_CONSTITUENCY"], ["14", "CANDIDATE_NOT_IN_CONSTITUENCY"], ["13", "CANDIDATE_NOT_IN_CONSTITUENCY"]];
      for (const [candidateId, code] of onChain) {
        const res = await authorize(s, candidateId);
        assert.equal(res.status, 422, `${candidateId}: ${res.text}`);
        assert.equal(res.body.error.code, code, candidateId);
      }
      assert.equal(await VoteTicket.countDocuments({}), 0);
      assert.equal(await stageOf(s), "ELIGIBLE");
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_AUTHORIZATION_ISSUED" }), 0);
    });

    it("accepts the lowest and highest candidate of the voter's own ballot, and counts exactly that one", async () => {
      const first = await ready(voter, "1");
      assert.equal((await cast(first)).status, 200);
      const v2 = await mkVoter(2);
      assert.equal((await cast(await ready(v2, "7"))).status, 200);
      assert.deepEqual(await votes(...BLR), [1n, 0n, 0n, 0n, 0n, 0n, 1n]);
      const mum = await mkVoter(3, { constituencyCode: "MH-MUM" });
      const sm = await session(mum);
      assert.equal((await authorize(sm, "3")).body.error.code, "CANDIDATE_NOT_IN_CONSTITUENCY");
      assert.equal((await authorize(sm, "13")).body.error.code, "CANDIDATE_NOT_IN_CONSTITUENCY", "last Delhi candidate");
      assert.equal((await authorize(sm, "18")).status, 200, "highest candidate id overall");
      assert.equal((await cast(sm)).status, 200);
      assert.equal(await chain.contract.votesOf(18), 1n);
      assert.equal(await chain.contract.constituencyTotal(constituencyIdOf("MH-MUM")), 1n);
    });

    it("body shapes, content types, query strings and prototype tricks cannot smuggle identity or a candidate", async () => {
      const s = await session(voter);
      const cases = [
        { body: "[]", type: "application/json" },
        { body: '"3"', type: "application/json" },
        { body: "3", type: "application/json" },
        { body: "null", type: "application/json" },
        { body: "{not json", type: "application/json" },
        { body: '{"candidateId":"3"', type: "application/json" },
        { body: "candidateId=3", type: "application/x-www-form-urlencoded" },
        { body: "candidateId=3", type: "text/plain" },
        { body: '{"candidateId":"3"}', type: "text/plain" },
        { body: '{"candidateId":"3","__proto__":{"candidateId":"4"}}', type: "application/json" },
        { body: '{"candidateId":"3","constructor":{"prototype":{"candidateId":"4"}}}', type: "application/json" },
        { body: '{"candidateId":"3","nullifier":"0x' + "1".repeat(64) + '"}', type: "application/json" },
        { body: '{"candidateId":"3","signature":"0x' + "1".repeat(130) + '"}', type: "application/json" },
        { body: '{"candidateId":"3","relayer":"0x' + "1".repeat(40) + '"}', type: "application/json" },
        { body: '{"candidateId":"3","deadline":99999999999}', type: "application/json" },
        { body: JSON.stringify({ candidateId: "3", pad: "x".repeat(200_000) }), type: "application/json" },
      ];
      for (const c of cases) {
        const res = await rawPost(s, "/authorization", c);
        assert.ok(res.status === 400 || res.status === 413, `${c.body.slice(0, 60)} -> ${res.status}`);
      }
      for (const q of ["?candidateId=4", "?x=1", "?__proto__[candidateId]=4", "?candidateId[]=4", "?constituency=DL-DEL"]) {
        const res = await rawPost(s, `/authorization${q}`, { body: '{"candidateId":"3"}', type: "application/json" });
        assert.equal(res.status, 400, q);
      }
      assert.equal(Object.prototype.candidateId, undefined, "Object.prototype was polluted");
      assert.equal(await VoteTicket.countDocuments({}), 0);
      assert.equal(await stageOf(s), "ELIGIBLE");
    });

    it("no endpoint lets a voter reach another constituency's candidate or choose a constituency", async () => {
      const del = await mkVoter(2, { constituencyCode: "DL-DEL" });
      const sd = await session(del);
      for (const id of ["1", "3", "7", "14", "18"]) assert.equal((await authorize(sd, id)).body.error.code, "CANDIDATE_NOT_IN_CONSTITUENCY", id);
      const ballot = await call(sd, "get", "/ballot", undefined, { "X-Constituency": "KA-BLR", "X-Forwarded-Host": "KA-BLR" });
      assert.equal(ballot.status, 200);
      assert.deepEqual(ballot.body.data.candidates.map((c) => c.candidateId), ["8", "9", "10", "11", "12", "13"]);
      assert.equal((await call(sd, "get", "/ballot?constituency=KA-BLR")).status, 400);
      assert.equal((await call(sd, "get", "/ballot?constituencyCode=KA-BLR")).status, 400);
      assert.equal((await call(sd, "post", "/eligibility/check", { constituencyCode: "KA-BLR" })).status, 400);
      assert.equal((await authorize(sd, "9")).status, 200);
      const nonce = await relayerNonce();
      for (const body of [{ candidateId: "3" }, { constituencyId: constituencyIdOf("KA-BLR") }, { constituencyCode: "KA-BLR" }]) assert.equal((await call(sd, "post", "/cast", body, { "Idempotency-Key": newKey() })).status, 400);
      for (const q of ["?candidateId=3", "?constituency=KA-BLR"]) assert.equal((await call(sd, "post", `/cast${q}`, {}, { "Idempotency-Key": newKey() })).status, 400);
      await noTransactionSent(nonce);
      assert.equal((await cast(sd, newKey())).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 0n, 0n, 0n, 0n, 0n]);
      assert.equal(await chain.contract.votesOf(9), 1n);
      assert.equal(await chain.contract.constituencyTotal(constituencyIdOf("DL-DEL")), 1n);
      assert.equal(await chain.contract.constituencyTotal(constituencyIdOf("KA-BLR")), 0n);
    });

    it("concurrent authorizations for DIFFERENT candidates on a fresh voter: exactly one is acknowledged and that one is what gets counted", async () => {
      const s = await session(voter);
      const ids = ["1", "2", "3", "4", "5", "6", "7"];
      const results = await Promise.all(ids.map((id) => authorize(s, id)));
      const ok = results.filter((r) => r.status === 200);
      assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.body)));
      for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.body.error.code, "AUTHORIZATION_ALREADY_ISSUED");
      const chosen = ids[results.indexOf(ok[0])];
      assert.equal((await ticketOf(voter)).candidateId, chosen);
      assert.equal(await VoteTicket.countDocuments({}), 1);
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_AUTHORIZATION_ISSUED" }), 1);
      assert.equal((await cast(s)).status, 200);
      const counted = await votes(...BLR);
      assert.deepEqual(counted.map(String), BLR.map((id) => (String(id) === chosen ? "1" : "0")));
    });

    it("re-authorization cannot change the choice at any point: unexpired, in flight, or after the vote is counted", async () => {
      const net = rpcDown();
      app = build(net.chain);
      const s = await ready(voter, "3");
      assert.equal((await authorize(s, "4")).body.error.code, "AUTHORIZATION_ALREADY_ISSUED");
      assert.equal((await cast(s)).status, 503); // A's signed transaction is persisted, the broadcast failed
      const mid = await ticketOf(voter);
      for (const id of ["3", "4", "5"]) assert.equal((await authorize(s, id)).status, 409, id);
      let after = await ticketOf(voter);
      assert.deepEqual([after.candidateId, after.status, after.txHash, after.rawTx], ["3", "SUBMITTING", mid.txHash, mid.rawTx]);

      // the voter's session dies and they log in again: still cannot swap
      clock.advance(400);
      const s2 = await session(voter);
      assert.equal((await authorize(s2, "4")).body.error.code, "AUTHORIZATION_ALREADY_ISSUED");
      after = await ticketOf(voter);
      assert.deepEqual([after.candidateId, after.status, after.txHash], ["3", "SUBMITTING", mid.txHash]);

      net.state.down = false;
      assert.equal(await castSvc.recoverPending({ minAgeMs: 0 }), 1);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
    });

    it("a second login cannot run beside a live session; after logout the old cookie is dead, a stale unexpired ticket cannot be cast from ELIGIBLE, and one ballot results", async () => {
      const s1 = await ready(voter, "3");
      assert.equal((await login(voter)).body.error.code, "SESSION_ACTIVE");
      assert.equal((await call(s1, "post", "/auth/logout", {})).status, 204);
      assert.equal((await cast(s1)).status, 401, "the revoked cookie is useless");
      const s2 = await session(voter);
      const nonce = await relayerNonce();
      assert.equal((await cast(s2)).body.error.code, "STAGE_REQUIRED", "an unexpired ticket does not bypass the stage");
      await noTransactionSent(nonce);
      assert.equal((await authorize(s2, "4")).body.error.code, "AUTHORIZATION_ALREADY_ISSUED");
      const again = await authorize(s2, "3");
      assert.equal(again.status, 200);
      assert.equal(String((await ticketOf(voter))._id), again.body.data.ticketId, "same ticket, not a second one");
      assert.equal((await cast(s2)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
      assert.equal(await total(), 1n);
      assert.equal(await VoteTicket.countDocuments({}), 1);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("cast request hygiene", () => {
    it("query strings, body fields and odd bodies are refused before anything is signed", async () => {
      const s = await ready(voter, "3");
      const nonce = await relayerNonce();
      const key = { "Idempotency-Key": newKey() };
      for (const q of ["?candidateId=4", "?x=1", "?__proto__[candidateId]=4", "?signature=0x", "?a=1&a=2"]) assert.equal((await rawPost(s, `/cast${q}`, { body: "{}", type: "application/json", headers: key })).status, 400, q);
      for (const body of ['{"candidateId":"4"}', '{"candidateId":"3"}', '{"nullifier":"0x1"}', '{"signature":"0x"}', '{"relayer":"0x1"}', '{"__proto__":{"candidateId":"4"}}', '{"idempotencyKey":"aaaaaaaa"}', "[]", '"x"', "null", "{bad", JSON.stringify({ pad: "y".repeat(150_000) })]) {
        const res = await rawPost(s, "/cast", { body, type: "application/json", headers: key });
        assert.ok([400, 413].includes(res.status), `${body.slice(0, 40)} -> ${res.status}`);
      }
      assert.equal((await rawPost(s, "/cast", { body: "candidateId=4", type: "application/x-www-form-urlencoded", headers: key })).status, 200, "an ignored form body does not choose a candidate");
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
      assert.equal(await relayerNonce(), nonce + 1);
    });

    it("hostile Idempotency-Key values are refused without echo, GET/PUT are not routed, and the boundary lengths work", async () => {
      const s = await ready(voter, "3");
      const nonce = await relayerNonce();
      const bad = ["", "short", "x".repeat(7), "x".repeat(65), "x".repeat(8000), "key with spaces", "key,comma,comma", "key;semi;colon", 'key"quote"quote', "<script>alert(1)</script>", "../../etc/passwd", "$ne$ne$ne$ne", "kéy12345678", "tab\tin\tkey1234", "a".repeat(8) + "\u007f", "%0d%0aX-Evil:1", "key\\r\\nX-Evil:1", "0x" + "ab".repeat(40), "{{7*7}}{{7*7}}"];
      for (const key of bad) {
        let res;
        try {
          res = await call(s, "post", "/cast", {}, { "Idempotency-Key": key });
        } catch {
          continue; // the HTTP client itself refuses to put this on the wire
        }
        assert.equal(res.status, 400, JSON.stringify(key.slice(0, 30)));
        assert.equal(res.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
        assert.ok(!res.text.includes("<script>") && !res.text.includes("passwd"), "the key is never echoed");
        assert.equal(res.headers["x-evil"], undefined);
      }
      const dup = await rawPost(s, "/cast", { body: "{}", type: "application/json", headers: { "Idempotency-Key": ["goodkey-one-1", "goodkey-two-2"] } });
      assert.equal(dup.status, 400, "two Idempotency-Key headers");
      for (const [method, path] of [["get", "/cast"], ["put", "/cast"], ["delete", "/cast"], ["get", "/authorization"], ["put", "/authorization"]]) assert.equal((await request(app)[method](`/api/v1/voter${path}`).set("Cookie", `vc_voter=${s.token}`)).status, 404, `${method} ${path}`);
      assert.equal((await request(app).post("/api/v1/voter/cast").set("Idempotency-Key", newKey()).send({})).status, 401, "no cookie");
      assert.equal((await request(app).post("/api/v1/voter/cast").set("Cookie", "vc_voter=garbage").set("Idempotency-Key", newKey()).send({})).status, 401);
      await noTransactionSent(nonce);
      assert.equal((await ticketOf(voter)).status, "AUTH_ISSUED");
      assert.equal((await cast(s, "AbC_-123")).status, 200, "8-character key");
      assert.equal((await cast(s, "k".repeat(64))).status, 200, "64-character key replays the result");
      assert.equal(await total(), 1n);
    });

    it("the same Idempotency-Key used by two voters never crosses over", async () => {
      const v2 = await mkVoter(2);
      const sa = await ready(voter, "3");
      const sb = await ready(v2, "4");
      const [ra, rb] = await Promise.all([cast(sa, "shared-key-for-both"), cast(sb, "shared-key-for-both")]);
      assert.deepEqual([ra.status, rb.status], [200, 200]);
      assert.notEqual(ra.body.data.txHash, rb.body.data.txHash);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 1n, 0n, 0n, 0n]);
      const byNullifier = new Map((await ballotEvents()).map((e) => [e.args.nullifier, e]));
      assert.equal(byNullifier.get(await nullifierOf(voter)).transactionHash, ra.body.data.txHash);
      assert.equal(byNullifier.get(await nullifierOf(v2)).transactionHash, rb.body.data.txHash);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("malformed session and ticket combinations (manufactured in Mongo)", () => {
    const forceStage = (s, stage, ms = 120_000) => VoterSession.updateOne({ _id: s.sessionId }, { stage, stageExpiresAt: new Date(clock.now() + ms) });

    it("session AUTH_ISSUED but no ticket: nothing is signed or sent; a normal authorization still works from there", async () => {
      const s = await session(voter);
      await forceStage(s, "AUTH_ISSUED");
      const nonce = await relayerNonce();
      const res = await cast(s);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "STAGE_REQUIRED");
      assert.equal(await VoteTicket.countDocuments({}), 0);
      await noTransactionSent(nonce);
      assert.equal((await authorize(s, "5")).status, 200);
      assert.equal((await cast(s)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 0n, 0n, 1n, 0n, 0n]);
    });

    it("voter Y in AUTH_ISSUED without a ticket cannot touch voter X's ticket; with their own, each counts only their own choice", async () => {
      const y = await mkVoter(2);
      const sx = await ready(voter, "3");
      const sy = await session(y);
      await forceStage(sy, "AUTH_ISSUED");
      const nonce = await relayerNonce();
      assert.equal((await cast(sy)).body.error.code, "STAGE_REQUIRED");
      await noTransactionSent(nonce);
      const x1 = await ticketOf(voter);
      assert.deepEqual([x1.status, x1.candidateId, x1.txHash], ["AUTH_ISSUED", "3", null]);
      assert.equal((await authorize(sy, "4")).status, 200);
      const [rx, ry] = await Promise.all([cast(sx), cast(sy)]);
      assert.deepEqual([rx.status, ry.status], [200, 200]);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 1n, 0n, 0n, 0n]);
      const byNullifier = new Map((await ballotEvents()).map((e) => [e.args.nullifier, e.args.candidateId]));
      assert.equal(byNullifier.get(await nullifierOf(voter)), 3n);
      assert.equal(byNullifier.get(await nullifierOf(y)), 4n);
    });

    it("ticket CONFIRMED but the session is still AUTH_ISSUED: the answer is the confirmed one and the session is healed to SUBMITTED", async () => {
      const s = await ready(voter, "3");
      const ok = await cast(s);
      await forceStage(s, "AUTH_ISSUED");
      const nonce = await relayerNonce();
      const again = await cast(s);
      assert.equal(again.status, 200);
      assert.deepEqual(again.body.data, ok.body.data);
      assert.equal(await stageOf(s), "SUBMITTED");
      await noTransactionSent(nonce);
      assert.equal((await authorize(s, "4")).body.error.code, "STAGE_REQUIRED");
    });

    it("FAILED tickets never send anything: TX_REVERTED, and RECONCILIATION_REQUIRED with a missing, unknown or absent hash", async () => {
      const s = await ready(voter, "3");
      const nonce = await relayerNonce();
      await VoteTicket.updateOne({ voterId: voter._id }, { status: "FAILED", failureCode: "TX_REVERTED" });
      assert.equal((await cast(s)).body.error.code, "TX_REVERTED");
      for (const txHash of [null, "0x" + "ab".repeat(32)]) {
        await VoteTicket.updateOne({ voterId: voter._id }, { status: "FAILED", failureCode: "RECONCILIATION_REQUIRED", txHash });
        const res = await cast(s);
        assert.equal(res.status, 409);
        assert.equal(res.body.error.code, "RECONCILIATION_REQUIRED");
      }
      await noTransactionSent(nonce);
      assert.equal(await total(), 0n);
    });

    it("an expired ticket under a still-valid session stage is refused (no signature) and can be restarted properly", async () => {
      const s = await ready(voter, "3");
      await VoteTicket.updateOne({ voterId: voter._id }, { authorizationExpiresAt: new Date(clock.now() - 1000) });
      const nonce = await relayerNonce();
      const res = await cast(s);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "AUTHORIZATION_EXPIRED");
      assert.equal((await ticketOf(voter)).status, "AUTH_ISSUED");
      await noTransactionSent(nonce);
      assert.equal((await authorize(s, "6")).status, 200, "an expired, never-submitted authorization may be replaced");
      assert.equal((await cast(s)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 0n, 0n, 0n, 1n, 0n]);
    });

    it("a SUBMITTING ticket whose lock another process holds is not re-signed: the request reports 202 and sends nothing", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      await VoteTicket.updateOne({ voterId: voter._id }, { status: "SUBMITTING", claimToken: "other-process", lockUntil: new Date(Date.now() + 60_000) });
      const nonce = await relayerNonce();
      const res = await cast(s);
      assert.equal(res.status, 202, JSON.stringify(res.body));
      assert.equal(res.body.data.state, "SUBMITTING");
      assert.equal(res.body.data.stage, "AUTH_ISSUED");
      await noTransactionSent(nonce);
      const ticket = await ticketOf(voter);
      assert.deepEqual([ticket.status, ticket.claimToken, ticket.txHash], ["SUBMITTING", "other-process", null]);
    });

    it("session SUBMITTED with a ticket that was reset to AUTH_ISSUED can still finish, and counts the ticket's candidate", async () => {
      const s = await ready(voter, "5");
      await forceStage(s, "SUBMITTED");
      const res = await cast(s);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(await votes(...BLR), [0n, 0n, 0n, 0n, 1n, 0n, 0n]);
    });

    it("voter X's cookie cannot cast voter Y's ticket (the ticket is looked up by the session's own voter)", async () => {
      const y = await mkVoter(2);
      const sx = await session(voter);
      const sy = await ready(y, "4");
      await forceStage(sx, "AUTH_ISSUED");
      assert.equal((await cast(sx)).body.error.code, "STAGE_REQUIRED");
      assert.equal((await ticketOf(y)).status, "AUTH_ISSUED");
      assert.equal(await total(), 0n);
      assert.equal((await cast(sy)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 0n, 1n, 0n, 0n, 0n]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("the voter or the election changes mid-flow", () => {
    it("suspended between authorization and cast: refused, nothing sent; once reinstated the same ticket finishes with the same candidate", async () => {
      const s = await ready(voter, "3");
      const nonce = await relayerNonce();
      await Voter.updateOne({ _id: voter._id }, { status: "SUSPENDED" });
      assert.equal((await cast(s)).status, 401);
      assert.equal((await login(voter)).body.error.code, "VOTER_SUSPENDED");
      await noTransactionSent(nonce);
      assert.equal(await total(), 0n);
      await Voter.updateOne({ _id: voter._id }, { status: "ACTIVE" });
      const s2 = await session(voter);
      assert.equal((await authorize(s2, "3")).status, 200);
      assert.equal((await cast(s2)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
    });

    it("the service itself refuses a suspended voter even if a stale session reaches it", async () => {
      const s = await ready(voter, "3");
      const principal = await auth.authenticate(s.token);
      await Voter.updateOne({ _id: voter._id }, { status: "SUSPENDED" });
      await assert.rejects(castSvc.cast(principal, { idempotencyKey: newKey() }, {}), (e) => e.code === "VOTER_SUSPENDED");
      assert.equal(await total(), 0n);
    });

    it("moved to another (or an invalid) constituency between authorization and cast: refused, nothing sent, the old-constituency candidate is never counted", async () => {
      const s = await ready(voter, "3");
      const nonce = await relayerNonce();
      for (const code of ["DL-DEL", "XX-NOPE", "not a code!!"]) {
        await Voter.updateOne({ _id: voter._id }, { constituencyCode: code });
        const res = await cast(s);
        assert.equal(res.status, 409, code);
        assert.equal(res.body.error.code, "CONSTITUENCY_NOT_CONFIGURED", code);
        await noTransactionSent(nonce);
        const ticket = await ticketOf(voter);
        assert.deepEqual([ticket.status, ticket.candidateId, ticket.txHash, ticket.rawTx], ["AUTH_ISSUED", "3", null, null]);
      }
      assert.equal(await total(), 0n);
      await Voter.updateOne({ _id: voter._id }, { constituencyCode: "DL-DEL" });
      assert.equal((await authorize(s, "8")).body.error.code, "AUTHORIZATION_ALREADY_ISSUED", "cannot restart until the old authorization has lapsed");
      await Voter.updateOne({ _id: voter._id }, { constituencyCode: "KA-BLR" });
      assert.equal((await cast(s)).status, 200, "moved back: the original authorization is still good");
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
    });

    it("a ticket authorized for BLR can never be counted for the voter's NEW constituency, and the restart after expiry counts only the new ballot", async () => {
      const s = await ready(voter, "3");
      await Voter.updateOne({ _id: voter._id }, { constituencyCode: "DL-DEL" });
      assert.equal((await cast(s)).status, 409);
      clock.advance(181);
      const s2 = await session(voter);
      assert.equal((await authorize(s2, "3")).body.error.code, "CANDIDATE_NOT_IN_CONSTITUENCY");
      assert.equal((await authorize(s2, "12")).status, 200);
      assert.equal((await cast(s2)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 0n, 0n, 0n, 0n, 0n]);
      assert.equal(await chain.contract.votesOf(12), 1n);
      assert.equal(await chain.contract.constituencyTotal(constituencyIdOf("DL-DEL")), 1n);
      assert.equal(await chain.contract.constituencyTotal(constituencyIdOf("KA-BLR")), 0n);
    });

    it("the owner rotates the relayer or the authority between authorization and cast: refused with nothing consumed, and the same ticket completes after the rotation is undone", async () => {
      const s = await ready(voter, "3");
      const nonce = await relayerNonce();
      const other = new Wallet(hardhatAccount(8).privateKey).address;
      await (await owner().setRelayer(other)).wait();
      assert.equal((await cast(s)).body.error.code, "CONFIGURATION_ERROR");
      await (await owner().setRelayer(relayerAddr())).wait();
      await (await owner().setAuthoritySigner(other)).wait();
      assert.equal((await cast(s)).body.error.code, "AUTHORIZATION_REJECTED");
      await (await owner().setAuthoritySigner(chain.signers.addresses.authority)).wait();
      assert.equal(await relayerNonce(), nonce, "only owner transactions happened");
      assert.equal(await total(), 0n);
      assert.equal((await ticketOf(voter)).status, "AUTH_ISSUED");
      assert.equal((await cast(s)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
    });

    it("the election closes between the persisted transaction and its broadcast: the reverted ballot is never reported as counted", async () => {
      let closed = false;
      app = build(withProvider({
        broadcastTransaction: async (raw) => {
          if (!closed) {
            closed = true;
            await (await owner().closeElection()).wait();
          }
          return chain.provider.broadcastTransaction(raw);
        },
      }));
      const s = await ready(voter, "3");
      const res = await cast(s);
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.notEqual(res.status, 200);
      assert.equal(await total(), 0n);
      assert.equal(await chain.contract.nullifierUsed(await nullifierOf(voter)), false);
      const ticket = await ticketOf(voter);
      assert.notEqual(ticket.status, "CONFIRMED");
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 0);
      assert.equal((await cast(s)).body.error.code, "ELECTION_CLOSED");
      await castSvc.recoverPending({ minAgeMs: 0 });
      assert.notEqual((await ticketOf(voter)).status, "CONFIRMED");
      assert.equal(await total(), 0n);
    });

    it("the election closes between the pre-flight simulation and transaction building: nothing is counted and the voter is not told the vote succeeded", async () => {
      app = build(withProvider({ estimateGas: async (req) => { await (await owner().closeElection()).wait(); return chain.provider.estimateGas(req); } }));
      const s = await ready(voter, "3");
      const res = await cast(s);
      assert.ok(res.status >= 400, JSON.stringify(res.body));
      assert.equal(await total(), 0n);
      assert.notEqual((await ticketOf(voter)).status, "CONFIRMED");
      assert.equal((await cast(s)).body.error.code, "ELECTION_CLOSED");
    });

    it("the vote and the close sit in the same pending block: the ticket ends CONFIRMED if and only if the ballot was counted", async (ctx) => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const s = await ready(voter, "3");
      await automine(false);
      try {
        assert.equal((await cast(s)).status, 202);
        await owner().closeElection();
        await chain.provider.send("evm_mine", []);
      } finally {
        await automine(true);
      }
      const counted = await total();
      await castSvc.recoverPending({ minAgeMs: 0 });
      const ticket = await ticketOf(voter);
      ctx.diagnostic(`vote ordered ${counted === 1n ? "before" : "after"} the close`);
      if (counted === 1n) {
        assert.equal(ticket.status, "CONFIRMED");
        assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
      } else {
        assert.equal(ticket.status, "FAILED");
        assert.equal(ticket.failureCode, "TX_REVERTED");
        assert.equal(await chain.contract.nullifierUsed(await nullifierOf(voter)), false);
      }
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), counted === 1n ? 1 : 0);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("lost responses, RPC failures and the relayer queue", () => {
    it("the client drops the connection mid-request: the vote still lands exactly once and every retry returns that result", async () => {
      const s = await ready(voter, "3");
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const req = http.request({ host: "127.0.0.1", port: server.address().port, method: "POST", path: "/api/v1/voter/cast", headers: { Cookie: `vc_voter=${s.token}`, "Idempotency-Key": newKey(), "Content-Type": "application/json", "Content-Length": 2 } });
        req.on("error", () => {});
        req.end("{}");
        await sleep(30);
        req.destroy();
        await waitFor(async () => (await ticketOf(voter)).status === "CONFIRMED");
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
      const nonce = await relayerNonce();
      const retry = await cast(s, newKey());
      assert.equal(retry.status, 200);
      assert.equal(retry.body.data.txHash, (await ticketOf(voter)).txHash);
      assert.equal(await total(), 1n);
      assert.equal(await relayerNonce(), nonce);
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 1);
    });

    it("the receipt lookup fails after the transaction mined: 503, then the retry confirms the SAME transaction without a second one", async () => {
      const flaky = { on: true };
      app = build(withProvider({ getTransactionReceipt: async (h) => { if (flaky.on) throw new Error("rpc hiccup"); return chain.provider.getTransactionReceipt(h); } }));
      const s = await ready(voter, "3");
      const nonceBefore = await relayerNonce();
      const first = await cast(s);
      assert.equal(first.status, 503, JSON.stringify(first.body));
      assert.equal(await total(), 1n, "it did mine");
      const mid = await ticketOf(voter);
      assert.equal(mid.status, "SUBMITTED");
      flaky.on = false;
      const second = await cast(s);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.data.txHash, mid.txHash);
      assert.equal(await relayerNonce(), nonceBefore + 1);
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 1);
    });

    it("confirmation is evidence-based: if the stored ticket disagrees with the mined BallotCast (candidate or constituency), the voter is never told it is confirmed", async () => {
      for (const [field, value] of [["candidateId", "4"], ["constituencyId", constituencyIdOf("DL-DEL")]]) {
        await mongoose.connection.dropDatabase();
        await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), VoteTicket.syncIndexes(), AuditLog.syncIndexes()]);
        const v = await mkVoter(field === "candidateId" ? 30 : 31);
        const flaky = { on: true };
        app = build(withProvider({ getTransactionReceipt: async (h) => { if (flaky.on) throw new Error("rpc hiccup"); return chain.provider.getTransactionReceipt(h); } }));
        const s = await ready(v, "3");
        assert.equal((await cast(s)).status, 503); // mined for candidate 3 / KA-BLR, confirmation lookup failed
        const snapshotBefore = await total();
        await VoteTicket.updateOne({ voterId: v._id }, { [field]: value });
        flaky.on = false;
        const res = await cast(s);
        assert.equal(res.status, 409, `${field}: ${res.text}`);
        assert.equal(res.body.error.code, "RECONCILIATION_REQUIRED");
        assert.equal((await ticketOf(v)).status, "FAILED");
        assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 0);
        assert.ok(snapshotBefore >= 1n);
        assert.equal((await cast(s)).status, 409, "and it stays flagged");
        await revertTo(chain.provider, snap); // start the next round from the pristine chain again
        snap = await snapshot(chain.provider);
        await (await owner().openElection()).wait();
      }
    });

    it("the node accepts the transaction and then every RPC lookup fails: no second transaction, and recovery confirms the first", async () => {
      const flaky = { on: true };
      app = build(withProvider({
        broadcastTransaction: async (raw) => { const r = await chain.provider.broadcastTransaction(raw); if (flaky.on) throw new Error("connection reset after acceptance"); return r; },
        getTransaction: async (h) => { if (flaky.on) throw new Error("rpc down"); return chain.provider.getTransaction(h); },
        getTransactionReceipt: async (h) => { if (flaky.on) throw new Error("rpc down"); return chain.provider.getTransactionReceipt(h); },
      }));
      const s = await ready(voter, "3");
      const nonceBefore = await relayerNonce();
      assert.equal((await cast(s)).status, 503);
      const mid = await ticketOf(voter);
      assert.match(mid.txHash, /^0x[0-9a-f]{64}$/);
      assert.equal(await total(), 1n);
      flaky.on = false;
      const retry = await cast(s);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.data.txHash, mid.txHash);
      assert.equal(await relayerNonce(), nonceBefore + 1);
      assert.equal((await ticketOf(voter)).rawTx, null);
    });

    it("an authorization about to expire while WAITING in the relayer queue is not used; the voter before it is unaffected", async () => {
      const second = await mkVoter(2);
      let release;
      const gate = new Promise((r) => (release = r));
      let entered;
      const inQueue = new Promise((r) => (entered = r));
      let stalled = false;
      app = build(withProvider({
        getTransactionCount: async (a, tag) => {
          if (tag === "pending" && !stalled) {
            stalled = true;
            entered();
            await gate;
          }
          return chain.provider.getTransactionCount(a, tag);
        },
      }));
      const sa = await ready(voter, "3");
      const sb = await ready(second, "4");
      const nonce = await relayerNonce();
      const pa = cast(sa);
      await inQueue;
      const pb = cast(sb);
      await waitFor(async () => (await ticketOf(second)).status === "SUBMITTING");
      await sleep(500); // B's request is now parked behind A inside the relayer queue
      // The dev chain's own clock runs ahead of the wall clock (the deploy script mines ~20 blocks within seconds), and the backend
      // deliberately grants that skew back to the authorization. Take it into account so that about 10 s of the window remain.
      const skewS = Math.max(0, Math.ceil(((await chain.provider.getBlock("latest")).timestamp * 1000 - clock.now()) / 1000));
      clock.advance(170 + skewS);
      release();
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.equal(ra.status, 200, JSON.stringify(ra.body));
      assert.equal(rb.status, 409, JSON.stringify(rb.body));
      assert.equal(rb.body.error.code, "AUTHORIZATION_EXPIRED");
      const tb = await ticketOf(second);
      assert.deepEqual([tb.status, tb.txHash, tb.rawTx], ["AUTH_ISSUED", null, null]);
      assert.equal(await relayerNonce(), nonce + 1, "only A's transaction was sent");
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 0n, 0n, 0n, 0n]);
    });

    it("a transaction that reverts (out of gas) and a later restart with ANOTHER candidate: only the new choice is counted, and the old signed call cannot be replayed afterwards", async (ctx) => {
      app = build(withProvider({ estimateGas: async () => 60_000n })); // gas limit too small: mines as a revert
      const sa = await ready(voter, "3");
      const bad = await cast(sa);
      assert.equal(bad.status, 502, JSON.stringify(bad.body));
      assert.equal(bad.body.error.code, "TX_REVERTED");
      const oldTx = await chain.provider.getTransaction((await ticketOf(voter)).txHash);
      const oldArgs = chain.contract.interface.parseTransaction({ data: oldTx.data }).args;
      assert.equal(oldArgs[2], 3n);
      assert.equal(await total(), 0n);

      app = build();
      clock.advance(130); // the first session idles out
      const sb = await session(voter);
      assert.equal((await authorize(sb, "4")).status, 200, "a reverted attempt may start over");
      let stale = "refused";
      await relayerContract().castVote.staticCall(...oldArgs).then(() => (stale = "STILL VALID"), () => {});
      ctx.diagnostic(`old authorization for candidate 3 after the reset to 4: ${stale} (only the relayer key could use it)`);
      assert.equal((await cast(sb)).status, 200);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 0n, 1n, 0n, 0n, 0n]);
      await assert.rejects(relayerContract().castVote.staticCall(...oldArgs), revertsWith("NullifierAlreadyUsed"));
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("simultaneous voters", () => {
    it("8 voters across three constituencies share the relayer nonce space while some voters double- and triple-submit: 8 ballots, each for its own candidate", async () => {
      const plan = [
        ["KA-BLR", "3"], ["KA-BLR", "4"], ["KA-BLR", "5"], ["KA-BLR", "1"],
        ["DL-DEL", "8"], ["DL-DEL", "9"], ["MH-MUM", "14"], ["MH-MUM", "15"],
      ];
      const people = [];
      for (const [i, [code, candidate]] of plan.entries()) {
        const v = await mkVoter(10 + i, { constituencyCode: code });
        people.push({ v, code, candidate, s: await ready(v, candidate) });
      }
      const nonceBefore = await relayerNonce();
      // interleave: every voter once, voter 0 three more times, voter 4 twice more, voter 7 once more
      const jobs = [...people.map((p, i) => ({ i })), { i: 0 }, { i: 4 }, { i: 0 }, { i: 7 }, { i: 4 }, { i: 0 }].sort(() => Math.random() - 0.5);
      const results = await Promise.all(jobs.map(({ i }) => cast(people[i].s, i === 0 && Math.random() < 0.5 ? "shared-dup-key-voter0" : newKey()).then((res) => ({ i, res }))));
      for (const { i, res } of results) assert.ok([200, 202].includes(res.status), `voter ${i}: ${res.status} ${res.text}`);
      for (const p of people) await waitFor(async () => (await ticketOf(p.v)).status === "CONFIRMED");

      const events = await ballotEvents();
      assert.equal(events.length, 8);
      assert.equal(await total(), 8n);
      assert.equal(await relayerNonce(), nonceBefore + 8, "exactly one transaction per voter");
      const byNullifier = new Map(events.map((e) => [e.args.nullifier, e]));
      assert.equal(new Set(events.map((e) => e.transactionHash)).size, 8);
      for (const p of people) {
        const e = byNullifier.get(await nullifierOf(p.v));
        assert.ok(e, "ballot for voter exists");
        assert.equal(e.args.candidateId, BigInt(p.candidate));
        assert.equal(e.args.constituencyId, constituencyIdOf(p.code));
      }
      for (const { i, res } of results) if (res.body.data.txHash) assert.equal(res.body.data.txHash, byNullifier.get(await nullifierOf(people[i].v)).transactionHash, `voter ${i} got somebody else's transaction`);
      const wanted = new Set(plan.map(([, c]) => c));
      for (let id = 1n; id <= 18n; id++) assert.equal(await chain.contract.votesOf(id), wanted.has(String(id)) ? 1n : 0n, `candidate ${id}`);
      for (const code of ["KA-BLR", "DL-DEL", "MH-MUM"]) assert.equal(await chain.contract.constituencyTotal(constituencyIdOf(code)), BigInt(plan.filter(([c]) => c === code).length));
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 8);
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_SUBMISSION_STARTED" }), 8);
      for (const p of people) assert.equal(await stageOf(p.s), "SUBMITTED");
    });

    it("a voter fires 20 concurrent casts with 20 different keys while a neighbour votes: one ballot each", async () => {
      const neighbour = await mkVoter(2);
      const sa = await ready(voter, "6");
      const sb = await ready(neighbour, "2");
      const nonce = await relayerNonce();
      const results = await Promise.all([...Array.from({ length: 20 }, () => cast(sa)), cast(sb)]);
      for (const r of results) assert.ok([200, 202].includes(r.status), r.text);
      await waitFor(async () => (await ticketOf(voter)).status === "CONFIRMED");
      assert.deepEqual(await votes(...BLR), [0n, 1n, 0n, 0n, 0n, 1n, 0n]);
      assert.equal(await relayerNonce(), nonce + 2);
      assert.equal(new Set(results.slice(0, 20).map((r) => r.body.data.txHash).filter(Boolean)).size, 1);
    });
  });

  describe("load", () => {
    it("30 voters across three constituencies with random duplicate storms and a recovery sweep running at the same time: one ballot per voter, each for its own candidate", async () => {
      const ballots = { "KA-BLR": ["1", "2", "3", "4", "5", "6", "7"], "DL-DEL": ["8", "9", "10", "11", "12", "13"], "MH-MUM": ["14", "15", "16", "17", "18"] };
      const codes = Object.keys(ballots);
      const people = [];
      for (let i = 0; i < 30; i++) {
        const code = codes[i % 3];
        const candidate = ballots[code][(i * 7) % ballots[code].length];
        const v = await mkVoter(100 + i, { constituencyCode: code });
        people.push({ v, code, candidate, s: await ready(v, candidate) });
      }
      const nonceBefore = await relayerNonce();
      const jobs = [];
      for (const [i] of people.entries()) for (let k = 0; k < 1 + Math.floor(Math.random() * 4); k++) jobs.push(i);
      jobs.sort(() => Math.random() - 0.5);
      const sweeps = Promise.all([0, 1, 2].map(async () => { await sleep(30); return castSvc.recoverPending({ minAgeMs: 0 }); }));
      const results = await Promise.all(jobs.map((i) => cast(people[i].s)));
      await sweeps;
      for (const r of results) assert.ok([200, 202].includes(r.status), `${r.status} ${r.text}`);
      for (const p of people) await waitFor(async () => (await ticketOf(p.v)).status === "CONFIRMED", 10_000);
      assert.equal(await total(), 30n);
      assert.equal(await relayerNonce(), nonceBefore + 30);
      const byNullifier = new Map((await ballotEvents()).map((e) => [e.args.nullifier, e]));
      assert.equal(byNullifier.size, 30);
      for (const p of people) {
        const e = byNullifier.get(await nullifierOf(p.v));
        assert.equal(e.args.candidateId, BigInt(p.candidate));
        assert.equal(e.args.constituencyId, constituencyIdOf(p.code));
      }
      assert.equal(await AuditLog.countDocuments({ action: "VOTE_CONFIRMED" }), 30);
    });
  });

  describe("a real mempool: blocks are not mined instantly", () => {
    it("five voters cast while their transactions only sit in the pending pool: consecutive nonces, one block, every ballot for its own candidate", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const people = [];
      for (const [i, candidate] of ["3", "4", "5", "6", "7"].entries()) {
        const v = i === 0 ? voter : await mkVoter(20 + i);
        people.push({ v, candidate, s: await ready(v, candidate) });
      }
      const nonceBefore = await relayerNonce();
      await automine(false);
      try {
        const first = await Promise.all(people.map((p) => cast(p.s)));
        for (const r of first) assert.equal(r.status, 202, JSON.stringify(r.body));
        const pending = await chain.provider.getTransactionCount(relayerAddr(), "pending");
        assert.equal(pending, nonceBefore + 5, "five distinct nonces");
        assert.equal(new Set(first.map((r) => r.body.data.txHash)).size, 5);
        await chain.provider.send("evm_mine", []);
      } finally {
        await automine(true);
      }
      const second = await Promise.all(people.map((p) => cast(p.s)));
      for (const r of second) assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await relayerNonce(), nonceBefore + 5);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 1n, 1n, 1n, 1n]);
      const byNullifier = new Map((await ballotEvents()).map((e) => [e.args.nullifier, e]));
      for (const [i, p] of people.entries()) assert.equal(byNullifier.get(await nullifierOf(p.v)).transactionHash, second[i].body.data.txHash);
    });

    it("a pending transaction is dropped from the mempool while another voter's transaction takes its nonce: the first voter's vote restarts cleanly and both ballots count", async () => {
      app = build(chain, { receiptTimeoutMs: 300 });
      const other = await mkVoter(2);
      const s1 = await ready(voter, "3");
      const s2 = await ready(other, "4");
      const nonceBefore = await relayerNonce();
      await automine(false);
      try {
        const r1 = await cast(s1);
        assert.equal(r1.status, 202);
        assert.equal(await chain.provider.send("hardhat_dropTransaction", [r1.body.data.txHash]), true);
        const r2 = await cast(s2); // gets the nonce the dropped transaction had
        assert.equal(r2.status, 202);
        await chain.provider.send("evm_mine", []);
      } finally {
        await automine(true);
      }
      assert.equal(await total(), 1n);
      const again = await cast(s1);
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal((await cast(s2)).status, 200);
      assert.equal(await total(), 2n);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 1n, 0n, 0n, 0n]);
      assert.equal(await relayerNonce(), nonceBefore + 2);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
      assert.equal((await ticketOf(other)).status, "CONFIRMED");
    });
  });

  describe("integration gaps", () => {
    // BUG: the SPA origin the backend itself allows (CORS_ORIGINS / DEV_CORS_DEFAULT) cannot send the Idempotency-Key header that
    // POST /voter/cast REQUIRES: the preflight answer lists only Content-Type, Authorization and X-Request-Id, so a browser refuses
    // the request and no voter can cast from a cross-origin frontend. Fix: add "Idempotency-Key" to cors allowedHeaders in app.js.
    it("BUG: the CORS preflight for POST /voter/cast allows the required Idempotency-Key header", async () => {
      const origin = config.corsOrigins[0];
      assert.ok(origin, "an allowed origin exists");
      const res = await request(app).options("/api/v1/voter/cast").set("Origin", origin).set("Access-Control-Request-Method", "POST").set("Access-Control-Request-Headers", "content-type,idempotency-key");
      assert.equal(res.headers["access-control-allow-origin"], origin);
      const allowed = String(res.headers["access-control-allow-headers"] ?? "").toLowerCase().split(",").map((h) => h.trim());
      assert.ok(allowed.includes("idempotency-key"), `preflight allows only: ${allowed.join(", ")}`);
      assert.ok(allowed.includes("content-type"));
    });

    // BUG (low): when a lagging RPC makes a MINED vote look unknown (no receipt, no tx, nullifier not yet visible) while the relayer's
    // latest nonce has already moved, reconcile() resets the ticket to AUTH_ISSUED and ERASES txHash. The next attempt then finds the
    // nullifier used, can only answer RECONCILIATION_REQUIRED, and (txHash gone) can never heal, although the correct ballot is on chain.
    // Fix: keep the hash (e.g. lastTxHash) through the reset, and/or on "nullifier used without own evidence" look up the BallotCast
    // event for the nullifier and confirm when candidate + constituency match the ticket.
    it("BUG: a false 'unknown transaction' (lagging RPC) must not turn a counted vote into an unhealable RECONCILIATION_REQUIRED", async () => {
      const mode = { v: "glitch" };
      const lagging = {
        ...chain,
        provider: new Proxy(chain.provider, {
          get: (target, p) => {
            if (p === "getTransactionReceipt") return async (h) => { if (mode.v === "glitch") throw new Error("rpc hiccup"); return mode.v === "lag" ? null : target.getTransactionReceipt(h); };
            if (p === "getTransaction") return async (h) => (mode.v === "lag" ? null : target.getTransaction(h));
            return typeof target[p] === "function" ? target[p].bind(target) : target[p];
          },
        }),
        contract: new Proxy(chain.contract, {
          get: (target, p) => (p === "nullifierUsed" ? async (...a) => (mode.v === "lag" && a.length === 1 ? false : target.nullifierUsed(...a)) : typeof target[p] === "function" ? target[p].bind(target) : target[p]),
        }),
      };
      app = build(lagging);
      const s = await ready(voter, "3");
      assert.equal((await cast(s)).status, 503); // the vote mined, but the confirmation lookup failed
      assert.equal(await total(), 1n);
      mode.v = "lag";
      await cast(s);
      mode.v = "ok";
      const healed = await cast(s);
      assert.equal(await total(), 1n, "exactly one ballot, for the right candidate");
      assert.equal(healed.status, 200, `the voter's counted vote is reported as failed: ${healed.text}`);
      assert.equal((await ticketOf(voter)).status, "CONFIRMED");
    });

    it("two backend instances (separate relayer queues) choose the same nonce at the same moment: the loser recovers by itself and both ballots count", async () => {
      const gate = { reads: 0, release: null };
      const open = new Promise((r) => (gate.release = r));
      const sameNonce = withProvider({
        getTransactionCount: async (a, tag) => {
          const n = await chain.provider.getTransactionCount(a, tag);
          if (tag === "pending" && gate.reads < 2) {
            if (++gate.reads === 2) gate.release();
            await open;
          }
          return n;
        },
      });
      const other = await mkVoter(2);
      relayerQueue = createRelayerQueue();
      const app1 = build(sameNonce);
      relayerQueue = createRelayerQueue();
      const app2 = build(sameNonce);
      app = app1;
      const s1 = await ready(voter, "3");
      const s2 = await ready(other, "4");
      const nonceBefore = await relayerNonce();
      app = app1;
      const p1 = cast(s1);
      app = app2;
      const p2 = cast(s2);
      const first = await Promise.all([p1, p2]);
      assert.equal(await total(), 1n, "only one of the two same-nonce transactions can mine");
      assert.ok(first.some((r) => r.status === 200 || r.status === 202));
      for (const [i, sess] of [s1, s2].entries()) {
        if (first[i].status === 200) continue;
        app = i === 0 ? app1 : app2;
        const retry = await cast(sess);
        assert.equal(retry.status, 200, `voter ${i + 1}: ${retry.text}`);
      }
      assert.equal(await total(), 2n);
      assert.deepEqual(await votes(...BLR), [0n, 0n, 1n, 1n, 0n, 0n, 0n]);
      assert.equal(await relayerNonce(), nonceBefore + 2);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("privacy", () => {
    it("across success, rejection and failure paths no response, header, log line or audit row carries uid, nullifier, signature, raw transaction, keys, or a candidate next to a voter identity", async () => {
      const net = rpcDown();
      const v2 = await mkVoter(2);
      const v3 = await mkVoter(3, { constituencyCode: "DL-DEL" });
      app = build(net.chain);
      const s1 = await session(voter);
      await call(s1, "get", "/ballot");
      for (const id of ["19", "8", "abc", "3"]) await authorize(s1, id);
      await authorize(s1, "4"); // already issued
      await call(s1, "post", "/cast", { candidateId: "4" }, { "Idempotency-Key": newKey() });
      const failed = await rawPost(s1, "/cast?candidateId=4&uid=x", { body: "{}", type: "application/json", headers: { "Idempotency-Key": newKey(), "X-Forwarded-For": "6.6.6.6" } });
      assert.equal(failed.status, 400);
      const down = await cast(s1);
      assert.equal(down.status, 503);
      const rawTx = (await ticketOf(voter)).rawTx;
      net.state.down = false;
      const ok = await cast(s1);
      assert.equal(ok.status, 200);
      await call(s1, "get", "/status");

      const s2 = await ready(v2, "5");
      await VoteTicket.updateOne({ voterId: v2._id }, { status: "FAILED", failureCode: "RECONCILIATION_REQUIRED" });
      await cast(s2);
      const s3 = await ready(v3, "9");
      await Voter.updateOne({ _id: v3._id }, { constituencyCode: "KA-BLR" });
      await cast(s3);
      await login(voter); // refused while the session lives, or ALREADY_VOTED later
      await (await owner().closeElection()).wait();
      await cast(s1);

      const audit = await mongoose.connection.collection("auditlogs").find({}).toArray();
      const auditText = JSON.stringify(audit);
      const everything = JSON.stringify(captured) + auditText + memory.lines.join("");
      const uids = (await mongoose.connection.collection("voters_v2").find({}).toArray()).map((v) => v.uid);
      const nullifiers = await Promise.all([voter, v2, v3].map(nullifierOf));
      const sec = config.secrets;
      const secrets = [...uids, ...nullifiers, rawTx, s1.token, s2.token, s3.token, sec.nullifierSecret.toString("hex"), sec.authorityPrivateKey, sec.relayerPrivateKey, sec.authorityPrivateKey.slice(2), sec.relayerPrivateKey.slice(2), PW];
      for (const secret of secrets) assert.ok(!everything.includes(secret), `leaked ${String(secret).slice(0, 10)}...`);
      assert.ok(!/0x[0-9a-f]{130}\b/i.test(everything), "a 65-byte signature appears somewhere");
      assert.ok(!/0x02f9/i.test(everything), "a raw EIP-1559 transaction appears somewhere");
      assert.ok(!/0x[0-9a-f]{100,}/i.test(everything), "a long hex blob appears somewhere");
      for (const row of audit) {
        const text = JSON.stringify(row);
        assert.ok(!/candidate(Id)?"\s*:/i.test(text), `a candidate is recorded in an audit row: ${text}`);
        assert.ok(!(row.meta?.voterId && row.txHash), `an audit row links a voter to a transaction: ${text}`);
        assert.notEqual(row.ip, "6.6.6.6", "a client-supplied X-Forwarded-For was trusted");
      }
      for (const line of memory.lines) {
        const parsed = JSON.parse(line);
        assert.ok(!("candidateId" in parsed), "a log line carries a candidate");
        assert.ok(!/voterId|email/i.test(Object.keys(parsed).join(",")) || !/candidate/i.test(line), "a log line pairs a voter with a candidate");
        assert.ok(!line.includes("uid=x") && !line.includes("candidateId=4"), "a query string was logged");
      }
      for (const r of captured) {
        assert.match(String(r.headers["cache-control"]), /no-store/, `${r.method} ${r.path} may be cached`);
        assert.equal(r.headers["x-powered-by"], undefined);
        if (r.status !== 204) assert.match(String(r.headers["content-type"]), /^application\/json/, `${r.method} ${r.path} is not JSON: ${r.headers["content-type"]}`);
      }
      // (a 400 only names the rejected FIELDS, e.g. "Invalid request: candidateId, uid"; every other answer must not mention these at all)
      for (const r of captured.filter((x) => /\/(authorization|cast)/.test(x.path) && x.status !== 400)) assert.ok(!/signature|nullifier|rawTx|candidateId|"uid"/i.test(r.text), `${r.path} response mentions secret fields: ${r.text}`);
      for (const r of captured.filter((x) => x.status === 400)) assert.ok(/^\{"error":\{"code":"[A-Z_]+","message":"[^"]*","requestId":"[0-9a-f-]+"\}\}$/.test(r.text), `unexpected 400 body ${r.text}`);
    });
  });
});
