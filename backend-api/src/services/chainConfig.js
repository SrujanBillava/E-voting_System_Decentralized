import { AppError } from "../utils/errors.js";

/** Live contract phase (the source of truth); never cached or mirrored in Mongo. */
export async function readPhaseName(chain) {
  try {
    return ["Setup", "Open", "Closed"][Number(await chain.contract.phase())];
  } catch {
    throw new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");
  }
}

export async function requireSetup(chain) {
  const phase = await readPhaseName(chain);
  if (phase !== "Setup") throw new AppError(409, "ELECTION_LOCKED", `Configuration is locked: the election is ${phase}`);
}

/** Constituency record from the contract, or null when it does not exist. */
export async function readConstituencyById(chain, id) {
  try {
    const [code, name] = await chain.contract.getConstituency(id);
    return { id, code, name };
  } catch (err) {
    if (err?.revert?.name === "UnknownConstituency") return null;
    throw new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");
  }
}
