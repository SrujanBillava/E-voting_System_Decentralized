// The FINAL PROTOTYPE / RESEARCH Groth16 ceremony's verifier: provenance, real proofs for K_c = 2, 8 and 16 through the verifier and through VoteChainV3's normal path,
// and rejection of everything that must not verify (a proof from the OLD test setup above all).
import { expect } from "chai";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validityPublicSignals } from "../../privacy-v3/src/ballot.js";
import { verifyValidity } from "../../privacy-v3/src/validity.js";
import { verifyWithKey } from "../../privacy-v3/testing/groth16.js";
import { CORE, PROJECT, cid, configure, describeWithProofs, makeBallot, newWorld, register, submit, validityOf, votersOf } from "./helpers/world.js";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const read = (...p) => fs.readFileSync(path.join(CORE, ...p));
const manifest = JSON.parse(read("spec", "final-ceremony.json"));
const meta = JSON.parse(fs.readFileSync(path.join(PROJECT, "contracts", "verifiers", "BallotValidityVerifier.meta.json"), "utf8"));
const sol = fs.readFileSync(path.join(PROJECT, "contracts", "verifiers", "BallotValidityVerifier.sol"), "utf8");
const committedVk = JSON.parse(read("spec", "verification_key.json"));
const oldProof = JSON.parse(read("spec", "old-test-proof.json"));
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const constants = Object.fromEntries([...sol.matchAll(/uint256 constant (\w+)\s*=\s*(\d+);/g)].map(([, name, value]) => [name, value]));

