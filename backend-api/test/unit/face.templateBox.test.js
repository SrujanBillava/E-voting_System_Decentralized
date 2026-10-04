import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { DESCRIPTOR_LENGTH } from "../../src/biometrics/constants.js";
import { toUnitVector } from "../../src/biometrics/descriptor.js";
import { openTemplate, sealTemplate } from "../../src/biometrics/templateBox.js";
import { person, samplesOf } from "../helpers/face.js";

const KEY = Buffer.from("5e1c8a3f7b9d2046c8e0a2f4b6d81357e9c1a3b5d7f90246a8c0e2f4b6d8a1c3", "hex");
const VOTER = "64b7f0c2a1d3e4f5a6b7c8d9";
const OTHER_VOTER = "64b7f0c2a1d3e4f5a6b7c8da";
const samples = (count = 3) => samplesOf(person(11), count).map(toUnitVector);
const flip = (base64) => {
  const bytes = Buffer.from(base64, "base64");
  bytes[Math.floor(bytes.length / 2)] ^= 0x01;
  return bytes.toString("base64");
};

describe("face template encryption (AES-256-GCM)", () => {
  it("round trip: every number of every sample comes back exactly, for 3, 4 and 5 samples", () => {
    for (const count of [3, 4, 5]) {
      const original = samples(count);
      const opened = openTemplate(KEY, VOTER, sealTemplate(KEY, VOTER, original));
      assert.equal(opened.length, count);
      for (let s = 0; s < count; s++) {
        assert.ok(opened[s] instanceof Float32Array);
        assert.equal(opened[s].length, DESCRIPTOR_LENGTH);
        assert.deepEqual(Array.from(opened[s]), Array.from(original[s]));
      }
    }
  });

  it("stores only { ct, iv, tag, v } and none of the plaintext", () => {
    const original = samples();
    const box = sealTemplate(KEY, VOTER, original);
    assert.deepEqual(Object.keys(box).sort(), ["ct", "iv", "tag", "v"]);
    assert.equal(Buffer.from(box.iv, "base64").length, 12);
    assert.equal(Buffer.from(box.tag, "base64").length, 16);
    const plain = Buffer.alloc(DESCRIPTOR_LENGTH * 4);
    original[0].forEach((x, i) => plain.writeFloatLE(x, i * 4));
    const stored = JSON.stringify(box);
    assert.ok(!stored.includes(plain.toString("base64").slice(0, 40)), "the plaintext bytes are not in the stored value");
    assert.ok(!Buffer.from(box.ct, "base64").includes(plain.subarray(0, 32)));
    assert.ok(!stored.includes(VOTER), "the voter id is authenticated, not stored inside the box");
  });

  it("uses a fresh random IV: sealing the same template twice gives different ciphertexts", () => {
    const original = samples();
    const a = sealTemplate(KEY, VOTER, original);
    const b = sealTemplate(KEY, VOTER, original);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
    assert.deepEqual(openTemplate(KEY, VOTER, a), openTemplate(KEY, VOTER, b));
  });

  it("tamper: a template bound to one voter cannot be opened as another voter (wrong AAD)", () => {
    const box = sealTemplate(KEY, VOTER, samples());
    assert.throws(() => openTemplate(KEY, OTHER_VOTER, box), /could not be decrypted/);
    assert.throws(() => openTemplate(KEY, "", box), /could not be decrypted/);
  });

  it("tamper: the wrong key cannot open it", () => {
    const box = sealTemplate(KEY, VOTER, samples());
    assert.throws(() => openTemplate(randomBytes(32), VOTER, box), /could not be decrypted/);
    const almost = Buffer.from(KEY);
    almost[31] ^= 0x01;
    assert.throws(() => openTemplate(almost, VOTER, box), /could not be decrypted/);
  });

  it("tamper: one changed bit in the ciphertext, the IV or the tag is detected", () => {
    const box = sealTemplate(KEY, VOTER, samples());
    for (const field of ["ct", "iv", "tag"]) assert.throws(() => openTemplate(KEY, VOTER, { ...box, [field]: flip(box[field]) }), /could not be decrypted/, field);
  });

  it("tamper: truncated, swapped or missing parts are refused", () => {
    const a = sealTemplate(KEY, VOTER, samples());
    const b = sealTemplate(KEY, VOTER, samples(4));
    assert.throws(() => openTemplate(KEY, VOTER, { ...a, ct: a.ct.slice(0, 200) }));
    assert.throws(() => openTemplate(KEY, VOTER, { ...a, tag: b.tag }));
    assert.throws(() => openTemplate(KEY, VOTER, { ...a, iv: b.iv }));
    assert.throws(() => openTemplate(KEY, VOTER, { ...a, tag: "" }));
    assert.throws(() => openTemplate(KEY, VOTER, { ct: a.ct }));
  });

  it("tamper: a shortened authentication tag or IV is refused, even when it is a prefix of the real one", () => {
    const box = sealTemplate(KEY, VOTER, samples());
    const cut = (base64, bytes) => Buffer.from(base64, "base64").subarray(0, bytes).toString("base64");
    for (const bytes of [0, 4, 8, 12, 13, 14, 15]) assert.throws(() => openTemplate(KEY, VOTER, { ...box, tag: cut(box.tag, bytes) }), /could not be decrypted/, `tag of ${bytes} bytes`);
    for (const bytes of [0, 8, 11]) assert.throws(() => openTemplate(KEY, VOTER, { ...box, iv: cut(box.iv, bytes) }), /could not be decrypted/, `iv of ${bytes} bytes`);
    assert.throws(() => openTemplate(KEY, VOTER, { ...box, tag: Buffer.concat([Buffer.from(box.tag, "base64"), Buffer.alloc(1)]).toString("base64") }), /could not be decrypted/);
    assert.equal(openTemplate(KEY, VOTER, box).length, 3, "the untouched box still opens");
  });

  it("refuses an unknown box version and a box that is not an object", () => {
    const box = sealTemplate(KEY, VOTER, samples());
    for (const bad of [{ ...box, v: 2 }, { ...box, v: undefined }, { ...box, ct: 5 }, { ...box, iv: 5 }, null, undefined, "box", 42]) assert.throws(() => openTemplate(KEY, VOTER, bad), /could not be decrypted/);
  });

  it("errors never contain template data or the key", () => {
    const box = sealTemplate(KEY, VOTER, samples());
    let message = "";
    try {
      openTemplate(randomBytes(32), VOTER, box);
    } catch (err) {
      message = String(err?.message) + String(err?.stack);
    }
    assert.match(message, /could not be decrypted/);
    assert.ok(!message.includes(box.ct.slice(0, 24)));
    assert.ok(!message.includes(KEY.toString("hex")));
  });

  it("refuses to seal a sample of the wrong length", () => {
    assert.throws(() => sealTemplate(KEY, VOTER, [new Float32Array(DESCRIPTOR_LENGTH - 1)]), /wrong length/);
  });

  it("a decrypted payload that is not a whole number of samples is refused", async () => {
    const { encryptSecret } = await import("../../src/auth/secretBox.js");
    const odd = encryptSecret(KEY, Buffer.alloc(DESCRIPTOR_LENGTH * 4 + 3).toString("base64"), `face-template:v1:${VOTER}`);
    assert.throws(() => openTemplate(KEY, VOTER, odd), /unexpected size/);
    const empty = encryptSecret(KEY, "", `face-template:v1:${VOTER}`);
    assert.throws(() => openTemplate(KEY, VOTER, empty), /unexpected size/);
  });
});
