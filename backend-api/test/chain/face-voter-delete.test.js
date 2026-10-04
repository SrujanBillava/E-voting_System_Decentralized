import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { loadEnv } from "../../src/config/env.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { FaceChallenge } from "../../src/models/FaceChallenge.js";
import { FaceTemplate } from "../../src/models/FaceTemplate.js";
import { Voter } from "../../src/models/Voter.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createBallotConfigService } from "../../src/services/ballotConfig.service.js";
import { createFaceService } from "../../src/services/face.service.js";
import { createVoterService, generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { adminWorld } from "../helpers/admin.js";
import { assertPristineLocalChain, localServices, revertTo, snapshot } from "../helpers/chain.js";
import { validEnv } from "../helpers/env.js";
import { person, rounded, samplesOf } from "../helpers/face.js";

// Needs the local chain and a disposable MongoDB (MONGODB_TEST_URI). Deleting a voter (Setup only) must remove THAT voter's
// encrypted face template and the face-challenge rows of THAT voter's sessions, and nothing that belongs to anybody else.
const uri = process.env.MONGODB_TEST_URI;
const KEY = loadEnv(validEnv()).secrets.faceTemplateKey;

describe("biometrics: deleting a voter removes their face data (real chain + Mongo)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  let chain, snap, w, token, ann, bob;
  const mk = async (name, email) => Voter.create({ uid: generateUid(), voterId: generateVoterId(), name, email, passwordHash: await bcrypt.hash("a voter password", 4), constituencyCode: "KA-BLR" });
  const call = (method, path, body) => {
    const r = w.request()[method](`/api/v1/admin${path}`).set(w.bearer(token));
    return body === undefined ? r : r.send(body);
  };
  const enrol = (voter, seed) => call("put", `/voters/${voter._id}/face`, { descriptors: samplesOf(person(seed), 3).map(rounded) });
  /** A live session with a face-challenge row, the way a voter who had started face verification would have one. */
  const withChallenge = async (voter) => {
    const t = new Date();
    const session = await VoterSession.create({ voterId: voter._id, tokenHash: `h-${voter.voterId}-${Math.random()}`, createdAt: t, lastActivityAt: t, absoluteExpiresAt: new Date(+t + 900_000), stageExpiresAt: new Date(+t + 300_000) });
    await FaceChallenge.create({ sessionId: session._id, voterId: voter._id, tokenHash: "a".repeat(64), action: "BLINK", expiresAt: new Date(+t + 30_000), purgeAt: new Date(+t + 900_000), challengesIssued: 1 });
    return session;
  };

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
    w = await adminWorld({
      extras: ({ audit, ownerQueue, auth }) => {
        const faceService = createFaceService({ Voter, VoterSession, FaceTemplate, FaceChallenge, authService: {}, chain, audit, templateKey: KEY });
        return {
          faceService,
          voterService: createVoterService({ Voter, chain, audit, bcryptCost: 4, FaceTemplate, FaceChallenge }),
          configService: createBallotConfigService({ chain, audit, ownerQueue }),
          authService: auth,
        };
      },
    });
    await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), FaceTemplate.syncIndexes(), FaceChallenge.syncIndexes()]);
    token = (await w.loginAs(await w.createAdmin())).body.data.accessToken;
    ann = await mk("Ann", "ann@example.org");
    bob = await mk("Bob", "bob@example.org");
  });
  afterEach(() => revertTo(chain.provider, snap));

  it("deletes the voter's template and challenge rows; another voter's data is untouched", async () => {
    assert.equal((await enrol(ann, 11)).status, 200);
    assert.equal((await enrol(bob, 12)).status, 200);
    const annSession = await withChallenge(ann);
    const bobSession = await withChallenge(bob);
    assert.equal(await FaceTemplate.countDocuments({}), 2);

    const res = await call("delete", `/voters/${ann._id}`);
    assert.equal(res.status, 204);

    assert.equal(await Voter.findById(ann._id), null);
    assert.equal(await FaceTemplate.countDocuments({ voterId: ann._id }), 0, "Ann's encrypted template is gone");
    assert.equal(await FaceChallenge.countDocuments({ sessionId: annSession._id }), 0, "Ann's challenge row is gone");
    assert.equal(await FaceTemplate.countDocuments({ voterId: bob._id }), 1, "Bob's template remains");
    assert.equal(await FaceChallenge.countDocuments({ sessionId: bobSession._id }), 1, "Bob's challenge row remains");
    assert.equal((await Voter.findById(bob._id)).faceEnrolled, true);
    assert.equal(await AuditLog.countDocuments({ action: "VOTER_DELETED" }), 1);
  });

  it("works for a voter who was never enrolled, and deleting twice is a plain 404", async () => {
    assert.equal((await call("delete", `/voters/${ann._id}`)).status, 204);
    assert.equal((await call("delete", `/voters/${ann._id}`)).status, 404);
  });

  it("a failing cleanup does not turn a completed delete into an error; it is audited", async () => {
    assert.equal((await enrol(ann, 11)).status, 200);
    const original = FaceTemplate.deleteOne;
    FaceTemplate.deleteOne = () => Promise.reject(new Error("db hiccup"));
    try {
      assert.equal((await call("delete", `/voters/${ann._id}`)).status, 204);
    } finally {
      FaceTemplate.deleteOne = original;
    }
    assert.equal(await Voter.findById(ann._id), null);
    const row = await AuditLog.findOne({ action: "VOTER_FACE_CLEANUP_FAILED" });
    assert.ok(row);
    assert.equal(row.result, "failure");
    assert.ok(!JSON.stringify(row).includes("db hiccup"), "no raw error text in the audit row");
  });
});
