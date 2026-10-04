import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESCRIPTOR_LENGTH, FACE_MODEL, TEMPLATE_VERSION } from "../../src/biometrics/constants.js";
import { toUnitVector } from "../../src/biometrics/descriptor.js";
import { sealTemplate } from "../../src/biometrics/templateBox.js";
import { createFaceService } from "../../src/services/face.service.js";
import { capture, person, rounded, samplesOf } from "../helpers/face.js";

// Offline: the face service with stand-in models, for the paths a healthy single database never takes
// (a write that fails half-way, two requests inserting the same row, an index build that fails).
// The normal behaviour is tested against a real database in test/chain/face.test.js.

const KEY = Buffer.from("5e1c8a3f7b9d2046c8e0a2f4b6d81357e9c1a3b5d7f90246a8c0e2f4b6d8a1c3", "hex");
const VOTER_DB_ID = "64b7f0c2a1d3e4f5a6b7c8d9";
const ASHA = person(1);
const duplicateKey = () => Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
/** What a Mongoose query looks like to the service: awaitable, and it has select(). */
const query = (value) => ({ select: async () => value, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) });

function world(overrides = {}) {
  const calls = [];
  const audits = [];
  const note = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const voter = { _id: VOTER_DB_ID, voterId: "VC-ABCDEFGHJK", faceEnrolled: true };
  const template = { box: sealTemplate(KEY, VOTER_DB_ID, samplesOf(ASHA).map(toUnitVector)), algorithm: FACE_MODEL, dimension: DESCRIPTOR_LENGTH, templateVersion: TEMPLATE_VERSION };
  const models = {
    Voter: {
      findById: async () => voter,
      updateOne: async (...args) => note("Voter.updateOne")(...args),
    },
    VoterSession: { updateOne: async (...args) => note("VoterSession.updateOne")(...args) },
    FaceTemplate: {
      createIndexes: async () => note("FaceTemplate.createIndexes")(),
      updateOne: async (...args) => note("FaceTemplate.updateOne")(...args),
      findOne: (...args) => {
        note("FaceTemplate.findOne")(...args);
        return query(template);
      },
      deleteOne: async (...args) => note("FaceTemplate.deleteOne")(...args),
    },
    FaceChallenge: {
      createIndexes: async () => note("FaceChallenge.createIndexes")(),
      updateOne: async (...args) => note("FaceChallenge.updateOne")(...args),
      findOneAndUpdate: async (...args) => {
        note("FaceChallenge.findOneAndUpdate")(...args);
        return { attempts: 1, challengesIssued: 1 };
      },
      findOne: async () => ({ attempts: 0 }),
    },
  };
  for (const [model, methods] of Object.entries(overrides.models ?? {})) Object.assign(models[model], methods);
  const service = createFaceService({
    ...models,
    authService: { transitionStage: async (...args) => (note("transitionStage")(...args), true), ...overrides.authService },
    chain: { contract: { phase: async () => 0n } },
    audit: { record: async (entry) => void audits.push(entry) },
    templateKey: KEY,
    now: () => Date.parse("2026-10-03T10:00:00Z"),
  });
  const session = { sessionId: "a".repeat(24), voterDbId: VOTER_DB_ID, stage: "AUTHENTICATED", sessionExpiresAt: new Date("2026-10-03T10:15:00Z"), voter: { voterId: voter.voterId, faceEnrolled: true } };
  const ctx = { ip: "127.0.0.1", requestId: "req-1", adminId: "b".repeat(24) };
  const names = () => calls.map((c) => c[0]);
  return { service, calls, names, audits, session, ctx };
}

const probe = () => rounded(capture(ASHA, 0.85, 60));
const CHALLENGE = "c".repeat(43);

describe("face service: construction", () => {
  it("refuses a template key that is not exactly 32 bytes", () => {
    for (const bad of [undefined, null, "", KEY.toString("hex"), KEY.subarray(0, 31), Buffer.alloc(33)]) {
      assert.throws(() => createFaceService({ Voter: {}, VoterSession: {}, FaceTemplate: {}, FaceChallenge: {}, authService: {}, chain: {}, audit: {}, templateKey: bad }), /32 bytes/);
    }
  });
});

describe("face service: the unique indexes are in place before first use", () => {
  it("builds them once, and tries again after a failed build", async () => {
    let builds = 0;
    const w = world({
      models: {
        FaceTemplate: {
          createIndexes: async () => {
            builds++;
            if (builds === 1) throw new Error("index build failed");
          },
        },
      },
    });
    await assert.rejects(w.service.issueChallenge(w.session, w.ctx), /index build failed/);
    assert.equal(w.names().includes("FaceChallenge.findOneAndUpdate"), false, "nothing was issued without the indexes");
    assert.equal(typeof (await w.service.issueChallenge(w.session, w.ctx)).challenge, "string");
    await w.service.issueChallenge(w.session, w.ctx);
    assert.equal(builds, 2, "one failed build, one successful build, and no rebuild afterwards");
  });
});

