import { DESCRIPTOR_LENGTH } from "../../src/biometrics/constants.js";

/**
 * TEST FIXTURES ONLY: made-up face descriptors with a similarity we control.
 * Nothing here comes from a real person.
 */

/** Small deterministic random generator, so every run produces the same vectors. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const scaled = (v, k) => v.map((x) => x * k);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

/** A random unit vector: the "true face" of an imaginary person. Different seeds are different people. */
export function person(seed) {
  const random = mulberry32(seed);
  const v = Array.from({ length: DESCRIPTOR_LENGTH }, () => random() * 2 - 1);
  return scaled(v, 1 / norm(v));
}

/**
 * A capture whose cosine similarity to `base` is exactly `similarity` (up to rounding):
 * cos(angle) * base + sin(angle) * (a direction at right angles to base).
 */
export function capture(base, similarity, seed = 1) {
  const random = mulberry32(seed * 7919 + 13);
  const noise = Array.from({ length: base.length }, () => random() * 2 - 1);
  const along = dot(noise, base);
  const orthogonal = noise.map((x, i) => x - along * base[i]);
  const unit = scaled(orthogonal, 1 / norm(orthogonal));
  const sine = Math.sqrt(Math.max(0, 1 - similarity * similarity));
  return base.map((x, i) => similarity * x + sine * unit[i]);
}

/** `count` enrolment samples of one person: all close to the true face and to each other. */
export const samplesOf = (base, count = 3, similarity = 0.9) => Array.from({ length: count }, (_, i) => capture(base, similarity, 100 + i));

/** What a real browser sends: numbers rounded to 6 decimals. */
export const rounded = (v) => v.map((x) => Math.round(x * 1e6) / 1e6);

export const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b));
