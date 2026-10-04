import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM (Node's built-in). `aad` binds a ciphertext to its owner so rows cannot be swapped. */
export function encryptSecret(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ct: ct.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), v: 1 };
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function decryptSecret(key, box, aad) {
  // Node accepts shortened GCM tags unless told otherwise, and a short tag can be guessed: insist on the full sizes.
  const iv = typeof box?.iv === "string" ? Buffer.from(box.iv, "base64") : null;
  const tag = typeof box?.tag === "string" ? Buffer.from(box.tag, "base64") : null;
  if (typeof box?.ct !== "string" || iv?.length !== IV_BYTES || tag?.length !== TAG_BYTES) throw new Error("encrypted value is malformed");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(box.ct, "base64")), decipher.final()]).toString("utf8");
}
