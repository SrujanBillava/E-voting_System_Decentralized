// REPRODUCIBLE BUILD CHECK: builds the kiosk twice from the same sources, in two fresh directories, and demands byte-identical output (every file's SHA-256 equal).
// What an auditor does to check that the kiosk a polling station runs is the kiosk the sources produce:  npm run build:verify  ->  compare the printed bundle hash.
//   node scripts/verify-build.mjs
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
const env = { ...process.env };
delete env.VITE_E2E_FACE; // the production build never carries the test engine
const dirs = ["dist-verify-a", "dist-verify-b"].map((d) => path.join(root, d));
const manifests = dirs.map((dir) => {
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync(process.execPath, [vite, "build", "--outDir", dir, "--emptyOutDir"], { cwd: root, env, stdio: "pipe" });
  execFileSync(process.execPath, [path.join(root, "scripts", "check-bundle.mjs"), "--dir", dir], { cwd: root, stdio: "pipe" });
  return JSON.parse(fs.readFileSync(path.join(dir, "build-manifest.json"), "utf8"));
});
const [a, b] = manifests.map((m) => JSON.stringify(m.files));
for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
if (a !== b) {
  const [fa, fb] = manifests.map((m) => m.files);
  const differing = Object.keys(fa).filter((k) => fa[k] !== fb[k]);
  console.error(`NOT REPRODUCIBLE: ${differing.length} file(s) differ: ${differing.join(", ")}`);
  process.exit(1);
}
console.log(`reproducible: two clean builds are byte-identical (${Object.keys(manifests[0].files).length} files); bundle sha256 ${createHash("sha256").update(a).digest("hex")}`);
