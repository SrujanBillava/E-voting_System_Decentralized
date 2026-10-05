// TEST SUPPORT. REAL anonymous ballot packages: real Semaphore membership proofs and real Groth16 validity proofs from the frozen privacy-v3 core.
import { keccak256, toUtf8Bytes } from "ethers";
import { TEST_CONTEXT } from "../../../privacy-v3/src/params.js";
import { makeGroup } from "../../../privacy-v3/src/semaphore.js";
import { castBallot } from "../../../privacy-v3/src/voter.js";
import { shutdownProver } from "../../../privacy-v3/src/validity.js";
import { fakeVoter } from "../../../privacy-v3/testing/fake-voters.js";

export { shutdownProver };
export const fakeIdentity = (label) => fakeVoter(label);

/** the wire format of the relayer (decimal strings, the arguments of submitBallot) from a privacy-v3 submission */
export function toWire(submission) {
  const d = (x) => BigInt(x).toString();
  const proof = submission.validity.proof;
  return {
    constituencyId: keccak256(toUtf8Bytes(submission.constituency)),
    membership: { merkleTreeDepth: d(submission.semaphore.merkleTreeDepth), merkleTreeRoot: d(submission.semaphore.merkleTreeRoot), nullifier: d(submission.semaphore.nullifier), points: submission.semaphore.points.map(d) },
    coords: submission.ciphertexts.flatMap((c) => [...c.c1, ...c.c2]).map(d),
    validity: { a: [d(proof.pi_a[0]), d(proof.pi_a[1])], b: [[d(proof.pi_b[0][1]), d(proof.pi_b[0][0])], [d(proof.pi_b[1][1]), d(proof.pi_b[1][0])]], c: [d(proof.pi_c[0]), d(proof.pi_c[1])] },
  };
}

/**
 * `count` voters of one constituency: their commitments (to be registered on-chain as ONE batch, in this order) and a ballot package for each, with
 * choices[i] as the vote of voter i. Proofs are generated here (a few seconds each).
 */
export async function makeVoters({ code, kc, count, H, label = "relay" }) {
  const voters = Array.from({ length: count }, (_, i) => fakeIdentity(`${label}:${code}-${i + 1}`));
  const group = makeGroup(voters);
  const packages = [];
  for (let i = 0; i < count; i++) {
    const out = await castBallot({ identity: voters[i], group, ctx: TEST_CONTEXT, constituency: code, kc, choice: i % kc, H });
    packages.push(toWire(out.submission));
  }
  return { voters, commitments: voters.map((v) => v.commitment), packages, group };
}
