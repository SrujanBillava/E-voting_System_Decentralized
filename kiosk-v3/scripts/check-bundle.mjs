// Proves what a PRODUCTION kiosk build must not contain and must contain, then writes dist/build-manifest.json (SHA-256 of every file) so a build can be pinned and compared.
//   node scripts/check-bundle.mjs [--dir dist] [--no-manifest]
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCsp } from "./csp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const dir = path.resolve(root, arg("--dir", "dist"));
const problems = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(dir).filter((f) => path.basename(f) !== "build-manifest.json");
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const isText = (f) => /\.(html|js|mjs|css|json|svg)$/.test(f);
const text = (f) => fs.readFileSync(f, "utf8");

// 1. nothing test-only, nothing secret
const FORBIDDEN = [
  ["the test face engine", /e2e-fake|__E2E_FACE__|E2EFaceEngine/],
  ["a test biometric hook", /VITE_E2E_FACE|FACE_BYPASS|SKIP_FACE|TEST_BIOMETRIC/i],
  ["a database or service secret", /mongodb(\+srv)?:\/\/|MONGODB_URI|ISSUER_PRIVATE_KEY|RELAYER_PRIVATE_KEY|TEMPLATE_KEY|COOKIE_SECRET|JWT_SECRET/],
];
// the well-known development keys of Hardhat / Anvil (accounts 0-9): they must never be in a build
const DEV_KEYS = [
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", "47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", "8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", "4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", "dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];
for (const f of files.filter(isText)) {
  const t = text(f);
  const rel = path.relative(dir, f);
  for (const [what, re] of FORBIDDEN) if (re.test(t)) problems.push(`${rel} contains ${what}`);
  for (const key of DEV_KEYS) if (t.toLowerCase().includes(key)) problems.push(`${rel} contains a well-known development private key`);
}

// 2. the page: one strict policy, no inline script, no third-party URL
const indexPath = path.join(dir, "index.html");
if (!fs.existsSync(indexPath)) problems.push("index.html is missing");
else {
  const html = text(indexPath);
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
  const origins = /connect-src 'self' ([^;]+)/.exec(meta ?? "")?.[1]?.split(" ") ?? [];
  if (!meta) problems.push("index.html has no Content-Security-Policy");
  else if (origins.length === 0) problems.push("the page's Content-Security-Policy is not the kiosk's policy (it has no connect-src for the configured services)");
  else if (meta !== buildCsp({ identityBase: origins[0], relayBase: origins[1] ?? origins[0], rpcUrl: origins[2] ?? origins[0] }, { meta: true })) problems.push("the page's Content-Security-Policy is not the kiosk's policy");
  if (/'unsafe-inline'|'unsafe-eval'/.test(meta ?? "")) problems.push("the policy allows unsafe-inline or unsafe-eval");
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) problems.push("index.html has an inline script");
  if (/\son[a-z]+\s*=/.test(html.replace(/content="[^"]*"/g, ""))) problems.push("index.html has an inline event handler");
  const external = [...html.matchAll(/(?:src|href)="(https?:)?\/\/[^"]+"/g)].map((m) => m[0]);
  if (external.length > 0) problems.push(`index.html references another origin: ${external.join(", ")}`);
}
// no code or style from a CDN or a remote font, anywhere in the bundle's own references
for (const f of files.filter((x) => /\.(css|html)$/.test(x))) {
  const t = text(f);
  if (/@import\s+url\(\s*['"]?https?:/.test(t) || /url\(\s*['"]?https?:/.test(t)) problems.push(`${path.relative(dir, f)} loads a remote resource`);
}

// 3. the proving artifacts are the pinned ones
const pins = JSON.parse(fs.readFileSync(path.join(root, "pinned-artifacts.json"), "utf8")).files;
for (const [name, hash] of Object.entries(pins)) {
  const f = path.join(dir, "artifacts", name);
  if (!fs.existsSync(f)) problems.push(`artifacts/${name} is missing from the build`);
  else if (sha256(f) !== hash) problems.push(`artifacts/${name} is not the pinned file`);
}
if (!fs.existsSync(path.join(dir, "face", "ghostnet", "insightface-ghostnet-strides1.json"))) problems.push("the face model files are missing from the build");

if (problems.length > 0) {
  console.error(`check-bundle FAILED for ${path.relative(root, dir)}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}

// 4. the manifest: every file's SHA-256 (sorted, no timestamps), so two builds of the same sources can be compared byte for byte
if (!process.argv.includes("--no-manifest")) {
  const manifest = { files: Object.fromEntries(files.map((f) => [path.relative(dir, f), sha256(f)]).sort(([a], [b]) => (a < b ? -1 : 1))), pinnedArtifacts: pins };
  fs.writeFileSync(path.join(dir, "build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const bundleHash = createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex");
  console.log(`bundle OK: ${files.length} files, manifest sha256 ${bundleHash}`);
} else console.log(`bundle OK: ${files.length} files`);
