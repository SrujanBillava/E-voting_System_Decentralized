// Read-only consistency check of the deployed local contract against deployments/local.json
// and the canonical seed data. Exits non-zero on any mismatch.
// Expected phase defaults to Setup; override with EXPECT_PHASE=Open|Closed.
import { ELECTION_CODE, ELECTION_ID, constituencies, constituencyIdOf, expectedCandidates } from "../ignition/data/election.js";
import { PHASES, connectLocal, readMetadata } from "./lib/local.js";
import { readFileSync } from "node:fs";
import { ethers as E } from "ethers";
import { ROOT } from "./lib/local.js";

const meta = readMetadata();
const exported = JSON.parse(readFileSync(`${ROOT}/exports/Voting.json`, "utf8"));
const expectPhase = process.env.EXPECT_PHASE ?? "Setup";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const ethers = await connectLocal();
const net = await ethers.provider.getNetwork();

check("metadata chainId matches the connected chain", Number(net.chainId) === meta.chainId, `${net.chainId} vs ${meta.chainId}`);
const code = await ethers.provider.getCode(meta.contractAddress);
check("bytecode exists at contract address", code !== "0x", meta.contractAddress);
if (code === "0x") {
  console.log("\nNo contract deployed at the recorded address. Is the node running and freshly deployed?");
  process.exit(1);
}

const v = await ethers.getContractAt("Voting", meta.contractAddress);

check("election id matches metadata", (await v.ELECTION_ID()) === meta.electionId);
check("election id == keccak256(utf8(election code))", meta.electionId === E.keccak256(E.toUtf8Bytes(ELECTION_CODE)) && meta.electionId === ELECTION_ID);
check("owner matches", (await v.owner()) === meta.owner, meta.owner);
check("authority signer matches", (await v.authoritySigner()) === meta.authoritySigner, meta.authoritySigner);
check("relayer matches", (await v.relayer()) === meta.relayer, meta.relayer);
check("owner, authority and relayer are three distinct accounts", new Set([meta.owner, meta.authoritySigner, meta.relayer]).size === 3);
check("no pending ownership transfer", (await v.pendingOwner()) === E.ZeroAddress);

const phase = PHASES[Number(await v.phase())];
check(`phase == ${expectPhase}`, phase === expectPhase, `is ${phase}`);

check(
  "EIP-712 type hash on chain == hash of the exported type string",
  (await v.BALLOT_AUTHORIZATION_TYPEHASH()) === E.id(exported.eip712.typeString),
);
const d = await v.eip712Domain();
check(
  "EIP-712 domain is VoteChain/2/chainId/this contract",
  d.name === exported.eip712.domainName && d.version === exported.eip712.domainVersion && Number(d.chainId) === meta.chainId && d.verifyingContract === meta.contractAddress,
);

// ---- constituencies
check("constituency count", Number(await v.constituencyCount()) === constituencies.length, `${await v.constituencyCount()} expected ${constituencies.length}`);
for (const c of constituencies) {
  const id = constituencyIdOf(c.code);
  try {
    const [code2, name] = await v.getConstituency(id);
    check(`constituency ${c.code}: exists, id == keccak256(code), name matches`, code2 === c.code && name === c.name && id === E.keccak256(E.toUtf8Bytes(c.code)));
  } catch {
    check(`constituency ${c.code}: exists`, false, "getConstituency reverted");
    continue;
  }
  const count = Number(await v.candidateCountOf(id));
  check(`constituency ${c.code}: has candidates`, count > 0, `${count}`);
  check(`constituency ${c.code}: candidate count`, count === c.candidates.length, `${count} expected ${c.candidates.length}`);
  check(`constituency ${c.code}: tally is 0`, Number(await v.constituencyTotal(id)) === 0 || expectPhase !== "Setup");
}

// ---- candidates
check("candidate count", Number(await v.candidateCount()) === expectedCandidates.length, `${await v.candidateCount()} expected ${expectedCandidates.length}`);
let candidatesOk = true;
for (const c of expectedCandidates) {
  try {
    const [name, cid] = await v.getCandidate(c.id);
    if (name !== c.name || cid !== c.constituencyId) {
      candidatesOk = false;
      console.log(`        candidate ${c.id}: got "${name}" in ${cid}, expected "${c.name}" in ${c.constituencyCode}`);
    }
  } catch {
    candidatesOk = false;
    console.log(`        candidate ${c.id} missing`);
  }
}
check("every candidate has the expected name and constituency", candidatesOk);
check("candidate 0 is invalid", await v.getCandidate(0).then(() => false, () => true));

// ---- metadata file agrees with the chain
check("metadata lists the same candidates", JSON.stringify(meta.candidates.map((c: { id: number; name: string; constituencyId: string }) => [c.id, c.name, c.constituencyId])) === JSON.stringify(expectedCandidates.map((c) => [c.id, c.name, c.constituencyId])));

if (expectPhase === "Setup") check("totalBallots == 0", (await v.totalBallots()) === 0n);

console.log(failures === 0 ? "\nLocal deployment verified: all checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
