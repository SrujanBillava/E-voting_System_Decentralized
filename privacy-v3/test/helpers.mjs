import fs from "node:fs";
import path from "node:path";
import { validityArtifacts, semaphoreArtifacts, ROOT } from "../src/artifacts.js";
import { ballotHash, encryptVector, validityCircuitInput } from "../src/ballot.js";
import { calculateWitness } from "../src/validity.js";
import { TEST_CONTEXT, constituencyField } from "../src/params.js";

export const ctx = TEST_CONTEXT;
export const BLR = constituencyField("KA-BLR");

export const artifactsPresent = [validityArtifacts.wasm, validityArtifacts.zkey, validityArtifacts.vkey, semaphoreArtifacts(3).wasm, semaphoreArtifacts(3).zkey].every((f) => fs.existsSync(f));
export const SKIP_NO_ARTIFACTS = artifactsPresent ? false : "build artifacts missing: run `npm run build:circuit`";

const circuitSource = fs.readFileSync(path.join(ROOT, "circuits", "ballot_validity.circom"), "utf8").split("\n");

/** A circuit input for a (possibly MALICIOUS) vector m: slots j < kc get real encryptions of whatever m[j] is. */
export function witnessInput({ H, kc, m, nullifier = 7n, constituencyId = BLR, tweak }) {
  const { ciphertexts, r } = encryptVector({ H, kc, m });
  const input = validityCircuitInput({ ctx, constituencyId, kc, H, nullifier, ciphertexts, m, r });
  tweak?.(input, { ciphertexts, r });
  return { input, ciphertexts, r, hash: ballotHash(ctx, constituencyId, ciphertexts) };
}

/**
 * Runs the circuit's witness calculator. Returns { ok: true } when every constraint holds, or { ok: false, line, rule } where `rule`
 * is the source line of the constraint that failed (circom reports it), so a test can prove it failed for the INTENDED reason.
 */
export async function tryWitness(input) {
  try {
    await calculateWitness(input);
    return { ok: true };
  } catch (err) {
    const text = String(err?.message ?? err);
    // circom reports a call trace: the violated constraint first, then the templates that contain it. Frames inside our own file carry a source line.
    const frames = [...text.matchAll(/template (\w+?)_\d+ line: (\d+)/g)].map(([, template, line]) => ({
      template,
      line: Number(line),
      source: ["BallotValidity", "ElGamalSlot"].includes(template) ? circuitSource[Number(line) - 1].trim() : null,
    }));
    const first = frames.find((f) => f.source);
    return { ok: false, line: first?.line ?? null, rule: first?.source ?? null, frames, text };
  }
}

export const vec = (ones, extra = {}) => Array.from({ length: 16 }, (_, j) => BigInt(extra[j] ?? (ones.includes(j) ? 1 : 0)));
