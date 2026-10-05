// THE PRIVACY BOUNDARY, end to end: real voters go through the IDENTITY service (credential issuance), then a kiosk (this test) takes the PUBLIC group data from the
// RELAYER, proves membership locally with real Semaphore + Groth16 proofs and submits an anonymous ballot through the relayer. Two services, two processes' worth of
// configuration, two mongoose instances, two databases, two keys. Afterwards each side's database, logs and HTTP responses are scanned for the other side's secrets.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import mongoose from "mongoose";
import request from "supertest";
import { Group } from "../../../privacy-v3/src/semaphore.js";
import { TEST_CONTEXT } from "../../../privacy-v3/src/params.js";
import { castBallot } from "../../../privacy-v3/src/voter.js";
import { shutdownProver, fakeIdentity, toWire } from "../../../relay-v3/test/helpers/ballots.js";
import { closeDb as closeRelayDb, connectTestDb as connectRelayDb, dumpDb as dumpRelayDb, relayMongoose, resetDb as resetRelayDb } from "../../../relay-v3/test/helpers/db.js";
import { configFor as relayConfigFor } from "../../../relay-v3/test/helpers/env.js";
import { composeRelay } from "../../../relay-v3/src/compose.js";
import { secretValuesOf as relaySecrets } from "../../../relay-v3/src/config/env.js";
import { createMemoryLogger as relayMemoryLogger } from "../../../relay-v3/src/utils/logger.js";
import { composeIdentity } from "../../src/compose.js";
import { secretValuesOf as identitySecrets } from "../../src/config/env.js";
import { createMemoryLogger as identityMemoryLogger } from "../../src/utils/logger.js";
import { closeDb as closeIdentityDb, connectTestDb as connectIdentityDb, dumpDb as dumpIdentityDb, resetDb as resetIdentityDb, skipWithoutMongo } from "../helpers/db.js";
import { configFor as identityConfigFor } from "../helpers/env.js";
import { cookieOf, createVoter, eligibility, login, passFace, pollCredential, requestCredential } from "../helpers/journey.js";
import { findLeaks } from "../helpers/leak.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

const relayUri = process.env.MONGODB_RELAY_TEST_URI;
const skip = skipWithoutMongo || (relayUri ? false : "set MONGODB_RELAY_TEST_URI (a disposable database whose name contains 'test' and 'relay')") || (contractsCompiled ? false : "compile ../smart-contract-v3 first");

