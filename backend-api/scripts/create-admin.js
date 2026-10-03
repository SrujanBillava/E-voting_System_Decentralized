// Creates an admin account. There is deliberately NO HTTP signup endpoint.
//   npm run admin:create
// Prompts for email, name and password (typed input is hidden). For non-interactive use (CI, scripted
// setup) the password may instead come from the ADMIN_PASSWORD environment variable; prefer the prompt,
// since environment variables can end up in shell history and process listings.
// The password is never printed. The TOTP secret / otpauth URI is shown ONCE, here, and is not
// retrievable afterwards. Scan the QR code with an authenticator app now.
import readline from "node:readline";
import dotenv from "dotenv";
import mongoose from "mongoose";
import qrcode from "qrcode";
import { loadEnv } from "../src/config/env.js";
import { Admin } from "../src/models/Admin.js";
import { AdminSession } from "../src/models/AdminSession.js";
import { createAdminAuthService } from "../src/services/adminAuth.service.js";

dotenv.config({ quiet: true });

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) process.stdout.write(question); // show the prompt, hide what is typed
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

let exitCode = 0;
try {
  const config = loadEnv(process.env);
  const email = process.env.ADMIN_EMAIL ?? (await ask("Admin email: "));
  const name = process.env.ADMIN_NAME ?? (await ask("Admin name: "));
  const password = process.env.ADMIN_PASSWORD ?? (await ask("Password (min 12 chars, hidden): ", { hidden: true }));
  if (!process.env.ADMIN_PASSWORD && password !== (await ask("Repeat password: ", { hidden: true }))) throw new Error("passwords do not match");

  await mongoose.connect(config.secrets.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  const service = createAdminAuthService({ Admin, AdminSession, audit: { record: async () => {} }, secrets: config.secrets });
  const { admin, totpSecret, otpauthUri } = await service.createAdmin({ email, name, password });

  console.log(`\nCreated admin ${admin.email} (${admin.name}).`);
  console.log("\nScan this QR code with an authenticator app. It will NOT be shown again:\n");
  console.log(await qrcode.toString(otpauthUri, { type: "terminal", small: true }));
  console.log(`Manual entry key: ${totpSecret}\n${otpauthUri}\n`);
} catch (err) {
  exitCode = 1;
  console.error(err?.code === 11000 ? "An admin with that email already exists." : `Could not create admin: ${err?.message ?? err}`);
} finally {
  await mongoose.disconnect().catch(() => {});
}
process.exit(exitCode);
