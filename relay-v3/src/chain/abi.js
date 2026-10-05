import fs from "node:fs";
import { Interface } from "ethers";

/**
 * The relayer's copy of the contract ABI: a COMMITTED, GENERATED SUBSET (scripts/sync-abi.js). It has submitBallot and the reads around it and NO
 * commitment-issuance function, so this process cannot even encode one. `npm run check:abi` (and a test) fail on drift.
 */
export const ABI_URL = new URL("./generated/votechainv3.relay.abi.json", import.meta.url);
export const REQUIRED_FUNCTIONS = ["ELECTION_ID", "SEMAPHORE_DEPTH", "ballotHashOf", "getConstituency", "issuer", "nullifierUsed", "owner", "phase", "semaphore", "submitBallot", "trusteeConfiguration"];

export function loadAbi(url = ABI_URL) {
  const parsed = JSON.parse(fs.readFileSync(url, "utf8"));
  const voteChain = new Interface(parsed.contractAbi);
  const semaphore = new Interface(parsed.semaphoreAbi);
  for (const name of REQUIRED_FUNCTIONS) if (!voteChain.getFunction(name)) throw new Error(`VoteChainV3 ABI is missing required function "${name}"; run "npm run sync:abi"`);
  if (!voteChain.getEvent("BallotRecorded") || !semaphore.getEvent("MembersAdded")) throw new Error('the ABI copy lacks a required event; run "npm run sync:abi"');
  return Object.freeze({ voteChain, semaphore, contractAbi: parsed.contractAbi, semaphoreAbi: parsed.semaphoreAbi });
}
