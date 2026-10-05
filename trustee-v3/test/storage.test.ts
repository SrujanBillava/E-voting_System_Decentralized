// Encrypted-at-rest storage of a trustee's share: Argon2id + XChaCha20-Poly1305, an authenticated header, per-trustee files, restore.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import sodium from "libsodium-wrappers-sumo";
import { tallyAggregate } from "../src/threshold.ts";
import { G, SUBGROUP_ORDER as L, TEST_CONTEXT } from "../src/params.ts";
import { mul, pointToWire } from "../src/point.ts";
import { KDF_MODERATE, KDF_SENSITIVE, KDF_TESTING_ONLY, MIN_PASSWORD_LENGTH, decryptShareRecord, encryptShareRecord, readShareFile, writeShareFile, type ShareFile, type ShareRecord } from "../src/storage.ts";
import { randomScalar } from "../src/scalar.ts";
import { Trustee } from "../src/trustee.ts";
import { aggregateFor } from "../testing/aggregate.ts";
import { clone, runCeremony, type CeremonyRun } from "../testing/ceremony.ts";
import { assertNoLeak, spellings } from "../testing/spy.ts";

await sodium.ready;
// Passwords are generated per run and never written anywhere: there is no hard-coded password in this project.
const newPassword = (): string => randomBytes(18).toString("base64");
const FAST = { minKdf: KDF_TESTING_ONLY };

const record = (): ShareRecord => ({ index: 2, share: randomScalar(), verificationKey: mul(G, randomScalar()), transcriptHash: BigInt("0x" + randomBytes(32).toString("hex")), context: TEST_CONTEXT });

describe("share file: parameters", () => {
  it("the documented KDF parameters are exactly libsodium's own MODERATE and SENSITIVE (Argon2id: 3 passes / 256 MiB, 4 passes / 1 GiB) and MIN for tests", () => {
    assert.deepEqual({ ...KDF_MODERATE }, { opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE, memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE });
    assert.deepEqual({ ...KDF_SENSITIVE }, { opslimit: sodium.crypto_pwhash_OPSLIMIT_SENSITIVE, memlimit: sodium.crypto_pwhash_MEMLIMIT_SENSITIVE });
    assert.deepEqual({ ...KDF_TESTING_ONLY }, { opslimit: sodium.crypto_pwhash_OPSLIMIT_MIN, memlimit: sodium.crypto_pwhash_MEMLIMIT_MIN });
    assert.equal(KDF_MODERATE.memlimit, 256 * 1024 * 1024);
    assert.equal(sodium.crypto_pwhash_ALG_ARGON2ID13, 2);
    assert.equal(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES, 32);
    assert.equal(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, 24);
  });

  it("the default cost is MODERATE and works end to end (this one test really spends 256 MiB and about half a second)", () => {
    const r = record();
    const password = newPassword();
    const file = encryptShareRecord(r, password); // default parameters
    assert.equal(file.kdf.opslimit, KDF_MODERATE.opslimit);
    assert.equal(file.kdf.memlimit, KDF_MODERATE.memlimit);
    assert.equal(file.kdf.alg, "argon2id13");
    assert.equal(file.cipher.alg, "xchacha20poly1305-ietf");
    assert.deepEqual(decryptShareRecord(file, password).share, r.share); // default floor accepts it
  });
});

