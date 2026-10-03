// TEST-ONLY command line fixture for the browser (Playwright) end-to-end tests. It talks to MongoDB directly.
//
//   node test/helpers/e2e-fixture.js reset
//   node test/helpers/e2e-fixture.js admin <email> <password>        -> {"totpSecret": "..."}
//   node test/helpers/e2e-fixture.js totp <secret>                    -> {"code": "123456"}
//   node test/helpers/e2e-fixture.js voter <name> <email> <password> <constituencyCode> -> {"voterId": "VC-..."}
//   node test/helpers/e2e-fixture.js stage <voterId> <STAGE>          -> moves that voter's live session to STAGE
//
// It exists because the biometric step (AUTHENTICATED -> FACE_VERIFIED) is built on another branch: tests place a session
// at FACE_VERIFIED with the same trusted primitive the real step will use. It is NOT an HTTP endpoint, ships no route, and
// refuses to run unless NODE_ENV is not production, the database is local, and its name contains "e2e".
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { generateSync } from "otplib";
import { STAGE_ORDER } from "../../src/auth/voterStages.js";
import { loadEnv } from "../../src/config/env.js";
import { Admin } from "../../src/models/Admin.js";
import { AdminSession } from "../../src/models/AdminSession.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { Voter } from "../../src/models/Voter.js";
import { VoteTicket } from "../../src/models/VoteTicket.js";
import { VoterSession } from "../../src/models/VoterSession.js";
import { createAdminAuthService } from "../../src/services/adminAuth.service.js";
import { generateUid, generateVoterId } from "../../src/services/voter.service.js";

dotenv.config({ quiet: true });
const out = (value) => console.log(JSON.stringify(value));

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "totp") return out({ code: generateSync({ secret: args[0] }) });

  if (process.env.NODE_ENV === "production") throw new Error("refusing to run in production");
  const config = loadEnv(process.env);
  const uri = config.secrets.mongodbUri;
  const dbName = new URL(uri).pathname.replace(/^\//, "");
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri) || !dbName.includes("e2e")) throw new Error("refusing: the database must be local and its name must contain 'e2e'");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  switch (command) {
    case "reset":
      await mongoose.connection.dropDatabase();
      await Promise.all([Voter.syncIndexes(), VoterSession.syncIndexes(), VoteTicket.syncIndexes(), Admin.syncIndexes(), AdminSession.syncIndexes(), AuditLog.syncIndexes()]);
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
