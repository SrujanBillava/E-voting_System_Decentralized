import { DESCRIPTOR_LENGTH, DESCRIPTOR_MAX_ABS, DESCRIPTOR_MIN_NORM } from "./constants.js";

/**
 * A face descriptor arrives as a plain JSON array of numbers. These helpers decide whether it is acceptable
 * and turn it into the form everything else uses: a Float32Array scaled so that its length (L2 norm) is 1,
 * a "unit vector". After that only the direction is left, which is what cosine similarity compares.
 * Nothing here ever puts descriptor values into an error message.
 */

/** True when `value` is an array of exactly DESCRIPTOR_LENGTH finite numbers inside the sane range. */
export function isDescriptorShape(value) {
  if (!Array.isArray(value) || value.length !== DESCRIPTOR_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const x = value[i];
    if (typeof x !== "number" || !Number.isFinite(x) || Math.abs(x) > DESCRIPTOR_MAX_ABS) return false;
  }
  return true;
}

/**
 * Validates and normalises one descriptor.
 * @returns {Float32Array | null} the unit vector, or null when the input is not a usable descriptor
 */
export function toUnitVector(value) {
  if (!isDescriptorShape(value)) return null;
  let sum = 0;
  for (let i = 0; i < value.length; i++) sum += value[i] * value[i];
  const norm = Math.sqrt(sum);
  if (!(norm >= DESCRIPTOR_MIN_NORM)) return null; // all zeros carries no information
  const unit = new Float32Array(DESCRIPTOR_LENGTH);
  for (let i = 0; i < value.length; i++) unit[i] = value[i] / norm;
  return unit;
}
