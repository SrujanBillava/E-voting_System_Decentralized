// Encrypted share transport: libsodium crypto_box between trustees, with a header that binds ceremony, sender and recipient.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sodium from "libsodium-wrappers-sumo";
import { SUBGROUP_ORDER as L } from "../src/params.ts";
import { randomScalar } from "../src/scalar.ts";
import { SEALED_SHARE_BYTES, generateTransportKeyPair, isUsableTransportPublicKey, openShare, sealShare, wipe } from "../src/transport.ts";
import { bytesToBigInt } from "../src/encoding.ts";

await sodium.ready;
const ceremonyId = BigInt("0x" + "5a".repeat(32));
const alice = generateTransportKeyPair(); // trustee 1
const bob = generateTransportKeyPair(); // trustee 2
const carol = generateTransportKeyPair(); // trustee 3
const share = randomScalar();
const sealed = sealShare({ ceremonyId, from: 1, to: 2, share, senderSecretKey: alice.secretKey, recipientPublicKey: bob.publicKey });
const open = (over: Partial<Parameters<typeof openShare>[0]> = {}): bigint =>
  openShare({ ceremonyId, from: 1, to: 2, sealed, senderPublicKey: alice.publicKey, recipientSecretKey: bob.secretKey, ...over });

describe("share transport: honest path", () => {
  it("round trips the share; the ciphertext has the fixed length 24 + 74 + 16 = 114 bytes", () => {
    assert.equal(open(), share);
    assert.equal(sealed.length, SEALED_SHARE_BYTES);
    assert.equal(SEALED_SHARE_BYTES, 114);
  });

  it("is randomised (fresh nonce): sealing the same share twice gives different ciphertexts, both of which open", () => {
    const again = sealShare({ ceremonyId, from: 1, to: 2, share, senderSecretKey: alice.secretKey, recipientPublicKey: bob.publicKey });
    assert.notDeepEqual([...again], [...sealed]);
    assert.equal(open({ sealed: again }), share);
  });

  it("the share is not visible in the ciphertext (in any byte order), nor are the ceremony id or the header", () => {
    const big = Buffer.from(sealed).toString("hex");
    const be = share.toString(16).padStart(64, "0");
    const le = Buffer.from(be, "hex").reverse().toString("hex");
    assert.ok(!big.includes(be) && !big.includes(le) && !big.includes("5a".repeat(16)) && !big.includes(Buffer.from("V3-SHARE").toString("hex")));
  });

  it("transport keys are 32 bytes, distinct per generation, and the private half can be wiped", () => {
    assert.equal(alice.publicKey.length, 32);
    assert.equal(alice.secretKey.length, 32);
    assert.notDeepEqual([...alice.publicKey], [...bob.publicKey]);
    const temp = generateTransportKeyPair();
    wipe(temp.secretKey);
    assert.ok(temp.secretKey.every((b) => b === 0));
  });
});

describe("share transport: wrong recipient, wrong sender, corruption", () => {
  it("a share sent to the WRONG TRUSTEE (opened with another trustee's key) cannot be decrypted", () => {
    assert.throws(() => open({ recipientSecretKey: carol.secretKey }), /SHARE_DECRYPTION_FAILED/);
  });

  it("a share claimed to come from the WRONG SENDER key fails authentication: nobody can inject a share in another trustee's name", () => {
    assert.throws(() => open({ senderPublicKey: carol.publicKey }), /SHARE_DECRYPTION_FAILED/);
    const forged = sealShare({ ceremonyId, from: 1, to: 2, share, senderSecretKey: carol.secretKey, recipientPublicKey: bob.publicKey });
    assert.throws(() => open({ sealed: forged }), /SHARE_DECRYPTION_FAILED/, "sealed with carol's key, claimed to be from alice");
  });

  it("CORRUPTION anywhere (nonce, body, tag) fails authentication; truncated and extended messages are refused", () => {
    for (const position of [0, 12, 23, 24, 50, 97, 98, 113]) {
      const bad = Uint8Array.from(sealed);
      bad[position] ^= 0x01;
      assert.throws(() => open({ sealed: bad }), /SHARE_DECRYPTION_FAILED/, `byte ${position}`);
    }
    assert.throws(() => open({ sealed: sealed.slice(0, 113) }), /SHARE_DECRYPTION_FAILED/);
    assert.throws(() => open({ sealed: new Uint8Array([...sealed, 0]) }), /SHARE_DECRYPTION_FAILED/);
    assert.throws(() => open({ sealed: new Uint8Array(0) }), /SHARE_DECRYPTION_FAILED/);
  });
});

