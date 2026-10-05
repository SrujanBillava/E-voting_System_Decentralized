import { Group } from "../crypto/privacy.ts";
import type { ChainReader } from "./chain.ts";
import { KioskError } from "./errors.ts";
import type { RelayClient } from "./http.ts";
import type { ElectionParams } from "./types.ts";

const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export interface VerifiedGroup {
  group: InstanceType<typeof Group>;
  root: bigint;
  size: number;
  index: number;
}

/**
 * The kiosk does NOT trust a Merkle witness from anybody (there is none to ask for). It takes the FULL public leaf set, rebuilds the depth-20 tree itself and checks:
 *   1. the service answered for the right constituency and group, at the declared depth, with a consistent size;
 *   2. every leaf is a valid commitment, none is repeated;
 *   3. the rebuilt root equals the root the service claimed AND the contract's own current root, and the size equals the contract's;
 *   4. the voter's EXACT commitment is one of the leaves (and the contract agrees it is a member of this group).
 * The root it returns is the contract's CURRENT root, which the contract accepts by definition.
 */
export async function verifyPublicGroup(input: { relay: RelayClient; chain: ChainReader; params: ElectionParams; commitment: bigint }): Promise<VerifiedGroup> {
  const { relay, chain, params, commitment } = input;
  const data = await relay.getGroup(params.constituency.id);
  if (data.constituencyId.toLowerCase() !== params.constituency.id.toLowerCase() || BigInt(data.groupId) !== params.groupId) throw new KioskError("GROUP_MISMATCH", "The public group data is for another constituency.");
  if (data.merkleTreeDepth !== params.depth) throw new KioskError("GROUP_MISMATCH", "The public group data uses an unexpected depth.");
  if (!Array.isArray(data.leaves) || data.leaves.length !== data.size) throw new KioskError("GROUP_MISMATCH", "The public group data is inconsistent.");
  const leaves = data.leaves.map((leaf) => {
    if (typeof leaf !== "string" || !/^[1-9][0-9]{0,77}$/.test(leaf)) throw new KioskError("GROUP_MISMATCH", "The public group data contains an invalid entry.");
    const value = BigInt(leaf);
    if (value >= FIELD_PRIME) throw new KioskError("GROUP_MISMATCH", "The public group data contains an invalid entry.");
    return value;
  });
  if (new Set(leaves).size !== leaves.length) throw new KioskError("GROUP_MISMATCH", "The public group data repeats an entry.");

  const group = new Group(leaves);
  const root = BigInt(group.root);
  if (root !== BigInt(data.root)) throw new KioskError("ROOT_MISMATCH", "The public group does not rebuild to the root it claims.");
  const onChain = await chain.currentRoot(params.groupId);
  if (root !== onChain.root || leaves.length !== onChain.size) throw new KioskError("ROOT_MISMATCH", "The public group does not match the election network. Please try again in a moment.", { retryable: true });

  const index = leaves.indexOf(commitment);
  if (index < 0) throw new KioskError("COMMITMENT_NOT_IN_GROUP", "Your credential was not found in the public list for your constituency.");
  if (!(await chain.hasMember(params.groupId, commitment))) throw new KioskError("COMMITMENT_NOT_IN_GROUP", "Your credential was not found in the public list for your constituency.");
  return { group, root, size: leaves.length, index };
}
