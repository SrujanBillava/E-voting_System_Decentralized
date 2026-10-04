// Prepares every file the in-browser face pipeline loads, into frontend/public/face/ (git-ignored). Run once per checkout, and again
// whenever the pinned versions below change:
//
//   npm run face:setup           copy + download + verify
//   npm run face:setup -- --check   only report what is missing (exit 1 if anything is)
//
// Why a script and not committed files: the GhostNet weights come from InsightFace training data that is published for
// NON-COMMERCIAL RESEARCH use only, so this repository does not redistribute them. The Human models and the WebAssembly binaries
// are MIT/Apache and come straight from the installed npm packages. Everything is served by VoteChain itself: the browser never
// contacts a CDN, GitHub or any third party.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "face");
const check = process.argv.includes("--check");

// InsightFace GhostNet (strides 1), TensorFlow.js graph model: input [1,112,112,3] RGB 0..1, output 512 numbers.
const GHOSTNET = {
  commit: "c972aafea46d7481273c606cff4c6d5135ae1dc3",
  base: "https://raw.githubusercontent.com/vladmandic/insightface/c972aafea46d7481273c606cff4c6d5135ae1dc3/models",
  files: {
    "insightface-ghostnet-strides1.json": "ece6b0c3c05ee0b1788608bdfee94a48b3005403cc0c158e5ffae1816722e98f",
    "insightface-ghostnet-strides1.bin": "aee0964114004762b75591a6669648ff3b171ae2e54513077c76cf83aefdda5d",
  },
};
// Human: face detector (BlazeFace), 468-point face mesh, iris refinement. Copied from the installed package.
const HUMAN_MODELS = ["blazeface.json", "blazeface.bin", "facemesh.json", "facemesh.bin", "iris.json", "iris.bin"];
// TensorFlow.js WebAssembly backend binaries (version must match the TensorFlow.js inside @vladmandic/human).
const WASM_FILES = ["tfjs-backend-wasm.wasm", "tfjs-backend-wasm-simd.wasm", "tfjs-backend-wasm-threaded-simd.wasm"];

/** Download with a timeout and a few retries (a flaky network should not leave a half-written model). */
async function download(url, name) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      last = err;
      note(`  ${name}: attempt ${attempt} failed (${err?.cause?.code ?? err?.message ?? err})`);
    }
  }
  console.error(`Could not download ${name}: ${last?.cause?.code ?? last?.message ?? last}`);
  process.exit(1);
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const missing = [];
const note = (message) => console.log(message);

function ensure(dir, name, from) {
  const target = path.join(dir, name);
  if (fs.existsSync(target)) return;
  if (check) return missing.push(path.relative(root, target));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(from, target);
  note(`  copied ${path.relative(root, target)}`);
}

const humanModels = path.join(root, "node_modules", "@vladmandic", "human", "models");
const wasmDist = path.join(root, "node_modules", "@tensorflow", "tfjs-backend-wasm", "dist");
if (!check && (!fs.existsSync(humanModels) || !fs.existsSync(wasmDist))) {
  console.error("Run `npm install` first: @vladmandic/human and @tensorflow/tfjs-backend-wasm must be installed.");
  process.exit(1);
}
for (const name of HUMAN_MODELS) ensure(path.join(out, "human"), name, path.join(humanModels, name));
for (const name of WASM_FILES) ensure(path.join(out, "wasm"), name, path.join(wasmDist, name));

const dir = path.join(out, "ghostnet");
for (const [name, expected] of Object.entries(GHOSTNET.files)) {
  const target = path.join(dir, name);
  if (fs.existsSync(target) && sha256(target) === expected) continue;
  if (check) {
    missing.push(path.relative(root, target) + (fs.existsSync(target) ? " (checksum differs)" : ""));
    continue;
  }
  note(`  downloading ${name} (pinned commit ${GHOSTNET.commit.slice(0, 7)})`);
  const bytes = await download(`${GHOSTNET.base}/${name}`, name);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    console.error(`SHA-256 mismatch for ${name}: refusing to install a model that is not the pinned one.`);
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, bytes);
}

if (check) {
  if (missing.length > 0) {
    console.error("Face assets are missing:\n  " + missing.join("\n  ") + "\nRun: npm run face:setup");
    process.exit(1);
  }
  note("Face assets are present and the GhostNet checksums match.");
} else {
  note("Face assets are ready in public/face/ (git-ignored).");
}
