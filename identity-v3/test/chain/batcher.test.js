import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { secretValuesOf } from "../../src/config/env.js";
import { composeIdentity, MODELS } from "../../src/compose.js";
import { STAGES } from "../../src/auth/voterStages.js";
import { SimulatedCrash, TX_GAS_CAP, batchGasLimit } from "../../src/services/batcher.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { closeDb, connectTestDb, resetDb, skipWithoutMongo } from "../helpers/db.js";
import { configFor } from "../helpers/env.js";
import { commitmentOf, createVoter, pollCredential, requestCredential, toEligible } from "../helpers/journey.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

const { CredentialIssuance, CommitmentBatch } = MODELS;
const skip = skipWithoutMongo || (contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)");

const crashAt = (name, when = () => true) => ({ [name]: async (info) => { if (when(info)) throw new SimulatedCrash(`crash at ${name}`); } });
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
            return { hash: "0x" + "00".repeat(32) }; // "accepted" but never reached the node
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

describe("identity-v3: the epoch batcher (real chain + real MongoDB)", { skip }, () => {
  let world;
  let config;
  let identity;
  let memory;
  let snap;
  const buildIdentity = (opts = {}) => {
    const built = composeIdentity({ config, logger: memory.logger, provider: world.provider, clock: world.clock, bcryptCost: 4, rateLimits: { login: { windowMs: 60_000, limit: 10_000 }, face: { windowMs: 60_000, limit: 10_000 } }, ...opts });
    return built;
  };

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
    identity = buildIdentity();
    await identity.chain.init();
  });
  afterEach(async () => {
    await world.revert(snap);
  });

  /** n RESERVED records of the constituency (random public commitments, random voter ids), reserved in the chain's CURRENT epoch */
  async function reserve(n, { code = "BATCH", prefix = "bulk", at } = {}) {
    const now = at ?? (await world.clock.nowSeconds());
    const commitments = Array.from({ length: n }, () => BigInt("0x" + randomBytes(31).toString("hex")).toString());
    await CredentialIssuance.insertMany(commitments.map((commitment, i) => ({ _id: `${prefix}-${i}-${randomBytes(4).toString("hex")}`, electionId: world.electionId, voterId: new mongoose.Types.ObjectId(), state: "RESERVED", commitment, constituencyId: world.ids[code], reservedAt: now + i, reservedEpoch: Math.floor(now / 30), failures: 0 })));
    return commitments;
  }
  const sortedBig = (list) => list.map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const states = async () => Object.fromEntries((await CredentialIssuance.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
  const issuerNonce = () => world.provider.getTransactionCount(world.issuer.address, "latest");
  const batchEvents = async (code) => (await world.voteChain.queryFilter(world.voteChain.filters.CommitmentBatchRegistered(world.ids[code]))).map((e) => ({ count: Number(e.args.count), epoch: Number(e.args.epoch), tx: e.transactionHash }));

  describe("epoch cohorts", () => {
    it("the cohort of an epoch is sent in the NEXT epoch as ONE batch, sorted by value; the current epoch's reservations wait", async () => {
      const commitments = await reserve(5);
      assert.deepEqual((await identity.batcher.tick()).formed.map((f) => f.status), ["NOTHING_DUE"], "same epoch: nothing is sent");
      await world.nextEpoch();
      const report = await identity.batcher.tick();
      assert.equal(report.formed[0].outcome, "FINALIZED");
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments), "one batch, the public order is the sorted order (it says nothing about who reserved first)");
      assert.deepEqual((await batchEvents("BATCH")).map((e) => e.count), [5]);
      assert.deepEqual(await states(), { ISSUED: 5 });
    });

    it("never more than one batch per constituency per epoch: the next cohort waits for the following epoch", async () => {
      const first = await reserve(2);
      await world.nextEpoch();
      await identity.batcher.tick();
      const epoch1 = (await batchEvents("BATCH"))[0].epoch;
      const second = await reserve(2, { at: (await world.clock.nowSeconds()) - 60 }); // reserved in an EARLIER epoch: already due
      const sameEpoch = await identity.batcher.tick();
      assert.equal(sameEpoch.formed[0].status, "WAIT_EPOCH");
      assert.equal((await batchEvents("BATCH")).length, 1, "no second transaction in the same epoch");
      await world.nextEpoch();
      assert.equal((await identity.batcher.tick()).formed[0].outcome, "FINALIZED");
      const events = await batchEvents("BATCH");
      assert.equal(events.length, 2);
      assert.ok(events[1].epoch > epoch1);
      assert.deepEqual(await world.groupLeaves("BATCH"), [...sortedBig(first), ...sortedBig(second)]);
    });

    it("two constituencies in the same epoch each get their own batch (the limit is per constituency)", async () => {
      await reserve(2, { code: "BATCH" });
      await reserve(2, { code: "TN-CHE" });
      await world.nextEpoch();
      const report = await identity.batcher.tick();
      assert.deepEqual(report.formed.map((f) => f.outcome), ["FINALIZED", "FINALIZED"]);
      const a = (await batchEvents("BATCH"))[0];
      const b = (await batchEvents("TN-CHE"))[0];
      assert.equal(a.epoch, b.epoch, "the same epoch");
      assert.notEqual(a.tx, b.tx, "two transactions");
    });

    it("at most MAX_BATCH = 128 commitments per batch, sent with an EXPLICIT gas limit; the rest follows in the next epoch", async () => {
      const commitments = await reserve(130);
      await world.nextEpoch();
      assert.equal((await identity.batcher.tick()).formed[0].outcome, "FINALIZED");
      let events = await batchEvents("BATCH");
      assert.deepEqual(events.map((e) => e.count), [128]);
      const tx = await world.provider.getTransaction(events[0].tx);
      assert.equal(tx.gasLimit, batchGasLimit(128), "an explicit limit, not an estimate");
      assert.ok(batchGasLimit(128) <= TX_GAS_CAP && batchGasLimit(1) < batchGasLimit(128));
      assert.equal(batchGasLimit(10_000), TX_GAS_CAP, "capped at the per-transaction limit");
      assert.equal((await world.groupLeaves("BATCH")).length, 128);

      await world.nextEpoch();
      assert.equal((await identity.batcher.tick()).formed[0].outcome, "FINALIZED");
      events = await batchEvents("BATCH");
      assert.deepEqual(events.map((e) => e.count), [128, 2]);
      assert.deepEqual((await world.groupLeaves("BATCH")).sort(), sortedBig(commitments).sort());
      assert.deepEqual(await states(), { ISSUED: 130 });
    });

    it("a commitment somebody else already registered is dropped BEFORE signing (it would revert the whole cohort); the rest goes through", async () => {
      const commitments = await reserve(3);
      const stolen = commitments[1];
      const [first] = [BigInt(stolen)];
      await (await world.voteChain.connect(world.issuer).registerCommitmentBatch(world.ids["TN-CHE"], [first])).wait(); // registered out of band
      await world.nextEpoch();
      assert.equal((await identity.batcher.tick()).formed[0].outcome, "FINALIZED");
      assert.deepEqual(await states(), { ISSUED: 2, CANCELLED: 1 });
      assert.equal((await CredentialIssuance.findOne({ state: "CANCELLED" })).commitment, undefined);
      assert.equal((await world.groupLeaves("BATCH")).length, 2);
    });
  });

  describe("crash and retry safety", () => {
    /** a cohort of 3 that has been sent and finalized up to the named crash point; returns the commitments and the crashed manager's identity */
    async function crashedAt(name, when) {
      const commitments = await reserve(3);
      await world.nextEpoch();
      const doomed = buildIdentity({ testHooks: crashAt(name, when) });
      await doomed.chain.init();
      await assert.rejects(doomed.batcher.tick(), SimulatedCrash);
      return commitments;
    }
    /** a "restarted process": a fresh manager over the same database and chain, which first recovers */
    const restart = async (opts) => {
      const fresh = buildIdentity(opts);
      await fresh.chain.init();
      return fresh;
    };

    it("crash after the batch record, before any reservation was claimed: the batch is dropped and the cohort is simply formed again", async () => {
      const commitments = await crashedAt("afterBatchRecord");
      assert.equal(await CommitmentBatch.countDocuments({ state: "PREPARED" }), 1);
      assert.deepEqual(await states(), { RESERVED: 3 });
      const fresh = await restart();
      const report = await fresh.batcher.recover();
      assert.equal(report.resumed[0].outcome, "EMPTY");
      assert.equal(report.formed[0].outcome, "FINALIZED");
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments));
      assert.deepEqual(await states(), { ISSUED: 3 });
    });

    it("crash after the claim, before signing: nothing is on-chain; recovery signs and sends it", async () => {
      const commitments = await crashedAt("afterClaim");
      assert.deepEqual(await states(), { BATCHED: 3 });
      assert.deepEqual(await world.groupLeaves("BATCH"), []);
      const nonce = await issuerNonce();
      const fresh = await restart();
      const report = await fresh.batcher.recover();
      assert.equal(report.resumed[0].outcome, "FINALIZED");
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments));
      assert.equal(await issuerNonce(), nonce + 1, "exactly one transaction");
    });

    it("crash after signing, before broadcast: the raw transaction is persisted, nothing is on-chain, and recovery rebroadcasts the IDENTICAL bytes", async () => {
      const commitments = await crashedAt("afterSign");
      const signed = await CommitmentBatch.findOne({ state: "SIGNED" }).select("+rawTx");
      assert.ok(signed.rawTx && signed.txHash);
      assert.deepEqual(await world.groupLeaves("BATCH"), [], "not broadcast yet");
      assert.equal(await world.provider.getTransaction(signed.txHash), null);
      const nonce = await issuerNonce();
      assert.equal(signed.nonce, nonce);

      const fresh = await restart();
      const report = await fresh.batcher.recover();
      assert.equal(report.resumed[0].outcome, "FINALIZED");
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments));
      const events = await batchEvents("BATCH");
      assert.equal(events.length, 1);
      assert.equal(events[0].tx, signed.txHash, "the very transaction that was persisted");
      assert.equal(await issuerNonce(), nonce + 1);
      assert.deepEqual(await states(), { ISSUED: 3 });
    });

    it("crash after the broadcast, before the database knew: the transaction is already mined; recovery finds the receipt, verifies the events, and issues exactly once", async () => {
      const commitments = await crashedAt("afterBroadcast");
      const batch = await CommitmentBatch.findOne({});
      assert.equal(batch.state, "SIGNED", "the database never learned that it was sent");
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments), "but it is on-chain");
      const nonce = await issuerNonce();
      const fresh = await restart();
      assert.equal((await fresh.batcher.recover()).resumed[0].outcome, "FINALIZED");
      assert.equal(await issuerNonce(), nonce, "no second transaction");
      assert.equal((await batchEvents("BATCH")).length, 1);
      assert.deepEqual(await states(), { ISSUED: 3 });
    });

    it("an RPC timeout while broadcasting leaves the batch SIGNED; the next pass rebroadcasts the same bytes", async () => {
      await reserve(2);
      await world.nextEpoch();
      const flakyChain = flaky(world.provider, { failBroadcasts: 2 }); // the attempt and its retry both time out
      const timing = buildIdentity({ provider: flakyChain.provider });
      await timing.chain.init();
      const first = await timing.batcher.tick();
      assert.deepEqual(first.formed, [{ status: "ERROR", error: "CHAIN_UNAVAILABLE" }]);
      const signed = await CommitmentBatch.findOne({ state: "SIGNED" }).select("+rawTx");
      assert.ok(signed, "SIGNED and persisted");
      assert.deepEqual(await states(), { BATCHED: 2 });
      const second = await timing.batcher.tick();
      assert.equal(second.resumed[0].outcome, "FINALIZED");
      assert.deepEqual(new Set(flakyChain.state.sent), new Set([signed.rawTx]), "every attempt sent the identical bytes");
    });

    it("a transaction that vanished from the node (never mined, nonce still free) is rebroadcast byte for byte", async () => {
      await reserve(2);
      await world.nextEpoch();
      const flakyChain = flaky(world.provider, { swallowBroadcasts: 1 });
      const dropping = buildIdentity({ provider: flakyChain.provider });
      await dropping.chain.init();
      await dropping.batcher.tick();
      const batch = await CommitmentBatch.findOne({}).select("+rawTx");
      assert.equal(await world.provider.getTransaction(batch.txHash), null, "unknown to the node");
      assert.equal((await dropping.batcher.tick()).resumed[0].outcome, "FINALIZED");
      assert.equal((await batchEvents("BATCH")).length, 1);
      assert.equal(flakyChain.state.sent.length, 2);
      assert.equal(flakyChain.state.sent[0], flakyChain.state.sent[1]);
    });

    it("if the persisted transaction can NEVER be mined (its nonce was spent by another transaction) and the chain shows the cohort was not registered, the cohort is released and sent again with a new nonce", async () => {
      const commitments = await crashedAt("afterSign");
      const signed = await CommitmentBatch.findOne({ state: "SIGNED" });
      await (await world.issuer.sendTransaction({ to: world.issuer.address, value: 0n, nonce: signed.nonce })).wait(); // the nonce is spent
      const fresh = await restart();
      const nonceBefore = await issuerNonce();
      const report = await fresh.batcher.recover();
      assert.equal(report.resumed[0].outcome, "RELEASED", "the chain proved it never registered them: back in the queue");
      assert.equal((await CommitmentBatch.findById(signed._id)).state, "FAILED");
      assert.equal(report.formed[0].outcome, "FINALIZED", "and the same pass sends the cohort again (a failed batch registered nothing, so the epoch rule does not apply)");
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments));
      const events = await batchEvents("BATCH");
      assert.equal(events.length, 1);
      assert.notEqual(events[0].tx, signed.txHash);
      assert.equal(await issuerNonce(), nonceBefore + 1, "a fresh transaction with the next free nonce");
      assert.deepEqual(await states(), { ISSUED: 3 });
    });

    it("a mined transaction that REVERTED registered nothing: the receipt failure releases the cohort, and nobody is issued", async () => {
      await crashedAt("afterSign");
      const signed = await CommitmentBatch.findOne({ state: "SIGNED" });
      await (await world.voteChain.closeIssuance()).wait(); // the persisted transaction will now revert (IssuanceNotOpen)
      const fresh = await restart();
      const report = await fresh.batcher.recover();
      assert.equal(report.resumed[0].outcome, "REVERTED");
      assert.equal((await CommitmentBatch.findById(signed._id)).state, "FAILED");
      assert.equal((await CommitmentBatch.findById(signed._id)).commitments, undefined);
      assert.deepEqual(await world.groupLeaves("BATCH"), [], "nothing was registered");
      assert.equal((await states()).ISSUED, undefined);
      assert.equal(report.formed[0].status, "CLOSED", "and with issuance closed the released cohort is cancelled, never retried");
      assert.deepEqual(await states(), { CANCELLED: 3 });
    });

    it("an on-chain success whose database update was interrupted (CONFIRMED, records still BATCHED) is finished by recovery without registering anything again", async () => {
      const commitments = await crashedAt("afterConfirmed");
      assert.equal((await CommitmentBatch.findOne({})).state, "CONFIRMED");
      assert.deepEqual(await states(), { BATCHED: 3 });
      const nonce = await issuerNonce();
      const fresh = await restart();
      assert.equal((await fresh.batcher.recover()).resumed[0].outcome, "FINALIZED");
      assert.deepEqual(await states(), { ISSUED: 3 });
      assert.equal(await issuerNonce(), nonce);
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments));
    });

    it("a crash in the MIDDLE of finalizing (one voter issued, two not) is completed on restart: nobody is issued twice, nobody is left behind", async () => {
      await crashedAt("duringFinalize", ({ index }) => index === 1);
      assert.deepEqual(await states(), { ISSUED: 1, BATCHED: 2 });
      const fresh = await restart();
      assert.equal((await fresh.batcher.recover()).resumed[0].outcome, "FINALIZED");
      assert.deepEqual(await states(), { ISSUED: 3 });
      assert.equal((await batchEvents("BATCH")).length, 1);
      assert.equal((await CommitmentBatch.findOne({})).state, "FINALIZED");
      const raw = await mongoose.connection.db.collection("credentialissuances_v3").find({}).toArray();
      assert.ok(raw.every((r) => Object.keys(r).sort().join() === "_id,electionId,state,voterId"));
    });

    it("NO AUTOMATIC REISSUE once a cohort is on-chain: even with the transaction hash lost, recovery finds the cohort in the group's events and finalizes it instead of releasing it", async () => {
      const commitments = await crashedAt("afterBroadcast");
      await CommitmentBatch.updateOne({}, { $set: { txHash: "0x" + "ab".repeat(32) } }); // the hash on record is wrong; the bytes would not matter either
      const fresh = await restart();
      const report = await fresh.batcher.recover();
      assert.equal(report.resumed[0].outcome, "FINALIZED");
      assert.deepEqual(await world.groupLeaves("BATCH"), sortedBig(commitments), "still exactly once in the group");
      assert.deepEqual(await states(), { ISSUED: 3 });
      assert.equal((await batchEvents("BATCH")).length, 1);
    });

    it("an already-issued voter can never be given another credential, whatever asks: the service refuses a new commitment for an ISSUED record", async () => {
      const voter = await createVoter(config, { n: 50 });
      const cookie = await toEligible(identity.app, voter);
      await requestCredential(identity.app, cookie, { commitment: commitmentOf("v50") });
      await world.nextEpoch();
      await identity.batcher.tick();
      const principal = { voterDbId: String(voter.doc._id), stage: STAGES.ELIGIBLE, sessionId: String(new mongoose.Types.ObjectId()), sessionRef: "x" };
      await assert.rejects(identity.credentialService.request(principal, { commitment: commitmentOf("v50-again") }, {}), (err) => err.code === "CREDENTIAL_ALREADY_ISSUED");
      await assert.rejects(identity.credentialService.checkEligibility({ ...principal, stage: STAGES.FACE_VERIFIED }, {}), (err) => err.code === "CREDENTIAL_ALREADY_ISSUED");
      assert.equal(await CredentialIssuance.countDocuments({}), 1);
      assert.equal((await world.groupLeaves("KA-BLR")).length, 1);
      // and the poll delivers the result exactly once, ending the session
      assert.equal((await pollCredential(identity.app, cookie)).status, 200);
      assert.equal((await pollCredential(identity.app, cookie)).status, 401);
    });
  });
});
