// Canonical encodings. Every hash in this toolkit is taken over STATIC 32-byte big-endian words, exactly what Solidity's abi.encode produces for
// bytes32 / uint256 / address / uint8 arguments (the same style as the frozen V3 scope and ballot-hash encodings): fixed width, no length prefixes,
// no packing, so two different field tuples can never produce the same preimage. test/encoding.test.ts cross-checks this against ethers' AbiCoder.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { InvalidInputError } from "./errors.ts";

const UINT256_LIMIT = 1n << 256n;

/** A uint256 as 32 big-endian bytes. */
export function word(value: bigint): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value >= UINT256_LIMIT) throw new InvalidInputError("BAD_WORD", "value is not a uint256");
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** abi.encode of a list of static uint256-like words. */
export function encodeWords(values: readonly bigint[]): Uint8Array {
  return concatBytes(...values.map(word));
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt("0x" + bytesToHex(bytes));
}

/** keccak256(abi.encode(words)) as a uint256: the form pinned on-chain (transcript hash, ceremony id). */
export function keccakWords(values: readonly bigint[]): bigint {
  return bytesToBigInt(keccak_256(encodeWords(values)));
}

/** "0x" + 64 lowercase hex digits. */
export function hex32(value: bigint): string {
  return "0x" + bytesToHex(word(value));
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/** Strict inverse of hex32: exactly 0x + 64 LOWERCASE hex digits (no uppercase, no short forms, no whitespace). */
export function parseHex32(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !HEX32.test(value)) throw new InvalidInputError("BAD_ENCODING", `${what} must be 0x followed by 64 lowercase hex digits`);
  return BigInt(value);
}

/** "0x" + lowercase hex of arbitrary bytes. */
export function hexOfBytes(bytes: Uint8Array): string {
  return "0x" + bytesToHex(bytes);
}

/** Strict: "0x" + exactly 2*length lowercase hex digits. */
export function parseHexBytes(value: unknown, length: number, what: string): Uint8Array {
  if (typeof value !== "string" || value.length !== 2 + 2 * length || !/^0x[0-9a-f]*$/.test(value)) {
    throw new InvalidInputError("BAD_ENCODING", `${what} must be 0x followed by ${2 * length} lowercase hex digits`);
  }
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = parseInt(value.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}

/** A plain-object check that rejects arrays, null, class instances and objects with extra or missing keys: wire messages have an exact shape. */
export function exactKeys(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new InvalidInputError("BAD_STRUCTURE", `${what} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i])) throw new InvalidInputError("BAD_STRUCTURE", `${what} must have exactly the fields ${expected.join(", ")}`);
  return value as Record<string, unknown>;
}

export function assertInteger(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new InvalidInputError("BAD_INTEGER", `${what} must be an integer in ${min}..${max}`);
  return value;
}
