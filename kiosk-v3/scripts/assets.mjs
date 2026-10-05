// Prepares the large, git-ignored files the kiosk serves from its OWN origin (nothing is ever fetched from a third party at run time):
//   public/artifacts/  the four proving artifacts of ../privacy-v3 (copied, and checked against pinned-artifacts.json AND privacy-v3's build-info.json)
//   public/face/       the face models + WebAssembly files, from the V2 frontend's prepared assets (`npm run face:setup` there). They carry non-commercial research
//                      licences, so this repository does not redistribute them.
//   node scripts/assets.mjs            copy + verify
//   node scripts/assets.mjs --check    only report (exit 1 if anything is missing or wrong)
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const pins = JSON.parse(fs.readFileSync(path.join(root, "pinned-artifacts.json"), "utf8")).files;
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const problems = [];

const privacy = path.resolve(root, "..", "privacy-v3", "artifacts");
const sources = {
  "ballot_validity.wasm": path.join(privacy, "build", "ballot_validity_js", "ballot_validity.wasm"),
  "ballot_validity_final.zkey": path.join(privacy, "build", "ballot_validity_final.zkey"),
  "semaphore-20.wasm": path.join(privacy, "semaphore", "semaphore-20.wasm"),
  "semaphore-20.zkey": path.join(privacy, "semaphore", "semaphore-20.zkey"),
};
// the pins must also be exactly what the FINAL ceremony manifest says the browser bundles
const ceremonyFile = path.join(privacy, "..", "spec", "final-ceremony.json");
if (!fs.existsSync(ceremonyFile)) problems.push("privacy-v3/spec/final-ceremony.json is missing");
else {
  const browser = JSON.parse(fs.readFileSync(ceremonyFile, "utf8")).browser;
  if (browser.provingZkeySha256 !== pins["ballot_validity_final.zkey"]) problems.push("pinned-artifacts.json: the ballot-validity zkey pin is not the final ceremony's");
  if (browser.witnessWasmSha256 !== pins["ballot_validity.wasm"]) problems.push("pinned-artifacts.json: the ballot-validity wasm pin is not the final ceremony's");
}
const buildInfo = fs.existsSync(path.join(privacy, "build", "build-info.json")) ? JSON.parse(fs.readFileSync(path.join(privacy, "build", "build-info.json"), "utf8")).sha256 : null;
const buildInfoKey = { "ballot_validity.wasm": "wasm", "ballot_validity_final.zkey": "zkey" };

const outDir = path.join(root, "public", "artifacts");
fs.mkdirSync(outDir, { recursive: true });
for (const [name, source] of Object.entries(sources)) {
  if (!fs.existsSync(source)) {
    problems.push(`missing ${path.relative(root, source)} (run "npm run build:circuit" in ../privacy-v3)`);
    continue;
  }
  const hash = sha256(source);
  if (hash !== pins[name]) problems.push(`${name}: the artifact in ../privacy-v3 is not the pinned one (${hash})`);
  const recorded = buildInfo?.[buildInfoKey[name] ?? name.replace(".wasm", ".wasm")];
  if (recorded && recorded !== hash) problems.push(`${name}: differs from privacy-v3's own build-info.json`);
  const target = path.join(outDir, name);
  if (!check && (!fs.existsSync(target) || sha256(target) !== hash)) fs.copyFileSync(source, target);
  if (!fs.existsSync(target) || sha256(target) !== pins[name]) problems.push(`public/artifacts/${name} is missing or not the pinned file`);
}

const faceSource = path.resolve(root, "..", "frontend", "public", "face");
const faceOut = path.join(root, "public", "face");
const GHOSTNET = { "ghostnet/insightface-ghostnet-strides1.json": "ece6b0c3c05ee0b1788608bdfee94a48b3005403cc0c158e5ffae1816722e98f", "ghostnet/insightface-ghostnet-strides1.bin": "aee0964114004762b75591a6669648ff3b171ae2e54513077c76cf83aefdda5d" };
if (!fs.existsSync(faceSource)) {
  problems.push('the face assets are missing: run "npm run face:setup" in ../frontend first (they are not redistributed)');
} else {
  const copyTree = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const f = path.join(from, entry.name);
      const t = path.join(to, entry.name);
      if (entry.isDirectory()) {
        if (!check) fs.mkdirSync(t, { recursive: true });
        copyTree(f, t);
      } else if (!check && (!fs.existsSync(t) || fs.statSync(t).size !== fs.statSync(f).size)) fs.copyFileSync(f, t);
    }
  };
  fs.mkdirSync(faceOut, { recursive: true });
  copyTree(faceSource, faceOut);
  for (const [file, hash] of Object.entries(GHOSTNET)) {
    const target = path.join(faceOut, file);
    if (!fs.existsSync(target) || sha256(target) !== hash) problems.push(`public/face/${file} is missing or not the pinned model`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("proving artifacts and face assets are in place and verified");
