import type { PreflightSummary } from "../../api/types";

/** Plain-language labels for the backend's preflight check names (backend-api/src/chain/preflight.js). Unknown names fall back to the raw name. */
const LABELS: Record<string, string> = {
  "mongo.connectivity": "Database connection",
  "rpc.connectivity": "Blockchain RPC connection",
  "chain.id": "Blockchain network matches the configuration",
  "contract.bytecode": "Election contract is deployed",
  "signers.distinct": "Owner, authority and relayer accounts are separate",
  "contract.electionId": "Contract election ID matches the configuration",
  "contract.phase": "Contract phase can be read",
  "contract.owner": "Contract owner is the configured account",
  "contract.authoritySigner": "Ballot authority account matches the contract",
  "contract.relayer": "Relayer account matches the contract",
  "eip712.domain": "Signing domain matches the contract",
  "eip712.typehash": "Ballot authorization type matches the contract",
  "eip712.digest": "Ballot authorization self-test",
  "relayer.balance": "Relayer has funds to pay for transactions",
  "election.config": "Constituencies and candidates are consistent",
};

export const checkLabel = (name: string): string => LABELS[name] ?? name;
export const isKnownCheck = (name: string): boolean => name in LABELS;

export const CHECK_GROUPS: { title: string; names: string[] }[] = [
  { title: "Connections", names: ["mongo.connectivity", "rpc.connectivity", "chain.id", "contract.bytecode"] },
  { title: "Contract and accounts", names: ["signers.distinct", "contract.electionId", "contract.phase", "contract.owner", "contract.authoritySigner", "contract.relayer", "relayer.balance"] },
  { title: "Ballot signing", names: ["eip712.domain", "eip712.typehash", "eip712.digest"] },
  { title: "Election configuration", names: ["election.config"] },
];

export const overallLabel = (summary: PreflightSummary): string => (summary.status === "pass" ? "All checks passed" : summary.status === "warn" ? "Passed with warnings" : summary.status === "fail" ? "Some checks failed" : summary.status);
