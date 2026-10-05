// Builds everything the prototype needs under privacy-v3/artifacts (git-ignored, large):
//   bin/circom                      circom 2.2.3 release binary (downloaded, version printed)
//   ptau/ppot_0080_18.ptau          Perpetual Powers of Tau (PSE, contribution 80, 2^18), already phase-2 prepared
//   semaphore/semaphore-<d>.{wasm,zkey}   official Semaphore v4 artifacts for the pinned depths (3 for fast tests, 20 = frozen architecture)
//   build/ballot_validity.{r1cs,sym}, ballot_validity_js/   compiled circuit
//   build/ballot_validity_final.zkey, verification_key.json   the FINAL PROTOTYPE / RESEARCH ceremony output, provisioned from the committed ceremony/ and spec/ (see
//                                   spec/final-ceremony.json): it cannot be rebuilt (the contribution entropy is gone by design), so it is checked against its pinned SHA-256, never regenerated.
//                                   To run a NEW ceremony (which invalidates the verifier, the kiosk pins and every old proof): node scripts/final-ceremony.mjs --redo
//   --verify-zkey                   additionally runs snarkjs' full verification of the zkey against the R1CS and the ptau (about 20 s)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = (...p) => path.join(root, "artifacts", ...p);
const force = process.argv.includes("--force");
const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error };
const log = (...a) => console.log("[build]", ...a);
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const MiB = (bytes) => (bytes / 1048576).toFixed(2);

