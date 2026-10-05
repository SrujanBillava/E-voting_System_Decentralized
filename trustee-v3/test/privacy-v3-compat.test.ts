// Interoperability with the frozen privacy-v3 core: the same BabyJubJub group, the same exponential ElGamal conventions, the same election-key rules,
// and a real election whose ballots are encrypted by privacy-v3 and tallied by the trustees.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { AggregateCiphertext } from "../src/aggregate.ts";
import { FIELD_PRIME as P, G, IDENTITY, SUBGROUP_ORDER as L, TEST_CONTEXT, type Point } from "../src/params.ts";
import { add, isInSubgroup, mul, parsePointWire, pointsEqual } from "../src/point.ts";
import { randomScalar } from "../src/scalar.ts";
import { tallyAggregate } from "../src/threshold.ts";
import { runCeremony, type CeremonyRun } from "../testing/ceremony.ts";
import { encryptedBallot, pv3 } from "../testing/pv3.ts";
import { captureRandomness, logOf, scalarsOf } from "../testing/spy.ts";
import { curvePoints, mixedPoint, nonIdentityTorsion } from "../testing/torsion.ts";

const asPoint = (p: unknown): Point => [(p as bigint[])[0] as bigint, (p as bigint[])[1] as bigint];

describe("privacy-v3 compatibility: keys and conventions", () => {
  it("our exponential ElGamal slot (A, B) = (rG, tG + rH) is exactly what privacy-v3's encrypt produces, and ciphertexts add component-wise", () => {
    const H = mul(G, randomScalar());
    for (const t of [0, 1, 5, 99]) {
      const r = randomScalar();
      const theirs = pv3.elgamal.encrypt([...H], BigInt(t), r);
      assert.ok(pointsEqual(asPoint(theirs.c1), mul(G, r)));
      assert.ok(pointsEqual(asPoint(theirs.c2), add(mul(G, BigInt(t)), mul(H, r))));
    }
    const a = pv3.elgamal.encrypt([...H], 3n, randomScalar());
    const b = pv3.elgamal.encrypt([...H], 4n, randomScalar());
    const sum = pv3.elgamal.addCiphertexts(a, b);
    assert.ok(pointsEqual(asPoint(sum.c1), add(asPoint(a.c1), asPoint(b.c1))));
    assert.ok(pointsEqual(asPoint(sum.c2), add(asPoint(a.c2), asPoint(b.c2))));
  });

  it("an election key the toolkit would accept is exactly one privacy-v3's validatePublicKey accepts (non-identity prime-order subgroup point, x != 0): they agree on every kind of point", () => {
    const ours = (p: Point): boolean => isInSubgroup(p) && !pointsEqual(p, IDENTITY) && p[0] !== 0n;
    const sample: Point[] = [
      ...Array.from({ length: 5 }, () => mul(G, randomScalar())),
      ...nonIdentityTorsion(),
      ...Array.from({ length: 4 }, (_, i) => mixedPoint(mul(G, randomScalar()), i)),
      [0n, 1n],
      [0n, P - 1n],
      ...curvePoints(40).slice(0, 12),
    ];
    for (const p of sample) assert.equal(ours(p), pv3.elgamal.validatePublicKey([...p]), `${p[0]}:${p[1]}`);
  });

  it("the DKG's election public key passes privacy-v3's validatePublicKey and the contract's setElectionKey preconditions (canonical, on the curve, x != 0)", () => {
    const run = runCeremony();
    const H = run.verified.electionPublicKey;
    assert.ok(pv3.elgamal.validatePublicKey([...H]));
    assert.doesNotThrow(() => pv3.elgamal.assertValidPublicKey([...H]));
    assert.ok(H[0] !== 0n && H[0] < P && H[1] < P);
    assert.ok(isInSubgroup(H));
  });
});

