// TEST / DEMO SUPPORT ONLY. The single adapter between the trustee toolkit and the frozen privacy-v3 crypto core (exponential ElGamal over BabyJubJub).
// Nothing under src/ imports it, so the toolkit itself has no runtime coupling to privacy-v3.
import type { Point } from "../src/params.ts";

const base = new URL("../../privacy-v3/src/", import.meta.url);
let core: { elgamal: any; ballot: any; params: any };
try {
  const [elgamal, ballot, params] = await Promise.all(["elgamal.js", "ballot.js", "params.js"].map((f) => import(new URL(f, base).href)));
  core = { elgamal, ballot, params };
} catch (error) {
  throw new Error(`the privacy-v3 crypto core is needed for tests and the demo (run "npm ci" in ../privacy-v3): ${(error as Error).message}`);
}

export const pv3 = core;

/** One valid, encrypted one-hot ballot under H, exactly as a voter (or the privacy-v3 core) makes it: the `coords` of its BallotRecorded event, slot-major C1.x, C1.y, C2.x, C2.y. */
export function encryptedBallot(H: Point, slotCount: number, choice: number): { coords: bigint[] } {
  const m = core.ballot.oneHot(choice, slotCount);
  const { ciphertexts } = core.ballot.encryptVector({ H: [...H], kc: slotCount, m });
  const coords: bigint[] = [];
  for (let j = 0; j < slotCount; j++) coords.push(...ciphertexts[j].c1, ...ciphertexts[j].c2);
  return { coords };
}

/** Encrypts an ARBITRARY vote vector (it may be invalid, e.g. two-hot or value 5) under H with privacy-v3's exponential ElGamal: the `coords` of a hostile ballot. */
export function encryptedVector(H: Point, slotCount: number, votes: readonly bigint[]): { coords: bigint[] } {
  const m = [...votes, ...Array.from({ length: 16 - votes.length }, () => 0n)];
  const { ciphertexts } = core.ballot.encryptVector({ H: [...H], kc: slotCount, m });
  const coords: bigint[] = [];
  for (let j = 0; j < slotCount; j++) coords.push(...ciphertexts[j].c1, ...ciphertexts[j].c2);
  return { coords };
}
