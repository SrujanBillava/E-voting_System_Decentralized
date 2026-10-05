// The FINAL PROTOTYPE / RESEARCH Groth16 ceremony: the artifacts on disk are the ones the manifest describes, the circuit did not change, the zkey is a valid phase-2
// zkey of THAT circuit, real proofs for K_c = 2, 8 and 16 verify with the final key, and the old test setup's proof does not.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import * as snarkjs from "snarkjs";
import { ROOT, validityArtifacts } from "../src/artifacts.js";
import { oneHot, validityPublicSignals } from "../src/ballot.js";
import { generateTestKeyPair } from "../src/elgamal.js";
import { FIELD_PRIME } from "../src/params.js";
import { proveValidity, shutdownProver, verifyValidity } from "../src/validity.js";
import { PINS } from "../scripts/ceremony-pins.mjs";
import { verifyWithKey } from "../testing/groth16.js";
import { SKIP_NO_ARTIFACTS, witnessInput } from "./helpers.mjs";

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const at = (...p) => path.join(ROOT, ...p);
const manifest = JSON.parse(fs.readFileSync(at("spec", "final-ceremony.json"), "utf8"));
const oldProof = JSON.parse(fs.readFileSync(at("spec", "old-test-proof.json"), "utf8"));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
after(shutdownProver);

