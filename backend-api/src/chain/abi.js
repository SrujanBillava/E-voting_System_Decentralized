import fs from "node:fs";
import { Interface } from "ethers";
import { z } from "zod";

/**
 * The backend's copy of the generated contract export (smart-contract/exports/Voting.json).
 * It is a COMMITTED copy so the backend runs standalone from a fresh clone, with no dependency
 * on Hardhat or on the smart-contract/ folder at runtime. Refresh it with `npm run sync:abi`;
 * `npm run check:abi` (and a test) fail if it drifts from the contract export.
 */
export const VOTING_EXPORT_URL = new URL("./generated/Voting.json", import.meta.url);

const ExportSchema = z.object({
  contractName: z.literal("Voting"),
  eip712: z.object({
    domainName: z.string(),
    domainVersion: z.string(),
    primaryType: z.literal("BallotAuthorization"),
    typeString: z.string(),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  }),
  phases: z.array(z.string()).length(3),
  abi: z.array(z.record(z.string(), z.unknown())).min(1),
});

// Every contract member this backend relies on. A stale ABI copy fails at startup, not at 3am.
export const REQUIRED_FUNCTIONS = [
  "ELECTION_ID",
  "BALLOT_AUTHORIZATION_TYPEHASH",
  "phase",
  "owner",
  "authoritySigner",
  "relayer",
  "constituencyCount",
  "candidateCount",
  "totalBallots",
  "candidateCountOf",
  "getConstituencyIds",
  "getConstituency",
  "getCandidateIdsByConstituency",
  "getCandidate",
  "nullifierUsed",
  "ballotIndexOf",
  "hashAuthorization",
  "eip712Domain",
  "castVote",
];

export function loadVotingExport(url = VOTING_EXPORT_URL) {
  const parsed = ExportSchema.parse(JSON.parse(fs.readFileSync(url, "utf8")));
  const iface = new Interface(parsed.abi);
  for (const name of REQUIRED_FUNCTIONS) {
    if (!iface.getFunction(name)) throw new Error(`Voting ABI is missing required function "${name}"; run "npm run sync:abi"`);
  }
  return Object.freeze({ ...parsed, interface: iface });
}

const votingExport = loadVotingExport();
export const votingInterface = votingExport.interface;
export const votingAbi = votingExport.abi;
export const PHASES = votingExport.phases;
export const exportedEip712 = votingExport.eip712;
