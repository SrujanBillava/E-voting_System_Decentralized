import { Contract, Wallet } from "ethers";
import { AppError } from "../utils/errors.js";
import { loadAbi } from "./abi.js";

export const PHASE = Object.freeze({ Setup: 0, Open: 1, Closed: 2 });
export const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");
/** The decoded custom error of a failed call, or null when the failure was not a contract revert (a network problem). */
export const revertOf = (err) => (err?.revert?.name ? { name: err.revert.name, args: err.revert.args ?? [] } : null);

/** Everything the relayer reads from (and sends to) VoteChainV3. The ABI it uses has no issuance member. */
export function createChain({ config, provider, abi = loadAbi(), relayerKey = config.secrets?.relayerPrivateKey }) {
  const { contractAddress, chainId } = config.chain;
  const contract = new Contract(contractAddress, abi.voteChain, provider);
  const relayer = relayerKey ? new Wallet(relayerKey, provider) : null;
  const deployment = { chainId, contractAddress, electionId: config.chain.electionId ?? null };
  let semaphore = null;
  let depth = null;

  return {
    provider,
    contract,
    abi,
    relayer,
    deployment,
    confirmations: config.chain.confirmations ?? 1,
    addresses: Object.freeze({ relayer: relayer?.address ?? null }),
    get semaphore() {
      return semaphore;
    },
    /** the DECLARED proof depth the contract demands (20) */
    get declaredDepth() {
      return depth;
    },
    async init() {
      deployment.electionId = String(await contract.ELECTION_ID()).toLowerCase();
      semaphore = new Contract(await contract.semaphore(), abi.semaphore, provider);
      depth = Number(await contract.SEMAPHORE_DEPTH());
      return deployment;
    },
    /** The custom error behind a failed call: the contract's own, or one Semaphore raised on its behalf (an unknown or expired root, ...). */
    decodeRevert(err) {
      const direct = revertOf(err);
      if (direct) return direct;
      const data = err?.data ?? err?.info?.error?.data;
      if (typeof data === "string" && /^0x[0-9a-fA-F]{8}/.test(data)) {
        try {
          const parsed = abi.semaphore.parseError(data);
          if (parsed) return { name: parsed.name, args: [...parsed.args] };
        } catch {
          // not a Semaphore error either
        }
      }
      return null;
    },
    async readPhase() {
      try {
        return Number(await contract.phase());
      } catch {
        throw unavailable();
      }
    },
    /** the constituency as the contract holds it (null when unknown): candidate count, group and nothing about voters */
    async readConstituency(constituencyId) {
      try {
        const c = await contract.getConstituency(constituencyId);
        return { candidateCount: Number(c.candidateCount), groupId: BigInt(c.groupId), code: c.code };
      } catch (err) {
        if (revertOf(err)?.name === "UnknownConstituency") return null;
        throw unavailable();
      }
    },
    async nullifierUsed(nullifier, overrides = {}) {
      try {
        return await contract.nullifierUsed(BigInt(nullifier), overrides);
      } catch {
        throw unavailable();
      }
    },
  };
}
