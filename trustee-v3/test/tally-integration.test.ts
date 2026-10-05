// Trustee <-> contract integration, on a SYNTHETIC chain (plain data: a real key ceremony, ballots encrypted by privacy-v3, contract state computed with
// privacy-v3's own homomorphic addition). Covers the chain-derived aggregate, the pinned transcript, partial publications, the auditor and the combination.
// The same flow on a real Hardhat chain with real zero-knowledge ballots is in smart-contract-v3/test/tally.test.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AggregateCiphertext } from "../src/aggregate.ts";
import { auditConstituency, verifyFinalResult, type AuditInput, type AuditResult, type PartialPublication } from "../src/audit.ts";
import { bundleHash, padBundle } from "../src/bundle.ts";
import { verifyChainAggregate, VerifiedAggregate } from "../src/chain-aggregate.ts";
import { ToolkitError } from "../src/errors.ts";
import { G, TEST_CONTEXT, type Point } from "../src/params.ts";
import { add, mul, pointToWire } from "../src/point.ts";
import { randomScalar } from "../src/scalar.ts";
import { padTotals, resultsHash } from "../src/results.ts";
import { hex32 } from "../src/encoding.ts";
import { aggregateFor } from "../testing/aggregate.ts";
import { runCeremony } from "../testing/ceremony.ts";
import { simulateElection, type SimElection } from "../testing/chain-sim.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** the error code of a failing call, or "NO_ERROR" */
const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof ToolkitError ? error.code : `UNEXPECTED ${String(error)}`;
  }
  return "NO_ERROR";
};

let sim: SimElection;
let transcript: unknown;
const pubs: Record<string, PartialPublication[]> = {};
const byIndex = (code: string, ...indices: number[]): PartialPublication[] => indices.map((i) => pubs[code]!.find((p) => p.trusteeIndex === i)!);

const audit = (code: string, publications: PartialPublication[], over: Partial<AuditInput> = {}): AuditResult =>
  auditConstituency({ transcript, pinned: sim.pinned, state: sim.state(code), log: sim.log, publications, storedBundleHashes: sim.storedHashes(code, publications), ...over });

/** a publication whose words were changed AFTER the fact, with the hash recomputed (what the contract would anchor for a hostile trustee) */
const rehash = (pub: PartialPublication, words: bigint[], over: Partial<{ constituencyId: bigint; ballotCount: number; transcriptHash: bigint }> = {}): PartialPublication => {
  const constituencyId = over.constituencyId ?? pub.constituencyId;
  const ballotCount = over.ballotCount ?? pub.ballotCount;
  const hash = bundleHash({ context: sim.context, transcriptHash: over.transcriptHash ?? sim.pinned.transcriptHash, trusteeIndex: pub.trusteeIndex, constituencyId, ballotCount, candidateCount: pub.candidateCount }, padBundle(words, pub.candidateCount));
  return { ...pub, constituencyId, ballotCount, words, bundleHash: hash };
};

before(() => {
  // 19 ballots in six constituencies, numbered election-wide in an interleaved order; plus two HOSTILE one-ballot constituencies
  sim = simulateElection([
    { code: "KA-BLR", kc: 3, choices: [...Array(7).fill(0), ...Array(4).fill(1), ...Array(2).fill(2)] }, // 13 ballots: [7, 4, 2]
    { code: "MH-MUM", kc: 4, choices: [3, 3, 1] }, // [0, 1, 0, 2]
    { code: "TN-CHE", kc: 3, choices: [1] }, // exactly ONE ballot
    { code: "C02", kc: 2, choices: [] }, // none
    { code: "HOSTILE-BOUND", kc: 3, vectors: [[5n, 0n, 0n]] }, // one "ballot" that encrypts 5 votes: outside [0, ballotCount]
    { code: "HOSTILE-SUM", kc: 3, vectors: [[1n, 1n, 0n]] }, // one "ballot" that votes twice: the totals cannot add up
  ]);
  transcript = sim.run.transcript;
  for (const [code, indices] of [["KA-BLR", [1, 2, 3]], ["MH-MUM", [1, 2, 3]], ["TN-CHE", [1, 2]], ["HOSTILE-BOUND", [1, 2]], ["HOSTILE-SUM", [1, 2]]] as const) {
    pubs[code] = indices.map((i) => sim.publish(code, i));
  }
});

