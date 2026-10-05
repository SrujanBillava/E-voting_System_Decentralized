// Verifiable partial decryption of an AGGREGATE and its 2-of-3 combination. All public: anybody holding the verified ceremony transcript can check every
// trustee's Chaum-Pedersen proof and combine any t partial decryptions. No secret and no individual ballot is involved anywhere.
//
//   trustee i:  D_i = s_i * A  (per candidate slot) plus a proof that log_G(vk_i) == log_A(D_i)
//   combiner:   S = sum of lambda_i * D_i over t trustees (Lagrange at 0, mod l);  M = B - S = t_c * G;  t_c = BSGS(M) within 0..ballotCount
import { AggregateCiphertext } from "./aggregate.ts";
import { boundedDiscreteLog, BoundedDiscreteLog } from "./bsgs.ts";
import { verifyDecryptionShare } from "./chaum-pedersen.ts";
import { isVerifiedTranscript, verifyTranscript, type ParsedTranscript } from "./ceremony.ts";
import { contextToWire } from "./context.ts";
import { assertInteger, exactKeys, hex32, parseHex32 } from "./encoding.ts";
import { InvalidInputError, VerificationError } from "./errors.ts";
import { interpolatePointsAtZero } from "./lagrange.ts";
import { IDENTITY, type ElectionContext, type Point } from "./params.ts";
import { parsePointWire, pointToWire, pointsEqual, sub, type WirePoint } from "./point.ts";
import { parseProofWire, type Proof, type WireProof } from "./proof.ts";

export interface PartialSlot {
  slot: number;
  D: WirePoint; // s_i * A for this slot
  proof: WireProof; // Chaum-Pedersen: the same s_i as vk_i
}
/** One trustee's contribution for one aggregate: a partial decryption of every candidate slot. */
export interface PartialDecryption {
  trusteeIndex: number;
  constituencyId: string;
  slots: PartialSlot[];
}

interface ParsedPartial {
  trusteeIndex: number;
  constituencyId: bigint;
  slots: { slot: number; D: Point; proof: Proof }[];
}

function parsePartial(raw: unknown, n: number): ParsedPartial {
  const o = exactKeys(raw, ["trusteeIndex", "constituencyId", "slots"], "partial decryption");
  const trusteeIndex = assertInteger(o.trusteeIndex, 1, n, "trusteeIndex");
  if (!Array.isArray(o.slots)) throw new InvalidInputError("BAD_STRUCTURE", "slots must be an array");
  return {
    trusteeIndex,
    constituencyId: parseHex32(o.constituencyId, "constituencyId"),
    slots: o.slots.map((s, j) => {
      const slot = exactKeys(s, ["slot", "D", "proof"], `slot ${j}`);
      return { slot: assertInteger(slot.slot, 0, 15, "slot"), D: parsePointWire(slot.D, `D of slot ${j}`), proof: parseProofWire(slot.proof, `proof of slot ${j}`) };
    }),
  };
}

function sameContext(a: ElectionContext, b: ElectionContext): boolean {
  const x = contextToWire(a);
  const y = contextToWire(b);
  return x.chainId === y.chainId && x.contractAddress === y.contractAddress && x.electionId === y.electionId;
}

/** A verified ParsedTranscript is used as is; anything else is treated as a wire transcript and verified (for the aggregate's election) first. */
function resolveTranscript(transcript: unknown, context: ElectionContext): ParsedTranscript {
  if (isVerifiedTranscript(transcript)) {
    if (!sameContext(transcript.context, context)) throw new VerificationError("CONTEXT_MISMATCH", "the transcript belongs to another election context than the aggregate");
    return transcript;
  }
  const result = verifyTranscript(transcript, { context });
  if (!result.ok) throw new VerificationError(result.code, result.reason);
  return result.transcript;
}

function assertAggregate(aggregate: unknown): AggregateCiphertext {
  if (!AggregateCiphertext.isAggregate(aggregate)) throw new InvalidInputError("NOT_AN_AGGREGATE", "decryption works on an AggregateCiphertext only");
  return aggregate;
}

/** Throws if the partial decryption is not a valid, proven partial decryption of this aggregate by the trustee it names. */
function checkPartial(t: ParsedTranscript, aggregate: AggregateCiphertext, partial: ParsedPartial): void {
  if (partial.constituencyId !== aggregate.constituencyId) throw new VerificationError("INVALID_PARTIAL", `trustee ${partial.trusteeIndex}: partial decryption is for another constituency`);
  if (partial.slots.length !== aggregate.slots.length) throw new VerificationError("INVALID_PARTIAL", `trustee ${partial.trusteeIndex}: wrong number of slots`);
  const vk = t.verificationKeys[partial.trusteeIndex - 1] as Point;
  partial.slots.forEach((s, j) => {
    if (s.slot !== j) throw new VerificationError("INVALID_PARTIAL", `trustee ${partial.trusteeIndex}: slots must be listed in order`);
    const binding = { context: aggregate.context, constituencyId: aggregate.constituencyId, slot: j, trusteeIndex: partial.trusteeIndex };
    if (!verifyDecryptionShare(binding, vk, (aggregate.slots[j] as { A: Point }).A, s.D, s.proof)) {
      throw new VerificationError("INVALID_PARTIAL", `trustee ${partial.trusteeIndex}: the Chaum-Pedersen proof of slot ${j} does not verify`);
    }
  });
}

