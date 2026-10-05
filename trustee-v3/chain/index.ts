// The CHAIN ADAPTER: reads VoteChainV3 and submits one trustee's publication and endorsement. It is duck-typed over an injected ethers-style contract object (any
// object with the VoteChainV3 methods and filters), so this package has no runtime dependency on a chain library and src/ stays free of network code.
//
// PROCESS SEPARATION. Everything a trustee needs is ONE share file + the public transcript + public chain data: `publishFromShareFile` loads exactly one
// encrypted share (Trustee.restore) and nothing else. There is deliberately no function here that takes several trustees or several share files. In production
// every trustee runs this in its OWN OS process on its OWN machine, with its own signer; the auditor needs no secret at all. (Tests may hold several trustees
// in memory; that is a test convenience, not a supported workflow.)
import { auditConstituency, verifyFinalResult, verifyPinnedTranscript, type AuditResult, type PartialPublication, type PinnedConfiguration } from "../src/audit.ts";
import { BUNDLE_WORDS, bundleFromPartial, bundleHash } from "../src/bundle.ts";
import { verifyChainAggregate, type BallotLogEntry, type ContractConstituencyState } from "../src/chain-aggregate.ts";
import { hex32 } from "../src/encoding.ts";
import { InvalidInputError, VerificationError } from "../src/errors.ts";
import type { ElectionContext, Point } from "../src/params.ts";
import { readShareFile, type KdfParams } from "../src/storage.ts";
import { Trustee } from "../src/trustee.ts";

/** An ethers v6 Contract (or anything shaped like one) for a deployed VoteChainV3. Connect it to a trustee's signer to publish or endorse. */
export type VoteChainContract = Record<string, any>;

const PHASE_CLOSED = 2n;

/** bytes32 constituency id, from a bigint or a 0x-hex string */
export function constituencyKey(id: bigint | string): string {
  if (typeof id === "bigint") return hex32(id);
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new InvalidInputError("BAD_CONSTITUENCY", "a constituency id is a bytes32");
  return id.toLowerCase();
}

export async function readContext(contract: VoteChainContract): Promise<ElectionContext> {
  const runner = contract.runner;
  const provider = runner?.provider ?? runner;
  const network = await provider.getNetwork();
  return { chainId: BigInt(network.chainId), contractAddress: BigInt(await contract.getAddress()), electionId: BigInt(await contract.ELECTION_ID()) };
}

/** The trustee configuration the contract pinned in Setup, plus the context every hash is bound to. */
export async function readPinnedConfiguration(contract: VoteChainContract): Promise<PinnedConfiguration> {
  const config = await contract.trusteeConfiguration();
  if (!config.configured) throw new VerificationError("TRUSTEES_NOT_CONFIGURED", "the contract has no pinned trustee configuration");
  return {
    context: await readContext(contract),
    transcriptHash: BigInt(config.transcriptHash),
    electionKey: [BigInt(config.electionKeyX_), BigInt(config.electionKeyY_)] as Point,
    verificationKeys: [...config.verificationKeys].map((k: any) => [BigInt(k[0]), BigInt(k[1])] as Point),
    trustees: [...config.trustees].map(String),
  };
}

export async function readConstituencyState(contract: VoteChainContract, constituencyId: bigint | string): Promise<ContractConstituencyState> {
  const id = constituencyKey(constituencyId);
  const c = await contract.getConstituency(id);
  const candidateCount = Number(c.candidateCount);
  const aggregate: { A: Point; B: Point }[] = [];
  for (let j = 0; j < candidateCount; j++) {
    const a = await contract.aggregateOf(id, j);
    aggregate.push({ A: [BigInt(a.ax), BigInt(a.ay)], B: [BigInt(a.bx), BigInt(a.by)] });
  }
  return { constituencyId: BigInt(id), candidateCount, ballotCount: Number(c.ballots), totalBallots: Number(await contract.totalBallots()), aggregate };
}

