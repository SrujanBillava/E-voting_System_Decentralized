// Canonical encodings: the preimages are exactly what Solidity's abi.encode produces for static words; strict hex; exact-shape objects.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AbiCoder, keccak256, toBeHex } from "ethers";
import { assertInteger, encodeWords, exactKeys, hex32, hexOfBytes, keccakWords, parseHex32, parseHexBytes, word } from "../src/encoding.ts";
import { randomScalar } from "../src/scalar.ts";

describe("abi.encode compatibility (static words)", () => {
  const coder = AbiCoder.defaultAbiCoder();

  it("encodeWords equals ethers' abi.encode of uint256 values, for edge values and random ones", () => {
    const values = [0n, 1n, 255n, 2n ** 64n, 2n ** 255n, 2n ** 256n - 1n, randomScalar(), randomScalar()];
    assert.equal(hexOfBytes(encodeWords(values)), coder.encode(values.map(() => "uint256"), values));
  });

  it("equals abi.encode for the mixed bytes32 / uint256 / address / uint8 shape used by the challenges (address and uint8 are left-padded words)", () => {
    const tag = BigInt(keccak256(new TextEncoder().encode("tag")));
    const address = 0x5fbdb2315678afecb367f032d93f642f64180aa3n;
    const abi = coder.encode(["bytes32", "uint256", "address", "bytes32", "uint8", "uint256"], [toBeHex(tag, 32), 31337n, toBeHex(address, 20), toBeHex(7n, 32), 2, 99n]);
    assert.equal(hexOfBytes(encodeWords([tag, 31337n, address, 7n, 2n, 99n])), abi);
  });

  it("keccakWords is keccak256 of that encoding", () => {
    const values = [11n, 22n, randomScalar()];
    assert.equal(hex32(keccakWords(values)), keccak256(coder.encode(["uint256", "uint256", "uint256"], values)));
  });

  it("words are fixed width, so tuples that differ only in how digits are split cannot collide", () => {
    assert.equal(encodeWords([1n, 23n]).length, 64);
    assert.notEqual(hexOfBytes(encodeWords([1n, 23n])), hexOfBytes(encodeWords([12n, 3n])));
    assert.throws(() => word(-1n), /BAD_WORD/);
    assert.throws(() => word(2n ** 256n), /BAD_WORD/);
    assert.throws(() => word(5 as unknown as bigint), /BAD_WORD/);
  });
});

describe("strict hex and shapes", () => {
  it("parseHex32 accepts only 0x + 64 lowercase hex digits", () => {
    const good = hex32(2n ** 200n + 0xabcdefn); // contains hex letters, so the uppercase variant really differs
    assert.equal(parseHex32(good, "v"), 2n ** 200n + 0xabcdefn);
    for (const bad of [good.toUpperCase().replace("0X", "0x"), good.slice(0, -1), good + "0", good.slice(2), "0x" + "g".repeat(64), " " + good, good + "\n", 5n, 5, null, undefined]) {
      assert.throws(() => parseHex32(bad, "v"), /BAD_ENCODING/, String(bad));
    }
  });

  it("parseHexBytes needs the exact length and lowercase", () => {
    assert.deepEqual([...parseHexBytes("0x0aff", 2, "b")], [10, 255]);
    for (const bad of ["0x0aff00", "0x0a", "0x0AFF", "0aff", "0xzzzz", 5]) assert.throws(() => parseHexBytes(bad, 2, "b"), /BAD_ENCODING/, String(bad));
  });

  it("exactKeys needs a plain object with EXACTLY the expected fields: no extras, no missing, no arrays, no class instances", () => {
    assert.deepEqual(exactKeys({ a: 1, b: 2 }, ["b", "a"], "x"), { a: 1, b: 2 });
    class Fake {
      a = 1;
      b = 2;
    }
    for (const bad of [{ a: 1 }, { a: 1, b: 2, c: 3 }, [], null, undefined, "x", 5, new Fake(), Object.create({ a: 1, b: 2 })]) {
      assert.throws(() => exactKeys(bad, ["a", "b"], "x"), /BAD_STRUCTURE/, String(bad));
    }
  });

  it("assertInteger refuses non-integers, NaN, bigint, strings and out-of-range values", () => {
    assert.equal(assertInteger(3, 1, 3, "i"), 3);
    for (const bad of [0, 4, 1.5, NaN, Infinity, "2", 2n, null, undefined]) assert.throws(() => assertInteger(bad, 1, 3, "i"), /BAD_INTEGER/, String(bad));
  });
});
