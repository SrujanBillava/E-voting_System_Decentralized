import { decryptSecret, encryptSecret } from "../auth/secretBox.js";
import { DESCRIPTOR_LENGTH, TEMPLATE_VERSION } from "./constants.js";

/**
 * A face template (the enrolled sample descriptors of one voter) is only ever stored encrypted:
 * AES-256-GCM through src/auth/secretBox.js, with FACE_TEMPLATE_ENCRYPTION_KEY.
 *
 * The voter's database id goes in as "additional authenticated data". GCM then refuses to decrypt the
 * ciphertext for any other voter, so copying one voter's template row onto another voter is detected.
 */

const BYTES_PER_NUMBER = 4; // 32-bit floats, little-endian
const IV_BYTES = 12;
const TAG_BYTES = 16;

const aadOf = (voterDbId) => `face-template:v${TEMPLATE_VERSION}:${voterDbId}`;

/**
 * @param {Buffer} key 32 bytes
 * @param {string} voterDbId the voter's MongoDB _id as a string
 * @param {Float32Array[]} samples unit vectors of DESCRIPTOR_LENGTH numbers each
 * @returns {{ ct: string, iv: string, tag: string, v: number }} what is stored
 */
export function sealTemplate(key, voterDbId, samples) {
  const bytes = Buffer.alloc(samples.length * DESCRIPTOR_LENGTH * BYTES_PER_NUMBER);
  let offset = 0;
  for (const sample of samples) {
    if (sample.length !== DESCRIPTOR_LENGTH) throw new Error("face sample has the wrong length");
    for (let i = 0; i < DESCRIPTOR_LENGTH; i++) offset = bytes.writeFloatLE(sample[i], offset);
  }
  return encryptSecret(key, bytes.toString("base64"), aadOf(voterDbId));
}

/**
 * Throws when the key is wrong, the row belongs to another voter, or the stored data was altered.
 * The error never contains template data.
 * @returns {Float32Array[]}
 */
export function openTemplate(key, voterDbId, box) {
  // Node accepts shortened GCM tags unless told otherwise, and a 4-byte tag can be guessed. Insist on the full sizes.
  const sizeOf = (text) => (typeof text === "string" ? Buffer.from(text, "base64").length : -1);
  if (box?.v !== 1 || sizeOf(box.iv) !== IV_BYTES || sizeOf(box.tag) !== TAG_BYTES || typeof box.ct !== "string") throw new Error("face template could not be decrypted");
  let bytes;
  try {
    bytes = Buffer.from(decryptSecret(key, box, aadOf(voterDbId)), "base64");
  } catch {
    throw new Error("face template could not be decrypted");
  }
  const sampleBytes = DESCRIPTOR_LENGTH * BYTES_PER_NUMBER;
  if (bytes.length === 0 || bytes.length % sampleBytes !== 0) throw new Error("face template has an unexpected size");
  const samples = [];
  for (let start = 0; start < bytes.length; start += sampleBytes) {
    const sample = new Float32Array(DESCRIPTOR_LENGTH);
    for (let i = 0; i < DESCRIPTOR_LENGTH; i++) sample[i] = bytes.readFloatLE(start + i * BYTES_PER_NUMBER);
    samples.push(sample);
  }
  return samples;
}
