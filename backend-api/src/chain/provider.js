import { FetchRequest, JsonRpcProvider, Network } from "ethers";

/**
 * Read-only JSON-RPC provider. The expected chain id is fixed up front (staticNetwork) so ethers
 * never loops trying to "detect" a network; the real chain id is checked explicitly with
 * `readRemoteChainId` during preflight.
 */
export function createProvider({ rpcUrl, chainId, timeoutMs = 8000 }) {
  const request = new FetchRequest(rpcUrl);
  request.timeout = timeoutMs;
  const network = Network.from(chainId);
  // cacheTimeout: -1 disables ethers' default 250ms response cache: preflight and health must report
  // the node's CURRENT state, never a response from a moment ago.
  return new JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
}

/** eth_chainId as reported by the node (not the one we expect). */
export async function readRemoteChainId(provider) {
  return BigInt(await provider.send("eth_chainId", []));
}
