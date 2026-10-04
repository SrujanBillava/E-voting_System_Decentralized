// Test world for VoteChainV3. Every call of newWorld() builds a FRESH in-process network, so account 0's first transaction is always the
// VoteChainV3 deployment and the contract lands at the address used in privacy-v3's frozen vectors (0x5FbD...0aa3, chain id 31337).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";
import { ballotHash } from "../../../privacy-v3/src/ballot.js";
import { semaphoreArtifacts, validityArtifacts } from "../../../privacy-v3/src/artifacts.js";
import { generateTestKeyPair } from "../../../privacy-v3/src/elgamal.js";
import { TEST_CONTEXT, constituencyIdOf } from "../../../privacy-v3/src/params.js";
import { makeGroup } from "../../../privacy-v3/src/semaphore.js";
import { castBallot } from "../../../privacy-v3/src/voter.js";
import { shutdownProver } from "../../../privacy-v3/src/validity.js";
import { fakeVoter } from "../../../privacy-v3/testing/fake-voters.js";

// snarkjs keeps worker threads alive: end them once, after the whole run (a root-level hook: this module is imported by every test file).
after(async () => {
  await shutdownProver();
});

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.resolve(here, "..", "..");
export const CORE = path.resolve(PROJECT, "..", "privacy-v3");
export const vectors = JSON.parse(fs.readFileSync(path.join(CORE, "spec", "vectors.json"), "utf8"));

export const ctx = TEST_CONTEXT;
export const ELECTION_ID = vectors.scope.vectors[0].electionId; // the frozen test election id (bytes32)
export const Phase = { Setup: 0n, Open: 1n, Closed: 2n };
export const CLOSE_GRACE = 20 * 60;
export const EPOCH = 30;

export const artifactsPresent = [validityArtifacts.wasm, validityArtifacts.zkey, validityArtifacts.vkey, semaphoreArtifacts(20).wasm, semaphoreArtifacts(20).zkey].every((f) => fs.existsSync(f));
export const SKIP_NO_ARTIFACTS = artifactsPresent ? false : "privacy-v3 build artifacts missing: run `npm run build:circuit` in ../privacy-v3";
/** Mocha: tests that generate real proofs need the privacy-v3 artifacts; without them they are reported as pending, never silently dropped. */
export const describeWithProofs = artifactsPresent ? describe : describe.skip;

/** The standard constituencies of the test election: code -> candidate count (and the issuance cap). */
export const CONSTITUENCIES = {
  "KA-BLR": { kc: 3, cap: 50 }, // Bengaluru: the demo A/B/A election
  "MH-MUM": { kc: 4, cap: 50 }, // Mumbai
  "TN-CHE": { kc: 3, cap: 50 }, // Chennai: same candidate count as Bengaluru, used for wrong-group tests
  "C02": { kc: 2, cap: 50 },
  "C08": { kc: 8, cap: 50 },
  "C16": { kc: 16, cap: 50 },
  "BATCH": { kc: 2, cap: 1000 }, // commitment-batch gas tests
};
export const cid = constituencyIdOf;

/** Builds the network, deploys the official Semaphore stack + the generated validity verifier + VoteChainV3 (in Setup). */
export async function newWorld({ closeGrace = CLOSE_GRACE } = {}) {
  const { ethers, networkHelpers, networkConfig } = await network.create();
  const [owner, depDeployer, issuer, attacker, relayer, newOwner, stranger] = await ethers.getSigners();

  // dependencies are deployed by account 1 so that account 0's first transaction is VoteChainV3
  const poseidon = await ethers.deployContract("PoseidonT3", [], depDeployer);
  const semaphoreVerifier = await ethers.deployContract("SemaphoreVerifier", [], depDeployer);
  const SemaphoreFactory = await ethers.getContractFactory("Semaphore", { libraries: { PoseidonT3: await poseidon.getAddress() }, signer: depDeployer });
  const semaphore = await SemaphoreFactory.deploy(await semaphoreVerifier.getAddress());
  await semaphore.waitForDeployment();
  const validityVerifier = await ethers.deployContract("Groth16Verifier", [], depDeployer);

  const vc = await ethers.deployContract("VoteChainV3", [owner.address, ELECTION_ID, await semaphore.getAddress(), await validityVerifier.getAddress(), closeGrace], owner);
  const address = await vc.getAddress();
  if (address.toLowerCase() !== "0x" + ctx.contractAddress.toString(16)) throw new Error(`VoteChainV3 must land at the vector address, got ${address}`);

  return { ethers, networkHelpers, networkConfig, owner, depDeployer, issuer, attacker, relayer, newOwner, stranger, poseidon, semaphoreVerifier, semaphore, validityVerifier, vc, address };
}

