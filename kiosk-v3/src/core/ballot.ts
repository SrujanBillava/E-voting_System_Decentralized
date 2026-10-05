import { id as keccakOfText } from "ethers";
import { Group, Identity, ballotHash, constituencyIdValue, padCiphertexts, prepareBallot, proveMembership, proveValidity, validityCircuitInput, validityPublicSignals, wireCiphertexts } from "../crypto/privacy.ts";
import type { ChainReader } from "./chain.ts";
import { KioskError } from "./errors.ts";
import type { RelayWirePackage } from "./http.ts";
import type { BallotRecord, ElectionParams, SemaphoreProofWire, WireCiphertext } from "./types.ts";

export type PrepareStep = "encrypting" | "checking" | "validity-proof" | "membership-proof";
export interface PrepareTimings {
  encryptMs: number;
  validityWitnessMs: number;
  validityProveMs: number;
  semaphoreProveMs: number;
  totalMs: number;
}

const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/** keccak256 over everything an ordinary retry must NOT change: the ciphertexts, the validity proof, the nullifier, the ballot hash and the context they are bound to */
export function digestOf(record: Omit<BallotRecord, "digest" | "membership" | "relay">): string {
  const { constituency, kc, H, ctx, scope, nullifier, ballotHash: hash, ciphertexts, validity } = record;
  return keccakOfText(sortedJson({ constituency, kc, H, ctx, scope, nullifier, ballotHash: hash, ciphertexts, validity }));
}

const toBig = (c: WireCiphertext) => ({ c1: [BigInt(c.c1[0]), BigInt(c.c1[1])] as [bigint, bigint], c2: [BigInt(c.c2[0]), BigInt(c.c2[1])] as [bigint, bigint] });
const activeCoords = (ciphertexts: WireCiphertext[]): string[] => ciphertexts.flatMap((c) => [...c.c1, ...c.c2]);

/**
 * Re-checks a stored package: it is the package it says it is. The digest must match, the ballot hash must be what the FROZEN encoding gives for these exact ciphertexts
 * (canonical order, canonical identity padding), and the membership proof must be about this very ballot hash, scope and nullifier. A damaged or edited record is refused.
 */
export function assertRecordIntact(record: BallotRecord): void {
  const bad = (what: string): never => {
    throw new KioskError("PACKAGE_DAMAGED", `The stored ballot package is not intact (${what}). It was not sent.`);
  };
  if (digestOf(record) !== record.digest) bad("digest");
  const ctx = { chainId: BigInt(record.ctx.chainId), contractAddress: BigInt(record.ctx.contractAddress), electionId: BigInt(record.ctx.electionId) };
  if (record.ciphertexts.length !== record.kc) bad("ciphertext count");
  const recomputed = ballotHash(ctx, constituencyIdValue(record.constituency.code), padCiphertexts(record.ciphertexts.map(toBig)));
  if (recomputed.toString() !== record.ballotHash) bad("ballot hash");
  const m = record.membership;
  if (m.nullifier !== record.nullifier || m.message !== record.ballotHash || m.scope !== record.scope) bad("membership proof");
}

/**
 * Builds the IMMUTABLE anonymous ballot. Everything secret (the one-hot vector, the encryption randomness) exists only inside this function's memory while the proofs are made:
 * it is never returned and never stored. Uses the FROZEN privacy-v3 functions: prepareBallot (validates H, encrypts every active slot with fresh CSPRNG randomness, hashes),
 * proveValidity (the 68-signal Groth16 circuit) and proveMembership (Semaphore V4 at depth 20, message = the ballot hash, scope = the election scope).
 */