describe("integration: the audited tally, every trustee pair", () => {
  it("Kerala/Bengaluru: 13 ballots, the audit recovers [7, 4, 2] from EACH pair and from all three, with identical points and results hash", () => {
    const results = [[1, 2], [1, 3], [2, 3], [1, 2, 3]].map((pair) => audit("KA-BLR", byIndex("KA-BLR", ...pair)));
    for (const r of results) {
      assert.deepEqual(r.totals, [7, 4, 2]);
      assert.deepEqual(r.decryptedPoints, results[0]!.decryptedPoints);
      assert.equal(r.resultsHash, results[0]!.resultsHash);
    }
    assert.deepEqual(results.map((r) => r.usedTrustees), [[1, 2], [1, 3], [2, 3], [1, 2]]);
    assert.deepEqual(results.map((r) => r.validTrustees), [[1, 2], [1, 3], [2, 3], [1, 2, 3]]);
    assert.equal(results[0]!.resultsHash, resultsHash({ context: sim.context, transcriptHash: sim.pinned.transcriptHash, constituencyId: sim.id("KA-BLR"), ballotCount: 13, candidateCount: 3 }, padTotals([7, 4, 2], 3)));
    assert.equal(results[0]!.totals16.length, 16);
  });

  it("Mumbai: every pair of the three published trustees gives the same totals", () => {
    for (const pair of [[1, 2], [1, 3], [2, 3]]) assert.deepEqual(audit("MH-MUM", byIndex("MH-MUM", ...pair)).totals, [0, 1, 0, 2]);
  });

  it("a constituency with exactly ONE valid ballot is tallyable: its aggregate was rebuilt from the whole chain log (the minBallots guard is hygiene only)", () => {
    const result = audit("TN-CHE", byIndex("TN-CHE", 1, 2));
    assert.deepEqual(result.totals, [0, 1, 0]);
    assert.equal(result.aggregate.eventCount, 1);
    // the same aggregate is refused by the LOW-LEVEL path (minBallots = 2): the verified chain path is the security boundary, not that guard
    assert.throws(() => sim.run.trustees[0]!.partialDecrypt(result.aggregate.aggregate), /AGGREGATE_TOO_SMALL/);
  });

  it("a constituency without ballots has nothing to decrypt: the audit returns zeros with no publication, and a trustee refuses to decrypt it", () => {
    const result = audit("C02", []);
    assert.deepEqual(result.totals, [0, 0]);
    assert.deepEqual(result.validTrustees, []);
    assert.equal(result.totals16.every((t) => t === 0n), true);
    assert.throws(() => sim.run.trustees[0]!.partialDecryptVerified(sim.verified("C02")), /NOTHING_TO_DECRYPT/);
  });

  it("the finalized result must equal the audited one: totals, ballot count and results hash", () => {
    const result = audit("KA-BLR", byIndex("KA-BLR", 1, 3));
    const final = { totals: result.totals16, resultsHash: result.resultsHash, ballotCount: 13, candidateCount: 3 };
    assert.doesNotThrow(() => verifyFinalResult(final, result));
    assert.equal(codeOf(() => verifyFinalResult({ ...final, totals: padTotals([6, 5, 2], 3) }, result)), "FINAL_RESULT_MISMATCH");
    assert.equal(codeOf(() => verifyFinalResult({ ...final, resultsHash: final.resultsHash + 1n }, result)), "FINAL_RESULT_MISMATCH");
    assert.equal(codeOf(() => verifyFinalResult({ ...final, ballotCount: 14 }, result)), "FINAL_RESULT_MISMATCH");
  });
});

