import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidates = [
  // Bengaluru
  { name: "Amit Sharma", constituency: "Bengaluru" },
  { name: "Rahul Verma", constituency: "Bengaluru" },
  { name: "Neha Joshi", constituency: "Bengaluru" },
  { name: "Rakesh Gowda", constituency: "Bengaluru" },
  { name: "Anjali Rao", constituency: "Bengaluru" },
  { name: "Kiran Kumar", constituency: "Bengaluru" },
  { name: "Megha Iyer", constituency: "Bengaluru" },

  // Delhi
  { name: "Rohan Malhotra", constituency: "Delhi" },
  { name: "Priya Khanna", constituency: "Delhi" },
  { name: "Nikhil Sood", constituency: "Delhi" },
  { name: "Deepak Singh", constituency: "Delhi" },
  { name: "Ajay Mehra", constituency: "Delhi" },
  { name: "Kavita Arora", constituency: "Delhi" },

  // Mumbai
  { name: "Akash Patil", constituency: "Mumbai" },
  { name: "Sneha Kulkarni", constituency: "Mumbai" },
  { name: "Ritesh Deshmukh", constituency: "Mumbai" },
  { name: "Ayesha Khan", constituency: "Mumbai" },
  { name: "Nitin Sawant", constituency: "Mumbai" },
];

async function main() {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const signer = await provider.getSigner(0);
  console.log("Deployer account:", await signer.getAddress());

  const artifactPath = path.join(__dirname, "../artifacts/contracts/Voting.sol/Voting.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  console.log("Deploying Voting contract...");
  const voting = await factory.deploy();
  await voting.waitForDeployment();
  const address = await voting.getAddress();
  console.log("✅ Voting contract deployed to:", address);

  console.log(`Seeding ${candidates.length} candidates...`);
  for (const candidate of candidates) {
    const tx = await voting.addCandidate(candidate.name, candidate.constituency);
    await tx.wait();
    console.log(`  Added: ${candidate.name} (${candidate.constituency})`);
  }

  const count = await voting.candidateCount();
  console.log(`\n🎉 Success! Total candidates on-chain: ${count}`);
  console.log(`Contract address to set in frontend .env: ${address}`);
}

main().catch((err) => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
