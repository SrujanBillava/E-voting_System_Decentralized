import { AppError } from "../utils/errors.js";
import { unavailable } from "../chain/chain.js";

const CODE = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

/**
 * THE PUBLIC GROUP DATA PATH: everything a kiosk needs to build a Semaphore membership proof LOCALLY, from public chain data only.
 *
 *   - the FULL ordered leaf set of the constituency's group (every commitment ever inserted, in leaf order),
 *   - the current root and size, and a checkpoint (size, root, block time) after every batch, so a client can choose a root the contract still accepts,
 *   - the declared proof depth.
 *
 * It is NOT a Merkle-proof service and it knows no voter: it cannot answer "where is MY commitment"; the kiosk rebuilds the tree itself, checks that its
 * own commitment is a leaf, and that the rebuilt root equals the chain's. There is no secret witness and no identity-linked lookup anywhere on this path.
 */
export function createGroupsService({ chain }) {
  return {
    async group(key) {
      const { keccak256, toUtf8Bytes } = await import("ethers");
      let constituencyId;
      if (/^0x[0-9a-fA-F]{64}$/.test(key)) constituencyId = key.toLowerCase();
      else if (CODE.test(key) && key.length <= 40) constituencyId = keccak256(toUtf8Bytes(key));
      else throw new AppError(400, "VALIDATION_FAILED", "Invalid request: constituency");
      const constituency = await chain.readConstituency(constituencyId);
      if (!constituency) throw new AppError(404, "NOT_FOUND", "Unknown constituency");

      const { semaphore, provider } = chain;
      let logs;
      let root;
      let size;
      try {
        logs = await semaphore.queryFilter(semaphore.filters.MembersAdded(constituency.groupId), 0, "latest");
        [root, size] = await Promise.all([semaphore.getMerkleTreeRoot(constituency.groupId), semaphore.getMerkleTreeSize(constituency.groupId)]);
      } catch {
        throw unavailable();
      }
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      const leaves = [];
      const checkpoints = [];
      for (const log of logs) {
        if (Number(log.args.startIndex) !== leaves.length) throw new AppError(503, "GROUP_INCONSISTENT", "The group's events are not contiguous");
        leaves.push(...[...log.args.identityCommitments].map(String));
        let timestamp = null;
        try {
          timestamp = (await provider.getBlock(log.blockNumber))?.timestamp ?? null;
        } catch {
          throw unavailable();
        }
        checkpoints.push({ size: leaves.length, root: String(log.args.merkleTreeRoot), blockNumber: log.blockNumber, timestamp });
      }
      if (leaves.length !== Number(size)) throw new AppError(503, "GROUP_INCONSISTENT", "The group's events do not add up to its size");
      return { constituencyId, groupId: constituency.groupId.toString(), merkleTreeDepth: chain.declaredDepth, root: String(root), size: Number(size), leaves, checkpoints };
    },
  };
}
