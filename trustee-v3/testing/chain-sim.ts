// TEST SUPPORT ONLY. A SYNTHETIC election chain as plain data: a real key ceremony, ballots encrypted by privacy-v3 (valid ciphertexts, no zero-knowledge proofs) and
// numbered election-wide in an interleaved order, the "contract state" computed with privacy-v3's OWN homomorphic addition (independent of the code under test), and
// the trustees' publications. It lets the auditor and the chain-aggregate checks be tested thoroughly, including with hostile modifications, without a blockchain.
import { id as keccakOfText } from "ethers";
import { type PartialPublication, type PinnedConfiguration } from "../src/audit.ts";
import { activeWordsOf, bundleFromPartial, bundleHash } from "../src/bundle.ts";
import { verifyChainAggregate, type BallotLogEntry, type ContractConstituencyState, type VerifiedAggregate } from "../src/chain-aggregate.ts";
import type { ElectionContext, Point } from "../src/params.ts";
import { clone, runCeremony, type CeremonyRun } from "./ceremony.ts";
import { encryptedBallot, encryptedVector, pv3 } from "./pv3.ts";

export interface SimConstituency {
  code: string;
  kc: number;
  /** one valid one-hot ballot per entry: the chosen candidate */
  choices?: number[];
  /** hostile ballots: an explicit (possibly invalid) vote vector each */
  vectors?: bigint[][];
}

export interface SimElection {
  run: CeremonyRun;
  context: ElectionContext;
  pinned: PinnedConfiguration;
  log: BallotLogEntry[];
  totalBallots: number;
  id(code: string): bigint;
  state(code: string): ContractConstituencyState;
  verified(code: string): VerifiedAggregate;
  /** trustee `index`'s publication for the constituency, made through the integrated (chain-verified) path */
  publish(code: string, trusteeIndex: number): PartialPublication;
  /** what the contract would store after these trustees published */
  storedHashes(code: string, published: PartialPublication[]): bigint[];
}

export function simulateElection(constituencies: SimConstituency[], options: { run?: CeremonyRun } = {}): SimElection {
  const run = options.run ?? runCeremony();
  const context = run.context;
  const H = run.verified.electionPublicKey;
  const ids = new Map<string, bigint>(constituencies.map((c) => [c.code, BigInt(keccakOfText(c.code))]));
  const meta = new Map(constituencies.map((c) => [c.code, c]));

  // every ballot, then an interleaved election-wide order (so completeness has to be checked across constituencies)
  const pending: { code: string; coords: bigint[] }[] = [];
  for (const c of constituencies) {
    for (const choice of c.choices ?? []) pending.push({ code: c.code, coords: encryptedBallot(H, c.kc, choice).coords });
    for (const vector of c.vectors ?? []) pending.push({ code: c.code, coords: encryptedVector(H, c.kc, vector).coords });
  }
  for (let i = pending.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pending[i], pending[j]] = [pending[j]!, pending[i]!];
  }
  const log: BallotLogEntry[] = pending.map((p, i) => ({ constituencyId: ids.get(p.code)!, nullifier: BigInt(keccakOfText(`nullifier ${i}`)), ballotIndex: i + 1, ballotHash: BigInt(keccakOfText(`ballot ${i}`)), coords: p.coords }));

  // the contract's aggregate, computed with privacy-v3's own homomorphic addition
  const aggregateOf = (code: string): { A: Point; B: Point }[] => {
    const kc = meta.get(code)!.kc;
    const sums = Array.from({ length: kc }, () => pv3.elgamal.identityCiphertext());
    for (const entry of log.filter((e) => e.constituencyId === ids.get(code))) {
      for (let j = 0; j < kc; j++) sums[j] = pv3.elgamal.addCiphertexts(sums[j], { c1: [entry.coords[4 * j]!, entry.coords[4 * j + 1]!], c2: [entry.coords[4 * j + 2]!, entry.coords[4 * j + 3]!] });
    }
    return sums.map((s) => ({ A: [s.c1[0], s.c1[1]] as Point, B: [s.c2[0], s.c2[1]] as Point }));
  };

  const pinned: PinnedConfiguration = {
    context,
    transcriptHash: BigInt(run.transcript.transcriptHash),
    electionKey: H,
    verificationKeys: run.verified.verificationKeys,
    trustees: ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"],
  };
  const state = (code: string): ContractConstituencyState => ({
    constituencyId: ids.get(code)!,
    candidateCount: meta.get(code)!.kc,
    ballotCount: log.filter((e) => e.constituencyId === ids.get(code)).length,
    totalBallots: log.length,
    aggregate: aggregateOf(code),
  });
  const verified = (code: string): VerifiedAggregate => verifyChainAggregate({ context, state: state(code), log });
  const publish = (code: string, trusteeIndex: number): PartialPublication => {
    const s = state(code);
    const partial = run.trustees[trusteeIndex - 1]!.partialDecryptVerified(verified(code));
    const words = bundleFromPartial(partial, s.candidateCount);
    const hash = bundleHash({ context, transcriptHash: pinned.transcriptHash, trusteeIndex, constituencyId: s.constituencyId, ballotCount: s.ballotCount, candidateCount: s.candidateCount }, words);
    return { trusteeIndex, constituencyId: s.constituencyId, bundleHash: hash, ballotCount: s.ballotCount, candidateCount: s.candidateCount, words: activeWordsOf(words, s.candidateCount) };
  };
  const storedHashes = (_code: string, published: PartialPublication[]): bigint[] => [1, 2, 3].map((i) => published.find((p) => p.trusteeIndex === i)?.bundleHash ?? 0n);

  return { run, context, pinned, log, totalBallots: log.length, id: (code) => ids.get(code)!, state, verified, publish, storedHashes };
}

export { clone };
