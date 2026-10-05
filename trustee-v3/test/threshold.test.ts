// Threshold decryption of an AGGREGATE: every pair of trustees gives the identical result across many random elections; one trustee alone cannot decrypt;
// every way of forging, replaying or mixing partial decryptions is refused.
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { before, describe, it } from "node:test";
import { AggregateCiphertext } from "../src/aggregate.ts";
import { BoundedDiscreteLog } from "../src/bsgs.ts";
import { hex32 } from "../src/encoding.ts";
import { G, MAX_BALLOT_COUNT, SUBGROUP_ORDER as L, TEST_CONTEXT, type Point } from "../src/params.ts";
import { add, mul, parsePointWire, pointToWire, pointsEqual, sub } from "../src/point.ts";
import { inv, mod, mul as sMul, randomScalar } from "../src/scalar.ts";
import { combinePartialDecryptions, tallyAggregate, verifyPartialDecryption, type PartialDecryption } from "../src/threshold.ts";
import { serializeTranscript } from "../src/ceremony.ts";
import { aggregateFor } from "../testing/aggregate.ts";
import { clone, runCeremony, type CeremonyRun } from "../testing/ceremony.ts";
import { mixedPoint } from "../testing/torsion.ts";

const wire = (p: [string, string]): Point => parsePointWire(p, "point");
/** a DECRYPTED point M = t*G is the identity when a candidate got zero votes */
const decrypted = (p: [string, string]): Point => parsePointWire(p, "M", { allowIdentity: true });
const PAIRS: [number, number][] = [[1, 2], [1, 3], [2, 3]];

describe("threshold decryption: every pair of trustees decrypts the same aggregate identically (many random elections)", () => {
  it("6 independent ceremonies x 3 random aggregates: pairs (1,2), (1,3), (2,3) and all three together give IDENTICAL points and totals, equal to the truth", () => {
    for (let election = 0; election < 6; election++) {
      const run = runCeremony();
      const H = run.verified.electionPublicKey;
      for (let k = 0; k < 3; k++) {
        const slotCount = randomInt(2, 6);
        const ballots = randomInt(2, 200);
        const truth = Array.from({ length: slotCount }, () => 0);
        for (let b = 0; b < ballots; b++) truth[randomInt(0, slotCount)]!++;
        const aggregate = aggregateFor(H, truth, { constituencyId: BigInt(election * 10 + k + 1) });
        const partials = run.trustees.map((t) => t.partialDecrypt(aggregate));
        const results = PAIRS.map(([a, b]) => tallyAggregate({ transcript: run.verified, aggregate, partials: [partials[a - 1], partials[b - 1]] }));
        const everyone = tallyAggregate({ transcript: run.verified, aggregate, partials });
        for (const r of [...results, everyone]) {
          assert.deepEqual(r.totals, truth, `election ${election}/${k}`);
          assert.deepEqual(r.decryptedPoints, results[0]!.decryptedPoints, "IDENTICAL decrypted group points for every pair");
          assert.equal(r.ballotCount, ballots);
        }
        results[0]!.decryptedPoints.forEach((p, j) => assert.ok(pointsEqual(decrypted(p), mul(G, BigInt(truth[j]!))), "M = t*G"));
        assert.deepEqual(results.map((r) => r.usedTrustees), [[1, 2], [1, 3], [2, 3]]);
      }
    }
  });
});

