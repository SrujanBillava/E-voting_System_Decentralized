// Encrypted-at-rest storage of ONE trustee's final share s_j.
//
//   key        = Argon2id(password, random 16-byte salt)              libsodium crypto_pwhash, ALG_ARGON2ID13, 32 bytes
//   ciphertext = XChaCha20-Poly1305-IETF(share, nonce = 24 random bytes, associated data = the canonical JSON of the whole public header)
//
// Default cost: libsodium MODERATE = 3 passes over 256 MiB (about half a second here). SENSITIVE (4 passes, 1 GiB) is available. The header, including the
// cost parameters and the public fields (index, verification key, transcript hash, context), is AUTHENTICATED, so none of it can be altered; a file whose
// cost parameters are below the floor is REFUSED (a downgrade attack), and so are absurdly large ones (a memory-exhaustion attack).
// The share never reaches disk in clear text. Passwords are never hard-coded: they come from the caller.
import fs from "node:fs";
import path from "node:path";
import sodium from "libsodium-wrappers-sumo";
import { contextToWire, parseContextWire, type WireContext } from "./context.ts";
import { exactKeys, assertInteger, hex32, hexOfBytes, parseHex32, parseHexBytes, word, bytesToBigInt } from "./encoding.ts";
import { InvalidInputError } from "./errors.ts";
import type { ElectionContext, Point } from "./params.ts";
import { parsePointWire, pointToWire, type WirePoint } from "./point.ts";
import { assertScalar } from "./scalar.ts";
import { wipe } from "./transport.ts";

await sodium.ready;

export interface KdfParams {
  readonly opslimit: number;
  readonly memlimit: number;
}
/** libsodium crypto_pwhash_OPSLIMIT_/MEMLIMIT_MODERATE (a test pins these to sodium's own constants). */
export const KDF_MODERATE: KdfParams = Object.freeze({ opslimit: 3, memlimit: 268435456 });
/** libsodium SENSITIVE: 4 passes over 1 GiB. */
export const KDF_SENSITIVE: KdfParams = Object.freeze({ opslimit: 4, memlimit: 1073741824 });
/** libsodium MIN. TESTS ONLY: it is far below the floor and a default-policy load refuses files written with it. */
export const KDF_TESTING_ONLY: KdfParams = Object.freeze({ opslimit: 1, memlimit: 8192 });
const KDF_CEILING: KdfParams = Object.freeze({ opslimit: 16, memlimit: 2147483648 });

export const MIN_PASSWORD_LENGTH = 12;
const FORMAT = "votechain-v3-trustee-share";

export interface ShareRecord {
  readonly index: number;
  readonly share: bigint;
  readonly verificationKey: Point;
  readonly transcriptHash: bigint;
  readonly context: ElectionContext;
}

export interface ShareFile {
  format: typeof FORMAT;
  version: 1;
  kdf: { alg: "argon2id13"; opslimit: number; memlimit: number; salt: string };
  cipher: { alg: "xchacha20poly1305-ietf"; nonce: string };
  public: { index: number; verificationKey: WirePoint; transcriptHash: string; context: WireContext };
  ciphertext: string;
}

const headerOf = (f: Omit<ShareFile, "ciphertext">): Uint8Array =>
  sodium.from_string(JSON.stringify({ format: f.format, version: f.version, kdf: f.kdf, cipher: f.cipher, public: f.public }));

function assertPassword(password: unknown): Uint8Array {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 1024) {
    throw new InvalidInputError("WEAK_PASSWORD", `the password must be ${MIN_PASSWORD_LENGTH}..1024 characters`);
  }
  return sodium.from_string(password.normalize("NFKC"));
}

function deriveKey(password: Uint8Array, salt: Uint8Array, kdf: KdfParams): Uint8Array {
  return sodium.crypto_pwhash(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, password, salt, kdf.opslimit, kdf.memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13);
}

export function encryptShareRecord(record: ShareRecord, password: string, kdf: KdfParams = KDF_MODERATE): ShareFile {
  assertInteger(record.index, 1, 255, "trustee index");
  assertScalar(record.share, "share");
  if (!Number.isInteger(kdf.opslimit) || !Number.isInteger(kdf.memlimit) || kdf.opslimit < 1 || kdf.memlimit < 8192 || kdf.opslimit > KDF_CEILING.opslimit || kdf.memlimit > KDF_CEILING.memlimit) {
    throw new InvalidInputError("BAD_KDF", "KDF parameters out of range");
  }
  const pw = assertPassword(password);
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const header: Omit<ShareFile, "ciphertext"> = {
    format: FORMAT,
    version: 1,
    kdf: { alg: "argon2id13", opslimit: kdf.opslimit, memlimit: kdf.memlimit, salt: hexOfBytes(salt) },
    cipher: { alg: "xchacha20poly1305-ietf", nonce: hexOfBytes(nonce) },
    public: { index: record.index, verificationKey: pointToWire(record.verificationKey), transcriptHash: hex32(record.transcriptHash), context: contextToWire(record.context) },
  };
  const key = deriveKey(pw, salt, kdf);
  const plaintext = word(record.share);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, headerOf(header), null, nonce, key);
  wipe(key);
  wipe(pw);
  wipe(plaintext);
  return { ...header, ciphertext: hexOfBytes(ciphertext) };
}

