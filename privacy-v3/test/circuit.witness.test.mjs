// Ballot-validity circuit, witness level (no proving): which witnesses satisfy the constraint system and which do not.
// A rejected witness reports the exact source line of the violated constraint, so each negative test also proves it failed for the INTENDED reason.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, describe, it } from "node:test";
import * as snarkjs from "snarkjs";
import { validityArtifacts } from "../src/artifacts.js";
import { ballotHash, encryptVector, oneHot, validityPublicSignals } from "../src/ballot.js";
import { add, encrypt, generateTestKeyPair, randomScalar } from "../src/elgamal.js";
import { FIELD_PRIME, G } from "../src/params.js";
import { calculateWitness, shutdownProver } from "../src/validity.js";
import { BLR, SKIP_NO_ARTIFACTS, ctx, tryWitness, vec, witnessInput } from "./helpers.mjs";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const { publicKey: H } = generateTestKeyPair();
const { publicKey: H2 } = generateTestKeyPair();
after(shutdownProver);

describe("ballot validity circuit: honest witnesses", { skip: SKIP_NO_ARTIFACTS }, () => {
  for (const kc of [1, 2, 3, 8, 15, 16]) {
    for (const choice of new Set([0, kc - 1])) {
      it(`kc=${kc}, vote for candidate ${choice}`, async () => {
        const { input } = witnessInput({ H, kc, m: oneHot(choice, kc) });
        assert.deepEqual(await tryWitness(input), { ok: true });
      });
    }
  }

  it("the circuit's public signals equal the JS statement (ballot hash, context, key, ciphertexts), and the R1CS accepts the witness", async () => {
    const kc = 16;
    const { input, ciphertexts, hash } = witnessInput({ H, kc, m: oneHot(9, kc), nullifier: 123456789n });
    const wtns = await calculateWitness(input);
    const w = await snarkjs.wtns.exportJson(wtns);
    const expected = validityPublicSignals({ ctx, constituencyId: BLR, kc, H, nullifier: 123456789n, ciphertexts, hash });
    assert.deepEqual(w.slice(1, 1 + expected.length).map(String), expected);
    assert.equal(expected.length, 73, "1 output + 72 public inputs");
    assert.equal(await snarkjs.wtns.check(validityArtifacts.r1cs, wtns, quiet), true);
  });

  it("any nullifier value is acceptable to the circuit (it is an input the verifier supplies and the proof is bound to)", async () => {
    for (const nullifier of [0n, 1n, FIELD_PRIME - 1n]) assert.equal((await tryWitness(witnessInput({ H, kc: 3, m: oneHot(2, 3), nullifier }).input)).ok, true);
  });
});

describe("ballot validity circuit: invalid BALLOTS are unsatisfiable", { skip: SKIP_NO_ARTIFACTS }, () => {
  const cases = [
    ["two-hot [1,1,0,...]", 3, vec([0, 1]), /total === 1/],
    ["two-hot with kc=16 [.., 1 at 0 and 15]", 16, vec([0, 15]), /total === 1/],
    ["zero-hot [0,0,0,...]", 3, vec([]), /total === 1/],
    ["invalid value 5 in the voted slot", 3, vec([], { 0: 5n }), /m\[j\] \* \(m\[j\] - 1\) === 0/],
    ["invalid value 2 (sum would be 2)", 3, vec([], { 1: 2n }), /m\[j\] \* \(m\[j\] - 1\) === 0/],
    ["field wrap-around [2, -1, 0...] (sums to 1 mod p but is not binary)", 3, vec([], { 0: 2n, 1: FIELD_PRIME - 1n }), /m\[j\] \* \(m\[j\] - 1\) === 0/],
    ["vote in a padded slot (kc=3, slot 3)", 3, vec([3]), /inactiveMask\[j\] === 0/],
    ["vote in the last padded slot (kc=3, slot 15)", 3, vec([15]), /inactiveMask\[j\] === 0/],
    ["vote ONLY in a padded slot (kc=1, slot 15)", 1, vec([15]), /inactiveMask\[j\] === 0/],
    ["a real vote plus one in a padded slot", 3, vec([0, 7]), /total === 1|inactiveMask\[j\] === 0/],
  ];
  for (const [name, kc, m, rule] of cases) {
    it(`${name}`, async () => {
      const res = await tryWitness(witnessInput({ H, kc, m }).input);
      assert.equal(res.ok, false, "the witness must not satisfy the circuit");
      assert.match(res.rule ?? "", rule, `failed for the wrong reason: ${res.rule} (line ${res.line})`);
    });
  }

  it("the same ballots with a valid one-hot vector DO pass (control)", async () => {
    assert.equal((await tryWitness(witnessInput({ H, kc: 3, m: vec([1]) }).input)).ok, true);
  });
});

