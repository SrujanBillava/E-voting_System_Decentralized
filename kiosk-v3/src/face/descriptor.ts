import { DESCRIPTOR_LENGTH } from "./config.ts";

export class DescriptorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DescriptorError";
  }
}

/**
 * Checks a descriptor before it is sent anywhere: exactly 512 finite numbers, not all zero. Throws DescriptorError (the message never
 * contains the values). Returns a plain number array.
 */
export function validateDescriptor(input: ArrayLike<number>): number[] {
  if (!input || input.length !== DESCRIPTOR_LENGTH) throw new DescriptorError(`descriptor must have ${DESCRIPTOR_LENGTH} numbers`);
  const out: number[] = new Array(DESCRIPTOR_LENGTH);
  let energy = 0;
  for (let i = 0; i < DESCRIPTOR_LENGTH; i++) {
    const v = input[i];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new DescriptorError("descriptor contains a value that is not a finite number");
    out[i] = v;
    energy += v * v;
  }
  if (energy < 1e-12) throw new DescriptorError("descriptor is empty");
  return out;
}

/**
 * Lossless for the model's float32 output (9 significant digits round-trip a float32) and about 13 characters per number, so five
 * enrolment samples stay near 35 kB, far below the 100 kB request limit. This is NOT coarse rounding.
 */
export const compactDescriptor = (d: readonly number[]): number[] => d.map((v) => Number(v.toPrecision(9)));

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
