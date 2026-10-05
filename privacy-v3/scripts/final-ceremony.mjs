// THE FINAL PROTOTYPE / RESEARCH PHASE-2 CEREMONY for the frozen ballot-validity circuit.
//
//   node scripts/final-ceremony.mjs            (needs `npm run build:circuit`'s toolchain: artifacts/bin/circom and artifacts/ptau)
//
// What it does, in order:
//   1. checks the PUBLIC inputs against their pins: the Phase-1 ptau (SHA-256), the circuit source (SHA-256), and that compiling the circuit again gives the byte-identical
//      R1CS and witness wasm of the frozen milestone;
//   2. groth16 setup (deterministic: ptau + R1CS), then THREE sequential phase-2 contributions, each in its own OS process with fresh CSPRNG entropy (ceremony-contribute.mjs);
//   3. a public random beacon (drand quicknet; the round is fixed BEFORE it exists, then waited for) as the finalizing contribution;
//   4. snarkjs verification of the final zkey against the R1CS and the ptau, export of the verification key, a real proof with the final zkey verified with that key;
//   5. refuses a zkey byte-identical to the previous TEST zkey; writes ceremony/ballot_validity_final.zkey, spec/verification_key.json and spec/final-ceremony.json
//      (no entropy anywhere) and removes every intermediate zkey.
//
// HONEST LABEL: every contribution here is made on ONE development machine by the same operator. This is a FINAL PROTOTYPE / RESEARCH ceremony, NOT an independently governed
// multi-party production ceremony. Phase 1 (PSE Perpetual Powers of Tau, contribution 80) IS a real public multi-party ceremony; phase 2 is not.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { oneHot } from "../src/ballot.js";
import { generateTestKeyPair } from "../src/elgamal.js";
import { PINS } from "./ceremony-pins.mjs";
import { witnessInput } from "../test/helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = (...p) => path.join(root, "artifacts", ...p);
const WORK = A("ceremony-work");
const log = (...a) => console.log("[ceremony]", ...a);
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error };
const must = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const CONTRIBUTIONS = 3;
const BEACON_ITERATIONS_EXP = 10;
const DRAND = { chainHash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971", url: "https://api.drand.sh/v2/beacons/quicknet/rounds", period: 3 };

if (fs.existsSync(path.join(root, "ceremony", "ballot_validity_final.zkey")) && !process.argv.includes("--redo")) {
  throw new Error("a final zkey is already committed in ceremony/. Re-running draws NEW entropy and produces a DIFFERENT setup, invalidating the verifier, the kiosk pins and every proof. Pass --redo only if that is what you want.");
}

// ---- 1. public inputs
const circomVersion = execFileSync(A("bin", "circom"), ["--version"]).toString().trim();
must(circomVersion === PINS.circomVersion, `circom is "${circomVersion}", the pin is "${PINS.circomVersion}"`);
const snarkjsVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "snarkjs", "package.json"), "utf8")).version;
must(snarkjsVersion === PINS.snarkjsVersion, `snarkjs is ${snarkjsVersion}, the pin is ${PINS.snarkjsVersion}`);
const ptau = A("ptau", PINS.ptau.file);
must(sha256(ptau) === PINS.ptau.sha256, "the Phase-1 ptau does not match its pinned SHA-256 (it is the PSE Perpetual Powers of Tau file already used by privacy-v3); refusing to use it");
const source = path.join(root, "circuits", "ballot_validity.circom");
must(sha256(source) === PINS.circuitSourceSha256, "the circuit source differs from the frozen milestone");
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, "compile"), { recursive: true });
execFileSync(A("bin", "circom"), [source, "--r1cs", "--wasm", "--sym", "-o", path.join(WORK, "compile"), "-l", path.join(root, "node_modules"), "--O2"], { stdio: "ignore" });
const r1cs = path.join(WORK, "compile", "ballot_validity.r1cs");
const wasm = path.join(WORK, "compile", "ballot_validity_js", "ballot_validity.wasm");
must(sha256(r1cs) === PINS.r1csSha256, "recompiling the circuit did not give the frozen R1CS");
must(sha256(wasm) === PINS.wasmSha256, "recompiling the circuit did not give the frozen witness wasm");
const info = await snarkjs.r1cs.info(r1cs, quiet);
must(info.nConstraints === 49136 && info.nPubInputs === 68 && info.nOutputs === 0, `unexpected circuit shape: ${info.nConstraints} constraints, ${info.nPubInputs} public inputs`);
log(`inputs verified: ptau ${PINS.ptau.file}, circuit source, R1CS (${info.nConstraints} constraints, ${info.nPubInputs} public signals)`);

