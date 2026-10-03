// Reads the freshly deployed contract back from the chain and writes deployments/local.json.
// Configuration metadata only: no secrets, no private keys.
import fs from "node:fs";
import path from "node:path";
import { ELECTION_CODE } from "../ignition/data/election.js";
import { METADATA_PATH, ROOT, connectLocal } from "./lib/local.js";

const ethers = await connectLocal();
const { chainId } = await ethers.provider.getNetwork();

const addressesFile = path.join(ROOT, `ignition/deployments/chain-${chainId}/deployed_addresses.json`);
const addresses = JSON.parse(fs.readFileSync(addressesFile, "utf8"));
const contractAddress: string = addresses["VotingModule#Voting"];
if (!contractAddress) throw new Error(`VotingModule#Voting not found in ${addressesFile}`);

const voting = await ethers.getContractAt("Voting", contractAddress);

// The ElectionDeployed event gives a deterministic deployment block and timestamp.
const [deployedEvent] = await voting.queryFilter(voting.filters.ElectionDeployed(), 0, "latest");
if (!deployedEvent) throw new Error("ElectionDeployed event not found");
const deployBlock = await deployedEvent.getBlock();

const constituencies = [];
const candidates = [];
const ids: string[] = await voting.getConstituencyIds(0, await voting.constituencyCount());
for (const id of ids) {
  const [code, name] = await voting.getConstituency(id);
  const candidateIds: bigint[] = await voting.getCandidateIdsByConstituency(id, 0, await voting.candidateCountOf(id));
  constituencies.push({ code, name, id, candidateIds: candidateIds.map(Number) });
  for (const cid of candidateIds) {
    const [candidateName] = await voting.getCandidate(cid);
    candidates.push({ id: Number(cid), name: candidateName, constituencyCode: code, constituencyId: id });
  }
}
candidates.sort((a, b) => a.id - b.id);

const metadata = {
  schemaVersion: 1,
  network: "localhost",
  chainId: Number(chainId),
  contractName: "Voting",
  contractAddress,
  deployBlock: deployBlock.number,
  deployedAt: new Date(deployBlock.timestamp * 1000).toISOString(),
  electionCode: ELECTION_CODE,
  electionId: await voting.ELECTION_ID(),
  owner: await voting.owner(),
  authoritySigner: await voting.authoritySigner(),
  relayer: await voting.relayer(),
  constituencies,
  candidates,
};

fs.mkdirSync(path.dirname(METADATA_PATH), { recursive: true });
fs.writeFileSync(METADATA_PATH, JSON.stringify(metadata, null, 2) + "\n");

console.log("Deployment recorded -> deployments/local.json");
console.log(`  Contract : ${metadata.contractAddress}`);
console.log(`  Chain id : ${metadata.chainId}`);
console.log(`  Election : ${metadata.electionCode}`);
console.log(`  Election id : ${metadata.electionId}`);
console.log(`  Owner       : ${metadata.owner}`);
console.log(`  Authority   : ${metadata.authoritySigner}`);
console.log(`  Relayer     : ${metadata.relayer}`);
console.log(`  Constituencies: ${constituencies.length}, candidates: ${candidates.length}`);