/** Never throws: true only if the proofs of every slot verify against the ceremony's verification key of the trustee the partial names. */
export function verifyPartialDecryption(input: { transcript: unknown; aggregate: AggregateCiphertext; partial: unknown }): boolean {
  try {
    const aggregate = assertAggregate(input.aggregate);
    const t = resolveTranscript(input.transcript, aggregate.context);
    checkPartial(t, aggregate, parsePartial(input.partial, t.params.n));
    return true;
  } catch {
    return false;
  }
}

export interface Combined {
  /** the trustees whose partial decryptions were combined */
  usedTrustees: number[];
  /** per candidate slot M = B - S = t_c * G */
  points: Point[];
}

/**
 * Verifies EVERY supplied partial decryption (proofs, constituency, slot layout, distinct trustees) and combines t of them. Fewer than t, duplicated
 * trustees or any invalid proof is an error. If more than t are supplied, the extra ones must reproduce exactly the same points.
 */
export function combinePartialDecryptions(input: { transcript: unknown; aggregate: AggregateCiphertext; partials: readonly unknown[] }): Combined {
  const aggregate = assertAggregate(input.aggregate);
  const t = resolveTranscript(input.transcript, aggregate.context);
  if (aggregate.ballotCount === 0) return { usedTrustees: [], points: aggregate.slots.map(() => [IDENTITY[0], IDENTITY[1]] as Point) }; // nothing to decrypt: the empty aggregate IS the identity
  if (!Array.isArray(input.partials)) throw new InvalidInputError("BAD_STRUCTURE", "partials must be an array");
  const parsed = input.partials.map((p) => parsePartial(p, t.params.n));
  if (new Set(parsed.map((p) => p.trusteeIndex)).size !== parsed.length) throw new VerificationError("DUPLICATE_TRUSTEE", "the same trustee supplied more than one partial decryption");
  if (parsed.length < t.params.t) throw new VerificationError("INSUFFICIENT_PARTIALS", `at least ${t.params.t} partial decryptions from distinct trustees are needed to decrypt; got ${parsed.length}`);
  parsed.forEach((p) => checkPartial(t, aggregate, p));
  parsed.sort((a, b) => a.trusteeIndex - b.trusteeIndex);
  const used = parsed.slice(0, t.params.t);
  const decrypt = (chosen: ParsedPartial[], j: number): Point => {
    const S = interpolatePointsAtZero(chosen.map((p) => p.trusteeIndex), chosen.map((p) => (p.slots[j] as { D: Point }).D));
    return sub((aggregate.slots[j] as { B: Point }).B, S);
  };
  const points = aggregate.slots.map((_, j) => decrypt(used, j));
  for (const extra of parsed.slice(t.params.t)) {
    const alternative = [...used.slice(0, t.params.t - 1), extra];
    aggregate.slots.forEach((_, j) => {
      if (!pointsEqual(decrypt(alternative, j), points[j] as Point)) throw new VerificationError("INCONSISTENT_PARTIALS", `trustee ${extra.trusteeIndex} contradicts the other partial decryptions`);
    });
  }
  return { usedTrustees: used.map((p) => p.trusteeIndex), points };
}

export interface TallyResult {
  constituencyId: string;
  ballotCount: number;
  /** votes per candidate slot */
  totals: number[];
  /** the decrypted group points M = t_c * G, per slot (identical for every pair of trustees) */
  decryptedPoints: WirePoint[];
  usedTrustees: number[];
}

/**
 * Aggregate tally recovery: verify, combine, recover each total by baby-step giant-step within 0..ballotCount, re-check t*G == M and that the totals
 * add up to the ballot count (every valid ballot is one-hot, so they must).
 */
export function tallyAggregate(input: { transcript: unknown; aggregate: AggregateCiphertext; partials: readonly unknown[] }): TallyResult {
  const aggregate = assertAggregate(input.aggregate);
  const { usedTrustees, points } = combinePartialDecryptions(input);
  const table = aggregate.ballotCount === 0 ? null : boundedDiscreteLog(aggregate.ballotCount);
  const totals = points.map((M, j) => {
    if (table === null) return 0;
    const total = table.solve(M);
    if (total === null) throw new VerificationError("TALLY_OUT_OF_BOUND", `slot ${j}: the decrypted value is not a count between 0 and ${aggregate.ballotCount}`);
    if (!BoundedDiscreteLog.confirm(total, M)) throw new VerificationError("TALLY_NOT_CONFIRMED", `slot ${j}: t*G does not equal the decrypted point`);
    return total;
  });
  if (totals.reduce((a, b) => a + b, 0) !== aggregate.ballotCount) throw new VerificationError("TALLY_SUM_MISMATCH", "the candidate totals do not add up to the number of ballots");
  return { constituencyId: hex32(aggregate.constituencyId), ballotCount: aggregate.ballotCount, totals, decryptedPoints: points.map(pointToWire), usedTrustees };
}
