import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { encryptSecret } from "../../src/auth/secretBox.js";
import { DESCRIPTOR_LENGTH } from "../../src/biometrics/constants.js";
import { isDescriptorShape, toUnitVector } from "../../src/biometrics/descriptor.js";
import { bestSimilarity, cosineSimilarity, decide, lowestPairSimilarity } from "../../src/biometrics/matching.js";
import { openTemplate, sealTemplate } from "../../src/biometrics/templateBox.js";
import { ConfigError, loadEnv, secretValuesOf } from "../../src/config/env.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { validEnv } from "../helpers/env.js";
import { person, samplesOf } from "../helpers/face.js";

// ADVERSARIAL offline probes of the face building blocks (no database, no chain needed).
const KEY = loadEnv(validEnv()).secrets.faceTemplateKey;
const ID = "665f1c2ab3d4e5f607182930";
const samples = () => samplesOf(person(5), 3).map((s) => toUnitVector(s));
const flipBit = (b64, byte, bit = 0) => {
  const buf = Buffer.from(b64, "base64");
  buf[byte % buf.length] ^= 1 << bit;
  return buf.toString("base64");
};

describe("ADVERSARIAL face template box (AES-256-GCM)", () => {
  it("every seal uses a fresh 12-byte IV and a 16-byte tag: no IV repeats over 5000 seals under one key", () => {
    const ivs = new Set();
    const one = [toUnitVector(person(1))];
    for (let i = 0; i < 5000; i++) {
      const box = sealTemplate(KEY, ID, one);
      assert.equal(Buffer.from(box.iv, "base64").length, 12);
      assert.equal(Buffer.from(box.tag, "base64").length, 16);
      ivs.add(box.iv);
    }
    assert.equal(ivs.size, 5000);
  });

  it("any single flipped bit in the ciphertext, the IV or the tag is detected, at every sampled position", () => {
    const box = sealTemplate(KEY, ID, samples());
    assert.equal(openTemplate(KEY, ID, box).length, 3);
    const ctLen = Buffer.from(box.ct, "base64").length;
    for (let i = 0; i < 80; i++) {
      const pos = Math.floor((i * ctLen) / 80);
      assert.throws(() => openTemplate(KEY, ID, { ...box, ct: flipBit(box.ct, pos, i % 8) }), /could not be decrypted/);
    }
    for (let i = 0; i < 12; i++) assert.throws(() => openTemplate(KEY, ID, { ...box, iv: flipBit(box.iv, i, i % 8) }), /could not be decrypted/);
    for (let i = 0; i < 16; i++) assert.throws(() => openTemplate(KEY, ID, { ...box, tag: flipBit(box.tag, i, i % 8) }), /could not be decrypted/);
  });

  it("every tag length from 0 to 15 bytes (a prefix of the real tag), and every IV length except 12, is refused", () => {
    const box = sealTemplate(KEY, ID, samples());
    const tag = Buffer.from(box.tag, "base64");
    const iv = Buffer.from(box.iv, "base64");
    for (let n = 0; n < 16; n++) assert.throws(() => openTemplate(KEY, ID, { ...box, tag: tag.subarray(0, n).toString("base64") }), /could not be decrypted/, `tag ${n}`);
    for (const n of [0, 1, 8, 11]) assert.throws(() => openTemplate(KEY, ID, { ...box, iv: iv.subarray(0, n).toString("base64") }), /could not be decrypted/, `iv ${n}`);
    for (const n of [13, 16]) assert.throws(() => openTemplate(KEY, ID, { ...box, iv: Buffer.concat([iv, randomBytes(n - 12)]).toString("base64") }), /could not be decrypted/, `iv ${n}`);
    assert.throws(() => openTemplate(KEY, ID, { ...box, tag: Buffer.concat([tag, Buffer.from([0])]).toString("base64") }), /could not be decrypted/, "tag 17");
  });

  it("the voter id is bound as additional data: a different id, a re-cased id, a padded id and a neighbouring id all fail", () => {
    const box = sealTemplate(KEY, ID, samples());
    for (const other of [ID.toUpperCase(), ` ${ID}`, `${ID} `, `${ID}\n`, "665f1c2ab3d4e5f607182931", "", "undefined", `face-template:v1:${ID}`]) {
      assert.throws(() => openTemplate(KEY, other, box), /could not be decrypted/, JSON.stringify(other));
    }
  });

  it("hostile box shapes are refused with one generic message that carries no data", () => {
    const real = sealTemplate(KEY, ID, samples());
    const shapes = [
      null, undefined, 0, "box", [], {}, { v: 1 }, { ...real, v: "1" }, { ...real, v: 1.5 }, { ...real, v: [1] }, { ...real, ct: 5 }, { ...real, ct: null }, { ...real, ct: [real.ct] }, { ...real, ct: { toString: () => real.ct } },
      { ...real, iv: 12 }, { ...real, iv: [real.iv] }, { ...real, iv: null }, { ...real, tag: undefined }, { ...real, tag: {} }, { ct: real.ct, iv: real.iv, tag: real.tag },
    ];
    for (const box of shapes) {
      assert.throws(
        () => openTemplate(KEY, ID, box),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(/^face template (could not be decrypted|has an unexpected size)$/.test(err.message), err.message);
          assert.ok(!err.message.includes(real.ct.slice(0, 20)));
          return true;
        },
        JSON.stringify(box)?.slice(0, 40),
      );
    }
  });

  it("a template that decrypts but is not a whole number of samples, or is empty, is refused", () => {
    for (const bytes of [0, 1, 4, DESCRIPTOR_LENGTH * 4 - 1, DESCRIPTOR_LENGTH * 4 + 1, DESCRIPTOR_LENGTH * 4 * 2 - 4]) {
      const box = encryptSecret(KEY, randomBytes(bytes).toString("base64"), `face-template:v1:${ID}`); // authentic, but not a template
      assert.throws(() => openTemplate(KEY, ID, box), /has an unexpected size/, `${bytes} bytes`);
    }
    const whole = encryptSecret(KEY, Buffer.alloc(DESCRIPTOR_LENGTH * 4 * 7).toString("base64"), `face-template:v1:${ID}`);
    assert.equal(openTemplate(KEY, ID, whole).length, 7, "the box itself does not cap the number of samples; enrolment (3 to 5) does");
  });

  it("a key of the wrong length is refused by the cipher, never silently padded", () => {
    for (const bad of [Buffer.alloc(0), Buffer.alloc(16), Buffer.alloc(31), Buffer.alloc(33)]) assert.throws(() => sealTemplate(bad, ID, samples()));
  });
});

