import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MATCH_THRESHOLD } from "../../src/biometrics/constants.js";
import { toUnitVector } from "../../src/biometrics/descriptor.js";
import { bestSimilarity, cosineSimilarity, decide, lowestPairSimilarity } from "../../src/biometrics/matching.js";
import { capture, person, samplesOf } from "../helpers/face.js";

const unit = (v) => toUnitVector(v);
const close = (actual, expected, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

describe("face matching: cosine similarity", () => {
  it("is 1 for the same vector, -1 for the opposite one, and symmetric", () => {
    const a = unit(person(1));
    const b = unit(person(2));
    close(cosineSimilarity(a, a), 1, 1e-6);
    close(cosineSimilarity(a, a.map((x) => -x)), -1, 1e-6);
    assert.equal(cosineSimilarity(a, b), cosineSimilarity(b, a));
  });

  it("does not depend on the length of the vectors, only on their direction", () => {
    const a = person(1);
    const b = capture(a, 0.6);
    close(cosineSimilarity(a.map((x) => x * 40), b.map((x) => x * 0.01)), 0.6);
  });

  it("two unrelated random faces score near 0", () => {
    for (let seed = 10; seed < 40; seed++) assert.ok(Math.abs(cosineSimilarity(unit(person(seed)), unit(person(seed + 1000)))) < 0.2);
  });

  it("stays inside [-1, 1] and is 0 for empty or mismatched input instead of NaN", () => {
    const a = unit(person(1));
    assert.equal(cosineSimilarity(a, new Float32Array(a.length)), 0);
    assert.equal(cosineSimilarity(new Float32Array(0), new Float32Array(0)), 0);
    assert.equal(cosineSimilarity(a, a.subarray(0, 100)), 0);
    const score = cosineSimilarity(a, a);
    assert.ok(score <= 1 && score >= -1);
  });

  it("matches the similarity the test fixtures were built with", () => {
    const base = person(5);
    for (const wanted of [0.99, 0.9, 0.7, 0.5, 0.45, 0.3, 0.1, 0]) close(cosineSimilarity(unit(base), unit(capture(base, wanted))), wanted);
  });
});

describe("face matching: the decision", () => {
  const base = person(7);
  const enrolled = samplesOf(base, 3).map(unit);

  it("accepts a fresh capture of the enrolled person", () => {
    const out = decide(unit(capture(base, 0.85, 50)), enrolled);
    assert.equal(out.match, true);
    assert.ok(out.score > MATCH_THRESHOLD);
  });

  it("rejects a different person", () => {
    for (let seed = 200; seed < 230; seed++) {
      const out = decide(unit(person(seed)), enrolled);
      assert.equal(out.match, false, `seed ${seed} scored ${out.score}`);
    }
  });

  it("threshold edge: a score equal to the threshold passes, a score just below it fails", () => {
    const sample = unit(base);
    const probe = unit(capture(base, 0.5));
    const score = cosineSimilarity(probe, sample);
    assert.equal(decide(probe, [sample], score).match, true, "equal passes (>=)");
    assert.equal(decide(probe, [sample], score + 1e-9).match, false, "a hair above the score fails");
    assert.equal(decide(probe, [sample], score - 1e-9).match, true);
  });

  it("uses the default threshold constant when none is given", () => {
    const sample = unit(base);
    assert.equal(decide(unit(capture(base, MATCH_THRESHOLD + 0.02)), [sample]).match, true);
    assert.equal(decide(unit(capture(base, MATCH_THRESHOLD - 0.02)), [sample]).match, false);
  });

  it("scores against the BEST enrolled sample, wherever it is in the list", () => {
    const probe = unit(capture(base, 0.9, 77));
    const strangers = [unit(person(301)), unit(person(302))];
    const near = unit(base);
    for (const samples of [[near, ...strangers], [strangers[0], near, strangers[1]], [...strangers, near]]) {
      const out = decide(probe, samples);
      assert.equal(out.match, true);
      close(out.score, 0.9);
      assert.equal(bestSimilarity(probe, samples), cosineSimilarity(probe, near));
    }
  });

  it("never matches against an empty template", () => {
    assert.deepEqual(decide(unit(base), []), { match: false, score: 0 });
  });

  it("reports the score rounded to 4 decimals", () => {
    const { score } = decide(unit(capture(base, 0.612345678)), [unit(base)]);
    assert.equal(score, Math.round(score * 10000) / 10000);
    close(score, 0.6123, 2e-4);
  });
});

describe("face matching: enrolment consistency", () => {
  it("samples of one person have a high lowest-pair similarity", () => {
    assert.ok(lowestPairSimilarity(samplesOf(person(9), 5).map(unit)) > 0.7);
  });

  it("one stranger among the samples pulls the lowest pair down to about 0", () => {
    const mixed = [...samplesOf(person(9), 4), person(400)].map(unit);
    assert.ok(lowestPairSimilarity(mixed) < 0.2);
  });

  it("is 1 for fewer than two samples", () => {
    assert.equal(lowestPairSimilarity([]), 1);
    assert.equal(lowestPairSimilarity([unit(person(1))]), 1);
  });
});
