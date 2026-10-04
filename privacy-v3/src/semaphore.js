// Thin adapter over Semaphore V4 (identity, group, proof). One group per constituency, ONE election-wide scope.
import { Group } from "@semaphore-protocol/group";
import { Identity } from "@semaphore-protocol/identity";
import { generateProof, verifyProof } from "@semaphore-protocol/proof";
import { keccak256, toBeHex } from "ethers";
import { poseidon2 } from "poseidon-lite";
import { requireArtifacts, semaphoreArtifacts } from "./artifacts.js";
import { SEMAPHORE_DEPTH } from "./params.js";

export { Group, Identity };

/** Same transformation Semaphore applies to scope and message before they enter its circuit (keccak256 >> 8). */
export const semaphoreHash = (value) => BigInt(keccak256(toBeHex(BigInt(value), 32))) >> 8n;

/** The nullifier Semaphore v4 derives: Poseidon(hash(scope), identity secret scalar). proveMembership() asserts it equals the proof's nullifier. */
export const nullifierOf = (identity, scope) => poseidon2([semaphoreHash(scope), identity.secretScalar]);

export const makeGroup = (identities) => new Group(identities.map((i) => i.commitment));

/**
 * Anonymous membership proof whose `message` is the ballot hash. Throws if the identity is not a member of the group.
 * The proof is generated at the DECLARED depth (frozen architecture: 20), whatever the group's natural depth: a 5-member group still proves at depth 20.
 * The circuit artifacts are ALWAYS passed explicitly from artifacts/semaphore (pinned, SHA-256 checked by the build); this adapter never lets the
 * Semaphore library fall back to downloading them at runtime, and it throws if a file is missing.
 */
export async function proveMembership({ identity, group, message, scope, depth = SEMAPHORE_DEPTH }) {
  if (!Number.isInteger(depth) || depth < 1 || depth > 32) throw new RangeError("Semaphore depth must be an integer in 1..32");
  if (group.depth > depth) throw new RangeError(`the group needs depth ${group.depth}, which exceeds the declared depth ${depth}`);
  const artifacts = semaphoreArtifacts(depth);
  requireArtifacts(artifacts.wasm, artifacts.zkey);
  const proof = await generateProof(identity, group, message, scope, depth, artifacts);
  const expected = nullifierOf(identity, scope).toString();
  if (proof.nullifier !== expected) throw new Error("Semaphore nullifier formula changed: nullifierOf() no longer matches the proof");
  return proof;
}

/** Cryptographic check only (the caller checks root, scope and message). Never throws. */
export async function verifyMembership(proof) {
  try {
    return (await verifyProof(proof)) === true;
  } catch {
    return false;
  }
}