describe("share file: encrypt and decrypt", () => {
  const password = newPassword();
  const r = record();
  const file = encryptShareRecord(r, password, KDF_TESTING_ONLY);

  it("round trips every field", () => {
    const back = decryptShareRecord(file, password, FAST);
    assert.equal(back.index, r.index);
    assert.equal(back.share, r.share);
    assert.deepEqual([...back.verificationKey], [...r.verificationKey]);
    assert.equal(back.transcriptHash, r.transcriptHash);
    assert.deepEqual(back.context, r.context);
  });

  it("the file never contains the share (decimal, hex, either byte order) nor the password", () => {
    const text = JSON.stringify(file);
    assertNoLeak("share file", text, [r.share]);
    const le = Buffer.from(r.share.toString(16).padStart(64, "0"), "hex").reverse().toString("hex");
    assert.ok(!text.toLowerCase().includes(le));
    assert.ok(!text.includes(password));
    for (const form of spellings(r.share)) assert.ok(!text.toLowerCase().includes(form.toLowerCase()));
  });

  it("is randomised: the salt, the nonce and the ciphertext differ every time", () => {
    const again = encryptShareRecord(r, password, KDF_TESTING_ONLY);
    assert.notEqual(again.kdf.salt, file.kdf.salt);
    assert.notEqual(again.cipher.nonce, file.cipher.nonce);
    assert.notEqual(again.ciphertext, file.ciphertext);
    assert.equal(decryptShareRecord(again, password, FAST).share, r.share);
  });

  it("a WRONG password fails, and fails exactly like tampering does (no oracle)", () => {
    for (const bad of [newPassword(), password + "x", password.slice(0, -1) + (password.endsWith("A") ? "B" : "A")]) {
      assert.throws(() => decryptShareRecord(file, bad, FAST), /WRONG_PASSWORD_OR_TAMPERED/);
    }
  });

  it("TAMPERING with the ciphertext or ANY header field is detected: the whole header is authenticated", () => {
    const flip = (hex: string, at: number): string => hex.slice(0, at) + (hex[at] === "0" ? "1" : "0") + hex.slice(at + 1);
    const variants: [string, (f: ShareFile) => ShareFile][] = [
      ["ciphertext byte", (f) => ({ ...f, ciphertext: flip(f.ciphertext, 10) })],
      ["ciphertext tag", (f) => ({ ...f, ciphertext: flip(f.ciphertext, f.ciphertext.length - 3) })],
      ["nonce", (f) => ({ ...f, cipher: { ...f.cipher, nonce: flip(f.cipher.nonce, 5) } })],
      ["salt", (f) => ({ ...f, kdf: { ...f.kdf, salt: flip(f.kdf.salt, 5) } })],
      ["kdf opslimit", (f) => ({ ...f, kdf: { ...f.kdf, opslimit: f.kdf.opslimit + 1 } })],
      ["kdf memlimit", (f) => ({ ...f, kdf: { ...f.kdf, memlimit: f.kdf.memlimit + 1024 } })],
      ["public index", (f) => ({ ...f, public: { ...f.public, index: 3 } })],
      ["public verification key", (f) => ({ ...f, public: { ...f.public, verificationKey: pointToWire(mul(G, 5n)) } })],
      ["public transcript hash", (f) => ({ ...f, public: { ...f.public, transcriptHash: flip(f.public.transcriptHash, 20) } })],
      ["public context", (f) => ({ ...f, public: { ...f.public, context: { ...f.public.context, chainId: "1" } } })],
    ];
    for (const [name, change] of variants) {
      assert.throws(() => decryptShareRecord(change(clone(file)), password, FAST), /WRONG_PASSWORD_OR_TAMPERED/, name);
    }
  });

  it("structural damage is refused before anything is derived: extra/missing fields, unknown format or version or algorithm, wrong lengths, non-hex", () => {
    const structural: [string, unknown][] = [
      ["extra field", { ...file, note: "x" }],
      ["missing field", (({ ciphertext: _c, ...rest }) => rest)(file)],
      ["unknown format", { ...file, format: "other" }],
      ["unknown version", { ...file, version: 2 }],
      ["unknown kdf", { ...file, kdf: { ...file.kdf, alg: "scrypt" } }],
      ["short salt", { ...file, kdf: { ...file.kdf, salt: file.kdf.salt.slice(0, -2) } }],
      ["short ciphertext", { ...file, ciphertext: file.ciphertext.slice(0, -2) }],
      ["uppercase hex", { ...file, ciphertext: file.ciphertext.toUpperCase().replace("0X", "0x") }],
      ["null", null],
      ["array", []],
      ["string", "file"],
    ];
    for (const [name, value] of structural) assert.throws(() => decryptShareRecord(value, password, FAST), /BAD_SHARE_FILE|BAD_STRUCTURE|BAD_ENCODING/, name);
  });

  it("a KDF DOWNGRADE is refused: files whose Argon2id cost is below the default floor are not even tried (and absurd costs are refused too)", () => {
    assert.throws(() => decryptShareRecord(file, password), /KDF_BELOW_FLOOR/);
    assert.throws(() => decryptShareRecord(file, password, { minKdf: KDF_SENSITIVE }), /KDF_BELOW_FLOOR/);
    const huge = { ...file, kdf: { ...file.kdf, memlimit: 2 ** 40 } };
    assert.throws(() => decryptShareRecord(huge, password, FAST), /BAD_INTEGER/, "a memory-exhaustion attempt");
    assert.throws(() => encryptShareRecord(r, password, { opslimit: 100, memlimit: 8192 }), /BAD_KDF/);
    assert.throws(() => encryptShareRecord(r, password, { opslimit: 1, memlimit: 100 }), /BAD_KDF/);
  });

  it("passwords: at least 12 characters, a string, at most 1024; Unicode compatibility forms are normalised (NFKC)", () => {
    for (const bad of ["", "short", "x".repeat(MIN_PASSWORD_LENGTH - 1), "x".repeat(1025), null, undefined, 123456789012 as unknown as string]) {
      assert.throws(() => encryptShareRecord(r, bad as string, KDF_TESTING_ONLY), /WEAK_PASSWORD/, String(bad));
      assert.throws(() => decryptShareRecord(file, bad as string, FAST), /WEAK_PASSWORD/);
    }
    const ascii = randomBytes(9).toString("hex"); // 18 characters
    const fullWidth = [...ascii].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join(""); // the same characters in their full-width compatibility forms
    const f = encryptShareRecord(r, fullWidth, KDF_TESTING_ONLY);
    assert.equal(decryptShareRecord(f, ascii, FAST).share, r.share);
  });

  it("only a canonical share in range can be stored", () => {
    assert.throws(() => encryptShareRecord({ ...r, share: L }, password, KDF_TESTING_ONLY), /BAD_SCALAR/);
    assert.throws(() => encryptShareRecord({ ...r, index: 0 }, password, KDF_TESTING_ONLY), /BAD_INTEGER/);
  });
});

