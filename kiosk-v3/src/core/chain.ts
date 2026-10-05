import { Contract, JsonRpcProvider, Network, getAddress, type Provider } from "ethers";
import { SEMAPHORE_DEPTH, constituencyIdOf, electionScope, validatePublicKey } from "../crypto/privacy.ts";
import { KioskError } from "./errors.ts";
import type { ElectionParams, KioskConfig, RecordedEvidence } from "./types.ts";

/** The READ-ONLY slice of VoteChainV3 the kiosk uses. There is no write function in this list: the kiosk has no signer and never sends a transaction. */
const VOTECHAIN_ABI = [
  "function phase() view returns (uint8)",
  "function ELECTION_ID() view returns (bytes32)",
  "function electionKeyX() view returns (uint256)",
  "function electionKeyY() view returns (uint256)",
  "function SEMAPHORE_DEPTH() view returns (uint256)",
  "function semaphore() view returns (address)",
  "function scope() view returns (uint256)",
  "function constituencyCount() view returns (uint256)",
  "function constituencyIdAt(uint256) view returns (bytes32)",
  "function getConstituency(bytes32) view returns (string code, string name, uint256 groupId, uint256 registeredVoters, uint256 issued, uint256 ballots, uint256 candidateCount)",
  "function candidateName(bytes32, uint256) view returns (string)",
  "function ballotHashOf(bytes32, uint256[]) view returns (uint256)",
  "function nullifierUsed(uint256) view returns (bool)",
  "function isFinalized(bytes32) view returns (bool)",
  "function finalResult(bytes32) view returns (uint256[16] totals, bytes32 resultsHash, uint256 ballotCount, uint256 candidateCount)",
  "event BallotRecorded(bytes32 indexed constituencyId, uint256 indexed nullifier, uint256 indexed ballotIndex, uint256 ballotHash, uint256[] coords)",
];
const SEMAPHORE_ABI = ["function getMerkleTreeRoot(uint256) view returns (uint256)", "function getMerkleTreeSize(uint256) view returns (uint256)", "function hasMember(uint256, uint256) view returns (bool)"];

export interface ExpectedBallot {
  constituencyId: string;
  nullifier: string;
  ballotHash: string;
  coords: string[];
}
export type ElectionResult = { finalized: false } | { finalized: true; constituency: { code: string; id: string }; candidates: { name: string; votes: number }[]; ballotCount: number; resultsHash: string };

/** The kiosk's whole view of the chain: pinned, read-only, and replaceable by a fake in tests. */
export interface ChainReader {
  pinElection(constituencyCode: string): Promise<ElectionParams>;
  currentRoot(groupId: bigint): Promise<{ root: bigint; size: number }>;
  hasMember(groupId: bigint, commitment: bigint): Promise<boolean>;
  ballotHashOf(constituencyId: string, activeCoords: bigint[]): Promise<bigint>;
  /** the recorded evidence for this ballot, or null while it is not (yet) on-chain. Throws CONFIRMATION_MISMATCH if the chain holds a DIFFERENT ballot under the nullifier. */
  findRecorded(expected: ExpectedBallot, txHash?: string): Promise<RecordedEvidence | null>;
  /** the finalized result of a constituency, or { finalized: false }: nothing else about the count is ever read */
  readResult(constituencyCode: string): Promise<ElectionResult>;
  /** every constituency of the election (public registry data) and whether its result is finalized */
  listConstituencies(): Promise<{ code: string; name: string; id: string; finalized: boolean }[]>;
}

type Call = (...args: unknown[]) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface VoteChainView {
  phase: Call;
  ELECTION_ID: Call;
  electionKeyX: Call;
  electionKeyY: Call;
  SEMAPHORE_DEPTH: Call;
  semaphore: Call;
  scope: Call;
  constituencyCount: Call;
  constituencyIdAt: Call;
  getConstituency: Call;
  candidateName: Call;
  ballotHashOf: Call;
  nullifierUsed: Call;
  isFinalized: Call;
  finalResult: Call;
  queryFilter: Call;
  filters: { BallotRecorded: (...args: unknown[]) => unknown };
  interface: Contract["interface"];
}
interface SemaphoreView {
  getMerkleTreeRoot: Call;
  getMerkleTreeSize: Call;
  hasMember: Call;
}

const unreachable = (err: unknown): KioskError => (err instanceof KioskError ? err : new KioskError("CHAIN_UNREACHABLE", "The election network could not be read.", { retryable: true }));

