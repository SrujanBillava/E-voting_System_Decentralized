// Encrypted share transport between trustees: libsodium crypto_box (X25519 key agreement + XSalsa20-Poly1305), a mature, audited construction.
// Each trustee has ONE temporary transport key pair per ceremony; the private half is wiped after the shares have been received.
//
// A share f_i(j) travels from trustee i to trustee j as   nonce(24) || crypto_box(plaintext)   with
//   plaintext = "V3-SHARE"(8) || ceremonyId(32) || from(1) || to(1) || share(32, big-endian)        (74 bytes, fixed)
// crypto_box authenticates the SENDER (it needs the sender's transport secret key) and the recipient's key, and the header inside the authenticated
// plaintext binds the message to one ceremony, one sender and one recipient, so a share cannot be replayed into another ceremony, reflected back,
// or delivered to the wrong trustee. Whether the share is the RIGHT value is checked separately against the sender's public commitments.
import sodium from "libsodium-wrappers-sumo";
import { bytesToBigInt, word } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import { isCanonicalScalar } from "./scalar.ts";

await sodium.ready;

export const TRANSPORT_KEY_BYTES = 32;
const MAGIC = new Uint8Array([0x56, 0x33, 0x2d, 0x53, 0x48, 0x41, 0x52, 0x45]); // "V3-SHARE"
const NONCE_BYTES = 24;
const PLAINTEXT_BYTES = 8 + 32 + 1 + 1 + 32;
export const SEALED_SHARE_BYTES = NONCE_BYTES + PLAINTEXT_BYTES + 16;

export interface TransportKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export function generateTransportKeyPair(): TransportKeyPair {
  const pair = sodium.crypto_box_keypair();
  return { publicKey: pair.publicKey, secretKey: pair.privateKey };
}

/** 32 bytes, not all zero, and not a low-order X25519 point (a low-order key yields an all-zero shared secret, which libsodium refuses). */
export function isUsableTransportPublicKey(publicKey: unknown): boolean {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== TRANSPORT_KEY_BYTES || publicKey.every((b) => b === 0)) return false;
  try {
    const probe = sodium.crypto_box_keypair();
    sodium.crypto_scalarmult(probe.privateKey, publicKey);
    sodium.memzero(probe.privateKey);
    return true;
  } catch {
    return false;
  }
}

export const wipe = (bytes: Uint8Array): void => sodium.memzero(bytes);

export interface SealArgs {
  readonly ceremonyId: bigint;
  readonly from: number;
  readonly to: number;
  readonly share: bigint;
  readonly senderSecretKey: Uint8Array;
  readonly recipientPublicKey: Uint8Array;
}

export function sealShare(args: SealArgs): Uint8Array {
  if (!isCanonicalScalar(args.share)) throw new InvalidInputError("BAD_SCALAR", "a share must be reduced mod l");
  const plaintext = new Uint8Array(PLAINTEXT_BYTES);
  plaintext.set(MAGIC, 0);
  plaintext.set(word(args.ceremonyId), 8);
  plaintext[40] = args.from;
  plaintext[41] = args.to;
  plaintext.set(word(args.share), 42);
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const box = sodium.crypto_box_easy(plaintext, nonce, args.recipientPublicKey, args.senderSecretKey);
  wipe(plaintext);
  const out = new Uint8Array(SEALED_SHARE_BYTES);
  out.set(nonce, 0);
  out.set(box, NONCE_BYTES);
  return out;
}

export interface OpenArgs {
  readonly ceremonyId: bigint;
  readonly from: number;
  readonly to: number;
  readonly sealed: Uint8Array;
  readonly senderPublicKey: Uint8Array;
  readonly recipientSecretKey: Uint8Array;
}

/** Decrypts and authenticates one share and returns its value. Any failure (wrong key, wrong recipient, corruption, wrong header, non-canonical value) throws. */
export function openShare(args: OpenArgs): bigint {
  if (!(args.sealed instanceof Uint8Array) || args.sealed.length !== SEALED_SHARE_BYTES) throw new InvalidInputError("SHARE_DECRYPTION_FAILED", "encrypted share has the wrong length");
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_box_open_easy(args.sealed.slice(NONCE_BYTES), args.sealed.slice(0, NONCE_BYTES), args.senderPublicKey, args.recipientSecretKey);
  } catch {
    throw new InvalidInputError("SHARE_DECRYPTION_FAILED", "encrypted share failed authentication (corrupted, or not sealed by that sender for this recipient)");
  }
  try {
    if (plaintext.length !== PLAINTEXT_BYTES || !MAGIC.every((b, i) => plaintext[i] === b)) throw new InvalidInputError("SHARE_HEADER_MISMATCH", "unexpected share header");
    if (bytesToBigInt(plaintext.slice(8, 40)) !== args.ceremonyId) throw new InvalidInputError("SHARE_HEADER_MISMATCH", "share belongs to another ceremony");
    if (plaintext[40] !== args.from || plaintext[41] !== args.to) throw new InvalidInputError("SHARE_HEADER_MISMATCH", "share is not from that sender to this recipient");
    const share = bytesToBigInt(plaintext.slice(42, 74));
    if (!isCanonicalScalar(share)) throw new InvalidInputError("NON_CANONICAL_SHARE", "share is not reduced mod l");
    return share;
  } finally {
    wipe(plaintext);
  }
}