// ---- 2. setup + three contributions, each in its own process
let current = path.join(WORK, "ballot_validity_0000.zkey");
await snarkjs.zKey.newZKey(r1cs, ptau, current, quiet);
for (let i = 1; i <= CONTRIBUTIONS; i++) {
  const next = path.join(WORK, `ballot_validity_${String(i).padStart(4, "0")}.zkey`);
  execFileSync(process.execPath, [path.join(root, "scripts", "ceremony-contribute.mjs"), current, next, `prototype-contribution-${i}`], { stdio: ["ignore", "ignore", "inherit"] });
  fs.rmSync(current);
  current = next;
  log(`phase-2 contribution ${i}/${CONTRIBUTIONS} made in its own process`);
}

// ---- 3. public random beacon: the round is chosen BEFORE it exists, then waited for
const drand = async (round) => {
  const res = await fetch(`${DRAND.url}/${round}`);
  return res.ok ? res.json() : null;
};
const latest = await (await fetch(`${DRAND.url}/latest`)).json();
const round = latest.round + 12; // about 36 s from now
log(`beacon: drand quicknet round ${round} (fixed now, published in ~${12 * DRAND.period} s)`);
let beacon = null;
for (let i = 0; i < 60 && !beacon; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  beacon = await drand(round);
}
must(beacon?.signature, "the drand beacon did not appear");
const randomness = createHash("sha256").update(Buffer.from(beacon.signature, "hex")).digest("hex"); // quicknet: randomness = SHA-256(signature)
const finalZkey = path.join(WORK, "ballot_validity_final.zkey");
await snarkjs.zKey.beacon(current, finalZkey, "final-beacon", randomness, BEACON_ITERATIONS_EXP, quiet);
fs.rmSync(current);