describe("integration: the pinned transcript (steps 1-5)", () => {
  const good = (): PartialPublication[] => byIndex("KA-BLR", 1, 3);
  const withPinned = (change: object) => () => audit("KA-BLR", good(), { pinned: { ...sim.pinned, ...change } as AuditInput["pinned"] });

  it("a transcript whose hash is not the pinned hash is refused", () => {
    assert.equal(codeOf(withPinned({ transcriptHash: sim.pinned.transcriptHash + 1n })), "HASH_MISMATCH");
    assert.equal(codeOf(() => audit("KA-BLR", good(), { transcript: runCeremony().transcript })), "HASH_MISMATCH", "a perfectly valid transcript of ANOTHER ceremony");
  });

  it("a transcript with the wrong (n, t) is refused: a valid 2-of-2 ceremony, even when its own hash is the pinned one", () => {
    const twoOfTwo = runCeremony({ params: { n: 2, t: 2 } });
    assert.equal(codeOf(() => audit("KA-BLR", good(), { transcript: twoOfTwo.transcript, pinned: { ...sim.pinned, transcriptHash: BigInt(twoOfTwo.transcript.transcriptHash) } })), "PARAMS_MISMATCH");
  });

  it("a transcript whose H differs from the contract's H, or whose vk differ from the pinned ones, is refused", () => {
    assert.equal(codeOf(withPinned({ electionKey: add(sim.pinned.electionKey, G) })), "PINNED_H_MISMATCH");
    for (const i of [0, 1, 2]) assert.equal(codeOf(withPinned({ verificationKeys: sim.pinned.verificationKeys.map((vk, k) => (k === i ? add(vk, G) : vk)) })), "PINNED_VK_MISMATCH", `vk_${i + 1}`);
    assert.equal(codeOf(withPinned({ verificationKeys: sim.pinned.verificationKeys.slice(0, 2) })), "PINNED_CONFIG_MALFORMED");
  });

  it("a transcript of another election context, or a tampered transcript, is refused", () => {
    assert.equal(codeOf(withPinned({ context: { ...TEST_CONTEXT, chainId: 1n } })), "CONTEXT_MISMATCH");
    assert.equal(codeOf(withPinned({ context: { ...TEST_CONTEXT, contractAddress: 5n } })), "CONTEXT_MISMATCH");
    const tampered = JSON.parse(JSON.stringify(transcript));
    tampered.participants[0].proofs[0].e = hex32(BigInt(tampered.participants[0].proofs[0].e) ^ 1n);
    assert.notEqual(codeOf(() => audit("KA-BLR", good(), { transcript: tampered })), "NO_ERROR");
    assert.equal(codeOf(() => audit("KA-BLR", good(), { transcript: { ...(transcript as object), extra: 1 } })), "BAD_STRUCTURE");
  });
});