export async function buildBallot(input: { identity: Identity; params: ElectionParams; choice: number; group: Group; chain: ChainReader; onStep?: (step: PrepareStep) => void }): Promise<{ record: BallotRecord; timings: PrepareTimings }> {
  const { identity, params, choice, group, chain } = input;
  const step = input.onStep ?? (() => undefined);
  const t0 = performance.now();
  if (!Number.isInteger(choice) || choice < 0 || choice >= params.kc) throw new KioskError("BAD_CHOICE", "Please choose one of the candidates.");

  step("encrypting");
  const ballot = prepareBallot({ identity, ctx: params.ctx, constituency: params.constituency.code, kc: params.kc, choice, H: params.H });
  const { nullifier, hash, ciphertexts, scope } = ballot;
  const wire = wireCiphertexts(ciphertexts, params.kc) as WireCiphertext[];

  // The contract computes the same hash itself. If H, K_c, the election id or the chain id this kiosk used were not the contract's, they differ HERE, before any proof is wasted.
  step("checking");
  const onChain = await chain.ballotHashOf(params.constituency.id, activeCoords(wire).map(BigInt));
  if (onChain !== hash) throw new KioskError("BALLOT_HASH_MISMATCH", "The election network computes a different ballot fingerprint than this kiosk. Nothing was sent.");

  step("validity-proof");
  const validity = await proveValidity(validityCircuitInput({ kc: params.kc, H: params.H, nullifier, ciphertexts, m: ballot.m, r: ballot.r }));
  const expected = validityPublicSignals({ kc: params.kc, H: params.H, nullifier, ciphertexts });
  if (JSON.stringify(validity.publicSignals) !== JSON.stringify(expected)) throw new KioskError("PROOF_FAILED", "The ballot proof does not match the ballot. Nothing was sent.");

  // best effort (JavaScript cannot guarantee erasure): drop the secret witness the moment the validity proof exists
  ballot.m.length = 0;
  ballot.r.length = 0;

  step("membership-proof");
  const semaphoreStart = performance.now();
  const proof = (await proveMembership({ identity, group, message: hash, scope, depth: params.depth })) as SemaphoreProofWire;
  const semaphoreProveMs = performance.now() - semaphoreStart;
  if (proof.nullifier !== nullifier.toString()) throw new KioskError("PROOF_FAILED", "The membership proof and the ballot proof disagree. Nothing was sent.");

  const core = {
    v: 1 as const,
    constituency: params.constituency,
    kc: params.kc,
    H: [params.H[0].toString(), params.H[1].toString()] as [string, string],
    ctx: { chainId: params.ctx.chainId.toString(), contractAddress: params.ctx.contractAddress.toString(), electionId: params.ctx.electionId.toString() },
    scope: scope.toString(),
    nullifier: nullifier.toString(),
    ballotHash: hash.toString(),
    ciphertexts: wire,
    validity: { proof: validity.proof },
  };
  const record: BallotRecord = { ...core, digest: digestOf(core), membership: proof };
  assertRecordIntact(record);
  return { record, timings: { encryptMs: ballot.encryptMs, validityWitnessMs: validity.timings.witnessMs, validityProveMs: validity.timings.proveMs, semaphoreProveMs, totalMs: performance.now() - t0 } };
}

/**
 * ROOT REFRESH. When the selected root is no longer accepted, ONLY the Semaphore membership proof is regenerated, against the current root, for the SAME ballot hash, scope and
 * nullifier. The ciphertexts, their randomness, the validity proof and the digest are untouched (the result is checked to be the same underlying vote package).
 */
export async function refreshMembership(input: { identity: Identity; record: BallotRecord; group: Group; depth: number }): Promise<BallotRecord> {
  const { identity, record, group, depth } = input;
  const proof = (await proveMembership({ identity, group, message: BigInt(record.ballotHash), scope: BigInt(record.scope), depth })) as SemaphoreProofWire;
  const refreshed: BallotRecord = { ...record, membership: proof };
  if (refreshed.digest !== record.digest || proof.nullifier !== record.nullifier) throw new KioskError("PROOF_FAILED", "The refreshed proof does not belong to the same ballot.");
  assertRecordIntact(refreshed);
  return refreshed;
}

/** The exact relay-v3 package: the arguments of VoteChainV3.submitBallot as canonical decimal strings, built from the stored record. */
export function toRelayPackage(record: BallotRecord): RelayWirePackage {
  const p = record.validity.proof;
  const m = record.membership;
  const [a0, a1] = [p.pi_a[0], p.pi_a[1]] as [string, string];
  const b = p.pi_b as [string[], string[]];
  const c = p.pi_c as [string, string];
  return {
    constituencyId: record.constituency.id,
    membership: { merkleTreeDepth: String(m.merkleTreeDepth), merkleTreeRoot: m.merkleTreeRoot, nullifier: m.nullifier, points: m.points.map(String) },
    coords: activeCoords(record.ciphertexts),
    validity: { a: [a0, a1], b: [[b[0]![1]!, b[0]![0]!], [b[1]![1]!, b[1]![0]!]], c: [c[0], c[1]] },
  };
}

export const expectedOf = (record: BallotRecord) => ({ constituencyId: record.constituency.id, nullifier: record.nullifier, ballotHash: record.ballotHash, coords: activeCoords(record.ciphertexts) });