// ---- 4. verify
const lines = [];
const capture = { debug() {}, info: (m) => lines.push(String(m)), warn: console.warn, error: console.error };
must((await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, finalZkey, capture)) === true, "snarkjs REFUSED the final zkey against the R1CS and the ptau");
const hashes = [...lines.join("\n").matchAll(/contribution #(\d+) ([^\n]*):\n((?:\t\t[0-9a-f ]+\n?)+)/g)].map(([, n, name, h]) => ({ index: Number(n), name: name.replace(/:$/, "").trim(), contributionHash: h.replace(/[\s]/g, "") })).sort((a, b) => a.index - b.index);
must(hashes.length === CONTRIBUTIONS + 1, `expected ${CONTRIBUTIONS + 1} contributions in the zkey, found ${hashes.length}`);
const csHash = /Circuit Hash:\s*\n((?:\t\t[0-9a-f ]+\n?)+)/.exec(lines.join("\n"))?.[1].replace(/\s/g, "") ?? null;
const vk = await snarkjs.zKey.exportVerificationKey(finalZkey);
must(vk.nPublic === 68 && vk.IC.length === 69 && vk.protocol === "groth16" && vk.curve === "bn128", "unexpected verification key shape");
const vkText = JSON.stringify(vk, null, 2);
const vkHash = createHash("sha256").update(vkText).digest("hex");

// a real proof with the final zkey, verified with the exported key
const { publicKey: H } = generateTestKeyPair();
const { input, ciphertexts } = witnessInput({ H, kc: 16, m: oneHot(11, 16), nullifier: 424242n });
const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, finalZkey);
must(publicSignals.length === 68 && (await snarkjs.groth16.verify(vk, publicSignals, proof)) === true, "a real proof made with the final zkey does not verify with its verification key");
void ciphertexts;
await globalThis.curve_bn128?.terminate?.();
log("final zkey verified against the R1CS and the ptau; a real K_c = 16 proof verifies with the exported verification key");

// ---- 5. refuse the old test setup, publish the final artifacts, delete everything else
const finalHash = sha256(finalZkey);
must(finalHash !== PINS.previousTestZkeySha256, "the final zkey is byte-identical to the previous TEST zkey");
must(vkHash !== PINS.previousTestVerificationKeySha256, "the verification key is identical to the previous TEST key");
fs.mkdirSync(path.join(root, "ceremony"), { recursive: true });
fs.copyFileSync(finalZkey, path.join(root, "ceremony", "ballot_validity_final.zkey"));
fs.writeFileSync(path.join(root, "spec", "verification_key.json"), vkText); // the exact bytes whose SHA-256 the manifest records
const verifierTmp = path.join(WORK, "BallotValidityVerifier.sol");
execFileSync(process.execPath, [path.join(root, "node_modules", "snarkjs", "build", "cli.cjs"), "zkey", "export", "solidityverifier", finalZkey, verifierTmp], { stdio: ["ignore", "ignore", "inherit"] });
const manifest = {
  label: "FINAL PROTOTYPE / RESEARCH CEREMONY",
  version: "ballot-validity-prototype-final-1",
  trustStatement: "All phase-2 contributions and the beacon were applied on ONE development machine by the same operator. This is NOT an independently governed multi-party ceremony and must not be represented as one. Phase 1 is the public PSE Perpetual Powers of Tau (contribution 80). A production election needs a genuinely independent phase 2.",
  completedAt: new Date().toISOString(),
  circuit: { name: "ballot_validity", file: "circuits/ballot_validity.circom", sourceSha256: sha256(source), constraints: info.nConstraints, wires: info.nVars, publicSignals: info.nPubInputs, publicOutputs: info.nOutputs, privateInputs: info.nPrvInputs, kMax: 16 },
  toolchain: { circom: circomVersion, snarkjs: snarkjsVersion, curve: "bn128", protocol: "groth16" },
  phase1: { file: PINS.ptau.file, sha256: PINS.ptau.sha256, bytes: fs.statSync(ptau).size, power: PINS.ptau.power, source: PINS.ptau.source, note: "Perpetual Powers of Tau (PSE), contribution 80, already phase-2 prepared; the same file privacy-v3 used before this ceremony" },
  phase2: {
    contributions: CONTRIBUTIONS,
    beacon: { source: "drand quicknet", chainHash: DRAND.chainHash, round, signature: beacon.signature, randomness, numIterationsExp: BEACON_ITERATIONS_EXP },
    entries: hashes,
    circuitHash: csHash,
    entropy: "each contribution drew 64 bytes from the OS CSPRNG inside its own process (scripts/ceremony-contribute.mjs); never logged, stored or passed on a command line",
    verification: "snarkjs zKey.verifyFromR1cs(ballot_validity.r1cs, ptau, final zkey) = true",
  },
  artifacts: {
    r1csSha256: sha256(r1cs),
    witnessWasmSha256: sha256(wasm),
    finalZkeySha256: finalHash,
    finalZkeyBytes: fs.statSync(finalZkey).size,
    verificationKeySha256: vkHash,
    solidityVerifierSha256: sha256(verifierTmp),
    solidityVerifierCommand: "snarkjs zkey export solidityverifier ballot_validity_final.zkey BallotValidityVerifier.sol",
  },
  browser: { provingZkeySha256: finalHash, witnessWasmSha256: sha256(wasm), note: "the kiosk bundles exactly these two files and pins these hashes (kiosk-v3/pinned-artifacts.json)" },
  replaces: { previousTestZkeySha256: PINS.previousTestZkeySha256, previousTestVerificationKeySha256: PINS.previousTestVerificationKeySha256 },
};
fs.writeFileSync(path.join(root, "spec", "final-ceremony.json"), JSON.stringify(manifest, null, 2) + "\n");
// the working artifacts the rest of the toolchain reads
fs.mkdirSync(A("build"), { recursive: true });
fs.copyFileSync(finalZkey, A("build", "ballot_validity_final.zkey"));
fs.writeFileSync(A("build", "verification_key.json"), vkText);
fs.rmSync(WORK, { recursive: true, force: true }); // every intermediate zkey and the compile output
log("done:", JSON.stringify({ finalZkeySha256: finalHash, verificationKeySha256: vkHash, solidityVerifierSha256: manifest.artifacts.solidityVerifierSha256 }));
process.exit(0);
