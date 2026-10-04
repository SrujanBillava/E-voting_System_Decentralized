// TEST-ONLY command line fixture for the browser (Playwright) end-to-end tests. It talks to MongoDB directly.
//
//   node test/helpers/e2e-fixture.js reset
//   node test/helpers/e2e-fixture.js admin <email> <password>        -> {"totpSecret": "..."}
//   node test/helpers/e2e-fixture.js totp <secret>                    -> {"code": "123456"}
//   node test/helpers/e2e-fixture.js voter <name> <email> <password> <constituencyCode> -> {"voterId": "VC-..."}
//   node test/helpers/e2e-fixture.js stage <voterId> <STAGE>          -> moves that voter's live session to STAGE
//   node test/helpers/e2e-fixture.js enrol <voterId> <seed>           -> stores an encrypted SYNTHETIC face template (3 samples of imaginary person <seed>)
//   node test/helpers/e2e-fixture.js samples <seed> <count>           -> {"samples":[...]} synthetic enrolment samples of imaginary person <seed>
//   node test/helpers/e2e-fixture.js descriptor <seed> <similarity> [variant]  -> {"descriptor":[...]} a capture of person <seed> with that cosine similarity
//
// `stage` places a session at a stage WITHOUT biometrics: it is for focused non-biometric tests only. The biometric browser tests
// use `enrol` / `samples` / `descriptor` and the REAL face endpoints (no stage shortcut). None of this is an HTTP endpoint or ships a
// route, and the face data it produces is made-up numbers, never a real person. It refuses to run unless NODE_ENV is not production,
// the database is local, and its name contains "e2e".
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { generateSync } from "otplib";
import { STAGE_ORDER } from "../../src/auth/voterStages.js";
import { toUnitVector } from "../../src/biometrics/descriptor.js";
import { sealTemplate } from "../../src/biometrics/templateBox.js";
import { FACE_MODEL, DESCRIPTOR_LENGTH, TEMPLATE_VERSION } from "../../src/biometrics/constants.js";
import { loadEnv } from "../../src/config/env.js";
import { Admin } from "../../src/models/Admin.js";
import { AdminSession } from "../../src/models/AdminSession.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { FaceChallenge } from "../../src/models/FaceChallenge.js";
import { FaceTemplate } from "../../src/models/FaceTemplate.js";
import { Voter } from "../../src/models/Voter.js";
import { VoteTicket } from "../../src/models/VoteTicket.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createAdminAuthService } from "../../src/services/adminAuth.service.js";
import { generateUid, generateVoterId } from "../../src/services/voter.service.js";
import { capture, person, rounded, samplesOf } from "./face.js";

dotenv.config({ quiet: true });
const out = (value) => console.log(JSON.stringify(value));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "totp") return out({ code: generateSync({ secret: args[0] }) });
  if (command === "samples") return out({ samples: samplesOf(person(Number(args[0])), Number(args[1] ?? 3)).map(rounded) });
  if (command === "descriptor") return out({ descriptor: rounded(capture(person(Number(args[0])), Number(args[1]), Number(args[2] ?? 1))) });

  if (process.env.NODE_ENV === "production") throw new Error("refusing to run in production");
  const config = loadEnv(process.env);
  const uri = config.secrets.mongodbUri;
  const parsed = new URL(uri);
  const dbName = parsed.pathname.replace(/^\//, "");
  // Parse the URL instead of pattern-matching it: "mongodb://localhost:x@remote-host/e2e" has the host remote-host.
  if (parsed.protocol !== "mongodb:" || !["127.0.0.1", "localhost"].includes(parsed.hostname) || !dbName.includes("e2e")) throw new Error("refusing: the database must be local and its name must contain 'e2e'");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  switch (command) {
    case "reset":
      await mongoose.connection.dropDatabase();
      await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), VoteTicket.syncIndexes(), Admin.syncIndexes(), AdminSession.syncIndexes(), AuditLog.syncIndexes(), FaceTemplate.syncIndexes(), FaceChallenge.syncIndexes()]);
      return out({ ok: true });
    case "admin": {
      const service = createAdminAuthService({ Admin, AdminSession, audit: { record: async () => {} }, secrets: config.secrets, bcryptCost: 4 });
      const { totpSecret } = await service.createAdmin({ email: args[0], name: "E2E Admin", password: args[1] });
      return out({ totpSecret });
    }
    case "voter": {
      const [name, email, password, constituencyCode] = args;
      const voter = await Voter.create({ uid: generateUid(), voterId: generateVoterId(), name, email, passwordHash: await bcrypt.hash(password, 4), constituencyCode });
      return out({ voterId: voter.voterId });
    }
    case "enrol": {
      const [voterId, seed] = args;
      const voter = await Voter.findOne({ voterId });
      if (!voter) throw new Error("unknown voter");
      const samples = samplesOf(person(Number(seed)), 3).map(rounded).map(toUnitVector);
      await FaceTemplate.updateOne(
        { voterId: voter._id },
        { $set: { box: sealTemplate(config.secrets.faceTemplateKey, String(voter._id), samples), sampleCount: samples.length, dimension: DESCRIPTOR_LENGTH, algorithm: FACE_MODEL, templateVersion: TEMPLATE_VERSION, enrolledBy: null, enrolledAt: new Date() } },
        { upsert: true },
      );
      await Voter.updateOne({ _id: voter._id }, { $set: { faceEnrolled: true } });
      return out({ enrolled: voterId });
    }
    case "stage": {
      const [voterId, stage] = args;
      if (!STAGE_ORDER.includes(stage)) throw new Error("unknown stage");
      const voter = await Voter.findOne({ voterId });
      const res = await VoterSession.updateOne({ voterId: voter._id, active: true }, { $set: { stage, stageExpiresAt: new Date(Date.now() + 5 * 60_000) } });
      return out({ updated: res.modifiedCount });
    }
    default:
      throw new Error("unknown command");
  }
}

try {
  await main();
} catch (err) {
  console.error(err?.message ?? err);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