/** Setup: issuer, TEST election key, every standard constituency with its candidates. Returns the key pair (test-only secret). */
export async function configure(world, { only } = {}) {
  const { vc, issuer } = world;
  const { secret, publicKey } = generateTestKeyPair();
  await (await vc.setIssuer(issuer.address)).wait();
  await (await vc.setElectionKey(publicKey[0], publicKey[1])).wait();
  const ids = {};
  for (const [code, { kc, cap }] of Object.entries(CONSTITUENCIES)) {
    if (only && !only.includes(code)) continue;
    await (await vc.addConstituency(code, `${code} constituency`, cap)).wait();
    ids[code] = cid(code);
    for (let j = 0; j < kc; j++) await (await vc.addCandidate(ids[code], `${code} candidate ${j}`)).wait();
  }
  return { secret, H: publicKey, ids };
}

/** Five fake, deterministic voters per constituency, and the JS Semaphore group in registration order. */
export function votersOf(code, n = 5) {
  const voters = Array.from({ length: n }, (_, i) => fakeVoter(`v3-contract:${code}-${i + 1}`));
  return { voters, group: makeGroup(voters) };
}

/** Issuer registers the commitments of `voters` as ONE batch. */
export async function register(world, code, voters) {
  const tx = await world.vc.connect(world.issuer).registerCommitmentBatch(cid(code), voters.map((v) => v.commitment));
  return tx.wait();
}

/** A complete, valid submission for the contract, built by the frozen privacy-v3 voter code. */
export async function makeBallot(world, { code, voters, group, index, choice, H, kc = CONSTITUENCIES[code].kc }) {
  const out = await castBallot({ identity: voters[index], group, ctx, constituency: code, kc, choice, H });
  return { ...out, args: toArgs(out.submission) };
}

/** Semaphore proof object (privacy-v3 wire format) -> the MembershipProof struct of VoteChainV3 */
export const membershipOf = (s) => ({ merkleTreeDepth: BigInt(s.merkleTreeDepth), merkleTreeRoot: BigInt(s.merkleTreeRoot), nullifier: BigInt(s.nullifier), points: s.points.map(BigInt) });

/** snarkjs Groth16 proof -> the ValidityProof struct (B in the order snarkjs' Solidity verifier expects) */
export const validityOf = (p) => ({
  a: [BigInt(p.pi_a[0]), BigInt(p.pi_a[1])],
  b: [[BigInt(p.pi_b[0][1]), BigInt(p.pi_b[0][0])], [BigInt(p.pi_b[1][1]), BigInt(p.pi_b[1][0])]],
  c: [BigInt(p.pi_c[0]), BigInt(p.pi_c[1])],
});

/** the ACTIVE-slot ciphertext coordinates (slot-major C1.x, C1.y, C2.x, C2.y) of the first kc of 16 ciphertexts */
export const coordsOf = (ciphertexts, kc) => ciphertexts.slice(0, kc).flatMap((c) => [c.c1[0], c.c1[1], c.c2[0], c.c2[1]]).map(BigInt);

/** wire submission -> the arguments of VoteChainV3.submitBallot */
export function toArgs(submission) {
  return {
    constituencyId: cid(submission.constituency),
    membership: membershipOf(submission.semaphore),
    coords: submission.ciphertexts.flatMap((c) => [...c.c1, ...c.c2].map(BigInt)),
    validity: validityOf(submission.validity.proof),
  };
}

export const submit = (world, args, signer = world.relayer) => world.vc.connect(signer).submitBallot(args.constituencyId, args.membership, args.coords, args.validity);
export const clone = (args) => ({ constituencyId: args.constituencyId, membership: { ...args.membership, points: [...args.membership.points] }, coords: [...args.coords], validity: { a: [...args.validity.a], b: args.validity.b.map((r) => [...r]), c: [...args.validity.c] } });

/** the frozen ballot hash of a ballot's padded coordinates, computed by the JS core */
export const jsBallotHash = (code, ciphertexts) => ballotHash(ctx, BigInt(cid(code)), ciphertexts);
