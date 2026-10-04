// The Groth16 verifier snarkjs generated from the frozen 68-public-signal ballot-validity circuit, used UNMODIFIED.
import { expect } from "chai";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validityPublicSignals, padCiphertexts } from "../../privacy-v3/src/ballot.js";
import { generateTestKeyPair } from "../../privacy-v3/src/elgamal.js";
import { validityArtifacts } from "../../privacy-v3/src/artifacts.js";
import { CORE, PROJECT, describeWithProofs, makeBallot, newWorld, votersOf } from "./helpers/world.js";

const verifierDir = path.join(PROJECT, "contracts", "verifiers");
const sol = fs.readFileSync(path.join(verifierDir, "BallotValidityVerifier.sol"), "utf8");
const meta = JSON.parse(fs.readFileSync(path.join(verifierDir, "BallotValidityVerifier.meta.json"), "utf8"));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const constants = Object.fromEntries([...sol.matchAll(/uint256 constant (\w+)\s*=\s*(\d+);/g)].map(([, name, value]) => [name, value]));

describe("Ballot-validity verifier: provenance", () => {
  it("is exactly what snarkjs emitted (SHA-256 recorded at generation), for 68 public signals", () => {
    expect(sha256(sol)).to.equal(meta.solidityVerifierSha256);
    expect(meta.publicSignals).to.equal(68);
    expect(sol).to.include("uint[68] calldata _pubSignals");
    expect(sol).to.match(/contract Groth16Verifier \{/);
    expect(meta.snarkjs).to.equal("0.7.5");
    expect(sol, "an unmodified snarkjs export keeps its own generated-file header").to.include("This file is generated with [snarkJS]");
  });

  it("belongs to the COMMITTED build record: the verification-key and zkey hashes equal privacy-v3/results/build-info.json", () => {
    const record = JSON.parse(fs.readFileSync(path.join(CORE, "results", "build-info.json"), "utf8"));
    expect(meta.verificationKeySha256).to.equal(record.sha256.verificationKey);
    expect(meta.zkeySha256).to.equal(record.sha256.zkey);
    expect(record.circuit.publicInputs).to.equal(68);
    expect(record.circuit.publicOutputs).to.equal(0);
  });

  it("its embedded verification key equals the verification key of the local artifacts (run `npm run export:verifier` if you rebuilt the circuit)", function () {
    if (!fs.existsSync(validityArtifacts.vkey)) return this.skip();
    const raw = fs.readFileSync(validityArtifacts.vkey);
    expect(sha256(raw), "local artifacts were rebuilt: the verification key changed, regenerate the verifier with `npm run export:verifier`").to.equal(meta.verificationKeySha256);
    const vk = JSON.parse(raw);
    expect(vk.nPublic).to.equal(68);
    expect(vk.IC).to.have.length(69);
    expect(constants.alphax).to.equal(vk.vk_alpha_1[0]);
    expect(constants.alphay).to.equal(vk.vk_alpha_1[1]);
    for (const [name, point] of [["beta", vk.vk_beta_2], ["gamma", vk.vk_gamma_2], ["delta", vk.vk_delta_2]]) {
      expect(constants[`${name}x1`], `${name}x1`).to.equal(point[0][1]);
      expect(constants[`${name}x2`], `${name}x2`).to.equal(point[0][0]);
      expect(constants[`${name}y1`], `${name}y1`).to.equal(point[1][1]);
      expect(constants[`${name}y2`], `${name}y2`).to.equal(point[1][0]);
    }
    vk.IC.forEach((p, i) => {
      expect(constants[`IC${i}x`], `IC${i}x`).to.equal(p[0]);
      expect(constants[`IC${i}y`], `IC${i}y`).to.equal(p[1]);
    });
  });
});

describeWithProofs("Ballot-validity verifier: on-chain verification of real proofs", () => {
  let w;
  let b;
  let signals;
  const call = (a, bb, c, s) => w.validityVerifier.verifyProof(a, bb, c, s);

  before(async () => {
    w = await newWorld();
    const { voters, group } = votersOf("KA-BLR");
    const { publicKey: H } = generateTestKeyPair();
    b = await makeBallot(w, { code: "KA-BLR", voters, group, index: 0, choice: 1, H });
    signals = validityPublicSignals({ kc: 3, H, nullifier: BigInt(b.submission.semaphore.nullifier), ciphertexts: b.internals.ciphertexts }).map(BigInt);
  });

  it("a real validity proof verifies on-chain for the 68 public signals [nullifier, kc, H.x, H.y, 64 coordinates]", async () => {
    expect(signals).to.have.length(68);
    expect(await call(b.args.validity.a, b.args.validity.b, b.args.validity.c, signals)).to.equal(true);
  });

  it("changing ANY ONE of the 68 public signals makes it fail on-chain (no signal is unconstrained)", async () => {
    for (let i = 0; i < 68; i++) {
      const changed = [...signals];
      changed[i] = changed[i] + 1n;
      expect(await call(b.args.validity.a, b.args.validity.b, b.args.validity.c, changed), `signal ${i} + 1`).to.equal(false);
    }
  });

  it("a signal that is not a field element is refused, not reduced", async () => {
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const changed = [...signals];
    changed[0] = signals[0] + P; // same residue, non-canonical
    expect(await call(b.args.validity.a, b.args.validity.b, b.args.validity.c, changed)).to.equal(false);
  });

  it("malformed or modified proofs fail: wrong A, B or C elements, swapped B halves, zero proof, proof of another statement", async () => {
    const v = b.args.validity;
    expect(await call([v.a[0] + 1n, v.a[1]], v.b, v.c, signals)).to.equal(false);
    expect(await call(v.a, [[v.b[0][0] + 1n, v.b[0][1]], v.b[1]], v.c, signals)).to.equal(false);
    expect(await call(v.a, v.b, [v.c[0], v.c[1] + 1n], signals)).to.equal(false);
    expect(await call(v.a, [[v.b[0][1], v.b[0][0]], [v.b[1][1], v.b[1][0]]], v.c, signals), "B in snarkjs order instead of the Solidity order").to.equal(false);
    expect(await call([0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n], signals)).to.equal(false);
    const { voters, group } = votersOf("KA-BLR");
    const other = await makeBallot(w, { code: "KA-BLR", voters, group, index: 1, choice: 2, H: generateTestKeyPair().publicKey });
    expect(await call(other.args.validity.a, other.args.validity.b, other.args.validity.c, signals), "another ballot's proof").to.equal(false);
  });

  it("padded slots must be the identity pair: the same proof does not verify for a statement with a different padded coordinate", async () => {
    const changed = [...signals];
    changed[4 + 3 * 4] = 5n; // slot 3 is padding for kc = 3
    expect(await call(b.args.validity.a, b.args.validity.b, b.args.validity.c, changed)).to.equal(false);
    expect(padCiphertexts(b.internals.ciphertexts.slice(0, 3)).length).to.equal(16);
  });
});
