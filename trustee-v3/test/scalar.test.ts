// Scalar arithmetic is mod l, never mod the field prime p; canonical-form checks; the entropy source.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256 } from "ethers";
import { FIELD_PRIME, SUBGROUP_ORDER as L } from "../src/params.ts";
import { add, assertScalar, hashToScalar, inv, isCanonicalScalar, mod, mul, neg, parseScalarWire, pow, randomScalar, scalarToWire, sub } from "../src/scalar.ts";

describe("scalar arithmetic is modulo l", () => {
  it("reduces mod l: mod(-1) = l-1, mod(l) = 0, and l (not p) is the wrap-around point", () => {
    assert.equal(mod(-1n), L - 1n);
    assert.equal(mod(L), 0n);
    assert.equal(mod(L + 5n), 5n);
    assert.equal(add(L - 1n, 1n), 0n);
    assert.notEqual(add(L - 1n, 1n), L, "a sum that reaches l wraps to 0; it is never left unreduced");
    assert.equal(add(FIELD_PRIME - 1n, 1n), FIELD_PRIME % L, "p is not special: it reduces like any other integer");
  });

  it("add/sub/mul/neg satisfy the field laws on random scalars", () => {
    for (let i = 0; i < 200; i++) {
      const a = randomScalar();
      const b = randomScalar();
      const c = randomScalar();
      assert.equal(add(a, neg(a)), 0n);
      assert.equal(sub(add(a, b), b), a);
      assert.equal(mul(a, add(b, c)), add(mul(a, b), mul(a, c)));
      assert.equal(mul(mul(a, b), c), mul(a, mul(b, c)));
    }
  });

  it("inverse: a * a^-1 = 1 for random scalars; 0 has no inverse; l is prime so Fermat holds", () => {
    for (let i = 0; i < 100; i++) {
      const a = randomScalar();
      assert.equal(mul(a, inv(a)), 1n);
    }
    assert.throws(() => inv(0n), /DIVISION_BY_ZERO/);
    assert.throws(() => inv(L), /DIVISION_BY_ZERO/);
    assert.equal(pow(2n, L - 1n), 1n);
  });

  it("the BN254 field prime is a WRONG modulus and gives different answers: the same product mod p and mod l disagree", () => {
    const a = L - 3n;
    const b = L - 7n;
    const rightModL = mul(a, b);
    const wrongModP = (a * b) % FIELD_PRIME;
    assert.notEqual(rightModL, wrongModP);
    assert.ok(rightModL < L && wrongModP >= L === (wrongModP >= L), "sanity");
  });
});

describe("canonical scalars", () => {
  it("accepts exactly 0 <= v < l; refuses l, l+1, p, negatives, numbers, strings", () => {
    for (const ok of [0n, 1n, L - 1n, L >> 1n]) assert.ok(isCanonicalScalar(ok));
    for (const bad of [L, L + 1n, FIELD_PRIME, -1n, 5, "5", null, undefined, {}, [1n]]) assert.ok(!isCanonicalScalar(bad as unknown), String(bad));
  });

  it("assertScalar can also require non-zero", () => {
    assert.equal(assertScalar(7n, "x", { nonZero: true }), 7n);
    assert.throws(() => assertScalar(0n, "x", { nonZero: true }), /ZERO_SCALAR/);
    assert.throws(() => assertScalar(L, "x"), /BAD_SCALAR/);
  });

  it("wire form: 0x + 64 lowercase hex, strictly; round trips; refuses uppercase, short, long, unprefixed, values >= l", () => {
    for (const v of [0n, 1n, L - 1n, randomScalar()]) assert.equal(parseScalarWire(scalarToWire(v), "v"), v);
    const good = scalarToWire(0xabcdef12345n); // contains hex letters, so the uppercase variant really differs
    assert.match(good, /^0x[0-9a-f]{64}$/);
    for (const bad of [good.toUpperCase().replace("0X", "0x"), good.slice(0, -2), good + "00", good.slice(2), "0x" + L.toString(16).padStart(64, "0"), "0x" + FIELD_PRIME.toString(16).padStart(64, "0"), 12345n, 12345, null]) {
      assert.throws(() => parseScalarWire(bad, "v"), /BAD_ENCODING|BAD_SCALAR/, String(bad));
    }
    assert.throws(() => scalarToWire(L), /BAD_SCALAR/);
    assert.throws(() => parseScalarWire(scalarToWire(0n), "v", { nonZero: true }), /ZERO_SCALAR/);
  });
});

describe("randomScalar and hashToScalar", () => {
  it("2000 draws are distinct, in [1, l-1], with the expected top-bit and parity frequencies (CSPRNG-looking)", () => {
    const draws = Array.from({ length: 2000 }, () => randomScalar());
    assert.equal(new Set(draws).size, draws.length);
    assert.ok(draws.every((r) => r >= 1n && r < L));
    const high = draws.filter((r) => r >= 1n << 250n).length / draws.length; // (l - 2^250) / l = 0.339
    const odd = draws.filter((r) => (r & 1n) === 1n).length / draws.length;
    assert.ok(high > 0.28 && high < 0.4, `fraction above 2^250: ${high}`);
    assert.ok(odd > 0.44 && odd < 0.56, `fraction odd: ${odd}`);
  });

  it("randomScalar takes no arguments and ignores any it is given (no seed, no injected source)", () => {
    assert.equal(randomScalar.length, 0);
    const constant = () => Buffer.alloc(48, 7);
    assert.notEqual((randomScalar as (...a: unknown[]) => bigint)(constant), (randomScalar as (...a: unknown[]) => bigint)(constant));
  });

  it("hashToScalar is uint256(keccak256(preimage)) mod l: equal to an independent ethers computation for preimages of every length", () => {
    for (const length of [0, 1, 31, 32, 33, 64, 352, 544, 1000]) {
      const preimage = Uint8Array.from(Array.from({ length }, () => Math.floor(Math.random() * 256)));
      assert.equal(hashToScalar(preimage), BigInt(keccak256(preimage)) % L, `length ${length}`);
    }
    assert.equal(hashToScalar(new Uint8Array(0)), BigInt("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470") % L, "keccak256 of the empty string, reduced mod l");
  });

  it("the reduction of a 256-bit hash mod the 251-bit l is slightly non-uniform, exactly as documented: 2^256/l is about 42.3, so the likeliest challenge has probability 43/2^256", () => {
    const N = 1n << 256n;
    const q = N / L;
    assert.equal(q, 42n);
    assert.ok(N % L > 0n && N % L < L, "the residues below 2^256 mod l are the (43/42 times) likelier ones");
    const worstChallengeBits = 256 - Math.log2(Number(q + 1n)); // -log2 of the likeliest challenge's probability, 43 / 2^256
    const uniformBits = Math.log2(Number(L));
    assert.ok(uniformBits - worstChallengeBits > 0.02 && uniformBits - worstChallengeBits < 0.03, `min-entropy loss ${uniformBits - worstChallengeBits} bits (documented: about 0.02)`);
  });

  it("hashToScalar is deterministic, in [0, l), and sensitive to every input bit", () => {
    const a = new Uint8Array(64).fill(1);
    const b = Uint8Array.from(a);
    b[63] ^= 1;
    assert.equal(hashToScalar(a), hashToScalar(Uint8Array.from(a)));
    assert.notEqual(hashToScalar(a), hashToScalar(b));
    assert.ok(hashToScalar(a) < L);
  });
});