describe("integration: the aggregate is rebuilt from the chain log (steps 6-7)", () => {
  const state = () => sim.state("KA-BLR");
  const verify = (log = sim.log, st = state()) => () => verifyChainAggregate({ context: sim.context, state: st, log });
  const blrAt = (n: number): number => sim.log.findIndex((e, i) => e.constituencyId === sim.id("KA-BLR") && sim.log.slice(0, i).filter((x) => x.constituencyId === sim.id("KA-BLR")).length === n);

  it("the honest log reproduces the contract's aggregate and ballot count exactly, for every constituency", () => {
    for (const code of ["KA-BLR", "MH-MUM", "TN-CHE", "C02"]) {
      const verified = sim.verified(code);
      assert.equal(verified.aggregate.ballotCount, sim.state(code).ballotCount);
      assert.equal(verified.logLength, sim.totalBallots);
      assert.equal(sim.totalBallots, 19, "13 + 3 + 1 + 0 + 1 + 1");
    }
    assert.equal(sim.verified("TN-CHE").eventCount, 1);
    assert.equal(sim.verified("C02").eventCount, 0);
  });

  it("a MISSING event is refused, wherever it is: in this constituency, or in another one (the election-wide log must be complete)", () => {
    assert.equal(codeOf(verify(sim.log.filter((_, i) => i !== blrAt(3)))), "LOG_INCOMPLETE");
    assert.equal(codeOf(verify(sim.log.filter((e) => e.constituencyId !== sim.id("MH-MUM") || e.ballotIndex !== sim.log.find((x) => x.constituencyId === sim.id("MH-MUM"))!.ballotIndex))), "LOG_INCOMPLETE");
    assert.equal(codeOf(verify(sim.log.slice(0, -1))), "LOG_INCOMPLETE");
    assert.equal(codeOf(verify([])), "LOG_INCOMPLETE");
    // the missing event cannot be hidden by renumbering: the contract still says how many ballots it recorded
    assert.equal(codeOf(verify(sim.log.filter((_, i) => i !== 4).map((e, i) => ({ ...e, ballotIndex: i + 1 })))), "LOG_INCOMPLETE");
  });

  it("a DUPLICATED event is refused (one event twice, or an extra copy)", () => {
    const duplicated = sim.log.map((e, i) => (i === 6 ? { ...sim.log[5]! } : e));
    assert.equal(codeOf(verify(duplicated)), "LOG_DUPLICATE_EVENT");
    assert.equal(codeOf(verify([...sim.log, sim.log[0]!])), "LOG_INCOMPLETE");
  });

  it("REORDERED or invalidly INDEXED events are refused: swapped events, a gap, index 0, a huge index, a repeated index", () => {
    const swapped = [...sim.log];
    [swapped[2], swapped[9]] = [swapped[9]!, swapped[2]!];
    assert.equal(codeOf(verify(swapped)), "LOG_OUT_OF_ORDER");
    assert.equal(codeOf(verify([...sim.log].reverse())), "LOG_OUT_OF_ORDER");
    assert.equal(codeOf(verify(sim.log.map((e, i) => (i === 5 ? { ...e, ballotIndex: 0 } : e)))), "LOG_INDEX_GAP");
    assert.equal(codeOf(verify(sim.log.map((e, i) => (i === 5 ? { ...e, ballotIndex: 999 } : e)))), "LOG_INDEX_GAP");
    assert.equal(codeOf(verify(sim.log.map((e, i) => (i === 5 ? { ...e, ballotIndex: 1.5 } : e)))), "LOG_MALFORMED");
    assert.equal(codeOf(verify(sim.log.map((e, i) => (i === 5 ? { ...e, ballotIndex: 2 } : e)))), "LOG_DUPLICATE_EVENT");
  });

  it("a MODIFIED ciphertext is refused: another valid point (the aggregate no longer matches), an off-curve point, a non-canonical coordinate, an identity C1, a wrong length", () => {
    const at = blrAt(2);
    const edit = (change: (coords: bigint[]) => bigint[]) => sim.log.map((e, i) => (i === at ? { ...e, coords: change([...e.coords]) } : e));
    const C2: Point = [sim.log[at]!.coords[2]!, sim.log[at]!.coords[3]!];
    const shifted = add(C2, G);
    assert.equal(codeOf(verify(edit((c) => ((c[2] = shifted[0]), (c[3] = shifted[1]), c)))), "AGGREGATE_MISMATCH");
    assert.equal(codeOf(verify(edit((c) => ((c[2] = c[2]! + 1n), c)))), "INVALID_BALLOT_LOG");
    assert.equal(codeOf(verify(edit((c) => ((c[0] = c[0]! + 21888242871839275222246405745257275088548364400416034343698204186575808495617n), c)))), "INVALID_BALLOT_LOG");
    assert.equal(codeOf(verify(edit((c) => ((c[0] = 0n), (c[1] = 1n), c)))), "INVALID_BALLOT_LOG");
    assert.equal(codeOf(verify(edit((c) => c.slice(0, 11)))), "INVALID_BALLOT_LOG");
    assert.equal(codeOf(verify(edit((c) => [...c, 0n, 1n, 0n, 1n]))), "INVALID_BALLOT_LOG");
  });

  it("an event-derived aggregate that differs from the contract's aggregate is refused, for any slot and either half", () => {
    for (let j = 0; j < 3; j++) {
      for (const half of ["A", "B"] as const) {
        const st = state();
        const aggregate = st.aggregate.map((s, k) => (k === j ? { ...s, [half]: add(s[half], G) } : s));
        assert.equal(codeOf(verify(sim.log, { ...st, aggregate })), "AGGREGATE_MISMATCH", `slot ${j} ${half}`);
      }
    }
  });

  it("an INCORRECT ballot count is refused: too large, too small, or this constituency's events relabelled", () => {
    assert.equal(codeOf(verify(sim.log, { ...state(), ballotCount: 14 })), "LOG_COUNT_MISMATCH");
    assert.equal(codeOf(verify(sim.log, { ...state(), ballotCount: 12 })), "LOG_COUNT_MISMATCH");
    assert.equal(codeOf(verify(sim.log.map((e) => (e.constituencyId === sim.id("MH-MUM") ? { ...e, constituencyId: sim.id("KA-BLR") } : e)))), "LOG_COUNT_MISMATCH");
    assert.equal(codeOf(verify(sim.log, { ...state(), totalBallots: sim.totalBallots + 1 })), "LOG_INCOMPLETE");
    assert.equal(codeOf(verify(sim.log, { ...state(), totalBallots: sim.totalBallots - 1 })), "LOG_INCOMPLETE");
  });

  it("the 'fake aggregate' attack fails: ONE voter's ballot presented as the aggregate of two ballots cannot match the chain", () => {
    const single = sim.state("TN-CHE");
    assert.equal(codeOf(() => verifyChainAggregate({ context: sim.context, state: { ...single, ballotCount: 2 }, log: sim.log })), "LOG_COUNT_MISMATCH");
    const forged = { ...state(), ballotCount: 2, aggregate: single.aggregate.concat() };
    assert.notEqual(codeOf(() => verifyChainAggregate({ context: sim.context, state: forged, log: sim.log })), "NO_ERROR");
  });

  it("a malformed contract state is refused", () => {
    for (const bad of [{ ...state(), candidateCount: 0 }, { ...state(), candidateCount: 17 }, { ...state(), aggregate: state().aggregate.slice(1) }, { ...state(), ballotCount: -1 }, { ...state(), totalBallots: 3 }]) {
      assert.equal(codeOf(verify(sim.log, bad)), "STATE_MALFORMED");
    }
    assert.equal(codeOf(() => verifyChainAggregate({ context: sim.context, state: state(), log: "log" as never })), "LOG_MALFORMED");
  });
});

