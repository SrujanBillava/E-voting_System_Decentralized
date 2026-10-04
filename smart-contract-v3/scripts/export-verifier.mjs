// Generates contracts/verifiers/BallotValidityVerifier.sol from the frozen privacy-v3 ballot-validity circuit's final zkey, with snarkjs, UNMODIFIED.
//   npm run export:verifier
// It also writes BallotValidityVerifier.meta.json (hashes of the zkey, the verification key and the generated Solidity) so the tests can prove that
// the committed verifier matches the committed build record (privacy-v3/results/build-info.json) and, when the artifacts are present, your local build.
//
// The zkey is a TEST-ONLY setup (phase 2 = one local contribution). Rebuilding the artifacts (npm run build:circuit in privacy-v3) draws fresh
// randomness and therefore produces a DIFFERENT verification key: run this script again afterwards, and use a real multi-party phase 2 in production.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = path.resolve(root, "..", "privacy-v3");
const zkey = path.join(core, "artifacts", "build", "ballot_validity_final.zkey");
const vkey = path.join(core, "artifacts", "build", "verification_key.json");
const cli = path.join(core, "node_modules", "snarkjs", "build", "cli.cjs");
const out = path.join(root, "contracts", "verifiers", "BallotValidityVerifier.sol");
const meta = path.join(root, "contracts", "verifiers", "BallotValidityVerifier.meta.json");

for (const f of [zkey, vkey, cli]) if (!fs.existsSync(f)) throw new Error(`missing ${f}\nbuild the crypto core first: cd ../privacy-v3 && npm install && npm run build:circuit`);
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

execFileSync(process.execPath, [cli, "zkey", "export", "solidityverifier", zkey, out], { stdio: ["ignore", "ignore", "inherit"] });
const vk = JSON.parse(fs.readFileSync(vkey, "utf8"));
if (vk.nPublic !== 68) throw new Error(`expected the frozen 68 public signals, the verification key has ${vk.nPublic}`);
const record = {
  contract: "Groth16Verifier",
  circuit: "privacy-v3/circuits/ballot_validity.circom",
  publicSignals: vk.nPublic,
  snarkjs: JSON.parse(fs.readFileSync(path.join(core, "node_modules", "snarkjs", "package.json"), "utf8")).version,
  command: "snarkjs zkey export solidityverifier ballot_validity_final.zkey BallotValidityVerifier.sol",
  zkeySha256: sha256(zkey),
  verificationKeySha256: sha256(vkey),
  solidityVerifierSha256: sha256(out),
  setup: "TEST ONLY: Perpetual Powers of Tau phase 1 + ONE local phase-2 contribution (not a ceremony). Regenerate after any rebuild of the artifacts.",
};
fs.writeFileSync(meta, JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
