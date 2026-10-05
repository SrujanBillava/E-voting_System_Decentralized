// Generates contracts/verifiers/BallotValidityVerifier.sol from the frozen privacy-v3 ballot-validity circuit's final zkey, with snarkjs, UNMODIFIED.
//   npm run export:verifier
// It also writes BallotValidityVerifier.meta.json (hashes of the zkey, the verification key and the generated Solidity) so the tests can prove that
// the committed verifier matches the FINAL ceremony manifest (privacy-v3/spec/final-ceremony.json), the committed build record and, when the artifacts are present, your local build.
//
// The zkey is the FINAL PROTOTYPE / RESEARCH ceremony output (three phase-2 contributions + a public beacon, all on one development machine). It is committed and cannot be
// rebuilt: `npm run build:circuit` in privacy-v3 only PROVISIONS it (hash-checked). A new ceremony (final-ceremony.mjs --redo) gives a different key: run this script again then.
// A production election needs a genuinely independently administered phase 2.
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
const ceremony = JSON.parse(fs.readFileSync(path.join(core, "spec", "final-ceremony.json"), "utf8"));
if (sha256(zkey) !== ceremony.artifacts.finalZkeySha256) throw new Error("the zkey is not the one recorded in privacy-v3/spec/final-ceremony.json: run `npm run build:circuit` in privacy-v3 to provision the final one");

execFileSync(process.execPath, [cli, "zkey", "export", "solidityverifier", zkey, out], { stdio: ["ignore", "ignore", "inherit"] });
if (sha256(out) !== ceremony.artifacts.solidityVerifierSha256) throw new Error("the generated verifier differs from the SHA-256 recorded in the final ceremony manifest");
const vk = JSON.parse(fs.readFileSync(vkey, "utf8"));
if (vk.nPublic !== 68) throw new Error(`expected the frozen 68 public signals, the verification key has ${vk.nPublic}`);
const record = {
  label: "FINAL PROTOTYPE / RESEARCH CEREMONY VERIFIER",
  contract: "Groth16Verifier",
  circuit: "privacy-v3/circuits/ballot_validity.circom",
  publicSignals: vk.nPublic,
  snarkjs: JSON.parse(fs.readFileSync(path.join(core, "node_modules", "snarkjs", "package.json"), "utf8")).version,
  command: "snarkjs zkey export solidityverifier ballot_validity_final.zkey BallotValidityVerifier.sol",
  zkeySha256: sha256(zkey),
  verificationKeySha256: sha256(vkey),
  solidityVerifierSha256: sha256(out),
  ceremony: "privacy-v3/spec/final-ceremony.json",
  setup: "FINAL PROTOTYPE / RESEARCH CEREMONY: Perpetual Powers of Tau phase 1 + three phase-2 contributions + a drand beacon, all applied on ONE development machine. NOT an independently governed ceremony: a production election needs a genuinely independent phase 2 and a verifier regenerated from it.",
};
fs.writeFileSync(meta, JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