describe("threshold decryption: the 7/4/2 election, partials, proofs and refusals", () => {
  let run: CeremonyRun;
  let aggregate: AggregateCiphertext;
  let partials: PartialDecryption[];
  let other: CeremonyRun; // another ceremony of the same election context

  before(() => {
    run = runCeremony();
    other = runCeremony();
    aggregate = aggregateFor(run.verified.electionPublicKey, [7, 4, 2]);
    partials = run.trustees.map((t) => t.partialDecrypt(aggregate));
  });
  const tally = (list: unknown[], agg: AggregateCiphertext = aggregate, transcript: unknown = run.verified) => tallyAggregate({ transcript, aggregate: agg, partials: list });
  const refuse = (list: unknown[], code: RegExp, agg: AggregateCiphertext = aggregate, transcript: unknown = run.verified): void => assert.throws(() => tally(list, agg, transcript), code);
  const tamper = (index: number, change: (p: PartialDecryption) => PartialDecryption): PartialDecryption => change(clone(partials[index]!));

  it("recovers [7, 4, 2] from each pair, with all proofs verified", () => {
    for (const [a, b] of PAIRS) {
      const result = tally([partials[a - 1], partials[b - 1]]);
      assert.deepEqual(result.totals, [7, 4, 2]);
      assert.equal(result.ballotCount, 13);
      assert.deepEqual(result.usedTrustees, [a, b]);
    }
  });

  it("the order in which the two partial decryptions are supplied does not matter", () => {
    assert.deepEqual(tally([partials[2], partials[0]]).totals, [7, 4, 2]);
    assert.deepEqual(tally([partials[1], partials[2]]).decryptedPoints, tally([partials[2], partials[1]]).decryptedPoints);
  });

  it("verifyPartialDecryption accepts honest partials and the same transcript given as plain JSON text is verified first", () => {
    for (const p of partials) assert.ok(verifyPartialDecryption({ transcript: run.verified, aggregate, partial: p }));
    const fromWire = JSON.parse(serializeTranscript(run.transcript));
    assert.ok(verifyPartialDecryption({ transcript: fromWire, aggregate, partial: partials[0] }));
    assert.deepEqual(tally([partials[0], partials[1]], aggregate, fromWire).totals, [7, 4, 2]);
    const tampered = { ...fromWire, transcriptHash: hex32(BigInt(fromWire.transcriptHash) + 1n) };
    assert.ok(!verifyPartialDecryption({ transcript: tampered, aggregate, partial: partials[0] }));
    refuse([partials[0], partials[1]], /HASH_MISMATCH/, aggregate, tampered);
  });

  it("ONE TRUSTEE ALONE cannot decrypt: a single partial decryption, or none, is refused by every workflow function", () => {
    refuse([partials[0]], /INSUFFICIENT_PARTIALS/);
    refuse([partials[2]], /INSUFFICIENT_PARTIALS/);
    refuse([], /INSUFFICIENT_PARTIALS/);
    assert.throws(() => combinePartialDecryptions({ transcript: run.verified, aggregate, partials: [partials[1]] }), /INSUFFICIENT_PARTIALS/);
  });

  it("...and its partial decryption is useless on its own: B - lambda*D_1 is not a count for ANY plausible lambda (1, 2, 3, -1, 1/2, 3/2, 2/3, random)", () => {
    const table = new BoundedDiscreteLog(aggregate.ballotCount);
    const lambdas = [1n, 2n, 3n, mod(-1n), inv(2n), sMul(3n, inv(2n)), sMul(2n, inv(3n)), mod(-2n), inv(3n), ...Array.from({ length: 5 }, () => randomScalar())];
    for (const slot of [0, 1, 2]) {
      const D1 = wire(partials[0]!.slots[slot]!.D);
      for (const lambda of lambdas) {
        const guess = sub(aggregate.slots[slot]!.B, mul(D1, lambda));
        assert.equal(table.solve(guess), null, `slot ${slot} lambda ${lambda}`);
      }
    }
  });

  it("a DUPLICATE trustee is refused: the same partial twice, two partials of the same trustee, or trustee 1 relabelled as trustee 2 or 3", () => {
    refuse([partials[0], partials[0]], /DUPLICATE_TRUSTEE/);
    const again = run.trustees[0]!.partialDecrypt(aggregate); // a fresh, perfectly valid second partial decryption by trustee 1
    refuse([partials[0], again], /DUPLICATE_TRUSTEE/);
    for (const label of [2, 3]) refuse([partials[0], tamper(0, (p) => ({ ...p, trusteeIndex: label }))], /INVALID_PARTIAL/);
    refuse([partials[1], tamper(0, (p) => ({ ...p, trusteeIndex: 2 }))], /DUPLICATE_TRUSTEE/);
    refuse([partials[0], partials[1], tamper(0, (p) => ({ ...p, trusteeIndex: 3 }))], /INVALID_PARTIAL/);
  });

  it("a MODIFIED partial decryption is refused: D changed, D replaced by a torsion-mixed point, the proof's e or z changed, non-canonical or zero proofs", () => {
    const D = (p: PartialDecryption, slot: number): Point => wire(p.slots[slot]!.D);
    const withSlot = (slot: number, change: (s: PartialDecryption["slots"][number]) => PartialDecryption["slots"][number]) => (p: PartialDecryption): PartialDecryption => ({ ...p, slots: p.slots.map((s, i) => (i === slot ? change(s) : s)) });
    refuse([partials[0], tamper(1, withSlot(1, (s) => ({ ...s, D: pointToWire(add(wire(s.D), G)) })))], /INVALID_PARTIAL/);
    refuse([partials[0], tamper(1, withSlot(2, (s) => ({ ...s, D: pointToWire(mixedPoint(wire(s.D), 1)) })))], /BAD_POINT/);
    refuse([partials[0], tamper(1, withSlot(0, (s) => ({ ...s, proof: { ...s.proof, e: hex32(BigInt(s.proof.e) ^ 1n) } })))], /INVALID_PARTIAL/);
    refuse([partials[0], tamper(1, withSlot(0, (s) => ({ ...s, proof: { ...s.proof, z: hex32(BigInt(s.proof.z) ^ 1n) } })))], /INVALID_PARTIAL/);
    refuse([partials[0], tamper(1, withSlot(0, (s) => ({ ...s, proof: { ...s.proof, z: hex32(BigInt(s.proof.z) + L) } })))], /BAD_SCALAR/);
    refuse([partials[0], tamper(1, withSlot(0, (s) => ({ ...s, proof: { e: hex32(0n), z: hex32(0n) } })))], /BAD_SCALAR|ZERO_SCALAR/);
    assert.ok(D(partials[0]!, 0));
  });

  it("a proof REUSED for another candidate slot is refused (the slots' proofs are swapped, and a slot-0 proof is copied into slot 1)", () => {
    refuse([partials[0], tamper(1, (p) => ({ ...p, slots: [{ ...p.slots[0]!, proof: p.slots[1]!.proof }, { ...p.slots[1]!, proof: p.slots[0]!.proof }, p.slots[2]!] }))], /INVALID_PARTIAL/);
    refuse([partials[0], tamper(1, (p) => ({ ...p, slots: [p.slots[0]!, { ...p.slots[0]!, slot: 1 }, p.slots[2]!] }))], /INVALID_PARTIAL/);
  });

  it("the slot layout must be exact: slots out of order, a slot missing, an extra slot, a repeated slot index", () => {
    refuse([partials[0], tamper(1, (p) => ({ ...p, slots: [p.slots[1]!, p.slots[0]!, p.slots[2]!] }))], /INVALID_PARTIAL/);
    refuse([partials[0], tamper(1, (p) => ({ ...p, slots: p.slots.slice(0, 2) }))], /INVALID_PARTIAL/);
    refuse([partials[0], tamper(1, (p) => ({ ...p, slots: [...p.slots, p.slots[0]!] }))], /INVALID_PARTIAL/);
  });

  it("a proof REUSED for another constituency is refused: the partial names another constituency, or the aggregate is another constituency's", () => {
    refuse([partials[0], tamper(1, (p) => ({ ...p, constituencyId: hex32(BigInt(p.constituencyId) + 1n) }))], /INVALID_PARTIAL/);
    const sameCiphertextsOtherConstituency = AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: aggregate.constituencyId + 1n, ballotCount: 13, slots: aggregate.slots.map((s) => ({ A: s.A, B: s.B })) });
    refuse([partials[0], partials[1]], /INVALID_PARTIAL/, sameCiphertextsOtherConstituency);
  });

  it("a proof REUSED for another aggregate (another A) is refused, even in the same constituency", () => {
    const another = aggregateFor(run.verified.electionPublicKey, [7, 4, 2], { constituencyId: aggregate.constituencyId });
    refuse([partials[0], partials[1]], /INVALID_PARTIAL/, another);
  });

  it("partials of ANOTHER CEREMONY's trustees are refused with this ceremony's transcript (and vice versa): a trustee key from another ceremony proves nothing here", () => {
    const foreign = other.trustees.map((t) => t.partialDecrypt(aggregate));
    refuse([partials[0], foreign[1]], /INVALID_PARTIAL/);
    refuse([foreign[0], foreign[1]], /INVALID_PARTIAL/);
    assert.throws(() => tallyAggregate({ transcript: other.verified, aggregate, partials: [partials[0], partials[1]] }), /INVALID_PARTIAL/);
  });

  it("another ELECTION: a trustee refuses an aggregate of another context, and a transcript of another context is refused for this aggregate", () => {
    const foreignContext = { chainId: 31337n, contractAddress: 0x1234n, electionId: TEST_CONTEXT.electionId };
    const foreignAggregate = aggregateFor(run.verified.electionPublicKey, [7, 4, 2], { context: foreignContext });
    assert.throws(() => run.trustees[0]!.partialDecrypt(foreignAggregate), /CONTEXT_MISMATCH/);
    assert.throws(() => tally([partials[0], partials[1]], foreignAggregate), /CONTEXT_MISMATCH/);
    const foreignRun = runCeremony({ context: foreignContext });
    assert.throws(() => tally([partials[0], partials[1]], aggregate, foreignRun.verified), /CONTEXT_MISMATCH/);
  });

  it("WRONG SCALAR MODULUS in the combination: Lagrange coefficients taken mod the field prime (or unreduced) do not recover the tally", () => {
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const D1 = wire(partials[0]!.slots[0]!.D);
    const D2 = wire(partials[1]!.slots[0]!.D);
    // right: S = 2*D1 - D2 (lambda = 2, -1 mod l). wrong: -1 taken mod p instead of mod l
    assert.throws(() => mul(D2, P - 1n), /BAD_SCALAR/, "the toolkit refuses a scalar that is not reduced mod l");
    const right = sub(aggregate.slots[0]!.B, sub(mul(D1, 2n), D2));
    assert.ok(pointsEqual(right, mul(G, 7n)));
  });
});

