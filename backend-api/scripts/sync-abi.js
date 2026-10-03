// Copies the generated contract export into the backend (src/chain/generated/Voting.json).
//   node scripts/sync-abi.js          copy
//   node scripts/sync-abi.js --check  exit 1 if the backend copy differs from the contract export
// The contract export is the single source of truth; never edit the backend copy by hand.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(root, "../smart-contract/exports/Voting.json");
const target = path.join(root, "src/chain/generated/Voting.json");
const check = process.argv.includes("--check");

if (!fs.existsSync(source)) {
  console.error(`Contract export not found: ${path.relative(root, source)}\nRun "npm run export:abi" in smart-contract/ first.`);
  process.exit(1);
}

const wanted = fs.readFileSync(source, "utf8");
const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

if (check) {
  if (current === wanted) {
    console.log("Backend ABI copy is in sync with smart-contract/exports/Voting.json");
    process.exit(0);
  }
  console.error('Backend ABI copy is OUT OF SYNC with smart-contract/exports/Voting.json. Run "npm run sync:abi".');
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, wanted);
console.log(current === wanted ? "ABI already up to date" : `ABI copied -> ${path.relative(root, target)}`);