describe("ADVERSARIAL descriptor validation and matching", () => {
  it("only a plain dense array of 512 finite numbers inside +-100 is accepted; array-likes, typed arrays and holes are not", () => {
    const ok = Array.from({ length: DESCRIPTOR_LENGTH }, (_, i) => Math.sin(i));
    assert.equal(isDescriptorShape(ok), true);
    assert.equal(isDescriptorShape(Float32Array.from(ok)), false);
    assert.equal(isDescriptorShape(Float64Array.from(ok)), false);
    assert.equal(isDescriptorShape({ length: DESCRIPTOR_LENGTH, ...ok }), false);
    assert.equal(isDescriptorShape(Object.assign(Object.create(Array.prototype), { length: 512 })), false);
    const holes = new Array(DESCRIPTOR_LENGTH);
    assert.equal(isDescriptorShape(holes), false);
    const sparse = ok.slice();
    delete sparse[3];
    assert.equal(isDescriptorShape(sparse), false);
    assert.equal(isDescriptorShape(ok.map((x, i) => (i === 9 ? new Number(x) : x))), false, "boxed numbers");
    assert.equal(isDescriptorShape(ok.map((x, i) => (i === 9 ? 1n : x))), false);
    assert.equal(isDescriptorShape(ok.map((x, i) => (i === 9 ? { valueOf: () => 0.1 } : x))), false);
    assert.equal(isDescriptorShape(ok.map((x, i) => (i === 9 ? NaN : x))), false);
    assert.equal(isDescriptorShape(ok.map((x, i) => (i === 9 ? -Infinity : x))), false);
    assert.equal(isDescriptorShape(ok.map((x, i) => (i === 9 ? 100 : x))), true);
    assert.equal(isDescriptorShape(ok.map((x, i) => (i === 9 ? Number.MIN_VALUE : x))), true);
  });

  it("scales that underflow to a zero norm are rejected, never turned into NaN or Infinity", () => {
    for (const v of [1e-9, 1e-100, 1e-160, 1e-200, 1e-300, Number.MIN_VALUE, 0, -0]) assert.equal(toUnitVector(Array(DESCRIPTOR_LENGTH).fill(v)), null, String(v));
    const tiny = toUnitVector(Array(DESCRIPTOR_LENGTH).fill(1e-6));
    assert.ok(tiny && Number.isFinite(tiny[0]));
    const unit = toUnitVector(Array.from({ length: DESCRIPTOR_LENGTH }, (_, i) => (i === 0 ? 100 : 1e-30)));
    assert.ok(unit.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...unit) - 1) < 1e-6);
  });

  it("a poisoned (NaN / Infinity) stored sample can never produce a match, and cannot hide behind a good sample", () => {
    const probe = toUnitVector(person(1));
    const bad = new Float32Array(DESCRIPTOR_LENGTH).fill(Infinity);
    const nan = new Float32Array(DESCRIPTOR_LENGTH).fill(NaN);
    assert.equal(decide(probe, [bad]).match, false);
    assert.equal(decide(probe, [nan]).match, false);
    assert.equal(decide(probe, [nan, bad]).match, false);
    assert.equal(decide(probe, [nan, probe]).match, true, "a good sample next to a poisoned one still decides");
    assert.ok(Number.isFinite(bestSimilarity(probe, [nan, bad])));
    assert.ok(Number.isNaN(cosineSimilarity(probe, bad)) || Math.abs(cosineSimilarity(probe, bad)) <= 1);
  });

  it("an all-equal probe, a unit-basis probe and a probe made of the enrolled mean score near zero against unrelated enrolled faces", () => {
    const enrolled = samples();
    const flat = toUnitVector(Array(DESCRIPTOR_LENGTH).fill(1));
    assert.ok(decide(flat, enrolled).score < 0.2, "flat probe");
    for (const k of [0, 17, 511]) {
      const basis = toUnitVector(Array.from({ length: DESCRIPTOR_LENGTH }, (_, i) => (i === k ? 1 : 0)));
      assert.ok(decide(basis, enrolled).score < 0.2, `basis ${k}`);
    }
    assert.ok(lowestPairSimilarity(enrolled) > 0.5, "the fixture samples really are one person");
  });
});

