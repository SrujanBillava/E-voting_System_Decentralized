import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";
import { z } from "zod";
import { ConfigError } from "../config/env.js";

const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_LOCAL_METADATA_PATH = path.resolve(BACKEND_ROOT, "../smart-contract/deployments/local.json");

// The part of smart-contract/deployments/local.json the backend understands. It never holds secrets.
const MetadataSchema = z.object({
  schemaVersion: z.literal(1),
  chainId: z.number().int().positive(),
  contractAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  electionId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  electionCode: z.string().optional(),
});

/**
 * Decide which contract this backend talks to.
 *
 *  - Environment variables (CHAIN_ID, VOTING_CONTRACT_ADDRESS, ELECTION_ID) are authoritative.
 *  - In production NOTHING else is consulted: all three must be set (enforced by loadEnv).
 *  - Outside production, any missing value may be filled from the local deployment metadata file
 *    written by `npm run deploy:local`, but never by MIXING sources: values may only come from the
 *    metadata file if the environment does not contradict it. A stale file therefore fails loudly
 *    instead of silently pointing the backend at the wrong contract.
 *
 * @returns {{ chainId: number, contractAddress: string, electionId: string, source: string }}
 */
export function resolveDeployment(config, { readFile = (p) => fs.readFileSync(p, "utf8") } = {}) {
  const { chainId, contractAddress, electionId, deploymentMetadataPath } = config.chain;

  if (chainId !== undefined && contractAddress !== undefined && electionId !== undefined) {
    return Object.freeze({ chainId, contractAddress: getAddress(contractAddress), electionId, source: "environment" });
  }
  if (config.isProduction) {
    throw new ConfigError([{ path: "CHAIN_ID/VOTING_CONTRACT_ADDRESS/ELECTION_ID", message: "must all be set in production" }]);
  }

  const file = deploymentMetadataPath ?? DEFAULT_LOCAL_METADATA_PATH;
  let metadata;
  try {
    metadata = MetadataSchema.parse(JSON.parse(readFile(file)));
  } catch (cause) {
    const missing = [["CHAIN_ID", chainId], ["VOTING_CONTRACT_ADDRESS", contractAddress], ["ELECTION_ID", electionId]]
      .filter(([, v]) => v === undefined)
      .map(([k]) => k);
    throw new ConfigError([
      {
        path: missing.join("/"),
        message: `not set, and no usable local deployment metadata at ${path.relative(process.cwd(), file) || file} (${cause instanceof z.ZodError ? "invalid content" : "unreadable"}). Run "npm run deploy:local" in smart-contract/ or set them explicitly.`,
      },
    ]);
  }

  const metaAddress = getAddress(metadata.contractAddress);
  const conflicts = [];
  if (chainId !== undefined && chainId !== metadata.chainId) conflicts.push(`CHAIN_ID=${chainId} but metadata says ${metadata.chainId}`);
  if (contractAddress !== undefined && getAddress(contractAddress) !== metaAddress) conflicts.push("VOTING_CONTRACT_ADDRESS differs from the metadata address");
  if (electionId !== undefined && electionId.toLowerCase() !== metadata.electionId.toLowerCase()) conflicts.push("ELECTION_ID differs from the metadata election id");
  if (conflicts.length > 0) {
    throw new ConfigError([
      {
        path: "CHAIN_ID/VOTING_CONTRACT_ADDRESS/ELECTION_ID",
        message: `environment contradicts the local deployment metadata (${conflicts.join("; ")}). Set all three explicitly, or redeploy.`,
      },
    ]);
  }

  return Object.freeze({
    chainId: metadata.chainId,
    contractAddress: metaAddress,
    electionId: metadata.electionId.toLowerCase(),
    source: "local-metadata",
  });
}
