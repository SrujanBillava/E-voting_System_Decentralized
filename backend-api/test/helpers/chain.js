import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../src/config/env.js";
import { createChainServices } from "../../src/chain/index.js";
import { DEFAULT_LOCAL_METADATA_PATH } from "../../src/chain/deployment.js";
import { validEnv } from "./env.js";

export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The deployment written by `npm run deploy:local` in smart-contract/. */
export function readLocalMetadata() {
  if (!fs.existsSync(DEFAULT_LOCAL_METADATA_PATH)) {
    throw new Error(
      "Chain tests need a local deployment. In smart-contract/ run `npm run node` (one terminal) and `npm run deploy:local` (another), then retry.",
    );
  }
  return JSON.parse(fs.readFileSync(DEFAULT_LOCAL_METADATA_PATH, "utf8"));
}

/** Environment for the real local chain, with the deployment coordinates set EXPLICITLY. */
export function localChainEnv(overrides = {}) {
  const meta = readLocalMetadata();
  return validEnv({
    CHAIN_RPC_URL: process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545",
    CHAIN_ID: String(meta.chainId),
    VOTING_CONTRACT_ADDRESS: meta.contractAddress,
    ELECTION_ID: meta.electionId,
    ...overrides,
  });
}

export function localServices(overrides = {}, options) {
  const config = loadEnv(localChainEnv(overrides));
  return { config, ...createChainServices(config, { rpcTimeoutMs: 4000, ...options }) };
}

/** Fails with an actionable message if the node is down or the deployment is stale/opened. */
export async function assertPristineLocalChain(services) {
  let phase;
  try {
    phase = Number(await services.contract.phase());
  } catch (cause) {
    throw new Error(
      `Cannot read the local Voting contract (${cause?.code ?? cause?.name}). Is the node running and freshly deployed? In smart-contract/: \`npm run node\` + \`npm run deploy:local\`.`,
    );
  }
  if (phase !== 0) {
    throw new Error("The local election is not in Setup (a previous run opened it). Restart the node and run `npm run deploy:local` in smart-contract/.");
  }
}

/** Never touches state permanently: Hardhat snapshot/revert. */
export const snapshot = (provider) => provider.send("evm_snapshot", []);
export const revertTo = (provider, id) => provider.send("evm_revert", [id]);
