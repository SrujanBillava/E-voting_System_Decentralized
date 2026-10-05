// TEST SUPPORT ONLY. Lets a test play the omniscient observer: it records every byte the toolkit draws from the OS CSPRNG (node:crypto randomBytes), so the
// test can reconstruct every secret scalar (coefficients, nonces) and then check that none of them, and nothing computed from them, leaks into public output.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { SUBGROUP_ORDER } from "../src/params.ts";
import { G, mul, pointsEqual, type Point } from "../src/point.ts";

export function captureRandomness<T>(fn: () => T): { result: T; draws: Buffer[] } {
  const mutable = crypto as unknown as { randomBytes: (size: number) => Buffer };
  const original = mutable.randomBytes;
  const draws: Buffer[] = [];
  mutable.randomBytes = (size: number): Buffer => {
    const bytes = original.call(crypto, size);
    draws.push(Buffer.from(bytes));
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    return { result: fn(), draws };
  } finally {
    mutable.randomBytes = original;
    syncBuiltinESMExports();
  }
}

/** The same for an async flow (a whole chain interaction): every draw made while `fn` runs is recorded. Do not run two captures at once. */
export async function captureRandomnessAsync<T>(fn: () => Promise<T>): Promise<{ result: T; draws: Buffer[] }> {
  const mutable = crypto as unknown as { randomBytes: (size: number) => Buffer };
  const original = mutable.randomBytes;
  const draws: Buffer[] = [];
  mutable.randomBytes = (size: number): Buffer => {
    const bytes = original.call(crypto, size);
    draws.push(Buffer.from(bytes));
    return bytes;
  };
  syncBuiltinESMExports();
  try {
    return { result: await fn(), draws };
  } finally {
    mutable.randomBytes = original;
    syncBuiltinESMExports();
  }
}

/** every scalar the toolkit drew through randomScalar(): 48 bytes -> (int mod (l-1)) + 1 */
export const scalarsOf = (draws: Buffer[]): bigint[] => draws.filter((d) => d.length === 48).map((d) => (BigInt("0x" + d.toString("hex")) % (SUBGROUP_ORDER - 1n)) + 1n);

/** the scalar a such that a*G == K, if it is among the drawn scalars */
export const logOf = (K: Point, scalars: bigint[]): bigint | undefined => scalars.find((a) => pointsEqual(mul(G, a), K));

/** every textual spelling of a secret value that could end up in a log or a message */
export function spellings(value: bigint): string[] {
  const hex = value.toString(16);
  return [value.toString(10), hex, hex.padStart(64, "0"), hex.toUpperCase(), hex.toUpperCase().padStart(64, "0")];
}

/** Fails if the payload (a string, or anything JSON-serialisable with bigints) contains ANY spelling of ANY of the secrets. */
export function assertNoLeak(label: string, payload: unknown, secrets: readonly bigint[]): void {
  const text = (typeof payload === "string" ? payload : JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value))).toLowerCase();
  for (const secret of secrets) {
    for (const form of spellings(secret)) {
      if (text.includes(form.toLowerCase())) throw new Error(`${label}: contains a secret value`);
    }
  }
}