describe("Final prototype ceremony: the committed verifier's provenance", () => {
  it("is labelled for what it is: a FINAL PROTOTYPE / RESEARCH CEREMONY verifier, no longer a TEST one, with the production warning", () => {
    expect(meta.label).to.equal("FINAL PROTOTYPE / RESEARCH CEREMONY VERIFIER");
    expect(manifest.label).to.equal("FINAL PROTOTYPE / RESEARCH CEREMONY");
    expect(JSON.stringify(meta)).to.not.match(/TEST ONLY/);
    expect(meta.setup).to.match(/NOT an independently governed ceremony/);
    expect(manifest.trustStatement).to.match(/NOT an independently governed multi-party ceremony/);
  });

  it("the committed Solidity, the metadata and the ceremony manifest agree byte for byte (zkey, verification key, Solidity)", () => {
    expect(sha256(sol)).to.equal(manifest.artifacts.solidityVerifierSha256);
    expect(meta.solidityVerifierSha256).to.equal(manifest.artifacts.solidityVerifierSha256);
    expect(meta.zkeySha256).to.equal(manifest.artifacts.finalZkeySha256);
    expect(meta.verificationKeySha256).to.equal(manifest.artifacts.verificationKeySha256);
    expect(sha256(read("ceremony", "ballot_validity_final.zkey"))).to.equal(manifest.artifacts.finalZkeySha256);
    expect(sha256(read("spec", "verification_key.json"))).to.equal(manifest.artifacts.verificationKeySha256);
    const record = JSON.parse(read("results", "build-info.json"));
    expect(record.sha256.zkey).to.equal(manifest.artifacts.finalZkeySha256);
    expect(record.sha256.verificationKey).to.equal(manifest.artifacts.verificationKeySha256);
    expect(record.sha256.r1cs).to.equal(manifest.artifacts.r1csSha256);
  });

  it("was generated from the FINAL zkey by the pinned command, unmodified: regenerating it gives the identical file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verifier-"));
    try {
      const out = path.join(tmp, "BallotValidityVerifier.sol");
      execFileSync(process.execPath, [path.join(CORE, "node_modules", "snarkjs", "build", "cli.cjs"), "zkey", "export", "solidityverifier", path.join(CORE, "ceremony", "ballot_validity_final.zkey"), out], { stdio: "ignore" });
      expect(fs.readFileSync(out, "utf8")).to.equal(sol);
      expect(meta.snarkjs).to.equal("0.7.5");
      expect(manifest.toolchain.snarkjs).to.equal("0.7.5");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("embeds exactly the committed final verification key, and expects exactly the 68 frozen public signals", () => {
    expect(committedVk.nPublic).to.equal(68);
    expect(committedVk.IC).to.have.length(69);
    expect(sol).to.include("uint[68] calldata _pubSignals");
    expect(constants.alphax).to.equal(committedVk.vk_alpha_1[0]);
    expect(constants.alphay).to.equal(committedVk.vk_alpha_1[1]);
    for (const [name, point] of [["beta", committedVk.vk_beta_2], ["gamma", committedVk.vk_gamma_2], ["delta", committedVk.vk_delta_2]]) {
      expect(constants[`${name}x1`], `${name}x1`).to.equal(point[0][1]);
      expect(constants[`${name}x2`], `${name}x2`).to.equal(point[0][0]);
      expect(constants[`${name}y1`], `${name}y1`).to.equal(point[1][1]);
      expect(constants[`${name}y2`], `${name}y2`).to.equal(point[1][0]);
    }
    committedVk.IC.forEach((pt, i) => {
      expect(constants[`IC${i}x`], `IC${i}x`).to.equal(pt[0]);
      expect(constants[`IC${i}y`], `IC${i}y`).to.equal(pt[1]);
    });
  });

  it("the CIRCUIT did not change: source, R1CS shape and the bundled witness wasm are the frozen milestone's", () => {
    expect(sha256(read("circuits", "ballot_validity.circom"))).to.equal(manifest.circuit.sourceSha256);
    expect(manifest.circuit).to.include({ constraints: 49136, publicSignals: 68, publicOutputs: 0, kMax: 16 });
    expect(manifest.artifacts.r1csSha256).to.equal("8cf62bd036a2d7c240d98d599eccbfb3f63ee2789fb0d07e13cc6effa67c047a");
    expect(manifest.artifacts.witnessWasmSha256).to.equal("15c7ce50f6efc22759c24e399bf8ed6f16adef881930da466542608e7f51d3df");
  });

  it("is NOT the old test setup: different zkey, different verification key, different delta; alpha, beta, gamma and the IC come from the same Phase 1 and circuit", () => {
    expect(manifest.artifacts.finalZkeySha256).to.not.equal(oldProof.oldTestZkeySha256);
    expect(manifest.artifacts.verificationKeySha256).to.not.equal(oldProof.oldTestVerificationKeySha256);
    const old = oldProof.oldTestVerificationKey;
    expect(JSON.stringify(committedVk.vk_delta_2)).to.not.equal(JSON.stringify(old.vk_delta_2));
    expect(JSON.stringify(committedVk.vk_alpha_1)).to.equal(JSON.stringify(old.vk_alpha_1));
    expect(JSON.stringify(committedVk.vk_beta_2)).to.equal(JSON.stringify(old.vk_beta_2));
    expect(JSON.stringify(committedVk.vk_gamma_2)).to.equal(JSON.stringify(old.vk_gamma_2));
    expect(JSON.stringify(committedVk.IC)).to.equal(JSON.stringify(old.IC));
    expect(manifest.phase2.contributions).to.equal(3);
    expect(manifest.phase2.entries.map((e) => e.name)).to.deep.equal(["prototype-contribution-1", "prototype-contribution-2", "prototype-contribution-3", "final-beacon"]);
    expect(new Set(manifest.phase2.entries.map((e) => e.contributionHash)).size).to.equal(4);
    expect(JSON.stringify(manifest)).to.not.match(/entropy"\s*:\s*"[0-9a-f]{64,}/);
  });
});

