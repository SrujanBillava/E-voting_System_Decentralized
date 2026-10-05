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
 * Startup proof that this service talks to the right contract in the right role. It refuses to start (throws PreflightError) when:
 * the node is on another chain; there is no contract at the address; the election id differs from the configured one; the contract's ISSUER is not this
 * service's key; the issuer key is also the contract's OWNER or one of the pinned TRUSTEES (four distinct roles: issuer, relayer, owner, trustees); the
 * contract's frozen constants (30 s epochs, MAX_BATCH 128) are not what the batcher is built for.
 */
export async function runPreflight(chain, config) {
  const { provider, contract } = chain;
  const remote = await readRemoteChainId(provider);
  if (remote !== BigInt(chain.deployment.chainId)) throw new PreflightError("CHAIN_ID_MISMATCH", "the node reports another chain id than CHAIN_ID");
  const code = await provider.getCode(chain.deployment.contractAddress);
  if (code === "0x") throw new PreflightError("NO_CONTRACT", "no contract code at VOTECHAIN_V3_ADDRESS");

  await chain.init();
  if (config.chain.electionId && config.chain.electionId !== chain.deployment.electionId) throw new PreflightError("ELECTION_ID_MISMATCH", "the contract's election id is not the configured ELECTION_ID");

  if ((await contract.EPOCH_SECONDS()) !== 30n) throw new PreflightError("EPOCH_MISMATCH", "the contract's epoch length is not the frozen 30 seconds");
  const maxBatch = Number(await contract.MAX_BATCH());
  if (config.batch.maxSize > maxBatch) throw new PreflightError("BATCH_SIZE_MISMATCH", "BATCH_MAX_SIZE exceeds the contract's MAX_BATCH");

  const me = chain.addresses.issuer;
  if (!me) throw new PreflightError("NO_ISSUER_KEY", "no issuer signer is configured");
  if (getAddress(await contract.issuer()) !== me) throw new PreflightError("ISSUER_MISMATCH", "this service's key is not the contract's issuer");
  if (getAddress(await contract.owner()) === me) throw new PreflightError("ROLE_CONFLICT", "the issuer key must not be the contract owner");
  const trustees = await contract.trusteeConfiguration();
  if (trustees.configured && [...trustees.trustees].map(getAddress).includes(me)) throw new PreflightError("ROLE_CONFLICT", "the issuer key must not be a trustee");

  const balance = await provider.getBalance(me);
  return { issuer: me, balance, maxBatch };
}
