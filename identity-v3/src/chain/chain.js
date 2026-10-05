import { Contract, Wallet } from "ethers";
import { AppError } from "../utils/errors.js";
import { loadAbi } from "./abi.js";

export const PHASE = Object.freeze({ Setup: 0, Open: 1, Closed: 2 });
export const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");

/** An election/issuance state that does not allow issuing right now, as the error the voter sees. */
export function assertIssuing(state) {
  if (state.phase === PHASE.Setup) throw new AppError(409, "ELECTION_NOT_OPEN", "The election is not open yet");
  if (state.phase === PHASE.Closed) throw new AppError(409, "ELECTION_CLOSED", "The election is closed");
  if (!state.issuanceOpen) throw new AppError(409, "ISSUANCE_CLOSED", "Credential issuance is closed");
}

/** The decoded custom error of a failed call, or null when the failure was not a contract revert (a network problem). */
export const revertOf = (err) => (err?.revert?.name ? { name: err.revert.name, args: err.revert.args ?? [] } : null);

/**
 * Everything the identity service reads from (and sends to) VoteChainV3. It is the ONLY module that talks to the chain, and the ABI it uses has no ballot member.
 *
 * `clock.nowSeconds()` is the time epochs are measured in: the later of this server's clock and the latest block's timestamp (like V2: a chain running
 * ahead of the server must not be second-guessed), injectable so tests control it.
 */
export function createChain({ config, provider, abi = loadAbi(), clock, issuerKey = config.secrets?.issuerPrivateKey }) {
  const { contractAddress, chainId } = config.chain;
  const contract = new Contract(contractAddress, abi.voteChain, provider);
  const issuer = issuerKey ? new Wallet(issuerKey, provider) : null;
  const deployment = { chainId, contractAddress, electionId: config.chain.electionId ?? null };
  let semaphore = null;

  const chain = {
    provider,
    contract,
    abi,
    issuer,
    deployment,
    confirmations: config.chain.confirmations ?? 1,
    addresses: Object.freeze({ issuer: issuer?.address ?? null }),
    get semaphore() {
      return semaphore;
    },

    /** Reads the election id and the Semaphore address from the contract. Called once, before anything else. */
    async init() {
      deployment.electionId = String(await contract.ELECTION_ID()).toLowerCase();
      semaphore = new Contract(await contract.semaphore(), abi.semaphore, provider);
      return deployment;
    },

    clock: clock ?? {
      async nowSeconds() {
        const head = await provider.getBlock("latest");
        return Math.max(Math.floor(Date.now() / 1000), head?.timestamp ?? 0);
      },
    },

    async readPhase() {
      try {
        return Number(await contract.phase());
      } catch {
        throw unavailable();
      }
    },

    /** Phase and the issuance flag (no constituency): what login needs. */
    async readPhaseAndIssuance() {
      try {
        const [phase, issuanceOpen] = await Promise.all([contract.phase(), contract.issuanceOpen()]);
        return { phase: Number(phase), issuanceOpen };
      } catch {
        throw unavailable();
      }
    },

    /** Phase, issuance flag and one constituency (null when the contract does not know it). */
    async readIssuanceState(constituencyId) {
      try {
        const [phase, issuanceOpen] = await Promise.all([contract.phase(), contract.issuanceOpen()]);
        let constituency = null;
        try {
          const c = await contract.getConstituency(constituencyId);
          constituency = { code: c.code, name: c.name, groupId: BigInt(c.groupId), registeredVoters: Number(c.registeredVoters), issued: Number(c.issued) };
        } catch (err) {
          if (revertOf(err)?.name !== "UnknownConstituency") throw err;
        }
        return { phase: Number(phase), issuanceOpen, constituency };
      } catch {
        throw unavailable();
      }
    },

    async commitmentRegistered(commitment) {
      try {
        return await contract.commitmentRegistered(BigInt(commitment));
      } catch {
        throw unavailable();
      }
    },

    /**
     * The public state of a Semaphore group (nothing voter-specific). `depth` is the DECLARED proof depth the contract demands (SEMAPHORE_DEPTH = 20), not the
     * tree's current height (a LeanIMT of one leaf has height 0): it is the value a kiosk must put into its membership proof.
     */
    async groupInfo(groupId) {
      try {
        const [root, size, depth] = await Promise.all([semaphore.getMerkleTreeRoot(groupId), semaphore.getMerkleTreeSize(groupId), contract.SEMAPHORE_DEPTH()]);
        return { groupId: BigInt(groupId), root: BigInt(root), size: Number(size), depth: Number(depth) };
      } catch {
        throw unavailable();
      }
    },
  };
  return chain;
}