describeWithProofs("Final prototype ceremony: real proofs for K_c = 2, 8 and 16", () => {
  let w;
  let key;
  const done = {};
  const CODES = { 2: "C02", 8: "C08", 16: "C16" };

  before(async () => {
    w = await newWorld();
    key = await configure(w, { only: Object.values(CODES) });
    await (await w.vc.openElection()).wait();
    for (const [kc, code] of Object.entries(CODES)) {
      const { voters, group } = votersOf(code);
      await register(w, code, voters);
      const b = await makeBallot(w, { code, voters, group, index: 0, choice: Number(kc) - 1, H: key.H });
      const signals = validityPublicSignals({ kc: Number(kc), H: key.H, nullifier: BigInt(b.submission.semaphore.nullifier), ciphertexts: b.internals.ciphertexts }).map(BigInt);
      done[kc] = { code, b, signals };
    }
  });

  for (const kc of [2, 8, 16]) {
    it(`K_c = ${kc}: a fresh real ballot, proved with the FINAL zkey, verifies off-chain, on the new Solidity verifier, and is recorded by VoteChainV3's normal path`, async () => {
      const { code, b, signals } = done[kc];
      expect(signals).to.have.length(68);
      expect(signals[1]).to.equal(BigInt(kc));
      expect(await verifyValidity(b.submission.validity.proof, signals.map(String)), "off-chain, final verification key").to.equal(true);
      const { a, b: bb, c } = b.args.validity;
      expect(await w.validityVerifier.verifyProof(a, bb, c, signals), "on-chain verifier").to.equal(true);
      const before = (await w.vc.getConstituency(cid(code))).ballots;
      await (await submit(w, b.args)).wait();
      expect((await w.vc.getConstituency(cid(code))).ballots).to.equal(before + 1n);
      expect(await w.vc.nullifierUsed(b.args.membership.nullifier)).to.equal(true);
    });
  }

  describe("the final verifier REJECTS", () => {
    const verify = (v, signals) => w.validityVerifier.verifyProof(v.a, v.b, v.c, signals);

    it("a proof made with the OLD test zkey (genuine under the old key, refused by the final key, off-chain and on-chain)", async () => {
      const signals = oldProof.publicSignals.map(BigInt);
      expect(signals).to.have.length(68);
      expect(await verifyWithKey(oldProof.oldTestVerificationKey, oldProof.publicSignals, oldProof.proof), "the fixture is a genuine proof for the OLD key").to.equal(true);
      expect(await verifyValidity(oldProof.proof, oldProof.publicSignals), "final verification key").to.equal(false);
      expect(await verify(validityOf(oldProof.proof), signals), "final Solidity verifier").to.equal(false);
    });

    it("a modified proof, a modified nullifier, K_c, H and ciphertext coordinate (every one of the 68 signals, in fact), on a real K_c = 16 ballot", async () => {
      const { b, signals } = done[16];
      const v = b.args.validity;
      expect(await verify(v, signals)).to.equal(true);
      expect(await verify({ a: [v.a[0] + 1n, v.a[1]], b: v.b, c: v.c }, signals), "modified A").to.equal(false);
      expect(await verify({ a: v.a, b: v.b, c: [v.c[0], v.c[1] + 1n] }, signals), "modified C").to.equal(false);
      expect(await verify({ a: v.a, b: [[v.b[0][0] + 1n, v.b[0][1]], v.b[1]], c: v.c }, signals), "modified B").to.equal(false);
      const named = { nullifier: 0, kc: 1, Hx: 2, Hy: 3, "first C1.x": 4, "first C2.y": 7, "last coordinate": 67 };
      for (const [name, i] of Object.entries(named)) {
        const changed = [...signals];
        changed[i] += 1n;
        expect(await verify(v, changed), `modified ${name}`).to.equal(false);
      }
      for (let i = 0; i < 68; i++) {
        const changed = [...signals];
        changed[i] += 1n;
        expect(await verify(v, changed), `signal ${i} + 1`).to.equal(false);
      }
    });

    it("a malformed or non-field public input: a signal equal to or above the field prime is refused, not reduced, at the first, middle and last position and at 2^256 - 1", async () => {
      const { b, signals } = done[8];
      const v = b.args.validity;
      for (const i of [0, 1, 2, 3, 35, 67]) {
        for (const bad of [signals[i] + P, P, (1n << 256n) - 1n]) {
          const changed = [...signals];
          changed[i] = bad;
          expect(await verify(v, changed), `signal ${i} = ${bad === P ? "p" : bad > P * 2n ? "2^256-1" : "s+p"}`).to.equal(false);
        }
      }
    });

    it("a proof of one K_c replayed for another, and the proof of another ballot", async () => {
      expect(await verify(done[2].b.args.validity, done[8].signals)).to.equal(false);
      expect(await verify(done[8].b.args.validity, done[16].signals)).to.equal(false);
      expect(await verify(done[16].b.args.validity, done[2].signals)).to.equal(false);
    });
  });
});
