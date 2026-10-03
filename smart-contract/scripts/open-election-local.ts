// Explicit, local-only helper: Setup -> Open. NEVER run automatically by deploy:local.
// Refuses to run against anything but the local Hardhat chain (31337).
import { PHASES, connectLocal, readMetadata } from "./lib/local.js";

const meta = readMetadata();
const ethers = await connectLocal();
const { chainId } = await ethers.provider.getNetwork();

if (chainId !== 31337n || meta.chainId !== 31337) {
  console.error(`Refusing to open: this helper only works on the local chain 31337 (connected: ${chainId}).`);
  process.exit(1);
}

const owner = await ethers.getSigner(meta.owner);
const voting = (await ethers.getContractAt("Voting", meta.contractAddress)).connect(owner);

const phase = PHASES[Number(await voting.phase())];
if (phase !== "Setup") {
  console.error(`Refusing to open: phase is ${phase}, expected Setup.`);
  process.exit(1);
}

await (await voting.openElection()).wait();
console.log(`Election opened. Phase is now ${PHASES[Number(await voting.phase())]} (irreversible for this deployment).`);