describe("share transport: the header binds ceremony, sender and recipient", () => {
  it("REPLAY into another ceremony is refused", () => {
    assert.throws(() => open({ ceremonyId: ceremonyId + 1n }), /SHARE_HEADER_MISMATCH/);
  });

  it("a share delivered under another sender or recipient index is refused, including a REFLECTION (2 -> 1 claimed for 1 -> 2)", () => {
    assert.throws(() => open({ from: 3 }), /SHARE_HEADER_MISMATCH/);
    assert.throws(() => open({ to: 3 }), /SHARE_HEADER_MISMATCH/);
    const reflected = sealShare({ ceremonyId, from: 2, to: 1, share, senderSecretKey: bob.secretKey, recipientPublicKey: alice.publicKey });
    assert.equal(openShare({ ceremonyId, from: 2, to: 1, sealed: reflected, senderPublicKey: bob.publicKey, recipientSecretKey: alice.secretKey }), share);
    assert.throws(() => openShare({ ceremonyId, from: 1, to: 2, sealed: reflected, senderPublicKey: bob.publicKey, recipientSecretKey: alice.secretKey }), /SHARE_HEADER_MISMATCH/);
  });

  it("a share that is not reduced mod l is refused, both when sealing and when opening a hand-made message (a share computed in the wrong modulus)", () => {
    assert.throws(() => sealShare({ ceremonyId, from: 1, to: 2, share: L, senderSecretKey: alice.secretKey, recipientPublicKey: bob.publicKey }), /BAD_SCALAR/);
    for (const big of [L, L + 1n, 2n ** 255n]) {
      const plaintext = new Uint8Array(74);
      plaintext.set(new TextEncoder().encode("V3-SHARE"), 0);
      plaintext.set(Buffer.from(ceremonyId.toString(16).padStart(64, "0"), "hex"), 8);
      plaintext[40] = 1;
      plaintext[41] = 2;
      plaintext.set(Buffer.from(big.toString(16).padStart(64, "0"), "hex"), 42);
      const nonce = sodium.randombytes_buf(24);
      const message = new Uint8Array([...nonce, ...sodium.crypto_box_easy(plaintext, nonce, bob.publicKey, alice.secretKey)]);
      assert.throws(() => open({ sealed: message }), /NON_CANONICAL_SHARE/, String(big));
    }
  });

  it("a message with a wrong magic or length inside the authenticated plaintext is refused", () => {
    for (const mutate of [(p: Uint8Array) => (p[0] ^= 1), (p: Uint8Array) => (p[8] ^= 1)]) {
      const plaintext = new Uint8Array(74);
      plaintext.set(new TextEncoder().encode("V3-SHARE"), 0);
      plaintext.set(Buffer.from(ceremonyId.toString(16).padStart(64, "0"), "hex"), 8);
      plaintext[40] = 1;
      plaintext[41] = 2;
      mutate(plaintext);
      const nonce = sodium.randombytes_buf(24);
      const message = new Uint8Array([...nonce, ...sodium.crypto_box_easy(plaintext, nonce, bob.publicKey, alice.secretKey)]);
      assert.throws(() => open({ sealed: message }), /SHARE_HEADER_MISMATCH/);
    }
    assert.equal(bytesToBigInt(new Uint8Array(0)), 0n);
  });
});

describe("transport public keys", () => {
  it("real keys are usable; the all-zero key and the low-order X25519 points are not", () => {
    assert.ok(isUsableTransportPublicKey(alice.publicKey));
    const lowOrder = [
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0100000000000000000000000000000000000000000000000000000000000000",
      "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
      "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for (const hex of lowOrder) assert.ok(!isUsableTransportPublicKey(Uint8Array.from(Buffer.from(hex, "hex"))), hex);
  });

  it("wrong lengths and wrong types are not usable", () => {
    for (const bad of [new Uint8Array(31), new Uint8Array(33), null, undefined, "key", [1, 2, 3]]) assert.ok(!isUsableTransportPublicKey(bad as unknown), String(bad));
  });
});
