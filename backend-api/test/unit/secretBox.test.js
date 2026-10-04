import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { decryptSecret, encryptSecret } from "../../src/auth/secretBox.js";

const key = randomBytes(32);

describe("secretBox (AES-256-GCM)", () => {
  it("round-trips, and a fresh IV is used every time", () => {
    const a = encryptSecret(key, "JBSWY3DPEHPK3PXP", "admin-1");
    const b = encryptSecret(key, "JBSWY3DPEHPK3PXP", "admin-1");
    assert.notEqual(a.iv, b.iv);
    assert.equal(Buffer.from(a.iv, "base64").length, 12);
    assert.equal(Buffer.from(a.tag, "base64").length, 16);
    assert.equal(decryptSecret(key, a, "admin-1"), "JBSWY3DPEHPK3PXP");
  });

  it("refuses another owner's AAD, a wrong key and altered ciphertext", () => {
    const box = encryptSecret(key, "secret", "admin-1");
    assert.throws(() => decryptSecret(key, box, "admin-2"));
    assert.throws(() => decryptSecret(randomBytes(32), box, "admin-1"));
    const ct = Buffer.from(box.ct, "base64");
    ct[0] ^= 1;
    assert.throws(() => decryptSecret(key, { ...box, ct: ct.toString("base64") }, "admin-1"));
  });

  it("refuses a truncated or padded authentication tag (a shortened GCM tag must not be accepted)", () => {
    const box = encryptSecret(key, "secret", "admin-1");
    const tag = Buffer.from(box.tag, "base64");
    for (const length of [0, 4, 8, 12, 15]) assert.throws(() => decryptSecret(key, { ...box, tag: tag.subarray(0, length).toString("base64") }, "admin-1"), /malformed/, `tag of ${length} bytes`);
    assert.throws(() => decryptSecret(key, { ...box, tag: Buffer.concat([tag, Buffer.alloc(1)]).toString("base64") }, "admin-1"), /malformed/);
  });

  it("refuses a malformed IV and missing or non-string fields", () => {
    const box = encryptSecret(key, "secret", "admin-1");
    assert.throws(() => decryptSecret(key, { ...box, iv: Buffer.alloc(8).toString("base64") }, "admin-1"), /malformed/);
    assert.throws(() => decryptSecret(key, { ...box, iv: undefined }, "admin-1"), /malformed/);
    assert.throws(() => decryptSecret(key, { ...box, tag: 123 }, "admin-1"), /malformed/);
    assert.throws(() => decryptSecret(key, { ...box, ct: null }, "admin-1"), /malformed/);
    assert.throws(() => decryptSecret(key, null, "admin-1"), /malformed/);
  });
});