describe("integration: an arbitrary aggregate can never enter the integrated trustee path (security boundary)", () => {
  it("partialDecryptVerified refuses every AggregateCiphertext that did not come out of verifyChainAggregate, and every look-alike", () => {
    const trustee = sim.run.trustees[0]!;
    const arbitrary = aggregateFor(sim.pinned.electionKey, [3, 2, 1]);
    const real = sim.verified("KA-BLR");
    const lookalike = { aggregate: real.aggregate, eventCount: 13, logLength: sim.totalBallots };
    const forged = Object.create(VerifiedAggregate.prototype, Object.getOwnPropertyDescriptors(lookalike));
    for (const bad of [arbitrary, real.aggregate, lookalike, forged, { aggregate: arbitrary }, null, undefined, "aggregate", 7]) {
      assert.equal(codeOf(() => trustee.partialDecryptVerified(bad as VerifiedAggregate)), "NOT_A_VERIFIED_AGGREGATE");
    }
    assert.throws(() => new VerifiedAggregate(Symbol("x"), real.aggregate, 13, sim.totalBallots), /NOT_A_VERIFIED_AGGREGATE/);
    assert.ok(VerifiedAggregate.isVerified(real));
    assert.ok(!VerifiedAggregate.isVerified(forged));
    assert.doesNotThrow(() => trustee.partialDecryptVerified(real));
  });

  it("a verified aggregate of ANOTHER election context is refused by the trustee", () => {
    const other = simulateElection([{ code: "KA-BLR", kc: 3, choices: [0, 1, 2] }], { run: runCeremony({ context: { chainId: 1n, contractAddress: 0x1234n, electionId: 0x5678n } }) });
    assert.throws(() => sim.run.trustees[0]!.partialDecryptVerified(other.verified("KA-BLR")), /CONTEXT_MISMATCH/);
  });
});