describe("ballot validity circuit: kc (candidate count) range", { skip: SKIP_NO_ARTIFACTS }, () => {
  it("kc = 0 is refused", async () => {
    const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.kc = "0") }).input);
    assert.equal(res.ok, false);
    assert.match(res.rule, /kcZero\.out === 0/);
  });
  it("kc = 17 (above K_MAX) is refused", async () => {
    const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.kc = "17") }).input);
    assert.equal(res.ok, false);
    assert.match(res.rule, /kcMax\.out === 1/);
  });
  for (const bad of ["32", "100", (FIELD_PRIME - 1n).toString()]) {
    it(`kc = ${bad.length > 6 ? "p-1" : bad} (does not fit 5 bits) is refused`, async () => {
      const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.kc = bad) }).input);
      assert.equal(res.ok, false);
      assert.match(res.rule, /kcBits\.in <== kc/);
    });
  }
  it("a ballot proven for one kc does not satisfy the statement of another: claiming kc=4 for a kc=3 ballot fails the padding rule", async () => {
    const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.kc = "4") }).input);
    assert.equal(res.ok, false, "slot 3 is now an active slot whose ciphertext must be a real encryption, but it is the canonical identity");
    assert.match(res.rule, /C1x\[j\] === e1x\[j\]|C1y\[j\] === e1y\[j\]|C2x\[j\] === e2x\[j\]|C2y\[j\] === e2y\[j\]/);
  });
  it("claiming a smaller kc than the ballot uses (kc=2 for a vote in slot 2) puts the vote in a padded slot", async () => {
    const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([2]), tweak: (i) => (i.kc = "2") }).input);
    assert.equal(res.ok, false);
    assert.match(res.rule, /inactiveMask\[j\] === 0/);
  });
});

describe("ballot validity circuit: ciphertext and key checks", { skip: SKIP_NO_ARTIFACTS }, () => {
  const ciphertextRule = /C1x\[j\] === e1x\[j\]|C1y\[j\] === e1y\[j\]|C2x\[j\] === e2x\[j\]|C2y\[j\] === e2y\[j\]/;

  for (const [field, slot] of [["C1x", 0], ["C1y", 1], ["C2x", 0], ["C2y", 2]]) {
    it(`a modified public ciphertext coordinate (${field}[${slot}]) is refused`, async () => {
      const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i[field][slot] = (BigInt(i[field][slot]) + 1n).toString()) }).input);
      assert.equal(res.ok, false);
      assert.match(res.rule, ciphertextRule);
    });
  }

  it("a ciphertext made for a different message (Enc(1) swapped for Enc(0) in the voted slot) is refused", async () => {
    const res = await tryWitness(
      witnessInput({
        H, kc: 3, m: vec([1]),
        tweak: (i) => {
          const other = encrypt(H, 0, randomScalar()); // a perfectly valid ciphertext, but not of the secret m
          i.C1x[1] = other.c1[0].toString(); i.C1y[1] = other.c1[1].toString(); i.C2x[1] = other.c2[0].toString(); i.C2y[1] = other.c2[1].toString();
        },
      }).input,
    );
    assert.equal(res.ok, false);
    assert.match(res.rule, ciphertextRule);
  });

  it("a ballot encrypted under H does not satisfy the statement for a DIFFERENT election key H' (wrong encryption public key)", async () => {
    const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.H = [H2[0].toString(), H2[1].toString()]) }).input);
    assert.equal(res.ok, false);
    assert.match(res.rule, /C2x\[j\] === e2x\[j\]|C2y\[j\] === e2y\[j\]/);
  });

  it("padded slots must be exactly the canonical identity pair: a real-looking encryption of 0 in a padded slot is refused", async () => {
    const res = await tryWitness(
      witnessInput({
        H, kc: 3, m: vec([1]),
        tweak: (i) => {
          const z = encrypt(H, 0, randomScalar());
          i.C1x[5] = z.c1[0].toString(); i.C1y[5] = z.c1[1].toString(); i.C2x[5] = z.c2[0].toString(); i.C2y[5] = z.c2[1].toString();
        },
      }).input,
    );
    assert.equal(res.ok, false);
    assert.match(res.rule, ciphertextRule);
  });

  it("a ciphertext carrying a different multiple of G (Enc(2): C2 + G) in the voted slot is refused", async () => {
    const res = await tryWitness(
      witnessInput({
        H, kc: 3, m: vec([1]),
        tweak: (i) => {
          const c2 = add([BigInt(i.C2x[1]), BigInt(i.C2y[1])], G);
          i.C2x[1] = c2[0].toString(); i.C2y[1] = c2[1].toString();
        },
      }).input,
    );
    assert.equal(res.ok, false);
    assert.match(res.rule, ciphertextRule);
  });

  it("an election key that is the identity (0,1), the order-2 point (0,-1), or off the curve is refused", async () => {
    let res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.H = ["0", "1"]) }).input);
    assert.equal(res.ok, false);
    assert.match(res.rule, /hxZero\.out === 0/);
    res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.H = ["0", (FIELD_PRIME - 1n).toString()]) }).input);
    assert.equal(res.ok, false);
    assert.match(res.rule, /hxZero\.out === 0/);
    res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.H = [H[0].toString(), (H[1] + 1n).toString()]) }).input);
    assert.equal(res.ok, false);
    assert.match(res.rule, /hOnCurve/);
  });

  it("randomness must be a 251-bit scalar: r = 2^251 is refused", async () => {
    const res = await tryWitness(witnessInput({ H, kc: 3, m: vec([1]), tweak: (i) => (i.r[0] = (1n << 251n).toString()) }).input);
    assert.equal(res.ok, false);
    assert.ok(res.frames.some((f) => f.template === "Num2Bits"), "the bit decomposition of r (251 bits) is what fails");
    assert.match(res.rule, /rBits\.in <== r;/);
  });
});

