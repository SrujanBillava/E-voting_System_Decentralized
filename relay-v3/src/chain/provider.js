import { FetchRequest, JsonRpcProvider, Network } from "ethers";

/** JSON-RPC provider with a fixed expected network (staticNetwork) and no response cache; the real chain id is checked in the startup preflight. */
export function createProvider({ rpcUrl, chainId, timeoutMs = 8000 }) {
  const request = new FetchRequest(rpcUrl);
  request.timeout = timeoutMs;
  const network = Network.from(chainId);
  return new JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
}
export async function readRemoteChainId(provider) {
  return BigInt(await provider.send("eth_chainId", []));
}
