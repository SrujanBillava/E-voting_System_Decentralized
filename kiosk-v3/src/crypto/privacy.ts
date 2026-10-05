// THE FROZEN CORE, imported verbatim from ../privacy-v3 (nothing is re-implemented here; the typed signatures below only describe it). In the browser three build-time shims
// (vite.config.ts) stand in for its Node-only edges.
import { assertValidPublicKey as assertValidPublicKeyJs, validatePublicKey as validatePublicKeyJs } from "../../../privacy-v3/src/elgamal.js";
import { ballotHash as ballotHashJs, padCiphertexts as padCiphertextsJs, validityCircuitInput as validityCircuitInputJs, validityPublicSignals as validityPublicSignalsJs } from "../../../privacy-v3/src/ballot.js";
import { SEMAPHORE_DEPTH, K_MAX, constituencyIdOf as constituencyIdOfJs, constituencyIdValue as constituencyIdValueJs, electionScope as electionScopeJs } from "../../../privacy-v3/src/params.js";
import { Group as GroupJs, Identity as IdentityJs, nullifierOf as nullifierOfJs, proveMembership as proveMembershipJs } from "../../../privacy-v3/src/semaphore.js";
import { prepareBallot as prepareBallotJs, wireCiphertexts as wireCiphertextsJs } from "../../../privacy-v3/src/voter.js";
import { proveValidity as proveValidityJs } from "../../../privacy-v3/src/validity.js";
import type { Groth16Proof, SemaphoreProofWire, WireCiphertext } from "../core/types.ts";

export type Point = [bigint, bigint];
export interface Ciphertext {
  c1: Point;
  c2: Point;
}
export interface Context {
  chainId: bigint;
  contractAddress: bigint;
  electionId: bigint;
}
export interface PreparedBallot {
  constituencyId: bigint;
  scope: bigint;
  nullifier: bigint;
  /** SECRET: the one-hot vector. Exists only in memory while the proofs are made. */
  m: bigint[];
  /** SECRET: the per-slot encryption randomness. Exists only in memory while the proofs are made. */
  r: bigint[];
  ciphertexts: Ciphertext[];
  hash: bigint;
  encryptMs: number;
}
export interface IdentityLike {
  readonly commitment: bigint;
  export(): string;
}
export interface GroupLike {
  readonly root: bigint | string;
  readonly depth: number;
  readonly members: bigint[];
}

export const Identity = IdentityJs as unknown as { new (privateKey?: string): IdentityLike; import(exported: string): IdentityLike };
export const Group = GroupJs as unknown as { new (leaves?: bigint[]): GroupLike };
export type Identity = IdentityLike;
export type Group = GroupLike;

export { K_MAX, SEMAPHORE_DEPTH };
export const assertValidPublicKey = assertValidPublicKeyJs as (H: Point) => void;
export const validatePublicKey = validatePublicKeyJs as (H: Point) => boolean;
export const ballotHash = ballotHashJs as (ctx: Context, constituencyId: bigint, ciphertexts: Ciphertext[]) => bigint;
export const padCiphertexts = padCiphertextsJs as (real: Ciphertext[]) => Ciphertext[];
export const constituencyIdOf = constituencyIdOfJs as (code: string) => string;
export const constituencyIdValue = constituencyIdValueJs as (code: string) => bigint;
export const electionScope = electionScopeJs as (ctx: Context) => bigint;
export const nullifierOf = nullifierOfJs as (identity: IdentityLike, scope: bigint) => bigint;
export const validityPublicSignals = validityPublicSignalsJs as (input: { kc: number; H: Point; nullifier: bigint; ciphertexts: Ciphertext[] }) => string[];
export const validityCircuitInput = validityCircuitInputJs as (input: { kc: number; H: Point; nullifier: bigint; ciphertexts: Ciphertext[]; m: bigint[]; r: bigint[] }) => Record<string, unknown>;
export const prepareBallot = prepareBallotJs as unknown as (input: { identity: IdentityLike; ctx: Context; constituency: string; kc: number; choice: number; H: Point }) => PreparedBallot;
export const wireCiphertexts = wireCiphertextsJs as (ciphertexts: Ciphertext[], kc: number) => WireCiphertext[];
export const proveValidity = proveValidityJs as unknown as (input: Record<string, unknown>) => Promise<{ proof: Groth16Proof; publicSignals: string[]; timings: { witnessMs: number; proveMs: number } }>;
export const proveMembership = proveMembershipJs as (input: { identity: IdentityLike; group: GroupLike; message: bigint; scope: bigint; depth: number }) => Promise<SemaphoreProofWire>;