describe("PRIVACY BOUNDARY end to end: identity side and anonymous side never learn each other's secrets", { skip }, () => {
  let world;
  let idLog;
  let relayLog;
  const idTraffic = [];
  const relayTraffic = [];
  const voters = [];
  let evidence;

  before(async () => {
    await connectIdentityDb();
    await connectRelayDb(relayUri);
    assert.notEqual(mongoose, relayMongoose, "two mongoose instances");
    assert.notEqual(mongoose.connection.name, relayMongoose.connection.name, "two databases");
    await resetIdentityDb();
    await resetRelayDb();
    world = await newWorld();
  });
  after(async () => {
    await shutdownProver();
    world?.stop();
    await closeIdentityDb();
    await closeRelayDb();
  });

  it("two voters get a credential from the identity service; the kiosk votes anonymously through the relayer with the PUBLIC group data; both ballots are confirmed", async () => {
    const idConfig = identityConfigFor(world);
    const relayConfig = relayConfigFor(world, { RELAY_MONGODB_URI: relayUri });
    assert.notEqual(idConfig.issuerAddress, relayConfig.relayerAddress, "two different keys");
    idLog = identityMemoryLogger({ level: "debug", secrets: identitySecrets(idConfig) });
    relayLog = relayMemoryLogger({ level: "debug", secrets: relaySecrets(relayConfig) });
    const identity = composeIdentity({ config: idConfig, logger: idLog.logger, provider: world.provider, clock: world.clock, bcryptCost: 4, rateLimits: { login: { windowMs: 60_000, limit: 10_000 }, face: { windowMs: 60_000, limit: 10_000 } } });
    await identity.chain.init();
    const relay = composeRelay({ config: relayConfig, logger: relayLog.logger, provider: world.provider, globalLimitPerMinute: 100_000 });
    await relay.chain.init();
    const record = (store) => (res) => {
      store.push(res.text ?? "", JSON.stringify(res.headers));
      return res;
    };
    const id = record(idTraffic);
    const rl = record(relayTraffic);

    // ---------------- identity side: login, face, eligibility, commitment (the kiosk's private identity never leaves this test)
    const cookies = [];
    for (const n of [101, 102]) {
      const voter = await createVoter(idConfig, { n });
      const kiosk = fakeIdentity(`boundary:kiosk-${n}`);
      const loginRes = id(await login(identity.app, voter));
      const cookie = cookieOf(loginRes);
      id(await passFace(identity.app, cookie, voter));
      id(await eligibility(identity.app, cookie));
      const res = id(await requestCredential(identity.app, cookie, { commitment: kiosk.commitment.toString() }));
      assert.equal(res.status, 202);
      voters.push({ voter, kiosk, cookie, sessionToken: cookie.split("=")[1] });
      cookies.push(cookie);
    }
    await world.nextEpoch();
    const report = await identity.batcher.tick();
    assert.equal(report.formed[0].outcome, "FINALIZED");
    const delivered = [];
    for (const v of voters) {
      const poll = id(await pollCredential(identity.app, v.cookie));
      assert.equal(poll.status, 200);
      assert.equal(poll.body.data.state, "CREDENTIAL_ISSUED");
      delivered.push(poll.body.data);
      assert.equal((id(await pollCredential(identity.app, v.cookie))).status, 401, "the identity session is over");
    }

    // ---------------- the anonymous side: NO cookie, NO credentials, only public data
    const packages = [];
    for (const [i, v] of voters.entries()) {
      const groupRes = rl(await request(relay.app).get(`/v1/groups/${delivered[i].constituency.id}`));
      assert.equal(groupRes.status, 200);
      const g = groupRes.body.data;
      assert.equal(g.size, 2);
      assert.ok(g.leaves.includes(v.kiosk.commitment.toString()), "the kiosk verifies its OWN commitment is in the public group");
      const tree = new Group(g.leaves.map(BigInt));
      assert.equal(tree.root.toString(), g.root, "and that the rebuilt root is the chain's root");
      assert.equal(g.root, delivered[i].group.root, "the identity side's group root and the public path agree");
      const out = await castBallot({ identity: v.kiosk, group: tree, ctx: TEST_CONTEXT, constituency: "KA-BLR", kc: 3, choice: i, H: world.H });
      const pkg = toWire(out.submission);
      packages.push(pkg);
      const res = rl(await request(relay.app).post("/v1/ballots").send(pkg)); // no Cookie header at all
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.state, "CONFIRMED");
      assert.equal(res.headers["set-cookie"], undefined);
      packages[i].txHash = res.body.data.txHash;
    }
    evidence = { packages, delivered };
    assert.equal(Number(await world.voteChain.totalBallots()), 2);
  });

  it("the IDENTITY side never contains a nullifier, a ciphertext coordinate, a validity proof, a membership proof point, a ballot transaction hash: not in its database, its logs, or anything it ever answered", async () => {
    const forbidden = evidence.packages.flatMap((p) => [p.membership.nullifier, ...p.coords, ...p.validity.a, ...p.validity.b.flat(), ...p.validity.c, ...p.membership.points, p.txHash]);
    assert.ok(forbidden.length > 40);
    const stores = { "identity database": await dumpIdentityDb(), "identity logs": idLog.lines.join("\n"), "identity HTTP traffic": idTraffic.join("\n") };
    for (const [name, text] of Object.entries(stores)) {
      assert.ok(text.length > 200, `${name} was read`);
      assert.deepEqual(findLeaks(text, forbidden), [], name);
    }
  });

  it("the RELAYER side never contains a voter id, uid, name, email, face data, identity session, credential record or batch: not in its database, its logs, or anything it ever answered", async () => {
    const forbidden = [];
    for (const { voter, sessionToken } of voters) {
      const d = voter.doc;
      forbidden.push(voter.id, String(d._id), d.email, d.name, d.uid, sessionToken);
    }
    const sessions = await mongoose.connection.db.collection("credentialissuances_v3").find({}).toArray();
    forbidden.push(...sessions.map((r) => r._id));
    forbidden.push(...(await mongoose.connection.db.collection("commitmentbatches_v3").find({}).toArray()).map((b) => b._id));
    const stores = { "relayer database": await dumpRelayDb(), "relayer logs": relayLog.lines.join("\n"), "relayer HTTP traffic": relayTraffic.join("\n") };
    for (const [name, text] of Object.entries(stores)) {
      assert.ok(text.length > 200, `${name} was read`);
      assert.deepEqual(findLeaks(text, forbidden), [], name);
    }
    // the commitment-to-voter relation does not exist on the relayer: it never stores or logs a commitment (the public group answer is not persisted)
    const commitments = voters.map((v) => v.kiosk.commitment.toString());
    assert.deepEqual(findLeaks((await dumpRelayDb()) + relayLog.lines.join("\n"), commitments), [], "no commitment at rest on the relayer");
    // and the identity side, symmetrically, has no commitment left next to a voter
    for (const name of ["credentialissuances_v3", "votersessions_v3", "facechallenges_v3", "voters_v2"]) assert.deepEqual(findLeaks(JSON.stringify(await mongoose.connection.db.collection(name).find({}).toArray()), commitments), [], name);
  });

  it("CONTROL: the scanner really catches a planted forbidden value on either side, in the database, in the logs and in the traffic", async () => {
    const nullifier = evidence.packages[0].membership.nullifier;
    await mongoose.connection.db.collection("planted").insertOne({ nullifier });
    assert.deepEqual(findLeaks(await dumpIdentityDb(), [nullifier]), [nullifier], "planted in the identity database");
    await mongoose.connection.db.collection("planted").deleteMany({});
    assert.deepEqual(findLeaks(await dumpIdentityDb(), [nullifier]), [], "and gone again");

    const voterId = voters[0].voter.id;
    relayLog.logger.info(`served a request for ${voterId}`);
    assert.deepEqual(findLeaks(relayLog.lines.join("\n"), [voterId]), [voterId], "planted in the relayer log");
    await relayMongoose.connection.db.collection("planted").insertOne({ note: voters[0].voter.doc.email });
    assert.deepEqual(findLeaks(await dumpRelayDb(), [voters[0].voter.doc.email]), [voters[0].voter.doc.email], "planted in the relayer database");
    assert.deepEqual(findLeaks(idTraffic.join("") + JSON.stringify({ leaked: nullifier }), [nullifier]), [nullifier], "planted in the identity traffic");
  });
});