export function createChainReader(config: KioskConfig, options: { provider?: Provider } = {}): ChainReader {
  const address = getAddress(config.contractAddress);
  const provider: Provider =
    options.provider ??
    (() => {
      const network = Network.from(config.chainId);
      return new JsonRpcProvider(config.rpcUrl, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
    })();
  const contract = new Contract(address, VOTECHAIN_ABI, provider) as unknown as VoteChainView;
  let pinned: Promise<{ electionId: string; semaphore: SemaphoreView }> | null = null;

  /** chain id, contract code, election id and the Semaphore contract: checked once against the PINNED configuration */
  const pins = () =>
    (pinned ??= (async () => {
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== config.chainId) throw new KioskError("WRONG_CHAIN", "This kiosk is connected to the wrong network.");
      if ((await provider.getCode(address)) === "0x") throw new KioskError("WRONG_CONTRACT", "There is no election contract at the configured address.");
      const electionId = String(await contract.ELECTION_ID()).toLowerCase();
      if (config.electionId && config.electionId.toLowerCase() !== electionId) throw new KioskError("WRONG_ELECTION", "The election on the network is not the one this kiosk is configured for.");
      return { electionId, semaphore: new Contract(String(await contract.semaphore()), SEMAPHORE_ABI, provider) as unknown as SemaphoreView };
    })().catch((err: unknown) => {
      pinned = null;
      throw unreachable(err);
    }));

  async function constituencyOf(code: string) {
    const id = constituencyIdOf(code);
    try {
      const c = await contract.getConstituency(id);
      if (c.code !== code) throw new KioskError("WRONG_CONSTITUENCY", "Your constituency is not configured as expected.");
      return { id, c };
    } catch (err) {
      if (err instanceof KioskError) throw err;
      if ((err as { revert?: { name?: string } })?.revert?.name === "UnknownConstituency") throw new KioskError("UNKNOWN_CONSTITUENCY", "Your constituency is not part of this election.");
      throw unreachable(err);
    }
  }

  return {
    async pinElection(code) {
      try {
        const { electionId } = await pins();
        const phase = Number(await contract.phase());
        if (phase === 0) throw new KioskError("ELECTION_NOT_OPEN", "The election is not open yet.");
        if (phase === 2) throw new KioskError("ELECTION_CLOSED", "The election is closed.");
        const { id, c } = await constituencyOf(code);
        const kc = Number(c.candidateCount);
        if (!Number.isInteger(kc) || kc < 1 || kc > 16) throw new KioskError("BAD_ELECTION", "The candidate list of this constituency is not valid.");
        const candidates = await Promise.all(Array.from({ length: kc }, (_, j) => contract.candidateName(id, j).then(String)));
        const H: [bigint, bigint] = [BigInt(await contract.electionKeyX()), BigInt(await contract.electionKeyY())];
        // the election key is checked EVERY time (canonical, on the curve, in the prime-order subgroup): a ballot is never encrypted under anything else
        if (!validatePublicKey(H)) throw new KioskError("ELECTION_KEY_INVALID", "The election key is not valid.");
        const depth = Number(await contract.SEMAPHORE_DEPTH());
        if (depth !== SEMAPHORE_DEPTH) throw new KioskError("BAD_ELECTION", "The election uses an unsupported group size.");
        const ctx = { chainId: BigInt(config.chainId), contractAddress: BigInt(address), electionId: BigInt(electionId) };
        // the scope is recomputed LOCALLY from the pinned context and must be what the contract itself uses
        if (BigInt(await contract.scope()) !== electionScope(ctx)) throw new KioskError("BAD_ELECTION", "The election scope does not match this kiosk's configuration.");
        return { ctx, electionId, constituency: { code, id }, constituencyName: String(c.name), kc, candidates, H, groupId: BigInt(c.groupId), depth, semaphore: String(await contract.semaphore()) };
      } catch (err) {
        throw unreachable(err);
      }
    },

    async currentRoot(groupId) {
      try {
        const { semaphore } = await pins();
        const [root, size] = await Promise.all([semaphore.getMerkleTreeRoot(groupId), semaphore.getMerkleTreeSize(groupId)]);
        return { root: BigInt(root), size: Number(size) };
      } catch (err) {
        throw unreachable(err);
      }
    },

    async hasMember(groupId, commitment) {
      try {
        const { semaphore } = await pins();
        return Boolean(await semaphore.hasMember(groupId, commitment));
      } catch (err) {
        throw unreachable(err);
      }
    },

    async ballotHashOf(constituencyId, activeCoords) {
      try {
        await pins();
        return BigInt(await contract.ballotHashOf(constituencyId, activeCoords));
      } catch (err) {
        // a REVERT (wrong coordinate count for this constituency, unknown constituency) means this kiosk and the contract disagree about the ballot: not a network problem
        if ((err as { code?: string })?.code === "CALL_EXCEPTION") throw new KioskError("BALLOT_HASH_MISMATCH", "The election network does not accept this ballot's shape. Nothing was sent.");
        throw unreachable(err);
      }
    },

    async findRecorded(expected, txHash) {
      try {
        await pins();
        let log: { blockNumber: number; transactionHash: string; args: { constituencyId: string; nullifier: bigint; ballotIndex: bigint; ballotHash: bigint; coords: bigint[] } } | null = null;
        if (txHash) {
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt) {
            if (receipt.status !== 1) throw new KioskError("TX_FAILED", "The network rejected the ballot transaction.");
            for (const entry of receipt.logs) {
              if (entry.address.toLowerCase() !== address.toLowerCase()) continue;
              const parsed = contract.interface.parseLog(entry);
              if (parsed?.name === "BallotRecorded" && BigInt(parsed.args.nullifier) === BigInt(expected.nullifier)) log = { blockNumber: entry.blockNumber, transactionHash: entry.transactionHash, args: parsed.args as never };
            }
          }
        }
        if (!log) {
          // the nullifier is an indexed topic: ask the chain directly, whoever sent the transaction
          const found = await contract.queryFilter(contract.filters.BallotRecorded(null, BigInt(expected.nullifier)), 0, "latest");
          const first = found[0] as unknown as { blockNumber: number; transactionHash: string; args: never } | undefined;
          if (first) log = first as never;
        }
        if (!log) return null;
        const a = log.args;
        const same = String(a.constituencyId).toLowerCase() === expected.constituencyId.toLowerCase() && BigInt(a.ballotHash) === BigInt(expected.ballotHash) && [...a.coords].length === expected.coords.length && [...a.coords].every((c, i) => BigInt(c) === BigInt(expected.coords[i]!));
        if (!same || BigInt(a.nullifier) !== BigInt(expected.nullifier)) throw new KioskError("CONFIRMATION_MISMATCH", "The recorded ballot does not match the ballot this kiosk prepared. Nothing was confirmed.");
        if (!(await contract.nullifierUsed(BigInt(expected.nullifier)))) return null;
        const block = await provider.getBlock(log.blockNumber);
        if (!block) return null;
        return { constituencyId: expected.constituencyId, ballotIndex: Number(a.ballotIndex), ballotHash: BigInt(a.ballotHash).toString(), txHash: log.transactionHash, blockNumber: log.blockNumber, blockHash: block.hash ?? "", blockTimestamp: block.timestamp };
      } catch (err) {
        throw unreachable(err);
      }
    },

    async listConstituencies() {
      try {
        await pins();
        const count = Number(await contract.constituencyCount());
        const out: { code: string; name: string; id: string; finalized: boolean }[] = [];
        for (let i = 0; i < count; i++) {
          const id = String(await contract.constituencyIdAt(i));
          const [c, finalized] = await Promise.all([contract.getConstituency(id), contract.isFinalized(id)]);
          out.push({ code: String(c.code), name: String(c.name), id, finalized: Boolean(finalized) });
        }
        return out;
      } catch (err) {
        throw unreachable(err);
      }
    },

    async readResult(code) {
      try {
        await pins();
        const { id, c } = await constituencyOf(code);
        if (!(await contract.isFinalized(id))) return { finalized: false };
        const kc = Number(c.candidateCount);
        const [result, names] = await Promise.all([contract.finalResult(id), Promise.all(Array.from({ length: kc }, (_, j) => contract.candidateName(id, j).then(String)))]);
        return { finalized: true, constituency: { code, id }, candidates: names.map((name, j) => ({ name, votes: Number(result.totals[j]) })), ballotCount: Number(result.ballotCount), resultsHash: String(result.resultsHash) };
      } catch (err) {
        throw unreachable(err);
      }
    },
  };
}
