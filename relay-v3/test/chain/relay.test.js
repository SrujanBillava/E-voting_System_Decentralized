import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Contract, Interface, Transaction, keccak256, toUtf8Bytes } from "ethers";
import mongoose from "mongoose";
import request from "supertest";
import { Group } from "../../../privacy-v3/src/semaphore.js";
import { runPreflight, PreflightError } from "../../src/chain/preflight.js";
import { composeRelay, MODELS } from "../../src/compose.js";
import { secretValuesOf } from "../../src/config/env.js";
import { canonicalPackage } from "../../src/services/ballotPackage.js";
import { SimulatedCrash } from "../../src/services/submit.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { makeVoters, shutdownProver } from "../helpers/ballots.js";
import { closeDb, connectTestDb, dumpDb, resetDb, skipWithoutMongo } from "../helpers/db.js";
import { configFor } from "../helpers/env.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";
import { artifactPath } from "../helpers/node.js";
import fs from "node:fs";

const { AnonymousSubmission } = MODELS;
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");
const clone = (v) => JSON.parse(JSON.stringify(v));
const patched = (pkg, fn) => {
  const copy = clone(pkg);
  fn(copy);
  return copy;
};

/** wraps a provider so broadcasts can fail (an RPC timeout) or silently vanish (a dropped transaction) */
function flaky(provider, { failBroadcasts = 0, swallowBroadcasts = 0 } = {}) {
  const state = { failBroadcasts, swallowBroadcasts, sent: [] };
  const proxy = new Proxy(provider, {
    get(target, prop) {
      if (prop === "broadcastTransaction") {
        return async (raw) => {
          state.sent.push(raw);
          if (state.failBroadcasts > 0) {
            state.failBroadcasts--;
            throw new Error("RPC timeout");
          }
          if (state.swallowBroadcasts > 0) {
            state.swallowBroadcasts--;
            return { hash: "0x" + "00".repeat(32) };
          }
          return target.broadcastTransaction(raw);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { provider: proxy, state };
}

describe("relay-v3: the anonymous relayer (real chain, real proofs, real MongoDB)", { skip }, () => {
  let world;
  let config;
  let relay;
  let app;
  let memory;
  let voters; // { voters, commitments, packages }
  let fullAbi;

  before(async () => {
    await connectTestDb();
    world = await newWorld();
    config = configFor(world);
    fullAbi = JSON.parse(fs.readFileSync(artifactPath("contracts", "VoteChainV3.sol", "VoteChainV3.json"), "utf8")).abi;
    voters = await makeVoters({ code: "KA-BLR", kc: 3, count: 4, H: world.H });
    await world.register("KA-BLR", voters.commitments);
    world.base = await world.snapshot();
  });
  after(async () => {
    await shutdownProver();
    world?.stop();
    await closeDb();
  });
  beforeEach(async () => {
    await resetDb();
    memory = createMemoryLogger({ level: "info", secrets: secretValuesOf(config) });
    relay = build();
    await relay.chain.init();
    app = relay.app;
  });
  afterEach(async () => {
    await world.reset();
  });

  const build = (opts = {}) => composeRelay({ config, logger: memory.logger, provider: world.provider, globalLimitPerMinute: 100_000, submit: { receiptTimeoutMs: 5000, pollMs: 20 }, ...opts });
  const post = (pkg, a = app) => request(a).post("/v1/ballots").send(pkg);
  const relayerNonce = () => world.provider.getTransactionCount(world.relayer.address, "latest");
  const recorded = async () => (await world.voteChain.queryFilter(world.voteChain.filters.BallotRecorded())).map((e) => ({ nullifier: e.args.nullifier.toString(), tx: e.transactionHash, index: Number(e.args.ballotIndex) }));
  const pkg0 = () => voters.packages[0];

  describe("the happy path", () => {
    it("a valid anonymous package is simulated, persisted, signed, broadcast and CONFIRMED by its BallotRecorded event; no cookie, no identity", async () => {
      const before = await world.provider.getBalance(world.relayer.address);
      const res = await post(pkg0());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.state, "CONFIRMED");
      assert.equal(res.body.data.nullifier, pkg0().membership.nullifier);
      assert.match(res.body.data.txHash, /^0x[0-9a-f]{64}$/);
      assert.equal(res.body.data.ballotIndex, 1);
      assert.equal(res.headers["set-cookie"], undefined, "the relayer never sets a cookie");

      assert.deepEqual(await recorded(), [{ nullifier: pkg0().membership.nullifier, tx: res.body.data.txHash, index: 1 }]);
      assert.ok(before > (await world.provider.getBalance(world.relayer.address)), "the relayer paid the gas");
      const doc = await AnonymousSubmission.findOne({}).select("+rawTx +calldata");
      assert.equal(doc.state, "CONFIRMED");
      assert.equal(doc.rawTx, null, "the raw transaction is dropped once confirmed");
      const status = await request(app).get(`/v1/ballots/${pkg0().membership.nullifier}`);
      assert.equal(status.status, 200);
      assert.equal(status.body.data.state, "CONFIRMED");
      assert.equal(status.body.data.txHash, res.body.data.txHash);
    });

    it("the contract is authoritative: a caller supplies no scope, no ballot hash, no K_c, no H and no election id (and cannot: those keys are refused)", async () => {
      for (const extra of [{ scope: "1" }, { ballotHash: "1" }, { kc: 3 }, { H: ["1", "2"] }, { electionId: "0x" + "00".repeat(32) }, { chainId: 31337 }, { contract: "0x" + "00".repeat(20) }]) {
        const res = await post({ ...pkg0(), ...extra });
        assert.equal(res.status, 400, JSON.stringify(Object.keys(extra)));
        assert.equal(res.body.error.code, "VALIDATION_FAILED");
      }
      assert.equal(await AnonymousSubmission.countDocuments({}), 0);
    });
  });

  describe("malformed requests are refused before anything is stored or spent", () => {
    const cases = {
      "an array": () => [],
      "null": () => null,
      "an empty object": () => ({}),
      "a missing membership": () => patched(pkg0(), (p) => delete p.membership),
      "a missing validity": () => patched(pkg0(), (p) => delete p.validity),
      "a number instead of a string": () => patched(pkg0(), (p) => (p.membership.nullifier = 12345)),
      "a hex number": () => patched(pkg0(), (p) => (p.membership.merkleTreeRoot = "0x1234")),
      "a negative number": () => patched(pkg0(), (p) => (p.coords[0] = "-1")),
      "a leading zero": () => patched(pkg0(), (p) => (p.membership.nullifier = "0" + p.membership.nullifier)),
      "a number above uint256": () => patched(pkg0(), (p) => (p.coords[0] = (2n ** 256n).toString())),
      "7 proof points": () => patched(pkg0(), (p) => p.membership.points.pop()),
      "9 proof points": () => patched(pkg0(), (p) => p.membership.points.push("1")),
      "a validity proof with a short a": () => patched(pkg0(), (p) => p.validity.a.pop()),
      "no coordinates": () => patched(pkg0(), (p) => (p.coords = [])),
      "3 coordinates": () => patched(pkg0(), (p) => (p.coords = p.coords.slice(0, 3))),
      "coordinates that are not a multiple of 4": () => patched(pkg0(), (p) => p.coords.push("1")),
      "68 coordinates": () => patched(pkg0(), (p) => (p.coords = Array(68).fill("1"))),
      "a constituency id that is not 32 bytes": () => patched(pkg0(), (p) => (p.constituencyId = "0x1234")),
    };
    for (const [name, make] of Object.entries(cases)) {
      it(`refuses ${name}`, async () => {
        const nonce = await relayerNonce();
        const res = await post(make());
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error.code, "VALIDATION_FAILED");
        assert.equal(await AnonymousSubmission.countDocuments({}), 0);
        assert.equal(await relayerNonce(), nonce);
      });
    }

    it("refuses a body that is not JSON, and an oversized body", async () => {
      assert.equal((await request(app).post("/v1/ballots").set("Content-Type", "text/plain").send("hello")).status, 400);
      assert.equal((await request(app).post("/v1/ballots").set("Content-Type", "application/json").send("{not json")).status, 400);
      assert.equal((await request(app).post("/v1/ballots").set("Content-Type", "application/json").send(JSON.stringify({ pad: "x".repeat(70_000) }))).status, 413);
    });

    it("semantic checks mirror the contract's own: a wrong declared depth, a nullifier or coordinate outside the field", async () => {
      const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      for (const [make, code] of [
        [() => patched(pkg0(), (p) => (p.membership.merkleTreeDepth = "19")), "WRONG_SEMAPHORE_DEPTH"],
        [() => patched(pkg0(), (p) => (p.membership.nullifier = P.toString())), "NULLIFIER_OUT_OF_FIELD"],
        [() => patched(pkg0(), (p) => (p.coords[2] = P.toString())), "COORDINATE_OUT_OF_FIELD"],
      ]) {
        const res = await post(make());
        assert.equal(res.status, 422);
        assert.equal(res.body.error.code, code);
      }
      assert.equal(await AnonymousSubmission.countDocuments({}), 0);
    });
  });

  describe("no identity, no cookie, no caller metadata", () => {
    it("voter, uid, token, JWT, session and credential fields in the body are REFUSED by name, and the value is never echoed", async () => {
      for (const field of ["voterId", "uid", "name", "email", "jwt", "token", "sessionId", "credentialId", "commitment", "biometric"]) {
        const res = await post({ ...pkg0(), [field]: "SECRET-VALUE-9f8e7d6c" });
        assert.equal(res.status, 400, field);
        assert.match(res.body.error.message, new RegExp(field));
        assert.equal(JSON.stringify(res.body).includes("SECRET-VALUE-9f8e7d6c"), false, "the submitted value is never echoed");
      }
      assert.equal(await AnonymousSubmission.countDocuments({}), 0);
    });

    it("cookies, Authorization, X-Forwarded-For, User-Agent, Referer and a request id are not required, not consumed and never stored or logged", async () => {
      const noise = { cookie: "vc3_voter=IDENTITY-SESSION-COOKIE-31337; vc_voter=OTHER-COOKIE-777", authorization: "Bearer IDENTITY-JWT-ABCDEF-0123456789", forwarded: "203.0.113.77", agent: "KioskBrowser/9.9.9-fingerprint", referer: "https://id.votechain.localhost/session/IDENTITY-SESSION-ID", requestId: "identity-session-request-id-12345" };
      const plain = await post(pkg0());
      assert.equal(plain.status, 200);
      await world.reset();
      await resetDb();
      relay = build();
      await relay.chain.init();
      const noisy = await request(relay.app).post("/v1/ballots").set("Cookie", noise.cookie).set("Authorization", noise.authorization).set("X-Forwarded-For", noise.forwarded).set("User-Agent", noise.agent).set("Referer", noise.referer).set("X-Request-Id", noise.requestId).send(pkg0());
      assert.equal(noisy.status, 200, "the same result with all of it, and without any of it");
      assert.equal(noisy.body.data.state, plain.body.data.state);
      assert.equal(noisy.headers["set-cookie"], undefined);
      assert.notEqual(noisy.headers["x-request-id"], noise.requestId, "an inbound request id is not accepted");
      const all = (await dumpDb()) + memory.lines.join("\n") + JSON.stringify(noisy.body) + JSON.stringify(noisy.headers);
      for (const secret of ["IDENTITY-SESSION-COOKIE-31337", "OTHER-COOKIE-777", "IDENTITY-JWT-ABCDEF-0123456789", "203.0.113.77", "KioskBrowser/9.9.9-fingerprint", "IDENTITY-SESSION-ID", "identity-session-request-id-12345"]) {
        assert.equal(all.toLowerCase().includes(secret.toLowerCase()), false, secret);
      }
    });

    it("CORS never allows credentials, and an unknown origin is refused", async () => {
      const ok = await request(app).get("/v1/health").set("Origin", "http://localhost:5173");
      assert.equal(ok.headers["access-control-allow-origin"], "http://localhost:5173");
      assert.equal(ok.headers["access-control-allow-credentials"], undefined);
      const preflight = await request(app).options("/v1/ballots").set("Origin", "http://localhost:5173").set("Access-Control-Request-Method", "POST");
      assert.equal(preflight.headers["access-control-allow-credentials"], undefined);
      assert.equal((await request(app).get("/v1/health").set("Origin", "https://evil.example")).status, 403);
    });

    it("the whole process has one global request budget and no per-caller one: a busy relayer answers 429 to everybody", async () => {
      const limited = build({ globalLimitPerMinute: 2 });
      await limited.chain.init();
      assert.equal((await request(limited.app).get("/v1/health")).status, 200);
      assert.equal((await request(limited.app).get("/v1/health")).status, 200);
      assert.equal((await request(limited.app).get("/v1/health")).status, 429);
    });
  });

  describe("nullifier idempotency", () => {
    it("the same package again returns the SAME confirmed result and sends no second transaction", async () => {
      const first = await post(pkg0());
      const nonce = await relayerNonce();
      const second = await post(pkg0());
      assert.equal(second.status, 200);
      assert.deepEqual(second.body.data, first.body.data);
      assert.equal(await relayerNonce(), nonce, "no second transaction");
      assert.equal((await recorded()).length, 1);
      assert.equal(await AnonymousSubmission.countDocuments({}), 1);
    });

    it("parallel identical requests produce exactly ONE transaction", async () => {
      const results = await Promise.all([post(pkg0()), post(pkg0()), post(pkg0()), post(pkg0())]);
      assert.ok(results.every((r) => r.status === 200 || r.status === 202), results.map((r) => r.status).join());
      assert.equal((await recorded()).length, 1);
      assert.equal(await AnonymousSubmission.countDocuments({}), 1);
      assert.equal(await relayerNonce(), 1);
      const status = await request(app).get(`/v1/ballots/${pkg0().membership.nullifier}`);
      assert.equal(status.body.data.state, "CONFIRMED");
    });

    it("the same nullifier with a DIFFERENT package is a conflict, before and after confirmation, and costs nothing", async () => {
      const other = patched(pkg0(), (p) => ([p.coords[0], p.coords[4]] = [p.coords[4], p.coords[0]]));
      await post(pkg0());
      const nonce = await relayerNonce();
      const res = await post(other);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "NULLIFIER_CONFLICT");
      assert.equal(await relayerNonce(), nonce);
      assert.equal((await recorded()).length, 1);
    });

    it("a nullifier recorded on-chain by ANOTHER submitter: the same ballot is reported as recorded (no new transaction); a different ballot with that nullifier is refused", async () => {
      const stranger = world.stranger;
      const { constituencyId, membership, coords, validity } = canonicalArgs(pkg0());
      const direct = await (await world.voteChain.connect(stranger).submitBallot(constituencyId, membership, coords, validity)).wait();
      const nonce = await relayerNonce();
      const same = await post(pkg0());
      assert.equal(same.status, 200);
      assert.equal(same.body.data.state, "CONFIRMED");
      assert.equal(same.body.data.txHash, direct.hash, "reported from the chain's own event");
      assert.equal(await relayerNonce(), nonce, "the relayer sent nothing");
      const other = await post(patched(pkg0(), (p) => ([p.coords[0], p.coords[4]] = [p.coords[4], p.coords[0]])));
      assert.equal(other.status, 409);
      assert.equal(other.body.error.code, "NULLIFIER_CONFLICT", "now it conflicts with the stored package");
      await AnonymousSubmission.deleteMany({});
      const bare = await post(patched(pkg0(), (p) => ([p.coords[0], p.coords[4]] = [p.coords[4], p.coords[0]])));
      assert.equal(bare.status, 409);
      assert.equal(bare.body.error.code, "NULLIFIER_ALREADY_USED", "and with no stored package the chain's record is what it conflicts with");
    });

    it("an unknown nullifier is 404, one recorded by somebody else is reported from the chain", async () => {
      assert.equal((await request(app).get("/v1/ballots/123456789")).status, 404);
      assert.equal((await request(app).get("/v1/ballots/not-a-number")).status, 400);
      const { constituencyId, membership, coords, validity } = canonicalArgs(pkg0());
      await (await world.voteChain.connect(world.stranger).submitBallot(constituencyId, membership, coords, validity)).wait();
      const res = await request(app).get(`/v1/ballots/${pkg0().membership.nullifier}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.state, "CONFIRMED");
      assert.equal(res.body.data.ballotIndex, 1);
    });
  });

  describe("the contract's static simulation is the gate: nothing invalid ever spends gas", () => {
    const rejected = async (pkg, codes) => {
      const nonce = await relayerNonce();
      const balance = await world.provider.getBalance(world.relayer.address);
      const res = await post(pkg);
      assert.equal(res.status, 422, JSON.stringify(res.body));
      assert.ok(codes.includes(res.body.error.code), `${res.body.error.code} not in ${codes}`);
      assert.equal(await AnonymousSubmission.countDocuments({}), 0, "nothing persisted");
      assert.equal(await relayerNonce(), nonce);
      assert.equal(await world.provider.getBalance(world.relayer.address), balance, "no gas spent");
      assert.equal((await recorded()).length, 0);
    };

    it("a malformed Semaphore proof is refused", async () => {
      await rejected(patched(pkg0(), (p) => (p.membership.points[0] = (BigInt(p.membership.points[0]) + 1n).toString())), ["INVALID_MEMBERSHIP_PROOF", "REJECTED_BY_CONTRACT"]);
      await rejected(patched(pkg0(), (p) => (p.membership.points = p.membership.points.map(() => "1"))), ["INVALID_MEMBERSHIP_PROOF", "REJECTED_BY_CONTRACT"]);
    });

    it("a Semaphore root that is not part of the group is refused", async () => {
      await rejected(patched(pkg0(), (p) => (p.membership.merkleTreeRoot = "123456789123456789")), ["INVALID_MEMBERSHIP_PROOF"]);
    });

    it("a malformed validity proof is refused", async () => {
      await rejected(patched(pkg0(), (p) => (p.validity.a[0] = (BigInt(p.validity.a[0]) + 1n).toString())), ["INVALID_VALIDITY_PROOF", "REJECTED_BY_CONTRACT"]);
      await rejected(patched(pkg0(), (p) => (p.validity.c = ["1", "2"])), ["INVALID_VALIDITY_PROOF", "REJECTED_BY_CONTRACT"]);
    });

    it("a package for the WRONG constituency is refused: a different candidate count, and a different group with the same count", async () => {
      await rejected(patched(pkg0(), (p) => (p.constituencyId = world.ids["MH-MUM"])), ["WRONG_COORDINATE_COUNT"]);
      await rejected(patched(pkg0(), (p) => (p.constituencyId = world.ids["TN-CHE"])), ["INVALID_MEMBERSHIP_PROOF"]);
      await rejected(patched(pkg0(), (p) => (p.constituencyId = keccak256(toUtf8Bytes("NO-SUCH")))), ["UNKNOWN_CONSTITUENCY"]);
    });

    it("a MODIFIED ciphertext is refused: the ballot hash the membership proof signed no longer matches", async () => {
      await rejected(patched(pkg0(), (p) => ([p.coords[0], p.coords[4]] = [p.coords[4], p.coords[0]])), ["INVALID_MEMBERSHIP_PROOF"]);
      await rejected(patched(pkg0(), (p) => (p.coords[1] = (BigInt(p.coords[1]) + 1n).toString())), ["INVALID_MEMBERSHIP_PROOF", "INVALID_VALIDITY_PROOF", "REJECTED_BY_CONTRACT"]);
    });

    it("a ballot is refused when the election is not Open", async () => {
      await (await world.voteChain.closeIssuance()).wait();
      await world.mineAt((await world.provider.getBlock("latest")).timestamp + 20 * 60 + 5);
      await (await world.voteChain.closeElection()).wait();
      const res = await post(pkg0());
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "ELECTION_CLOSED");
    });
  });

  describe("raw transaction persistence, restart and recovery", () => {
    const doomedAt = (name) => build({ testHooks: { [name]: async () => { throw new SimulatedCrash(name); } } });

    it("a broadcast that fails (RPC timeout) leaves the submission SIGNED with the raw transaction persisted; the identical retry rebroadcasts the same bytes", async () => {
      const f = flaky(world.provider, { failBroadcasts: 2 });
      const timing = build({ provider: f.provider });
      await timing.chain.init();
      const res = await request(timing.app).post("/v1/ballots").send(pkg0());
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, "CHAIN_UNAVAILABLE");
      const doc = await AnonymousSubmission.findOne({}).select("+rawTx");
      assert.equal(doc.state, "SIGNED");
      assert.ok(doc.rawTx && doc.txHash, "persisted before the broadcast");
      assert.equal((await recorded()).length, 0);
      const retry = await request(timing.app).post("/v1/ballots").send(pkg0());
      assert.equal(retry.status, 200);
      assert.equal(retry.body.data.txHash, doc.txHash, "the very transaction that was persisted");
      assert.deepEqual(new Set(f.state.sent), new Set([doc.rawTx]), "every attempt sent the identical bytes");
      assert.equal(await AnonymousSubmission.countDocuments({}), 1);
    });

    it("restart after the raw transaction was persisted but never broadcast: recovery rebroadcasts the IDENTICAL transaction, once", async () => {
      await assert.rejects(doomedAt("afterSign").submitService.submit(pkg0()), SimulatedCrash);
      const signed = await AnonymousSubmission.findOne({}).select("+rawTx");
      assert.equal(signed.state, "SIGNED");
      assert.equal(await world.provider.getTransaction(signed.txHash), null, "not on the node");
      const nonce = await relayerNonce();
      const fresh = build();
      await fresh.chain.init();
      assert.equal(await fresh.submitService.recover(), 1);
      const doc = await AnonymousSubmission.findOne({});
      assert.equal(doc.state, "CONFIRMED");
      assert.equal(doc.txHash, signed.txHash);
      assert.equal(await relayerNonce(), nonce + 1);
      assert.equal((await recorded()).length, 1);
    });

    it("restart after the broadcast, before the database knew: the transaction is mined; recovery verifies the event and sends nothing", async () => {
      await assert.rejects(doomedAt("afterBroadcast").submitService.submit(pkg0()), SimulatedCrash);
      assert.equal((await AnonymousSubmission.findOne({})).state, "SIGNED");
      assert.equal((await recorded()).length, 1, "it IS on-chain");
      const nonce = await relayerNonce();
      const fresh = build();
      await fresh.chain.init();
      await fresh.submitService.recover();
      assert.equal((await AnonymousSubmission.findOne({})).state, "CONFIRMED");
      assert.equal(await relayerNonce(), nonce);
      assert.equal((await recorded()).length, 1);
    });

    it("already-mined recovery without the transaction hash: the ballot is found by its nullifier and confirmed, never sent again", async () => {
      await assert.rejects(doomedAt("afterBroadcast").submitService.submit(pkg0()), SimulatedCrash);
      const real = (await recorded())[0].tx;
      await AnonymousSubmission.updateOne({}, { $set: { txHash: "0x" + "cd".repeat(32) } });
      const nonce = await relayerNonce();
      const fresh = build();
      await fresh.chain.init();
      await fresh.submitService.recover();
      const doc = await AnonymousSubmission.findOne({});
      assert.equal(doc.state, "CONFIRMED");
      assert.equal(doc.txHash, real, "the chain's own transaction");
      assert.equal(await relayerNonce(), nonce);
    });

    it("a transaction that vanished from the node (nonce still free) is rebroadcast byte for byte", async () => {
      const f = flaky(world.provider, { swallowBroadcasts: 1 });
      const dropping = build({ provider: f.provider, submit: { receiptTimeoutMs: 100, pollMs: 20 } });
      await dropping.chain.init();
      const first = await request(dropping.app).post("/v1/ballots").send(pkg0());
      assert.equal(first.status, 202, "broadcast, but the receipt never came");
      assert.equal((await recorded()).length, 0);
      const again = await request(dropping.app).post("/v1/ballots").send(pkg0());
      assert.equal(again.status, 200);
      assert.equal(f.state.sent.length, 2);
      assert.equal(f.state.sent[0], f.state.sent[1], "identical bytes");
      assert.equal((await recorded()).length, 1);
    });

    it("only when the chain PROVES the persisted transaction dead (its nonce was spent by another transaction, the nullifier is unused) is a NEW transaction created", async () => {
      await assert.rejects(doomedAt("afterSign").submitService.submit(pkg0()), SimulatedCrash);
      const signed = await AnonymousSubmission.findOne({}).select("+rawTx");
      await (await world.relayer.sendTransaction({ to: world.relayer.address, value: 0n, nonce: signed.nonce })).wait(); // the nonce is spent
      const fresh = build();
      await fresh.chain.init();
      await fresh.submitService.recover();
      let doc = await AnonymousSubmission.findOne({});
      assert.equal(doc.state, "QUEUED", "released only now, with the old hash remembered");
      assert.equal(doc.lastTxHash, signed.txHash);
      const res = await request(fresh.app).post("/v1/ballots").send(pkg0());
      assert.equal(res.status, 200);
      assert.notEqual(res.body.data.txHash, signed.txHash);
      assert.equal((await recorded()).length, 1);
      doc = await AnonymousSubmission.findOne({});
      assert.equal(doc.state, "CONFIRMED");
    });

    it("a success receipt WITHOUT the expected BallotRecorded event is never reported as confirmed: the submission FAILS (EVENT_MISSING) and an identical retry sends the real ballot", async () => {
      const canon = canonicalPackage(pkg0(), relay.chain.abi.voteChain);
      const nonce = await relayerNonce();
      const fees = await world.provider.getFeeData();
      const rawTx = await world.relayer.signTransaction({ type: 2, chainId: 31337n, nonce, to: world.relayer.address, value: 0n, gasLimit: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      await AnonymousSubmission.create({ _id: "crafted", nullifier: canon.nullifier, constituencyId: canon.constituencyId, packageHash: canon.packageHash, calldata: canon.calldata, state: "SIGNED", nonce, txHash: Transaction.from(rawTx).hash, rawTx, touchedAt: 0 });
      await relay.submitService.recover();
      const doc = await AnonymousSubmission.findOne({});
      assert.equal(doc.state, "FAILED");
      assert.equal(doc.failureCode, "EVENT_MISSING");
      assert.equal((await recorded()).length, 0);
      const retry = await post(pkg0());
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal((await recorded()).length, 1);
      assert.equal((await AnonymousSubmission.findOne({})).state, "CONFIRMED");
    });
  });

  describe("roles and keys", () => {
    it("the relayer cannot call the issuer-only commitment function, nor any owner function; its own ABI cannot even encode them", async () => {
      const full = new Contract(world.address, fullAbi, world.relayer);
      await assert.rejects(full.registerCommitmentBatch.staticCall(world.ids["KA-BLR"], [123456789n]), (err) => err.revert?.name === "NotIssuer");
      await assert.rejects(full.closeIssuance.staticCall(), (err) => err.revert?.name === "OwnableUnauthorizedAccount");
      await assert.rejects(full.setIssuer.staticCall(world.relayer.address), (err) => err.revert?.name === "OwnableUnauthorizedAccount");
      for (const name of ["registerCommitmentBatch", "setIssuer", "closeIssuance", "closeElection", "openElection", "addConstituency"]) {
        assert.equal(relay.chain.abi.voteChain.getFunction(name), null, `${name} is not in the relayer's ABI`);
      }
    });

    it("submitBallot is PERMISSIONLESS: a stranger submits a valid ballot, and the issuer has no privilege (it is refused like anybody else for an invalid one)", async () => {
      const bad = canonicalArgs(patched(pkg0(), (p) => (p.membership.points[0] = (BigInt(p.membership.points[0]) + 1n).toString())));
      for (const signer of [world.issuer, world.stranger, world.attacker]) {
        await assert.rejects(world.voteChain.connect(signer).submitBallot(bad.constituencyId, bad.membership, bad.coords, bad.validity), (err) => ["InvalidMembershipProof"].includes(err.revert?.name) || err.code === "CALL_EXCEPTION", signer.address);
      }
      const good = canonicalArgs(voters.packages[1]);
      const receipt = await (await world.voteChain.connect(world.stranger).submitBallot(good.constituencyId, good.membership, good.coords, good.validity)).wait();
      assert.equal(receipt.status, 1, "a stranger needs no registration, no role, no relayer");
      const third = canonicalArgs(voters.packages[2]);
      assert.equal((await (await world.voteChain.connect(world.issuer).submitBallot(third.constituencyId, third.membership, third.coords, third.validity)).wait()).status, 1, "the issuer may submit a ballot like anybody; it is no more and no less than anybody");
    });

    it("preflight refuses a relayer key that is the contract's issuer, owner or a trustee, and accepts the real one", async () => {
      const ok = composeRelay({ config, logger: memory.logger, provider: world.provider });
      assert.equal((await runPreflight(ok.chain, config)).relayer, world.relayer.address);
      for (const [wallet, role] of [[world.issuer, "issuer"], [world.owner, "owner"], [world.trustees[0], "trustee"]]) {
        const cfg = configFor(world, { RELAYER_PRIVATE_KEY: wallet.privateKey });
        const bad = composeRelay({ config: cfg, logger: memory.logger, provider: world.provider });
        await assert.rejects(runPreflight(bad.chain, cfg), (err) => err instanceof PreflightError && err.code === "ROLE_CONFLICT", role);
      }
      const wrongElection = configFor(world, { ELECTION_ID: "0x" + "11".repeat(32) });
      await assert.rejects(runPreflight(composeRelay({ config: wrongElection, logger: memory.logger, provider: world.provider }).chain, wrongElection), (err) => err.code === "ELECTION_ID_MISMATCH");
      const wrongChain = configFor(world, { CHAIN_ID: "1" });
      await assert.rejects(runPreflight(composeRelay({ config: wrongChain, logger: memory.logger, provider: world.provider }).chain, wrongChain), (err) => err.code === "CHAIN_ID_MISMATCH");
    });
  });

  describe("the public group data path (for the future kiosk)", () => {
    it("serves the FULL public leaf set, the root and checkpoints; a client rebuilds the tree itself, finds its own commitment, and the roots agree with the chain", async () => {
      const res = await request(app).get("/v1/groups/KA-BLR");
      assert.equal(res.status, 200);
      const g = res.body.data;
      assert.equal(g.constituencyId, world.ids["KA-BLR"]);
      assert.equal(g.merkleTreeDepth, 20);
      assert.equal(g.size, 4);
      assert.deepEqual(g.leaves, voters.commitments.map(String), "every commitment, in leaf order");
      const tree = new Group(g.leaves.map(BigInt));
      assert.equal(tree.root.toString(), g.root, "the client's own tree has the chain's root");
      assert.equal(g.root, (await world.semaphore.getMerkleTreeRoot((await world.voteChain.getConstituency(world.ids["KA-BLR"])).groupId)).toString());
      assert.ok(g.leaves.includes(voters.commitments[2].toString()), "the voter finds its own commitment");
      assert.equal(g.checkpoints.length, 1);
      assert.equal(g.checkpoints[0].root, g.root);
      assert.equal(g.checkpoints[0].size, 4);
      assert.ok(g.checkpoints[0].timestamp > 0);
      assert.deepEqual(Object.keys(g).sort(), ["checkpoints", "constituencyId", "groupId", "leaves", "merkleTreeDepth", "root", "size"], "no Merkle proof, no witness, nothing per voter");
      const byId = await request(app).get(`/v1/groups/${world.ids["KA-BLR"]}`);
      assert.deepEqual(byId.body.data, g);
      // the rebuilt tree proves membership with the real core: a ballot verified by the contract above used exactly this root
      assert.equal(g.root, voters.packages[0].membership.merkleTreeRoot);
    });

    it("an empty group, an unknown constituency and a malformed key", async () => {
      const empty = await request(app).get("/v1/groups/MH-MUM");
      assert.equal(empty.status, 200);
      assert.equal(empty.body.data.size, 0);
      assert.deepEqual(empty.body.data.leaves, []);
      assert.equal((await request(app).get("/v1/groups/NO-SUCH")).status, 404);
      assert.equal((await request(app).get("/v1/groups/not%20a%20code")).status, 400);
    });
  });
});

/** the contract arguments of a wire package */
const relayInterface = new Interface(JSON.parse(fs.readFileSync(new URL("../../src/chain/generated/votechainv3.relay.abi.json", import.meta.url), "utf8")).contractAbi);
function canonicalArgs(pkg) {
  const [constituencyId, membership, coords, validity] = canonicalPackage(pkg, relayInterface).args;
  return { constituencyId, membership, coords, validity };
}