describe("integration: partial publications (steps 8-12)", () => {
  /** [T1 valid, T2 valid, T3 hostile]: the audit must succeed on T1+T2 and name exactly why T3 was refused */
  const withHostileThird = (code: string, hostile: PartialPublication, over: Partial<AuditInput> = {}) => audit(code, [...byIndex(code, 1, 2), hostile], over);
  const reason = (result: AuditResult): string => result.invalid.map((i) => i.code).join(",");
  const third = (): PartialPublication => pubs["MH-MUM"]!.find((p) => p.trusteeIndex === 3)!;

  it("honest publications pass; the hostile third is the only one named", () => {
    const result = withHostileThird("MH-MUM", rehash(third(), [...third().words]));
    assert.equal(result.invalid.length, 0);
    assert.deepEqual(result.validTrustees, [1, 2, 3]);
  });

  it("a MODIFIED D (the hash recomputed, as the contract would anchor it) fails the Chaum-Pedersen check; the audit still succeeds on the two honest trustees", () => {
    const D = [pointToWire(add([BigInt(third().words[0]!), BigInt(third().words[1]!)] as Point, G))];
    const result = withHostileThird("MH-MUM", rehash(third(), third().words.map((w, i) => (i === 0 ? BigInt(D[0]![0]) : i === 1 ? BigInt(D[0]![1]) : w))));
    assert.equal(reason(result), "INVALID_PROOF");
    assert.deepEqual(result.totals, [0, 1, 0, 2]);
    assert.deepEqual(result.usedTrustees, [1, 2]);
  });

  it("MODIFIED e or z fails (by +1, a bit flip), in any slot", () => {
    for (const offset of [2, 3, 6, 15]) {
      for (const change of [(w: bigint) => w + 1n, (w: bigint) => w ^ 4n]) {
        const result = withHostileThird("MH-MUM", rehash(third(), third().words.map((w, i) => (i === offset ? change(w) : w))));
        assert.equal(reason(result), "INVALID_PROOF", `word ${offset}`);
      }
    }
  });

  it("a proof from ANOTHER SLOT fails: two slots' (D, e, z) swapped, or one slot's proof copied into another", () => {
    const w = third().words;
    const swapped = [...w.slice(4, 8), ...w.slice(0, 4), ...w.slice(8)];
    assert.equal(reason(withHostileThird("MH-MUM", rehash(third(), swapped))), "INVALID_PROOF");
    const copied = [...w.slice(0, 4), ...w.slice(0, 4), ...w.slice(8)];
    assert.equal(reason(withHostileThird("MH-MUM", rehash(third(), copied))), "INVALID_PROOF");
  });

  it("a proof for ANOTHER CONSTITUENCY fails: Bengaluru's words re-published for the single-ballot constituency (same candidate count, hash recomputed)", () => {
    const blr = pubs["KA-BLR"]!.find((p) => p.trusteeIndex === 3)!;
    const reused = rehash(blr, [...blr.words], { constituencyId: sim.id("TN-CHE"), ballotCount: 1 });
    const result = audit("TN-CHE", [...byIndex("TN-CHE", 1, 2), reused]);
    assert.equal(reason(result), "INVALID_PROOF");
    // and relabelled WITHOUT recomputing anything the publication is just for the wrong constituency
    assert.equal(reason(audit("TN-CHE", [...byIndex("TN-CHE", 1, 2), { ...blr }])), "WRONG_CONSTITUENCY");
  });

  it("a proof from ANOTHER ELECTION fails: as published it does not match this election's bundle hash; re-hashed under this election it fails the proof check", () => {
    const otherElection = simulateElection([{ code: "MH-MUM", kc: 4, choices: [3, 3, 1] }], { run: runCeremony({ context: { chainId: 31337n, contractAddress: 0x4242n, electionId: 0x2424n } }) });
    const foreign = otherElection.publish("MH-MUM", 3);
    assert.equal(reason(withHostileThird("MH-MUM", foreign)), "BUNDLE_HASH_MISMATCH");
    assert.equal(reason(withHostileThird("MH-MUM", rehash(foreign, [...foreign.words]))), "INVALID_PROOF");
  });

  it("a PACKAGE HASH MISMATCH is refused: the announced hash is not the hash of the published words, or not the hash the contract stored", () => {
    assert.equal(reason(withHostileThird("MH-MUM", { ...third(), bundleHash: third().bundleHash + 1n })), "BUNDLE_HASH_MISMATCH");
    const stored = sim.storedHashes("MH-MUM", [...byIndex("MH-MUM", 1, 2), third()]);
    assert.equal(reason(withHostileThird("MH-MUM", third(), { storedBundleHashes: [stored[0]!, stored[1]!, stored[2]! + 1n] })), "STORED_HASH_MISMATCH");
    assert.equal(reason(withHostileThird("MH-MUM", third(), { storedBundleHashes: [stored[0]!, stored[1]!, 0n] })), "STORED_HASH_MISMATCH", "the contract stores nothing for a trustee that never published");
  });

  it("a MALFORMED or non-canonically PADDED package is refused: wrong word count, an extra padded slot, a missing word, out-of-range words, wrong K_c or ballot count", () => {
    const t = third();
    const cases: [string, PartialPublication][] = [
      ["an extra (padded) slot of zeros", { ...t, words: [...t.words, 0n, 0n, 0n, 0n] }],
      ["an extra non-zero padded slot", { ...t, words: [...t.words, 1n, 2n, 3n, 4n] }],
      ["a missing word", { ...t, words: t.words.slice(0, -1) }],
      ["no words", { ...t, words: [] }],
      ["a word beyond uint256", { ...t, words: t.words.map((w, i) => (i === 3 ? 1n << 256n : w)) }],
      ["a negative word", { ...t, words: t.words.map((w, i) => (i === 3 ? -1n : w)) }],
      ["the wrong candidate count", { ...t, candidateCount: 3 }],
      ["the wrong ballot count", { ...t, ballotCount: 4 }],
    ];
    for (const [name, publication] of cases) assert.notEqual(reason(withHostileThird("MH-MUM", publication)), "", name);
    assert.equal(reason(withHostileThird("MH-MUM", { ...t, candidateCount: 3 })), "WRONG_CANDIDATE_COUNT");
    assert.equal(reason(withHostileThird("MH-MUM", { ...t, ballotCount: 4 })), "WRONG_BALLOT_COUNT");
    assert.equal(reason(withHostileThird("MH-MUM", { ...t, words: [...t.words, 0n, 0n, 0n, 0n] })), "BAD_BUNDLE");
    assert.equal(reason(withHostileThird("MH-MUM", { ...t, trusteeIndex: 4 })), "BAD_INTEGER");
  });
});

