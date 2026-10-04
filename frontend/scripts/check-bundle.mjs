// Scans the PRODUCTION build (dist/) for things that must never ship, and checks the biometric code is split out:
//   npm run build && npm run check:bundle
// Exit code 1 on any finding.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (!fs.existsSync(dist)) {
  console.error("dist/ not found: run `npm run build` first.");
  process.exit(1);
}
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);
const text = files.filter((f) => /\.(js|css|html|json|svg)$/.test(f)).map((f) => ({ f, s: fs.readFileSync(f, "utf8") }));
const problems = [];

// 1) secrets and test-only machinery
const FORBIDDEN = [
  ["secret variable name", /FACE_TEMPLATE_ENCRYPTION_KEY|NULLIFIER_SECRET|JWT_ACCESS_SECRET|ADMIN_TOTP_ENCRYPTION_KEY|PRIVATE_KEY/],
  ["test-only face engine", /__E2E_FACE__|e2e-fake|E2EFaceEngine|VITE_E2E_FACE/],
  ["MetaMask / ethers", /window\.ethereum|MetaMask/i],
  ["a face-bypass control", /skip\s*face|force\s*verified|demo\s*verif|verify\s*anyway/i],
  ["64-hex secret-looking value", /["'`](0x)?[0-9a-f]{64}["'`]/],
  ["long numeric array (a face descriptor?)", /\[(?:-?\d\.\d{5,},){60,}/],
];
for (const [label, re] of FORBIDDEN) for (const { f, s } of text) if (re.test(s)) problems.push(`${label} in ${path.relative(dist, f)}`);

// 2) the face models are NOT committed or copied by the build unless face:setup was run; but no model weights may be inlined in JS
for (const { f, s } of text) if (/insightface-ghostnet.*\.bin/.test(s) === false && s.length > 5_000_000) problems.push(`unexpectedly large text asset ${path.relative(dist, f)}`);

// 3) lazy loading: the entry bundle must not contain Human / TensorFlow.js
const index = files.filter((f) => /assets[\\/]index-.*\.js$/.test(f));
for (const f of index) {
  const s = fs.readFileSync(f, "utf8");
  if (/registerBackend|WEBGL_VERSION|tfjs-backend|BlazeFace|blazeface/.test(s)) problems.push(`biometric/TensorFlow code in the ENTRY bundle ${path.relative(dist, f)}`);
}
const heavy = text.filter(({ s }) => /registerBackend/.test(s)).map(({ f }) => path.relative(dist, f));
if (heavy.length === 0) problems.push("no lazy chunk with the face engine was found (is the biometric code included?)");
else console.log("face engine lives only in lazy chunk(s):", heavy.join(", "));

if (problems.length) {
  console.error("Bundle check FAILED:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log("Bundle check passed: no secrets, no test-only face engine, face code is lazy-loaded.");