describe("ballot validity circuit: the CONSTRAINT SYSTEM (not just the witness calculator) rejects tampering", { skip: SKIP_NO_ARTIFACTS }, () => {
  // Take an honest witness and overwrite single signals in the witness file, then ask the R1CS checker. 76 = size of the wtns header.
  const sym = fs.existsSync(validityArtifacts.r1cs.replace(".r1cs", ".sym")) ? fs.readFileSync(validityArtifacts.r1cs.replace(".r1cs", ".sym"), "utf8") : "";
  const indexOf = (name) => Number(new RegExp(`^\\d+,(-?\\d+),\\d+,main\\.${name.replace(/[[\]]/g, "\\$&")}$`, "m").exec(sym)?.[1]);
  const le32 = (v) => {
    const b = Buffer.alloc(32);
    for (let i = 0, x = BigInt(v); i < 32; i++, x >>= 8n) b[i] = Number(x & 0xffn);
    return b;
  };

  it("one-hot [0,1,0]: flipping bits in the witness file (two-hot, zero-hot, value 5, padded-slot vote) breaks R1CS satisfaction; the untouched copy passes", async () => {
    const kc = 3;
    const wtns = await calculateWitness(witnessInput({ H, kc, m: oneHot(1, kc) }).input);
    const buf = Buffer.from(wtns.data);
    assert.deepEqual(buf.subarray(76, 108), le32(1n), "w[0] = 1 sits at byte 76");
    const tampered = (edits) => {
      const copy = Buffer.from(buf);
      for (const [name, v] of Object.entries(edits)) le32(v).copy(copy, 76 + 32 * indexOf(name));
      return { type: "mem", data: new Uint8Array(copy) };
    };
    const check = (w) => snarkjs.wtns.check(validityArtifacts.r1cs, w, quiet);
    assert.equal(await check(tampered({})), true, "untouched");
    assert.equal(await check(tampered({ "m[0]": 1n })), false, "two-hot");
    assert.equal(await check(tampered({ "m[1]": 0n })), false, "zero-hot");
    assert.equal(await check(tampered({ "m[1]": 5n })), false, "value 5");
    assert.equal(await check(tampered({ "m[3]": 1n, "m[1]": 0n })), false, "vote moved into a padded slot");
    assert.equal(await check(tampered({ "C2x[1]": 12345n })), false, "modified ciphertext");
    assert.equal(await check(tampered({ "nullifier": 5n })), false, "the nullifier is CONSTRAINED: changing it alone breaks the R1CS, which is what ties a proof to its nullifier");
  });
});

// Keep the imports used for documentation of the statement being tested
void ballotHash; void encryptVector;
