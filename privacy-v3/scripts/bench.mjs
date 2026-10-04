// Benchmarks the ballot-validity circuit (and Semaphore) for kc = 2, 8, 16. Every kc runs in its own process so peak memory is per run.
//   node scripts/bench.mjs                 parent: runs the three children and writes results/bench.json
//   node scripts/bench.mjs --child <kc> <warmIterations>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const round = (n) => Math.round(n * 10) / 10;

if (process.argv[2] === "--child") {
  const kc = Number(process.argv[3]);
  const warm = Number(process.argv[4] ?? 5);
  const snarkjs = await import("snarkjs");
  const { semaphoreArtifacts } = await import("../src/artifacts.js");
  const { semaphoreHash } = await import("../src/semaphore.js");
  const { generateTestKeyPair } = await import("../src/elgamal.js");
  const { makeGroup, proveMembership, verifyMembership } = await import("../src/semaphore.js");
  const { fakeVoter } = await import("../testing/fake-voters.js");
  const { prepareBallot, wireCiphertexts } = await import("../src/voter.js");
  const { proveValidity, verifyValidity, shutdownProver } = await import("../src/validity.js");
  const { validityCircuitInput } = await import("../src/ballot.js");
  const { BallotBox } = await import("../src/ballotbox.js");
  const { TEST_CONTEXT, SEMAPHORE_DEPTH } = await import("../src/params.js");
  const ctx = TEST_CONTEXT;

  const { publicKey: H } = generateTestKeyPair();
  const voters = [1, 2, 3, 4, 5].map((i) => fakeVoter(`bench-${i}`));
  const group = makeGroup(voters);
  const rows = [];
  let constraints = null;
  for (let it = 0; it <= warm; it++) {
    const identity = voters[it % voters.length];
    const b = prepareBallot({ identity, ctx, constituency: "KA-BLR", kc, choice: it % kc, H });
    const input = validityCircuitInput({ kc, H, nullifier: b.nullifier, ciphertexts: b.ciphertexts, m: b.m, r: b.r });
    const validity = await proveValidity(input);
    let t = performance.now();
    const ok = await verifyValidity(validity.proof, validity.publicSignals);
    const verifyMs = performance.now() - t;
    if (!ok) throw new Error("benchmark proof did not verify");
    t = performance.now();
    const sem = await proveMembership({ identity, group, message: b.hash, scope: b.scope });
    const semProveMs = performance.now() - t;
    t = performance.now();
    if (!(await verifyMembership(sem))) throw new Error("semaphore proof did not verify");
    const semVerifyMs = performance.now() - t;
    // the same Semaphore statement proven without worker threads (Semaphore's own generateProof always uses the default thread pool)
    let semProveSingleMs = null;
    if (process.env.V3_SINGLE_THREAD) {
      const mp = group.generateMerkleProof(group.indexOf(identity.commitment));
      const a = semaphoreArtifacts(SEMAPHORE_DEPTH);
      const siblings = [...mp.siblings, ...Array(SEMAPHORE_DEPTH - mp.siblings.length).fill(0n)];
      t = performance.now();
      await snarkjs.groth16.fullProve({ secret: identity.secretScalar, merkleProofLength: mp.siblings.length, merkleProofIndex: mp.index, merkleProofSiblings: siblings, scope: semaphoreHash(b.scope), message: semaphoreHash(b.hash) }, a.wasm, a.zkey, undefined, undefined, { singleThread: true });
      semProveSingleMs = performance.now() - t;
    }
    // full server-side check of a complete submission (hash, shape, both pairings, binding, nullifier)
    const box = new BallotBox({ ctx, publicKey: H, constituencies: { "KA-BLR": { kc, group } } });
    const submission = JSON.parse(JSON.stringify({ constituency: "KA-BLR", ciphertexts: wireCiphertexts(b.ciphertexts, kc), semaphore: sem, validity: { proof: validity.proof } }));
    t = performance.now();
    const res = await box.submit(submission);
    const submitMs = performance.now() - t;
    if (!res.accepted) throw new Error(`benchmark submission rejected: ${res.reason}`);
    rows.push({ cold: it === 0, semaphoreProveSingleMs: semProveSingleMs ?? 0, encryptMs: b.encryptMs, witnessMs: validity.timings.witnessMs, proveMs: validity.timings.proveMs, verifyMs, semaphoreProveMs: semProveMs, semaphoreVerifyMs: semVerifyMs, boxSubmitMs: submitMs });
  }
  const usage = process.resourceUsage();
  await shutdownProver();
  console.log(JSON.stringify({ kc, rows, peakRssMiB: round(usage.maxRSS / 1024), constraints }));
  process.exit(0);
}

// ---------------------------------------------------------------- parent
const WARM = Number(process.env.BENCH_WARM ?? 5);
const KCS = (process.env.BENCH_KC ?? "2,8,16").split(",").map(Number);
const info = JSON.parse(fs.readFileSync(path.join(root, "artifacts", "build", "build-info.json"), "utf8"));
const results = [];
for (const kc of KCS) {
  console.error(`[bench] kc=${kc} (1 cold + ${WARM} warm iterations) ...`);
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--child", String(kc), String(WARM)], { encoding: "utf8", maxBuffer: 1 << 26 });
  const run = JSON.parse(out.trim().split("\n").pop());
  const warm = run.rows.filter((r) => !r.cold);
  const cold = run.rows.find((r) => r.cold);
  const stat = (key) => ({ cold: round(cold[key]), median: round(median(warm.map((r) => r[key]))), min: round(Math.min(...warm.map((r) => r[key]))), max: round(Math.max(...warm.map((r) => r[key]))) });
  results.push({
    kc,
    peakRssMiB: run.peakRssMiB,
    ms: {
      encrypt: stat("encryptMs"),
      validityWitness: stat("witnessMs"),
      validityProve: stat("proveMs"),
      validityVerify: stat("verifyMs"),
      semaphoreProve: stat("semaphoreProveMs"),
      ...(process.env.V3_SINGLE_THREAD ? { semaphoreProveSingleThread: stat("semaphoreProveSingleMs") } : {}),
      semaphoreVerify: stat("semaphoreVerifyMs"),
      boxSubmit: stat("boxSubmitMs"),
    },
  });
}
const cpus = os.cpus();
const single = Boolean(process.env.V3_SINGLE_THREAD);
const report = {
  singleThread: single,
  measuredAt: new Date().toISOString(),
  machine: { cpu: cpus[0].model, logicalCores: cpus.length, ramGiB: round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}`, node: process.version },
  setup: { warmIterations: WARM, note: "validity proving = snarkjs 0.7.5 groth16.prove on the zkey (multi-threaded WASM); witness = circom WASM witness calculator; all times in ms; browser/WASM-in-page timing not measured here" },
  circuit: info.circuit,
  sizesMiB: info.sizesMiB,
  results,
};
fs.mkdirSync(path.join(root, "results"), { recursive: true });
fs.writeFileSync(path.join(root, "results", single ? "bench-single-thread.json" : "bench.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
