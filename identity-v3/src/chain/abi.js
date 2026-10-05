import fs from "node:fs";
import { Interface } from "ethers";

/**
 * The identity service's copy of the contract ABI: a COMMITTED, GENERATED SUBSET (scripts/sync-abi.js). It deliberately has no ballot function, event or
 * error, so this process cannot even decode a ballot. Refresh with `npm run sync:abi`; `npm run check:abi` (and a test) fail on drift.
 */
export const ABI_URL = new URL("./generated/votechainv3.identity.abi.json", import.meta.url);

// Every contract member this service relies on. A stale ABI copy fails at startup, not at 3am.
export const REQUIRED_FUNCTIONS = ["ELECTION_ID", "EPOCH_SECONDS", "MAX_BATCH", "commitmentRegistered", "getConstituency", "issuanceOpen", "issuer", "owner", "phase", "registerCommitmentBatch", "semaphore", "trusteeConfiguration"];

export function loadAbi(url = ABI_URL) {
  const parsed = JSON.parse(fs.readFileSync(url, "utf8"));
  const voteChain = new Interface(parsed.contractAbi);
  const semaphore = new Interface(parsed.semaphoreAbi);
  for (const name of REQUIRED_FUNCTIONS) {
    if (!voteChain.getFunction(name)) throw new Error(`VoteChainV3 ABI is missing required function "${name}"; run "npm run sync:abi"`);
  }
  if (!voteChain.getEvent("CommitmentBatchRegistered") || !semaphore.getEvent("MembersAdded")) throw new Error('the ABI copy lacks a batch event; run "npm run sync:abi"');
  return Object.freeze({ voteChain, semaphore, contractAbi: parsed.contractAbi, semaphoreAbi: parsed.semaphoreAbi });
}