describe("face service: two requests inserting the same row", () => {
  it("enrolment: a duplicate-key error on the insert falls back to a plain update", async () => {
    let first = true;
    const w = world({
      models: {
        FaceTemplate: {
          updateOne: async (filter, update, options) => {
            w.calls.push(["FaceTemplate.updateOne", filter, update, options]);
            if (first) {
              first = false;
              throw duplicateKey();
            }
          },
        },
      },
    });
    const out = await w.service.enroll({ voterDbId: VOTER_DB_ID, descriptors: samplesOf(ASHA).map(rounded) }, w.ctx);
    assert.equal(out.voter.faceEnrolled, true);
    const writes = w.calls.filter((c) => c[0] === "FaceTemplate.updateOne");
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[0][3], { upsert: true });
    assert.equal(writes[1][3], undefined, "the retry is an update of the row the other request inserted");
    assert.deepEqual(Object.keys(writes[1][2].$set.box).sort(), ["ct", "iv", "tag", "v"]);
    assert.equal(w.audits.at(-1).action, "FACE_ENROLLED");
  });

  it("enrolment: any other database error is not swallowed, and the voter is not marked enrolled", async () => {
    const w = world({ models: { FaceTemplate: { updateOne: async () => Promise.reject(new Error("connection lost")) } } });
    await assert.rejects(w.service.enroll({ voterDbId: VOTER_DB_ID, descriptors: samplesOf(ASHA).map(rounded) }, w.ctx), /connection lost/);
    assert.equal(w.names().includes("Voter.updateOne"), false);
    assert.equal(w.audits.length, 0);
  });

  it("challenge: a duplicate-key error while creating the session row is harmless", async () => {
    const w = world({ models: { FaceChallenge: { updateOne: async () => Promise.reject(duplicateKey()) } } });
    const out = await w.service.issueChallenge(w.session, w.ctx);
    assert.match(out.challenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(w.names().includes("FaceChallenge.findOneAndUpdate"), true);
  });

  it("challenge: any other database error is not swallowed", async () => {
    const w = world({ models: { FaceChallenge: { updateOne: async () => Promise.reject(new Error("connection lost")) } } });
    await assert.rejects(w.service.issueChallenge(w.session, w.ctx), /connection lost/);
    assert.equal(w.names().includes("FaceChallenge.findOneAndUpdate"), false);
  });
});

describe("face service: after the step is granted", () => {
  it("a failed bookkeeping write does not turn a granted step into an error, and the success is audited", async () => {
    const w = world({
      models: {
        VoterSession: { updateOne: async () => Promise.reject(new Error("write failed")) },
        FaceChallenge: { updateOne: async (filter, update) => (update.$set?.verifiedAt ? Promise.reject(new Error("write failed")) : undefined) },
      },
    });
    const out = await w.service.verify({ session: w.session, challenge: CHALLENGE, descriptor: probe(), liveness: { passed: true } }, w.ctx);
    assert.equal(out.verified, true);
    assert.equal(out.stage, "FACE_VERIFIED");
    assert.deepEqual(w.audits.map((a) => a.action), ["FACE_VERIFY_SUCCESS"]);
    assert.equal(w.names().filter((n) => n === "transitionStage").length, 1);
  });

  it("the audit row is written before the bookkeeping", async () => {
    const order = [];
    const w = world({ models: { VoterSession: { updateOne: async () => void order.push("faceMethod") } } });
    w.audits.push = (entry) => order.push(entry.action);
    await w.service.verify({ session: w.session, challenge: CHALLENGE, descriptor: probe() }, w.ctx);
    assert.deepEqual(order, ["FACE_VERIFY_SUCCESS", "faceMethod"]);
  });
});

describe("face service: liveness reported by the browser", () => {
  it("a reported failure is refused before the template is read or anything is consumed", async () => {
    const w = world();
    await assert.rejects(w.service.verify({ session: w.session, challenge: CHALLENGE, descriptor: probe(), liveness: { passed: false, real: 0.2 } }, w.ctx), (err) => err.status === 422 && err.code === "FACE_LIVENESS_FAILED");
    assert.deepEqual(w.names().filter((n) => !n.endsWith("createIndexes")), [], "no read, no claim, no transition");
    assert.deepEqual(w.audits.map((a) => [a.action, a.meta.reason]), [["FACE_VERIFY_FAILURE", "liveness_reported_fail"]]);
  });

  it("a reported pass does not replace the comparison", async () => {
    const w = world();
    const out = await w.service.verify({ session: w.session, challenge: CHALLENGE, descriptor: rounded(person(99)), liveness: { passed: true, real: 1, live: 1 } }, w.ctx);
    assert.deepEqual(out, { verified: false, attemptsLeft: 2, locked: false });
    assert.equal(w.names().includes("transitionStage"), false);
  });
});

describe("face service: malformed input reaches no database call", () => {
  it("a bad challenge type or descriptor is refused first", async () => {
    const w = world();
    for (const body of [{ challenge: 5, descriptor: probe() }, { challenge: "short", descriptor: probe() }, { challenge: CHALLENGE, descriptor: probe().slice(1) }, { challenge: CHALLENGE, descriptor: null }]) {
      await assert.rejects(w.service.verify({ session: w.session, ...body }, w.ctx), (err) => err.status === 400 && err.code === "VALIDATION_FAILED");
    }
    assert.deepEqual(w.names().filter((n) => !n.endsWith("createIndexes")), []);
    assert.equal(w.audits.length, 0);
  });
});
