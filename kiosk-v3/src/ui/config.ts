import type { KioskConfig } from "../core/types.ts";

/** The kiosk's pinned configuration: build-time constants (see .env.production and build-manifest.json). Nothing here is read from the voter, the URL or a server. */
export function readConfig(): KioskConfig {
  const env = import.meta.env;
  const need = (value: string | undefined, name: string): string => {
    if (!value) throw new Error(`this kiosk build is missing ${name}`);
    return value;
  };
  return {
    identityBase: need(env.VITE_IDENTITY_BASE, "VITE_IDENTITY_BASE"),
    relayBase: need(env.VITE_RELAY_BASE, "VITE_RELAY_BASE"),
    rpcUrl: need(env.VITE_RPC_URL, "VITE_RPC_URL"),
    chainId: Number(need(env.VITE_CHAIN_ID, "VITE_CHAIN_ID")),
    contractAddress: need(env.VITE_VOTECHAIN_ADDRESS, "VITE_VOTECHAIN_ADDRESS"),
    ...(env.VITE_ELECTION_ID ? { electionId: env.VITE_ELECTION_ID } : {}),
    pollMs: 1000,
    issuanceTimeoutMs: 180_000,
    confirmTimeoutMs: 45_000,
  };
}
export const defaultConstituency = (): string => import.meta.env.VITE_DEFAULT_CONSTITUENCY ?? "";
