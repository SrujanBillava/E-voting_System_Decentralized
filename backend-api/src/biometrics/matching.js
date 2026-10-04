import { MATCH_THRESHOLD } from "./constants.js";

/**
 * Face comparison. Two descriptors of the same person point in almost the same direction, so we measure
 * the angle between them: cosine similarity, 1 for identical directions, about 0 for unrelated faces.
 * Every function does the same amount of work whatever the result is (no early exit).
 */

/** Cosine similarity of two equal-length vectors. Returns 0 when either one is empty. */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  const denominator = Math.sqrt(aa) * Math.sqrt(bb);
  if (!(denominator > 0)) return 0;
  return Math.max(-1, Math.min(1, dot / denominator));
}

/** The highest similarity between `probe` and any enrolled sample. */
export function bestSimilarity(probe, samples) {
  let best = -1;
  for (const sample of samples) {
    const score = cosineSimilarity(probe, sample);
    if (score > best) best = score;
  }
  return samples.length > 0 ? best : 0;
}

/** The lowest similarity between any two samples (1 when there are fewer than two). */
export function lowestPairSimilarity(samples) {
  let lowest = 1;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 1; j < samples.length; j++) {
      const score = cosineSimilarity(samples[i], samples[j]);
      if (score < lowest) lowest = score;
    }
  }
  return lowest;
}

/**
 * THE verification decision, made on the server.
 * @returns {{ match: boolean, score: number }} score is the best similarity, rounded to 4 decimals
 */
export function decide(probe, samples, threshold = MATCH_THRESHOLD) {
  const score = bestSimilarity(probe, samples);
  return { match: score >= threshold, score: Math.round(score * 10000) / 10000 };
}