/** The COMPLETE BallotRecorded log of the election (every constituency), in chain order. */
export async function readBallotLog(contract: VoteChainContract): Promise<BallotLogEntry[]> {
  const logs: any[] = await contract.queryFilter(contract.filters.BallotRecorded());
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  return logs.map((log) => ({
    constituencyId: BigInt(log.args.constituencyId),
    nullifier: BigInt(log.args.nullifier),
    ballotIndex: Number(log.args.ballotIndex),
    ballotHash: BigInt(log.args.ballotHash),
    coords: [...log.args.coords].map((w: any) => BigInt(w)),
  }));
}

export async function readPartialPublications(contract: VoteChainContract, constituencyId: bigint | string): Promise<PartialPublication[]> {
  const logs: any[] = await contract.queryFilter(contract.filters.PartialDecryptionPublished(constituencyKey(constituencyId)));
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  return logs.map((log) => ({
    trusteeIndex: Number(log.args.trusteeIndex),
    constituencyId: BigInt(log.args.constituencyId),
    bundleHash: BigInt(log.args.bundleHash),
    ballotCount: Number(log.args.ballotCount),
    candidateCount: Number(log.args.candidateCount),
    words: [...log.args.words].map((w: any) => BigInt(w)),
  }));
}

/** The bundle hash the contract stores for trustees 1, 2, 3 (0n = nothing published). */
export async function readStoredBundleHashes(contract: VoteChainContract, constituencyId: bigint | string): Promise<bigint[]> {
  const id = constituencyKey(constituencyId);
  return [BigInt(await contract.partialBundleHash(id, 1)), BigInt(await contract.partialBundleHash(id, 2)), BigInt(await contract.partialBundleHash(id, 3))];
}

/** Steps 1-17 of the audit, with everything fetched from the contract. Needs no secret. */
export async function auditFromChain(input: { contract: VoteChainContract; transcript: unknown; constituencyId: bigint | string }): Promise<AuditResult> {
  const { contract } = input;
  const [pinned, state, log, publications, storedBundleHashes] = await Promise.all([
    readPinnedConfiguration(contract),
    readConstituencyState(contract, input.constituencyId),
    readBallotLog(contract),
    readPartialPublications(contract, input.constituencyId),
    readStoredBundleHashes(contract, input.constituencyId),
  ]);
  return auditConstituency({ transcript: input.transcript, pinned, state, log, publications, storedBundleHashes });
}

async function requireClosed(contract: VoteChainContract): Promise<void> {
  if (BigInt(await contract.phase()) !== PHASE_CLOSED) throw new VerificationError("NOT_CLOSED", "the election is not Closed yet");
}

/**
 * ONE trustee publishes its partial decryption of a constituency. Order: the transcript must be the pinned one; this trustee's verification key must be the pinned
 * vk_i and the signer must be the pinned address; the aggregate is REBUILT from the complete chain log and checked against the contract (an arbitrary aggregate can
 * never enter); only that verified aggregate is decrypted; the bundle hash is computed locally and must equal the one the contract emits.
 */
export async function publishPartialDecryption(input: { contract: VoteChainContract; trustee: Trustee; transcript: unknown; constituencyId: bigint | string }): Promise<{ bundleHash: bigint; receipt: any }> {
  const { contract, trustee } = input;
  const id = constituencyKey(input.constituencyId);
  await requireClosed(contract);
  const pinned = await readPinnedConfiguration(contract);
  verifyPinnedTranscript(input.transcript, pinned);
  const vk = trustee.toJSON().verificationKey;
  const expectedVk = pinned.verificationKeys[trustee.index - 1] as Point;
  if (!vk || BigInt(vk[0]) !== expectedVk[0] || BigInt(vk[1]) !== expectedVk[1]) throw new VerificationError("NOT_THE_PINNED_TRUSTEE", `this trustee's verification key is not the pinned vk_${trustee.index}`);
  const signer = String(await contract.runner.getAddress());
  if (signer.toLowerCase() !== String(pinned.trustees[trustee.index - 1]).toLowerCase()) throw new VerificationError("NOT_THE_PINNED_ADDRESS", `the signer is not the address pinned for trustee ${trustee.index}`);

  const state = await readConstituencyState(contract, id);
  const verified = verifyChainAggregate({ context: pinned.context, state, log: await readBallotLog(contract) });
  const partial = trustee.partialDecryptVerified(verified);
  const words = bundleFromPartial(partial, state.candidateCount);
  const expected = bundleHash({ context: pinned.context, transcriptHash: pinned.transcriptHash, trusteeIndex: trustee.index, constituencyId: state.constituencyId, ballotCount: state.ballotCount, candidateCount: state.candidateCount }, words);
  if (words.length !== BUNDLE_WORDS) throw new VerificationError("BAD_BUNDLE", "unexpected bundle size");

  const receipt = await (await contract.publishPartialDecryption(id, trustee.index, words)).wait();
  const emitted = (receipt.logs as any[]).map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } }).find((e) => e?.name === "PartialDecryptionPublished");
  if (!emitted || BigInt(emitted.args.bundleHash) !== expected) throw new VerificationError("BUNDLE_HASH_MISMATCH", "the contract anchored another bundle hash than the one computed locally");
  return { bundleHash: expected, receipt };
}

