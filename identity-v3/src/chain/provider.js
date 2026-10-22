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

const TRANSIENT_CODES = new Set(["TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR", "UNKNOWN_ERROR", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET"]);

/**
 * True for a failure that says nothing about the request itself, only that the node could not answer it right now: a timeout, a refused or reset connection, an
 * HTTP 5xx, or a JSON-RPC error object (rate limit, "header not found", internal error). ethers v6 reports a JSON-RPC error of eth_call as a CALL_EXCEPTION
 * WITHOUT any data (measured: "limit exceeded" and "header not found" both arrive that way), so only such a data-less call exception counts; a call that the
 * node executed and that reverted carries data ("0x" or an error) and is deterministic. The CHAIN_UNAVAILABLE error of chain.js is transient by definition.
 */
export function isTransientRpcError(err) {
  if (!err) return false;
  if (err.code === "CHAIN_UNAVAILABLE") return true;
  if (TRANSIENT_CODES.has(err.code) || TRANSIENT_CODES.has(err.cause?.code) || TRANSIENT_CODES.has(err.error?.code)) return true;
  return err.code === "CALL_EXCEPTION" && err.data == null && !err.revert;
}
