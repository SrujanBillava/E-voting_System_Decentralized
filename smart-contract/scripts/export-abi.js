// Generates exports/Voting.json from the compiled Hardhat artifact. Never edit that file by hand.
// Deterministic: no timestamps, no bytecode. Run via `npm run export:abi` (which compiles first).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(root, "artifacts/contracts/Voting.sol/Voting.json");

if (!fs.existsSync(artifactPath)) {
  console.error(`Artifact not found: ${artifactPath}\nRun "npm run compile" first.`);
  process.exit(1);
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

const output = {
  contractName: artifact.contractName,
  sourceName: artifact.sourceName,
  // Must stay identical to the type string in Voting.sol; verify:local checks it against the chain.
  eip712: {
    domainName: "VoteChain",
    domainVersion: "2",
    primaryType: "BallotAuthorization",
    typeString:
      "BallotAuthorization(bytes32 electionId,bytes32 constituencyId,bytes32 nullifier,uint256 candidateId,address relayer,uint256 deadline)",
    types: {
      BallotAuthorization: [
        { name: "electionId", type: "bytes32" },
        { name: "constituencyId", type: "bytes32" },
        { name: "nullifier", type: "bytes32" },
        { name: "candidateId", type: "uint256" },
        { name: "relayer", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
  },
  phases: ["Setup", "Open", "Closed"],
  abi: artifact.abi,
};

const dir = path.join(root, "exports");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "Voting.json");
fs.writeFileSync(file, JSON.stringify(output, null, 2) + "\n");
console.log(`Exported ${output.abi.length} ABI entries -> ${path.relative(root, file)}`);
