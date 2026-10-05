import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Group } from "../../src/crypto/privacy.ts";
import { KioskError, verifyPublicGroup } from "../../src/core/index.ts";
import type { ChainReader, ElectionParams, RelayClient } from "../../src/core/index.ts";

const CID = "0x" + "ab".repeat(32);
const leaves = [111111111111111111n, 222222222222222222n, 333333333333333333n, 444444444444444444n];
const params = { groupId: 7n, depth: 20, constituency: { code: "KA-BLR", id: CID } } as unknown as ElectionParams;
const rootOf = (l: bigint[]) => BigInt(new Group(l).root);

function world(over: { data?: Record<string, unknown>; chain?: { root?: bigint; size?: number; member?: boolean } } = {}) {
  const data = { constituencyId: CID, groupId: "7", merkleTreeDepth: 20, root: rootOf(leaves).toString(), size: leaves.length, leaves: leaves.map(String), checkpoints: [], ...over.data };
  const relay = { getGroup: async () => data } as unknown as RelayClient;
  const chain = { currentRoot: async () => ({ root: over.chain?.root ?? rootOf(leaves), size: over.chain?.size ?? leaves.length }), hasMember: async () => over.chain?.member ?? true } as unknown as ChainReader;
  return { relay, chain };
}
const code = (c: string, retryable?: boolean) => (e: unknown) => e instanceof KioskError && e.code === c && (retryable === undefined || e.retryable === retryable);

describe("verifyPublicGroup: the kiosk trusts nobody's Merkle witness", () => {
  it("rebuilds the tree locally and returns the voter's index and the contract's root", async () => {
    const verified = await verifyPublicGroup({ ...world(), params, commitment: leaves[2]! });
    assert.equal(verified.index, 2);
    assert.equal(verified.size, 4);
    assert.equal(verified.root, rootOf(leaves));
    assert.equal(BigInt(verified.group.root), rootOf(leaves));
  });

  it("refuses a voter whose commitment is not in the list, and one the CONTRACT does not list even if the service does", async () => {
    await assert.rejects(verifyPublicGroup({ ...world(), params, commitment: 999n }), code("COMMITMENT_NOT_IN_GROUP"));
    await assert.rejects(verifyPublicGroup({ ...world({ chain: { member: false } }), params, commitment: leaves[0]! }), code("COMMITMENT_NOT_IN_GROUP"));
  });

  it("refuses a service that LIES about the root (not retryable), and a service that is merely behind the contract (retryable)", async () => {
    await assert.rejects(verifyPublicGroup({ ...world({ data: { root: "12345" } }), params, commitment: leaves[0]! }), code("ROOT_MISMATCH", false));
    await assert.rejects(verifyPublicGroup({ ...world({ chain: { root: 777n } }), params, commitment: leaves[0]! }), code("ROOT_MISMATCH", true));
    await assert.rejects(verifyPublicGroup({ ...world({ chain: { size: 9 } }), params, commitment: leaves[0]! }), code("ROOT_MISMATCH", true));
  });

  it("refuses data for another constituency or group, another depth, an inconsistent size, a repeated, malformed or out-of-field leaf", async () => {
    const bad: Record<string, unknown>[] = [
      { constituencyId: "0x" + "cd".repeat(32) },
      { groupId: "8" },
      { merkleTreeDepth: 16 },
      { size: 5 },
      { leaves: [...leaves.map(String), leaves[0]!.toString()], size: 5 },
      { leaves: ["0", ...leaves.slice(1).map(String)] },
      { leaves: ["0x10", ...leaves.slice(1).map(String)] },
      { leaves: ["0123", ...leaves.slice(1).map(String)] },
      { leaves: ["21888242871839275222246405745257275088548364400416034343698204186575808495617", ...leaves.slice(1).map(String)] },
      { leaves: [5, ...leaves.slice(1).map(String)] },
    ];
    for (const data of bad) await assert.rejects(verifyPublicGroup({ ...world({ data }), params, commitment: leaves[1]! }), code("GROUP_MISMATCH"), JSON.stringify(data).slice(0, 80));
  });
});