describe("threshold decryption: aggregates only, edge cases and tally validation", () => {
  let run: CeremonyRun;
  before(() => {
    run = runCeremony();
  });
  const H = (): Point => run.verified.electionPublicKey;

  it("only an AggregateCiphertext is accepted: raw ciphertexts, look-alikes, forged prototypes and direct construction are refused", () => {
    const real = aggregateFor(H(), [3, 2]);
    const lookalike = { context: real.context, constituencyId: real.constituencyId, ballotCount: real.ballotCount, slots: real.slots };
    const forged = Object.create(AggregateCiphertext.prototype, Object.getOwnPropertyDescriptors(lookalike));
    for (const bad of [lookalike, forged, { c1: [...G], c2: [...G] }, [G, G], real.slots[0], null, undefined, "aggregate", 5, real.toWire()]) {
      assert.throws(() => run.trustees[0]!.partialDecrypt(bad as AggregateCiphertext), /NOT_AN_AGGREGATE/, String(bad));
      assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate: bad as AggregateCiphertext, partials: [] }), /NOT_AN_AGGREGATE/);
    }
    assert.throws(() => new AggregateCiphertext(Symbol("x"), real.context, 1n, 2, real.slots), /NOT_AN_AGGREGATE/);
    assert.ok(AggregateCiphertext.isAggregate(real));
    assert.ok(!AggregateCiphertext.isAggregate(forged));
    assert.throws(() => ((real.slots[0] as { A: Point }).A = G), TypeError, "an aggregate is immutable");
    assert.throws(() => ((real as { ballotCount: number }).ballotCount = 99), TypeError);
  });

  it("AggregateCiphertext.create validates: ballot counts, slot counts, identity A, torsion points, the empty aggregate", () => {
    const slot = aggregateFor(H(), [2, 2]).slots[0]!;
    const make = (over: object) => AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: 5n, ballotCount: 4, slots: [slot], ...over });
    assert.doesNotThrow(() => make({}));
    for (const bad of [1.5, -1, NaN, MAX_BALLOT_COUNT + 1, "4"]) assert.throws(() => make({ ballotCount: bad }), /BAD_INTEGER/, String(bad));
    assert.throws(() => make({ slots: [] }), /BAD_SLOTS/);
    assert.throws(() => make({ slots: Array.from({ length: 17 }, () => slot) }), /BAD_SLOTS/);
    assert.throws(() => make({ slots: [{ A: [0n, 1n], B: slot.B }] }), /IDENTITY_POINT/);
    assert.throws(() => make({ slots: [{ A: mixedPoint(slot.A, 0), B: slot.B }] }), /BAD_POINT/);
    assert.throws(() => make({ slots: [{ A: slot.A, B: mixedPoint(slot.B, 5) }] }), /BAD_POINT/);
    assert.throws(() => make({ slots: [{ A: [1n, 2n], B: slot.B }] }), /BAD_POINT/);
    assert.throws(() => make({ constituencyId: 0n }), /BAD_CONSTITUENCY/);
    assert.throws(() => make({ context: { ...TEST_CONTEXT, chainId: 0n } }), /BAD_CONTEXT/);
    assert.throws(() => make({ ballotCount: 0 }), /INVALID_AGGREGATE/, "zero ballots but a non-identity aggregate");
    assert.doesNotThrow(() => make({ ballotCount: 0, slots: [{ A: [0n, 1n], B: [0n, 1n] }] }));
  });

  it("an EMPTY aggregate (zero ballots: the identity everywhere, what the contract starts with) tallies to zeros without any trustee; a trustee refuses to decrypt it", () => {
    const empty = AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: 9n, ballotCount: 0, slots: [{ A: [0n, 1n], B: [0n, 1n] }, { A: [0n, 1n], B: [0n, 1n] }] });
    assert.deepEqual(tallyAggregate({ transcript: run.verified, aggregate: empty, partials: [] }).totals, [0, 0]);
    assert.throws(() => run.trustees[0]!.partialDecrypt(empty), /AGGREGATE_TOO_SMALL/);
  });

  it("an aggregate of a SINGLE ballot is an individual ballot: trustees refuse it by default (minimum 2) and decrypt it only if explicitly configured for it", () => {
    const single = aggregateFor(H(), [0, 1, 0]);
    assert.equal(single.ballotCount, 1);
    for (const t of run.trustees) assert.throws(() => t.partialDecrypt(single), /AGGREGATE_TOO_SMALL/);
    const permissive = runCeremony({ minBallots: 1 });
    const one = aggregateFor(permissive.verified.electionPublicKey, [0, 1, 0]);
    const result = tallyAggregate({ transcript: permissive.verified, aggregate: one, partials: [permissive.trustees[0]!.partialDecrypt(one), permissive.trustees[2]!.partialDecrypt(one)] });
    assert.deepEqual(result.totals, [0, 1, 0]);
  });

  it("zero totals and the extremes are recovered: [0, 0, N], [N, 0], all votes for one candidate", () => {
    for (const totals of [[0, 0, 9], [9, 0], [0, 9], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]) {
      const aggregate = aggregateFor(H(), totals);
      const result = tallyAggregate({ transcript: run.verified, aggregate, partials: [run.trustees[0]!.partialDecrypt(aggregate), run.trustees[1]!.partialDecrypt(aggregate)] });
      assert.deepEqual(result.totals, totals);
    }
  });

  it("a LYING ballot count is caught: a count that is too small (a total exceeds it) or too large (the totals do not add up)", () => {
    const aggregate = aggregateFor(H(), [7, 4, 2]);
    const partials = [run.trustees[0]!.partialDecrypt(aggregate), run.trustees[1]!.partialDecrypt(aggregate)];
    const claim = (count: number): AggregateCiphertext => AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: aggregate.constituencyId, ballotCount: count, slots: aggregate.slots.map((s) => ({ A: s.A, B: s.B })) });
    assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate: claim(5), partials }), /TALLY_OUT_OF_BOUND/);
    assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate: claim(20), partials }), /TALLY_SUM_MISMATCH/);
    assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate: claim(14), partials }), /TALLY_SUM_MISMATCH/);
    assert.deepEqual(tallyAggregate({ transcript: run.verified, aggregate: claim(13), partials }).totals, [7, 4, 2]);
  });

  it("a TAMPERED aggregate half is caught: B + G (one extra vote) or a B from another encryption fails the bound or the sum check", () => {
    const aggregate = aggregateFor(H(), [7, 4, 2]);
    const partials = [run.trustees[0]!.partialDecrypt(aggregate), run.trustees[1]!.partialDecrypt(aggregate)];
    const withB = (j: number, B: Point): AggregateCiphertext => AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: aggregate.constituencyId, ballotCount: 13, slots: aggregate.slots.map((s, i) => ({ A: s.A, B: i === j ? B : s.B })) });
    assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate: withB(1, add(aggregate.slots[1]!.B, G)), partials }), /TALLY_SUM_MISMATCH/);
    assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate: withB(2, mul(G, randomScalar())), partials }), /TALLY_OUT_OF_BOUND/);
  });

  it("totals that do not add up to the ballot count (a vote counted twice, a non-one-hot ballot) are caught", () => {
    const aggregate = aggregateFor(H(), [5, 5], { ballotCount: 8 });
    const partials = [run.trustees[1]!.partialDecrypt(aggregate), run.trustees[2]!.partialDecrypt(aggregate)];
    assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate, partials }), /TALLY_SUM_MISMATCH/);
  });

  it("an aggregate encrypted under ANOTHER KEY decrypts to garbage and is caught (not a count within the bound)", () => {
    const wrongKey = mul(G, randomScalar());
    const aggregate = aggregateFor(wrongKey, [7, 4, 2]);
    const partials = [run.trustees[0]!.partialDecrypt(aggregate), run.trustees[1]!.partialDecrypt(aggregate)];
    assert.throws(() => tallyAggregate({ transcript: run.verified, aggregate, partials }), /TALLY_OUT_OF_BOUND/);
  });

  it("the largest aggregates work: 16 candidate slots, and a bound of 100,000 ballots", () => {
    const totals = Array.from({ length: 16 }, (_, i) => (i === 0 ? 100_000 - 15 : 1));
    const aggregate = aggregateFor(H(), totals);
    assert.equal(aggregate.ballotCount, 100_000);
    const partials = [run.trustees[0]!.partialDecrypt(aggregate), run.trustees[2]!.partialDecrypt(aggregate)];
    const result = tallyAggregate({ transcript: run.verified, aggregate, partials });
    assert.deepEqual(result.totals, totals);
    assert.ok(BoundedDiscreteLog.confirm(result.totals[0]!, decrypted(result.decryptedPoints[0]!)));
  });
});
