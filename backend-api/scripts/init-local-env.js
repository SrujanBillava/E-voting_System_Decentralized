// Creates backend-api/.env for LOCAL development if it does not exist yet.
//
// The three signer keys are the publicly documented Hardhat development accounts #0 (owner), #1
// (authority) and #2 (relayer): the same identities smart-contract's `deploy:local` configures.
// They are worthless on any real chain and the backend refuses them when NODE_ENV=production.
// NULLIFIER_SECRET is freshly random. No key or secret is printed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HDNodeWallet, Mnemonic } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

if (fs.existsSync(envPath)) {
  console.error(".env already exists; not overwriting it. Compare it with .env.example and add any missing variables.");
  process.exit(1);
}

const hardhat = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase("test test test test test test test test test test test junk"), "m/44'/60'/0'/0");
const [owner, authority, relayer] = [0, 1, 2].map((i) => hardhat.deriveChild(i));

const template = fs.readFileSync(path.join(root, ".env.example"), "utf8");
const filled = template
  .replace(/^OWNER_PRIVATE_KEY=.*$/m, `OWNER_PRIVATE_KEY=${owner.privateKey}`)
  .replace(/^AUTHORITY_PRIVATE_KEY=.*$/m, `AUTHORITY_PRIVATE_KEY=${authority.privateKey}`)
  .replace(/^RELAYER_PRIVATE_KEY=.*$/m, `RELAYER_PRIVATE_KEY=${relayer.privateKey}`)
  .replace(/^NULLIFIER_SECRET=.*$/m, `NULLIFIER_SECRET=${crypto.randomBytes(32).toString("hex")}`)
  .replace(/^JWT_ACCESS_SECRET=.*$/m, `JWT_ACCESS_SECRET=${crypto.randomBytes(32).toString("hex")}`)
  .replace(/^ADMIN_TOTP_ENCRYPTION_KEY=.*$/m, `ADMIN_TOTP_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("hex")}`)
  .replace(/^FACE_TEMPLATE_ENCRYPTION_KEY=.*$/m, `FACE_TEMPLATE_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("hex")}`);

// "wx": fail instead of following a symlink or overwriting a file that appeared since the check above.
fs.writeFileSync(envPath, filled, { flag: "wx", mode: 0o600 });
console.log("Created backend-api/.env for local development.");
console.log(`  owner     ${owner.address}`);
console.log(`  authority ${authority.address}`);
console.log(`  relayer   ${relayer.address}`);
console.log("Start the chain (smart-contract: npm run node && npm run deploy:local), MongoDB, then: npm start");