describe("share file: on disk", () => {
  it("is written with mode 0600 in a 0700 directory, is never overwritten, and reads back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trustee-v3-test-"));
    try {
      const file = path.join(dir, "trustee-2", "share.json");
      const content = encryptShareRecord(record(), newPassword(), KDF_TESTING_ONLY);
      const { mode } = writeShareFile(file, content);
      assert.equal(mode, 0o600, "owner read/write only");
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.deepEqual(readShareFile(file), content);
      assert.throws(() => writeShareFile(file, content), /EEXIST/, "a trustee's key file is never clobbered");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("restoring trustees from their encrypted files", () => {
  let run: CeremonyRun;
  let dir: string;
  const passwords = [newPassword(), newPassword(), newPassword()];

  before(() => {
    run = runCeremony();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trustee-v3-test-"));
    run.trustees.forEach((t, i) => writeShareFile(path.join(dir, `trustee-${i + 1}`, "share.json"), t.exportEncryptedShare(passwords[i]!, KDF_TESTING_ONLY)));
  });

  it("each trustee has its OWN directory with exactly one file; no file or directory holds more than one share; each decrypts only with its own password", () => {
    assert.deepEqual(fs.readdirSync(dir).sort(), ["trustee-1", "trustee-2", "trustee-3"]);
    const shares = new Set<bigint>();
    for (let i = 1; i <= 3; i++) {
      assert.deepEqual(fs.readdirSync(path.join(dir, `trustee-${i}`)), ["share.json"]);
      const file = readShareFile(path.join(dir, `trustee-${i}`, "share.json"));
      const r = decryptShareRecord(file, passwords[i - 1]!, FAST);
      assert.equal(r.index, i);
      shares.add(r.share);
      for (const other of [1, 2, 3].filter((x) => x !== i)) assert.throws(() => decryptShareRecord(file, passwords[other - 1]!, FAST), /WRONG_PASSWORD_OR_TAMPERED/, `trustee ${other}'s password must not open trustee ${i}'s file`);
      const text = fs.readFileSync(path.join(dir, `trustee-${i}`, "share.json"), "utf8");
      for (const j of [1, 2, 3]) assert.ok(!text.includes(passwords[j - 1]!));
    }
    assert.equal(shares.size, 3, "three different shares, three separate files");
  });

  it("restored trustees decrypt: every pair, using ONLY trustees reloaded from disk, recovers [7, 4, 2]", () => {
    const restored = [1, 2, 3].map((i) => Trustee.restore({ file: readShareFile(path.join(dir, `trustee-${i}`, "share.json")), password: passwords[i - 1]!, transcript: run.transcript, minKdf: KDF_TESTING_ONLY }));
    assert.deepEqual(restored.map((t) => t.state), ["finalized", "finalized", "finalized"]);
    const aggregate = aggregateFor(run.verified.electionPublicKey, [7, 4, 2]);
    const partials = restored.map((t) => t.partialDecrypt(aggregate));
    for (const [a, b] of [[1, 2], [1, 3], [2, 3]] as const) {
      assert.deepEqual(tallyAggregate({ transcript: run.verified, aggregate, partials: [partials[a - 1], partials[b - 1]] }).totals, [7, 4, 2]);
    }
    assert.deepEqual(restored.map((t) => t.index), [1, 2, 3]);
  });

  it("restore REFUSES: a wrong password, a modified file, another ceremony's transcript, a mislabelled index, and a share that does not match its verification key", () => {
    const file1 = readShareFile(path.join(dir, "trustee-1", "share.json")) as ShareFile;
    const base = { file: file1, password: passwords[0]!, transcript: run.transcript, minKdf: KDF_TESTING_ONLY };
    assert.ok(Trustee.restore(base));
    assert.throws(() => Trustee.restore({ ...base, password: newPassword() }), /WRONG_PASSWORD_OR_TAMPERED/);
    assert.throws(() => Trustee.restore({ ...base, file: { ...file1, ciphertext: file1.ciphertext.slice(0, 20) + (file1.ciphertext[20] === "0" ? "1" : "0") + file1.ciphertext.slice(21) } }), /WRONG_PASSWORD_OR_TAMPERED/);
    assert.throws(() => Trustee.restore({ ...base, file: file1, transcript: runCeremony().transcript }), /TRANSCRIPT_MISMATCH/);
    assert.throws(() => Trustee.restore({ ...base, minKdf: undefined as never }), /KDF_BELOW_FLOOR/, "the default floor rejects a weak file");
    const r = decryptShareRecord(file1, passwords[0]!, FAST);
    const wrongShare = encryptShareRecord({ ...r, share: randomScalar() }, passwords[0]!, KDF_TESTING_ONLY);
    assert.throws(() => Trustee.restore({ ...base, file: wrongShare }), /SHARE_KEY_MISMATCH/);
    const mislabelled = encryptShareRecord({ ...r, index: 2 }, passwords[0]!, KDF_TESTING_ONLY);
    assert.throws(() => Trustee.restore({ ...base, file: mislabelled }), /VERIFICATION_KEY_MISMATCH/);
    const tamperedTranscript = { ...run.transcript, transcriptHash: run.transcript.transcriptHash.replace(/.$/, "0") };
    assert.throws(() => Trustee.restore({ ...base, transcript: tamperedTranscript }), /HASH_MISMATCH|TRANSCRIPT_MISMATCH/);
  });

  it("a restored trustee keeps no ceremony state: it can only decrypt (it cannot be walked through a ceremony again)", () => {
    const restored = Trustee.restore({ file: readShareFile(path.join(dir, "trustee-3", "share.json")), password: passwords[2]!, transcript: run.transcript, minKdf: KDF_TESTING_ONLY });
    for (const call of [() => restored.announce(), () => restored.commit([]), () => restored.deal([]), () => restored.receive([]), () => restored.finalize({})]) assert.throws(call, /WRONG_STATE/);
    assert.equal(restored.state, "finalized");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
