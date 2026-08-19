import hre from "hardhat";
import { candidates } from "../ignition/data/candidates.ts";

async function main() {
  const ethers = (hre as any).ethers;

  console.log("Deploying Voting contract...");
  const Voting = await ethers.getContractFactory("Voting");
  const voting = await Voting.deploy();

  await voting.waitForDeployment();
  const address = await voting.getAddress();
  console.log("Voting contract deployed to:", address);

  console.log(`Seeding ${candidates.length} candidates...`);
  for (const candidate of candidates) {
    const tx = await voting.addCandidate(candidate.name, candidate.constituency);
    await tx.wait();
    console.log(`Added candidate: ${candidate.name} (${candidate.constituency})`);
  }

  const count = await voting.candidateCount();
  console.log(`✅ Seeding complete! Total candidates on-chain: ${count}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});