describe("privacy-v3 compatibility: a real election, ballot by ballot", () => {
  let run: CeremonyRun;
  let s: bigint;
  const counts = [7, 4, 2];
  const ballots: { coords: bigint[] }[] = [];

  before(() => {
    const captured = captureRandomness(() => runCeremony());
    run = captured.result;
    const scalars = scalarsOf(captured.draws);
    // omniscient test-side only: the shared secret, to cross-check the decryption convention against privacy-v3's own decryptToPoint
    s = run.transcript.participants.reduce((acc, p) => (acc + (logOf(parsePointWire(p.commitments[0]!, "K"), scalars) as bigint)) % L, 0n);
    counts.forEach((count, candidate) => {
      for (let i = 0; i < count; i++) ballots.push(encryptedBallot(run.verified.electionPublicKey, counts.length, candidate));
    });
  });

  it("the aggregate recomputed from the public ballot log equals privacy-v3's homomorphic sum of the same ciphertexts", () => {
    const aggregate = AggregateCiphertext.fromBallotLog({ context: TEST_CONTEXT, constituencyId: 42n, slotCount: 3, ballots });
    assert.equal(aggregate.ballotCount, 13);
    for (let slot = 0; slot < 3; slot++) {
      let sum = pv3.elgamal.identityCiphertext();
      for (const b of ballots) sum = pv3.elgamal.addCiphertexts(sum, { c1: [b.coords[4 * slot]!, b.coords[4 * slot + 1]!], c2: [b.coords[4 * slot + 2]!, b.coords[4 * slot + 3]!] });
      assert.ok(pointsEqual(aggregate.slots[slot]!.A, asPoint(sum.c1)));
      assert.ok(pointsEqual(aggregate.slots[slot]!.B, asPoint(sum.c2)));
    }
  });

  it("the trustees recover [7, 4, 2] from privacy-v3's ciphertexts with every pair, and the result equals privacy-v3's own decryption under the (test-only) secret", () => {
    const aggregate = AggregateCiphertext.fromBallotLog({ context: TEST_CONTEXT, constituencyId: 42n, slotCount: 3, ballots });
    const partials = run.trustees.map((t) => t.partialDecrypt(aggregate));
    const dlog = pv3.elgamal.makeDiscreteLog(64n);
    for (const [a, b] of [[1, 2], [1, 3], [2, 3]] as const) {
      const result = tallyAggregate({ transcript: run.verified, aggregate, partials: [partials[a - 1], partials[b - 1]] });
      assert.deepEqual(result.totals, counts);
      result.decryptedPoints.forEach((wire, slot) => {
        const M = parsePointWire(wire, "M", { allowIdentity: true });
        const theirs = pv3.elgamal.decryptToPoint(s, { c1: [...aggregate.slots[slot]!.A], c2: [...aggregate.slots[slot]!.B] });
        assert.ok(pointsEqual(M, asPoint(theirs)), "the threshold result equals the single-key decryption it replaces");
        assert.equal(dlog(theirs), BigInt(counts[slot]!));
      });
    }
  });

  it("recomputing the aggregate from a log is strict: wrong coordinate counts, non-canonical or off-curve coordinates and an identity C1 are refused; a torsion-poisoned log fails the final subgroup check", () => {
    const make = (list: { coords: bigint[] }[]) => () => AggregateCiphertext.fromBallotLog({ context: TEST_CONTEXT, constituencyId: 42n, slotCount: 3, ballots: list });
    const good = ballots[0]!;
    assert.throws(make([{ coords: good.coords.slice(0, 11) }]), /BAD_LOG/);
    assert.throws(make([{ coords: [...good.coords, 0n] }]), /BAD_LOG/);
    assert.throws(make([{ coords: good.coords.map((c, i) => (i === 3 ? c + P : c)) }]), /BAD_LOG/);
    assert.throws(make([{ coords: good.coords.map((c, i) => (i === 2 ? c + 1n : c)) }]), /BAD_LOG/, "off the curve");
    assert.throws(make([{ coords: good.coords.map((c, i) => (i === 4 ? 0n : i === 5 ? 1n : c)) }]), /BAD_LOG/, "identity C1");
    assert.throws(make("log" as never), /BAD_LOG/);
    const [tx, ty] = nonIdentityTorsion()[2]!;
    assert.throws(make([{ coords: good.coords.map((c, i) => (i === 0 ? tx : i === 1 ? ty : c)) }, ...ballots.slice(1)]), /BAD_POINT/, "a torsion point in C1 poisons the sum");
    assert.doesNotThrow(make(ballots));
  });
});