const CIRCOM_URL = "https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64";
const PTAU_FILE = "ppot_0080_18.ptau";
const PTAU_URL = "https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_18.ptau";
const SEMAPHORE_URL = (d, ext) => `https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-${d}.${ext}`;
// Depth 20 is the frozen architecture; depth 3 is only for fast tests. Both are PINNED: the artifact set 4.13.0 is the one @semaphore-protocol/proof 4.14.3 asks for,
// and the SHA-256 of every file is checked after download (and by test/semaphore.depth20.test.mjs), so a changed artifact fails the build instead of being used.
const SEMAPHORE_DEPTHS = (process.env.SEMAPHORE_DEPTHS ?? "3,20").split(",").map(Number);
const SEMAPHORE_SHA256 = {
  "semaphore-3.wasm": "48e15502f710be0a623d573d472edeeaf918fd5eee0b2ca9b407c4e4f20d12f2",
  "semaphore-3.zkey": "c36653c42784df35a01f3d93415af9ad8292a540f8deb134a6a34a01752a89d3",
  "semaphore-20.wasm": "6f71e55586929e520e76027ebe067daac8b41e2f4b8057313a5fd0304e1e44ee",
  "semaphore-20.zkey": "33f9a067a80c7daf90e085449073613a9559a1904dd40aeb6d603afb7988c2cc",
};

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  log("downloading", url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

const timings = {};
async function step(name, fn) {
  const t = performance.now();
  const out = await fn();
  timings[name] = Math.round(performance.now() - t);
  log(`${name}: ${(timings[name] / 1000).toFixed(1)} s`);
  return out;
}

// ---------------------------------------------------------------- toolchain + public parameters
if (process.platform === "linux" && process.arch === "x64") {
  await download(CIRCOM_URL, A("bin", "circom"));
  fs.chmodSync(A("bin", "circom"), 0o755);
} else if (!fs.existsSync(A("bin", "circom"))) {
  throw new Error("put a circom 2.2.x binary at artifacts/bin/circom (only the linux-x64 release is downloaded automatically)");
}
const circomVersion = execFileSync(A("bin", "circom"), ["--version"]).toString().trim();
log(circomVersion);
await download(PTAU_URL, A("ptau", "ppot_0080_18.ptau"));
for (const d of SEMAPHORE_DEPTHS) {
  for (const ext of ["wasm", "zkey"]) {
    const name = `semaphore-${d}.${ext}`;
    await download(SEMAPHORE_URL(d, ext), A("semaphore", name));
    const expected = SEMAPHORE_SHA256[name];
    if (expected && sha256(A("semaphore", name)) !== expected) throw new Error(`${name}: SHA-256 differs from the pinned Semaphore 4.13.0 artifact; refusing to use it (delete it to download again)`);
  }
}

// ---------------------------------------------------------------- compile
const r1cs = A("build", "ballot_validity.r1cs");
if (force || !fs.existsSync(r1cs)) {
  fs.mkdirSync(A("build"), { recursive: true });
  await step("compile", async () => {
    execFileSync(A("bin", "circom"), [path.join(root, "circuits", "ballot_validity.circom"), "--r1cs", "--wasm", "--sym", "-o", A("build"), "-l", path.join(root, "node_modules"), "--O2"], { stdio: "inherit" });
  });
}

// ---------------------------------------------------------------- Groth16 phase 2: the FINAL PROTOTYPE ceremony's output, provisioned and checked (never regenerated here)
const ceremony = JSON.parse(fs.readFileSync(path.join(root, "spec", "final-ceremony.json"), "utf8"));
const zkeyFinal = A("build", "ballot_validity_final.zkey");
const vkeyFile = A("build", "verification_key.json");
if (sha256(r1cs) !== ceremony.artifacts.r1csSha256) throw new Error("the compiled R1CS is not the one the final ceremony was run on (the circuit changed?): refusing to provision the final zkey");
const committedZkey = path.join(root, "ceremony", "ballot_validity_final.zkey");
if (sha256(committedZkey) !== ceremony.artifacts.finalZkeySha256) throw new Error("ceremony/ballot_validity_final.zkey does not match spec/final-ceremony.json");
if (sha256(path.join(root, "spec", "verification_key.json")) !== ceremony.artifacts.verificationKeySha256) throw new Error("spec/verification_key.json does not match spec/final-ceremony.json");
if (!fs.existsSync(zkeyFinal) || sha256(zkeyFinal) !== ceremony.artifacts.finalZkeySha256) fs.copyFileSync(committedZkey, zkeyFinal);
if (!fs.existsSync(vkeyFile) || sha256(vkeyFile) !== ceremony.artifacts.verificationKeySha256) fs.copyFileSync(path.join(root, "spec", "verification_key.json"), vkeyFile);
if (process.argv.includes("--verify-zkey")) {
  const ok = await step("zkey_verify", () => snarkjs.zKey.verifyFromR1cs(r1cs, A("ptau", PTAU_FILE), zkeyFinal, quiet));
  if (!ok) throw new Error("zkey verification against the r1cs and the ptau FAILED");
}

// ---------------------------------------------------------------- record what was built
const info = await snarkjs.r1cs.info(r1cs, quiet);
const record = {
  builtAt: new Date().toISOString(),
  circomVersion,
  snarkjs: JSON.parse(fs.readFileSync(path.join(root, "node_modules", "snarkjs", "package.json"))).version,
  circuit: { file: "circuits/ballot_validity.circom", constraints: info.nConstraints, wires: info.nVars, publicInputs: info.nPubInputs, publicOutputs: info.nOutputs, privateInputs: info.nPrvInputs },
  sizesMiB: {
    r1cs: MiB(fs.statSync(r1cs).size),
    wasm: MiB(fs.statSync(A("build", "ballot_validity_js", "ballot_validity.wasm")).size),
    zkey: MiB(fs.statSync(zkeyFinal).size),
    verificationKeyJson: MiB(fs.statSync(vkeyFile).size),
  },
  sha256: {
    ptau: sha256(A("ptau", "ppot_0080_18.ptau")),
    r1cs: sha256(r1cs),
    wasm: sha256(A("build", "ballot_validity_js", "ballot_validity.wasm")),
    zkey: sha256(zkeyFinal),
    verificationKey: sha256(vkeyFile),
    ...Object.fromEntries(SEMAPHORE_DEPTHS.flatMap((d) => ["wasm", "zkey"].map((e) => [`semaphore-${d}.${e}`, sha256(A("semaphore", `semaphore-${d}.${e}`))]))),
  },
  buildTimingsMs: timings,
  setupNote: "FINAL PROTOTYPE / RESEARCH CEREMONY (spec/final-ceremony.json): phase 1 = Perpetual Powers of Tau (PSE ppot_0080_18); phase 2 = three contributions with discarded OS-CSPRNG entropy + a drand beacon, all on ONE development machine. Not an independently governed production ceremony.",
};
fs.writeFileSync(A("build", "build-info.json"), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
process.exit(0);
