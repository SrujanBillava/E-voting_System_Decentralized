import { createVotingContract } from "./contract.js";
import { resolveDeployment } from "./deployment.js";
import { buildDomain } from "./eip712.js";
import { createProvider } from "./provider.js";
import { createSigners } from "./signers.js";

/**
 * Composition root for everything blockchain-related. No network traffic happens here:
 * providers connect lazily, so this is safe to call at startup before preflight.
 */
export function createChainServices(config, { rpcTimeoutMs } = {}) {
  const deployment = resolveDeployment(config);
  const provider = createProvider({ rpcUrl: config.secrets.chainRpcUrl, chainId: deployment.chainId, timeoutMs: rpcTimeoutMs });
  const contract = createVotingContract({ provider, address: deployment.contractAddress });
  const signers = createSigners({
    provider,
    ownerPrivateKey: config.secrets.ownerPrivateKey,
    authorityPrivateKey: config.secrets.authorityPrivateKey,
    relayerPrivateKey: config.secrets.relayerPrivateKey,
  });
  const domain = buildDomain({ chainId: deployment.chainId, verifyingContract: deployment.contractAddress });

  return {
    deployment,
    provider,
    contract,
    signers,
    domain,
    destroy: () => provider.destroy(),
  };
}