describe("integration: combination (steps 12-17)", () => {
  it("ONE valid trustee is not enough: a single publication, or one valid plus one invalid", () => {
    assert.equal(codeOf(() => audit("KA-BLR", byIndex("KA-BLR", 1))), "INSUFFICIENT_VALID_PARTIALS");
    assert.equal(codeOf(() => audit("KA-BLR", [])), "INSUFFICIENT_VALID_PARTIALS");
    const invalid = rehash(pubs["KA-BLR"]![2]!, pubs["KA-BLR"]![2]!.words.map((w, i) => (i === 2 ? w + 1n : w)));
    assert.equal(codeOf(() => audit("KA-BLR", [pubs["KA-BLR"]![0]!, invalid])), "INSUFFICIENT_VALID_PARTIALS");
  });

  it("the same trustee used twice is refused: a duplicated publication, or two publications with one index", () => {
    const one = byIndex("KA-BLR", 1)[0]!;
    assert.equal(codeOf(() => audit("KA-BLR", [one, one])), "DUPLICATE_TRUSTEE");
    assert.equal(codeOf(() => audit("KA-BLR", [one, { ...byIndex("KA-BLR", 3)[0]!, trusteeIndex: 1 }])), "DUPLICATE_TRUSTEE");
    // trustee 1's publication relabelled as trustee 2's: its proofs are bound to index 1
    const relabelled = rehash({ ...one, trusteeIndex: 2 }, [...one.words]);
    assert.equal(audit("KA-BLR", [one, relabelled, byIndex("KA-BLR", 3)[0]!]).invalid.map((i) => i.code).join(), "INVALID_PROOF");
  });

  it("two partials from DIFFERENT transcripts are refused: trustee 2 of another ceremony cannot stand in for this ceremony's trustee 2", () => {
    const foreign = simulateElection([{ code: "KA-BLR", kc: 3, choices: [...Array(7).fill(0), ...Array(4).fill(1), ...Array(2).fill(2)] }]);
    const impostor = foreign.publish("KA-BLR", 2);
    const asIfPinned = rehash(impostor, [...impostor.words]);
    assert.equal(codeOf(() => audit("KA-BLR", [byIndex("KA-BLR", 1)[0]!, impostor])), "INSUFFICIENT_VALID_PARTIALS");
    assert.equal(codeOf(() => audit("KA-BLR", [byIndex("KA-BLR", 1)[0]!, asIfPinned])), "INSUFFICIENT_VALID_PARTIALS");
  });

  it("a result outside the BSGS bound is caught: a 'ballot' that encrypts five votes is not a count within [0, ballotCount]", () => {
    assert.equal(codeOf(() => audit("HOSTILE-BOUND", pubs["HOSTILE-BOUND"]!)), "TALLY_OUT_OF_BOUND");
  });

  it("totals that do not add up to the ballot count are caught: a 'ballot' that votes twice", () => {
    assert.equal(codeOf(() => audit("HOSTILE-SUM", pubs["HOSTILE-SUM"]!)), "TALLY_SUM_MISMATCH");
  });
});

