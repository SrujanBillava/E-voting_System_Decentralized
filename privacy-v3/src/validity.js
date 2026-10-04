// Groth16 ballot-validity proofs (snarkjs). Witness generation and proving are timed separately.
import fs from "node:fs";
import * as snarkjs from "snarkjs";
import { requireArtifacts, validityArtifacts } from "./artifacts.js";

/** V3_SINGLE_THREAD=1 runs the prover without worker threads (a stand-in for a small kiosk / one browser worker). Benchmarks only. */
const proverOptions = process.env.V3_SINGLE_THREAD ? { singleThread: true } : undefined;

let vkeyCache;
const vkey = () => (vkeyCache ??= JSON.parse(fs.readFileSync(validityArtifacts.vkey, "utf8")));

/**
 * @returns {{ proof: object, publicSignals: string[], timings: { witnessMs: number, proveMs: number } }}
 * Throws (from the circuit's own constraint checks) when the witness violates the circuit, e.g. a two-hot ballot.
 */
export async function proveValidity(input) {
  requireArtifacts(validityArtifacts.wasm, validityArtifacts.zkey);
  const wtns = { type: "mem" };
  let t = performance.now();
  await snarkjs.wtns.calculate(input, validityArtifacts.wasm, wtns);
  const witnessMs = performance.now() - t;
  t = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.prove(validityArtifacts.zkey, wtns, undefined, proverOptions);
  return { proof, publicSignals, timings: { witnessMs, proveMs: performance.now() - t } };
}

/** Witness generation only (used by the negative tests: a violated constraint makes this throw). */
export async function calculateWitness(input) {
  requireArtifacts(validityArtifacts.wasm);
  const wtns = { type: "mem" };
  await snarkjs.wtns.calculate(input, validityArtifacts.wasm, wtns);
  return wtns;
}

/** False for a wrong proof, wrong public signals or a malformed proof object (never throws). */
export async function verifyValidity(proof, publicSignals) {
  try {
    return (await snarkjs.groth16.verify(vkey(), publicSignals, proof)) === true;
  } catch {
    return false;
  }
}

/** snarkjs keeps worker threads alive; call this when a process should be able to exit. */
export async function shutdownProver() {
  await globalThis.curve_bn128?.terminate?.();
}