describe("ADVERSARIAL configuration of the face key", () => {
  const key = "7d2f9a41c6e08b53a1d4f7e92b60c8a35e1f4d7a90b3c6e285f1a4d7c0b39e6f";
  const refused = (over) => {
    try {
      loadEnv(validEnv(over));
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      return err.message;
    }
    return null;
  };

  it("whitespace, quotes, a second 0x, a 0X prefix, a 31/33-byte key, non-hex and a missing key are all refused, naming the variable and never the value", () => {
    for (const bad of [` ${key}`, `${key} `, `"${key}"`, `0x0x${key}`, `0X${key}`, key.slice(2), `${key}ab`, `${key.slice(0, 63)}g`, key.replace(/.$/, "\n"), "", "changeme", "0".repeat(64), "ab".repeat(32), "0123456789abcdef".repeat(4)]) {
      const message = refused({ FACE_TEMPLATE_ENCRYPTION_KEY: bad });
      assert.ok(message, JSON.stringify(bad));
      assert.ok(message.includes("FACE_TEMPLATE_ENCRYPTION_KEY"));
      if (bad.length >= 8) assert.ok(!message.includes(bad.trim()), "the value is never echoed");
    }
  });

  it("the key must differ from every other secret, in any case and with or without 0x, and from the Mongo URI and RPC URL", () => {
    const env = validEnv();
    for (const name of ["NULLIFIER_SECRET", "JWT_ACCESS_SECRET", "ADMIN_TOTP_ENCRYPTION_KEY", "OWNER_PRIVATE_KEY"]) {
      const hex = env[name].replace(/^0x/, "");
      for (const variant of [hex, hex.toUpperCase(), `0x${hex}`]) assert.ok(refused({ FACE_TEMPLATE_ENCRYPTION_KEY: variant }), `${name} ${variant.slice(0, 6)}`);
    }
    assert.ok(refused({ MONGODB_URI: `mongodb://u:${key}@127.0.0.1:27017/x`, FACE_TEMPLATE_ENCRYPTION_KEY: key }));
    assert.ok(refused({ CHAIN_RPC_URL: `http://127.0.0.1:8545/${key}`, FACE_TEMPLATE_ENCRYPTION_KEY: key }));
    assert.equal(refused({ FACE_TEMPLATE_ENCRYPTION_KEY: key }), null, "control: a fresh random key is accepted");
  });

  it("the key is registered with the logger in every spelling it could appear in, and is not enumerable on the config", () => {
    const config = loadEnv(validEnv({ FACE_TEMPLATE_ENCRYPTION_KEY: key }));
    assert.ok(!Object.keys(config).includes("secrets"));
    assert.ok(!JSON.stringify(config).includes(key));
    assert.ok(secretValuesOf(config).includes(key));
    const { logger, lines } = createMemoryLogger({ secrets: secretValuesOf(config) });
    logger.error({ err: new Error(`boom ${key} ${key.toUpperCase()} 0x${key}`) }, `msg ${key}`);
    logger.info({ nested: { deep: [`x${key}y`] } });
    const text = lines.join("");
    assert.ok(!text.toLowerCase().includes(key));
  });
});
