import { getAddress } from "ethers";
import { readRemoteChainId } from "./provider.js";

export class PreflightError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "PreflightError";
    this.code = code;
  }
}

/**
 * Startup proof that this service talks to the right contract in the right role. It refuses to start when the node is on another chain, there is no contract
 * at the address, the election id is not the configured one, the declared depth is not 20, or the relayer key is ANOTHER ROLE's key: the contract's ISSUER,
 * its OWNER or one of the pinned TRUSTEES (four distinct roles: issuer, relayer, owner, trustees).
 */
export async function runPreflight(chain, config) {
  const { provider, contract } = chain;
  const remote = await readRemoteChainId(provider);
  if (remote !== BigInt(chain.deployment.chainId)) throw new PreflightError("CHAIN_ID_MISMATCH", "the node reports another chain id than CHAIN_ID");
  if ((await provider.getCode(chain.deployment.contractAddress)) === "0x") throw new PreflightError("NO_CONTRACT", "no contract code at VOTECHAIN_V3_ADDRESS");
  await chain.init();
  if (config.chain.electionId && config.chain.electionId !== chain.deployment.electionId) throw new PreflightError("ELECTION_ID_MISMATCH", "the contract's election id is not the configured ELECTION_ID");
  if (chain.declaredDepth !== 20) throw new PreflightError("DEPTH_MISMATCH", "the contract's declared Semaphore depth is not the frozen 20");

  const me = chain.addresses.relayer;
  if (!me) throw new PreflightError("NO_RELAYER_KEY", "no relayer signer is configured");
  if (getAddress(await contract.issuer()) === me) throw new PreflightError("ROLE_CONFLICT", "the relayer key must not be the contract's issuer");
  if (getAddress(await contract.owner()) === me) throw new PreflightError("ROLE_CONFLICT", "the relayer key must not be the contract owner");
  const trustees = await contract.trusteeConfiguration();
  if (trustees.configured && [...trustees.trustees].map(getAddress).includes(me)) throw new PreflightError("ROLE_CONFLICT", "the relayer key must not be a trustee");
  return { relayer: me, balance: await provider.getBalance(me) };
}
