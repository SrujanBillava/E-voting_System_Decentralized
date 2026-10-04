// Locations of the (git-ignored) build products. Run `npm run build:circuit` first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const A = (...p) => path.join(ROOT, "artifacts", ...p);

export const validityArtifacts = {
  wasm: A("build", "ballot_validity_js", "ballot_validity.wasm"),
  zkey: A("build", "ballot_validity_final.zkey"),
  vkey: A("build", "verification_key.json"),
  r1cs: A("build", "ballot_validity.r1cs"),
};
export const semaphoreArtifacts = (depth) => ({ wasm: A("semaphore", `semaphore-${depth}.wasm`), zkey: A("semaphore", `semaphore-${depth}.zkey`) });

export function requireArtifacts(...files) {
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`missing build artifacts (run: npm run build:circuit)\n  ${missing.join("\n  ")}`);
}