/** The same, loading ONLY this trustee's encrypted share file (a path or the parsed JSON) and its password. */
export async function publishFromShareFile(input: { contract: VoteChainContract; shareFile: string | object; password: string; transcript: unknown; constituencyId: bigint | string; minKdf?: KdfParams }): Promise<{ bundleHash: bigint; receipt: any }> {
  const file = typeof input.shareFile === "string" ? readShareFile(input.shareFile) : input.shareFile;
  const trustee = Trustee.restore({ file, password: input.password, transcript: input.transcript, ...(input.minKdf ? { minKdf: input.minKdf } : {}) });
  return publishPartialDecryption({ contract: input.contract, trustee, transcript: input.transcript, constituencyId: input.constituencyId });
}

/**
 * ONE trustee endorses the result it has independently audited: the full audit (every proof, the aggregate rebuilt from the log, the recomputed totals) must pass and
 * this trustee's own publication must be among the valid ones before the audited totals are sent. Returns the results hash and whether this endorsement finalized.
 */
export async function endorseAuditedResult(input: { contract: VoteChainContract; trusteeIndex: number; transcript: unknown; constituencyId: bigint | string }): Promise<{ resultsHash: bigint; finalized: boolean; receipt: any }> {
  const { contract } = input;
  const id = constituencyKey(input.constituencyId);
  await requireClosed(contract);
  const audit = await auditFromChain({ contract, transcript: input.transcript, constituencyId: id });
  if (audit.aggregate.aggregate.ballotCount !== 0 && !audit.validTrustees.includes(input.trusteeIndex)) throw new VerificationError("OWN_PUBLICATION_NOT_VALID", `trustee ${input.trusteeIndex} has no valid published partial decryption to endorse on`);
  const receipt = await (await contract.endorseResult(id, input.trusteeIndex, audit.totals16)).wait();
  const names = (receipt.logs as any[]).map((log) => { try { return contract.interface.parseLog(log); } catch { return null; } });
  const endorsed = names.find((e) => e?.name === "ResultEndorsed");
  if (!endorsed || BigInt(endorsed.args.resultsHash) !== audit.resultsHash) throw new VerificationError("RESULTS_HASH_MISMATCH", "the contract recorded another results hash than the audited one");
  return { resultsHash: audit.resultsHash, finalized: names.some((e) => e?.name === "ConstituencyFinalized"), receipt };
}

/** The finalized result as the contract holds it, checked against a fresh audit of the same constituency. Reverts on-chain until it is finalized. */
export async function readVerifiedFinalResult(input: { contract: VoteChainContract; transcript: unknown; constituencyId: bigint | string }): Promise<{ totals: number[]; resultsHash: bigint; ballotCount: number }> {
  const id = constituencyKey(input.constituencyId);
  const audit = await auditFromChain({ contract: input.contract, transcript: input.transcript, constituencyId: id });
  const result = await input.contract.finalResult(id);
  verifyFinalResult({ totals: [...result.totals].map((t: any) => BigInt(t)), resultsHash: BigInt(result.resultsHash), ballotCount: Number(result.ballotCount), candidateCount: Number(result.candidateCount) }, audit);
  return { totals: audit.totals, resultsHash: audit.resultsHash, ballotCount: audit.aggregate.aggregate.ballotCount };
}
