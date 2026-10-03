import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const METADATA_PATH = path.join(ROOT, "deployments/local.json");
export const PHASES = ["Setup", "Open", "Closed"] as const;

export async function connectLocal() {
  const { ethers } = await network.create("localhost");
  return ethers;
}

export function readMetadata() {
  if (!fs.existsSync(METADATA_PATH)) {
    throw new Error(`Missing ${path.relative(ROOT, METADATA_PATH)}. Run "npm run deploy:local" first.`);
  }
  return JSON.parse(fs.readFileSync(METADATA_PATH, "utf8"));
}