describe("integration: privacy", () => {
  const read = (f: string): string => fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

  it("the integration modules never touch scalar arithmetic: nothing there can add, multiply or interpolate secrets, so the full secret s cannot be reconstructed", () => {
    for (const file of ["src/bundle.ts", "src/results.ts", "src/chain-aggregate.ts", "src/audit.ts", "chain/index.ts"]) {
      assert.doesNotMatch(read(file), /from "\.\.?\/(src\/)?scalar\.ts"|randomScalar|hashToScalar/, file);
      assert.doesNotMatch(read(file), /interpolateScalar|reconstructSecret|recoverSecret|combineShares|sumSecrets/i, file);
    }
  });

  it("no integrated function accepts or returns a secret share, and none decrypts an individual ballot", () => {
    for (const file of ["src/bundle.ts", "src/results.ts", "src/chain-aggregate.ts", "src/audit.ts", "chain/index.ts"]) assert.doesNotMatch(read(file), /decryptBallot|decryptIndividual|individualBallot|#share|exportShare|getShare/i, file);
    const chain = read("chain/index.ts");
    assert.deepEqual([...chain.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]).sort(), [
      "auditFromChain", "constituencyKey", "endorseAuditedResult", "publishFromShareFile", "publishPartialDecryption", "readBallotLog", "readConstituencyState", "readContext", "readPartialPublications", "readPinnedConfiguration", "readStoredBundleHashes", "readVerifiedFinalResult",
    ]);
  });

  it("process separation: the publication path takes ONE trustee or ONE share file and nothing else (no list of trustees, no list of share files, one restore)", () => {
    const chain = read("chain/index.ts");
    assert.doesNotMatch(chain, /Trustee\[\]|shareFiles|trustees: Trustee|Array<Trustee>|passwords/, "no plural trustee input anywhere");
    assert.equal((chain.match(/Trustee\.restore\(/g) ?? []).length, 1, "exactly one restore, of exactly one share file");
    assert.match(chain, /shareFile: string \| object; password: string/);
    assert.match(chain, /publishPartialDecryption\(input: \{ contract: VoteChainContract; trustee: Trustee;/);
  });

  it("the chain adapter has no runtime chain-library dependency and no filesystem access beyond reading ONE share file", () => {
    const chain = read("chain/index.ts");
    assert.doesNotMatch(chain, /from "ethers"|require\(/);
    assert.doesNotMatch(chain, /node:fs|writeFile|readdir/);
  });
});