describe("final ceremony: manifest and committed artifacts", () => {
  it("is labelled honestly and records a three-contribution phase 2 plus a public beacon, without any entropy", () => {
    assert.equal(manifest.label, "FINAL PROTOTYPE / RESEARCH CEREMONY");
    assert.match(manifest.trustStatement, /ONE development machine/);
    assert.match(manifest.trustStatement, /NOT an independently governed/);
    assert.equal(manifest.phase2.contributions, 3);
    assert.deepEqual(manifest.phase2.entries.map((e) => e.name), ["prototype-contribution-1", "prototype-contribution-2", "prototype-contribution-3", "final-beacon"]);
    assert.equal(new Set(manifest.phase2.entries.map((e) => e.contributionHash)).size, 4, "every contribution is distinct");
    assert.match(manifest.phase2.beacon.randomness, /^[0-9a-f]{64}$/);
    assert.equal(manifest.phase2.beacon.chainHash, "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971");
    assert.deepEqual(Object.keys(manifest.phase2).sort(), ["beacon", "circuitHash", "contributions", "entries", "entropy", "verification"], "no field that could hold entropy");
    assert.match(manifest.phase2.entropy, /never logged, stored or passed on a command line/);
  });

  it("the committed zkey and verification key are exactly the manifest's; the browser files are the same; none is the old test setup", () => {
    assert.equal(sha256(at("ceremony", "ballot_validity_final.zkey")), manifest.artifacts.finalZkeySha256);
    assert.equal(sha256(at("spec", "verification_key.json")), manifest.artifacts.verificationKeySha256);
    assert.equal(manifest.browser.provingZkeySha256, manifest.artifacts.finalZkeySha256);
    assert.equal(manifest.browser.witnessWasmSha256, manifest.artifacts.witnessWasmSha256);
    assert.notEqual(manifest.artifacts.finalZkeySha256, PINS.previousTestZkeySha256, "not byte-identical to the previous TEST zkey");
    assert.notEqual(manifest.artifacts.verificationKeySha256, PINS.previousTestVerificationKeySha256);
    assert.equal(oldProof.oldTestZkeySha256, PINS.previousTestZkeySha256);
    const record = JSON.parse(fs.readFileSync(at("results", "build-info.json"), "utf8"));
    assert.equal(record.sha256.zkey, manifest.artifacts.finalZkeySha256);
    assert.equal(record.sha256.verificationKey, manifest.artifacts.verificationKeySha256);
    assert.match(record.setupNote, /FINAL PROTOTYPE \/ RESEARCH CEREMONY/);
    const vk = JSON.parse(fs.readFileSync(at("spec", "verification_key.json"), "utf8"));
    assert.deepEqual([vk.protocol, vk.curve, vk.nPublic, vk.IC.length], ["groth16", "bn128", 68, 69]);
  });

  it("the CIRCUIT is the frozen milestone's: source hash, constraint count, public signals, the pinned phase-1 file and toolchain versions", () => {
    assert.equal(sha256(at("circuits", "ballot_validity.circom")), PINS.circuitSourceSha256);
    assert.equal(manifest.circuit.sourceSha256, PINS.circuitSourceSha256);
    assert.deepEqual([manifest.circuit.constraints, manifest.circuit.publicSignals, manifest.circuit.publicOutputs, manifest.circuit.kMax], [49136, 68, 0, 16]);
    assert.equal(manifest.artifacts.r1csSha256, PINS.r1csSha256);
    assert.equal(manifest.artifacts.witnessWasmSha256, PINS.wasmSha256);
    assert.equal(manifest.phase1.sha256, PINS.ptau.sha256);
    assert.equal(manifest.phase1.file, "ppot_0080_18.ptau");
    assert.equal(manifest.toolchain.snarkjs, "0.7.5");
    assert.equal(manifest.toolchain.circom, "circom compiler 2.2.3");
  });

  it("build-circuit.mjs can no longer MAKE a setup: it only provisions and hash-checks the committed final one; the contribution script keeps its entropy in memory only", () => {
    const build = fs.readFileSync(at("scripts", "build-circuit.mjs"), "utf8");
    assert.ok(!/zKey\.(newZKey|contribute|beacon)|randomBytes/.test(build.replace(/\/\/.*$/gm, "")), "no setup, no contribution, no entropy in the build script");
    const contribute = fs.readFileSync(at("scripts", "ceremony-contribute.mjs"), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(contribute.includes("randomBytes(64)"));
    assert.ok(!/console\.(log|info|debug)|writeFile|process\.argv\[[^2-5]\]/.test(contribute), "the entropy is neither printed nor written");
    assert.ok(!/entropy\s*=\s*["'`]/.test(contribute), "nothing is hard-coded");
  });
});

describe("final ceremony: the artifacts in use", { skip: SKIP_NO_ARTIFACTS }, () => {
  it("the working artifacts ARE the final ones (build-circuit.mjs provisioned them): zkey, verification key, R1CS, witness wasm", () => {
    assert.equal(sha256(validityArtifacts.zkey), manifest.artifacts.finalZkeySha256);
    assert.equal(sha256(validityArtifacts.vkey), manifest.artifacts.verificationKeySha256);
    assert.equal(sha256(validityArtifacts.r1cs), manifest.artifacts.r1csSha256);
    assert.equal(sha256(validityArtifacts.wasm), manifest.artifacts.witnessWasmSha256);
  });

  it("snarkjs verifies the final zkey against the R1CS and the pinned Phase-1 ptau, with 3 contributions and the beacon in it (about 20 s)", { skip: !fs.existsSync(at("artifacts", "ptau", PINS.ptau.file)) && "ptau not downloaded" }, async () => {
    assert.equal(sha256(at("artifacts", "ptau", PINS.ptau.file)), PINS.ptau.sha256);
    const lines = [];
    const ok = await snarkjs.zKey.verifyFromR1cs(validityArtifacts.r1cs, at("artifacts", "ptau", PINS.ptau.file), validityArtifacts.zkey, { ...quiet, info: (m) => lines.push(String(m)) });
    assert.equal(ok, true);
    assert.equal(lines.filter((l) => /^contribution #/.test(l)).length, 4);
    assert.ok(lines.some((l) => l.startsWith("Beacon generator: " + manifest.phase2.beacon.randomness)), "the recorded public beacon is the one applied");
    const info = await snarkjs.r1cs.info(validityArtifacts.r1cs, quiet);
    assert.deepEqual([info.nConstraints, info.nPubInputs, info.nOutputs], [49136, 68, 0]);
  });

  for (const kc of [2, 8, 16]) {
    it(`K_c = ${kc}: a fresh real ballot proves with the FINAL zkey (68 real public signals) and verifies; tampering with the statement does not`, async () => {
      const { publicKey: H } = generateTestKeyPair();
      const nullifier = BigInt(`0x${createHash("sha256").update(`final-ceremony:${kc}`).digest("hex")}`) % FIELD_PRIME;
      const { input, ciphertexts } = witnessInput({ H, kc, m: oneHot(kc - 1, kc), nullifier });
      const { proof, publicSignals } = await proveValidity(input);
      assert.deepEqual(publicSignals, validityPublicSignals({ kc, H, nullifier, ciphertexts }));
      assert.equal(publicSignals.length, 68);
      assert.equal(await verifyValidity(proof, publicSignals), true);
      assert.equal(await verifyWithKey(JSON.parse(fs.readFileSync(at("spec", "verification_key.json"), "utf8")), publicSignals, proof), true, "also with the committed key");
      const bump = (i, by = 1n) => publicSignals.map((s, j) => (j === i ? (BigInt(s) + by).toString() : s));
      for (const [name, i] of [["nullifier", 0], ["K_c", 1], ["H.x", 2], ["H.y", 3], ["a ciphertext coordinate", 4], ["the last coordinate", 67]]) assert.equal(await verifyValidity(proof, bump(i)), false, `modified ${name}`);
      assert.equal(await verifyValidity(proof, bump(0, FIELD_PRIME)), false, "a non-canonical (>= p) public input is refused");
      assert.equal(await verifyValidity({ ...proof, pi_a: [proof.pi_a[0], (BigInt(proof.pi_a[1]) + 1n).toString(), "1"] }, publicSignals), false, "modified proof");
      assert.equal(await verifyValidity(proof, publicSignals.slice(0, 67)), false, "67 public signals");
    });
  }

  it("a proof made with the OLD test zkey was genuine under the old key and is REFUSED by the final one", async () => {
    assert.equal(await verifyWithKey(oldProof.oldTestVerificationKey, oldProof.publicSignals, oldProof.proof), true);
    assert.equal(await verifyValidity(oldProof.proof, oldProof.publicSignals), false);
  });
});