/** Strict structural parse of an untrusted share file. Throws InvalidInputError. Does not decrypt. */
function parseShareFile(value: unknown): { file: ShareFile; salt: Uint8Array; nonce: Uint8Array; ciphertext: Uint8Array } {
  const o = exactKeys(value, ["format", "version", "kdf", "cipher", "public", "ciphertext"], "share file");
  if (o.format !== FORMAT || o.version !== 1) throw new InvalidInputError("BAD_SHARE_FILE", "unknown share file format or version");
  const kdf = exactKeys(o.kdf, ["alg", "opslimit", "memlimit", "salt"], "share file kdf");
  const cipher = exactKeys(o.cipher, ["alg", "nonce"], "share file cipher");
  const pub = exactKeys(o.public, ["index", "verificationKey", "transcriptHash", "context"], "share file public header");
  if (kdf.alg !== "argon2id13" || cipher.alg !== "xchacha20poly1305-ietf") throw new InvalidInputError("BAD_SHARE_FILE", "unsupported algorithms");
  const salt = parseHexBytes(kdf.salt, sodium.crypto_pwhash_SALTBYTES, "kdf.salt");
  const nonce = parseHexBytes(cipher.nonce, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, "cipher.nonce");
  const ciphertext = parseHexBytes(o.ciphertext, 32 + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES, "ciphertext");
  const file: ShareFile = {
    format: FORMAT,
    version: 1,
    kdf: { alg: "argon2id13", opslimit: assertInteger(kdf.opslimit, 1, KDF_CEILING.opslimit, "kdf.opslimit"), memlimit: assertInteger(kdf.memlimit, 8192, KDF_CEILING.memlimit, "kdf.memlimit"), salt: kdf.salt as string },
    cipher: { alg: "xchacha20poly1305-ietf", nonce: cipher.nonce as string },
    public: {
      index: assertInteger(pub.index, 1, 255, "index"),
      verificationKey: pointToWire(parsePointWire(pub.verificationKey, "verificationKey")),
      transcriptHash: hex32(parseHex32(pub.transcriptHash, "transcriptHash")),
      context: contextToWire(parseContextWire(pub.context)),
    },
    ciphertext: o.ciphertext as string,
  };
  return { file, salt, nonce, ciphertext };
}

/**
 * Decrypts a share file. A wrong password and any tampering (of the ciphertext OR of any header field) fail identically ("WRONG_PASSWORD_OR_TAMPERED").
 * Files whose Argon2id cost is below `minKdf` (default MODERATE) are refused before any key derivation.
 */
export function decryptShareRecord(value: unknown, password: string, opts: { minKdf?: KdfParams } = {}): ShareRecord {
  const floor = opts.minKdf ?? KDF_MODERATE;
  const { file, salt, nonce, ciphertext } = parseShareFile(value);
  if (file.kdf.opslimit < floor.opslimit || file.kdf.memlimit < floor.memlimit) throw new InvalidInputError("KDF_BELOW_FLOOR", "the file's Argon2id cost is below the accepted floor");
  const pw = assertPassword(password);
  const key = deriveKey(pw, salt, { opslimit: file.kdf.opslimit, memlimit: file.kdf.memlimit });
  let plaintext: Uint8Array;
  try {
    const { ciphertext: _ignored, ...header } = file;
    plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, headerOf(header), nonce, key);
  } catch {
    throw new InvalidInputError("WRONG_PASSWORD_OR_TAMPERED", "cannot decrypt the share file: wrong password or the file was modified");
  } finally {
    wipe(key);
    wipe(pw);
  }
  const share = bytesToBigInt(plaintext);
  wipe(plaintext);
  assertScalar(share, "decrypted share");
  return {
    index: file.public.index,
    share,
    verificationKey: parsePointWire(file.public.verificationKey, "verificationKey"),
    transcriptHash: parseHex32(file.public.transcriptHash, "transcriptHash"),
    context: parseContextWire(file.public.context),
  };
}

/** Writes with mode 0600 in a 0700 directory and refuses to overwrite: a trustee's key file must never be clobbered silently. Returns the observed file mode. */
export function writeShareFile(file: string, content: ShareFile): { mode: number } {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // some filesystems cannot hold unix modes; the caller can inspect the returned mode
  }
  return { mode: fs.statSync(file).mode & 0o777 };
}

export function readShareFile(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
