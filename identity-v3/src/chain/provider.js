import { FetchRequest, JsonRpcProvider, Network } from "ethers";

/**
 * Read/broadcast JSON-RPC provider. The expected chain id is fixed up front (staticNetwork) so ethers never loops trying to "detect" a network; the real
 * chain id is checked explicitly during preflight. cacheTimeout -1: preflight and health must see the node's CURRENT state.
 */
export function createProvider({ rpcUrl, chainId, timeoutMs = 8000 }) {
  const request = new FetchRequest(rpcUrl);
  request.timeout = timeoutMs;
  const network = Network.from(chainId);
  return new JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
}

/** eth_chainId as reported by the node (not the one we expect). */
export async function readRemoteChainId(provider) {
  return BigInt(await provider.send("eth_chainId", []));
}
