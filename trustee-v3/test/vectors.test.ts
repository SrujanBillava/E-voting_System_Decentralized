// Known-answer vectors (spec/vectors.json): every encoding and derivation a contract or another implementation must reproduce. Each value is checked
// against THIS implementation and against an INDEPENDENT recomputation (ethers' AbiCoder and keccak256 + plain BigInt), so the file freezes the formats
// and cannot be circular: if anything in an encoding changes, this test fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AbiCoder, id as keccakOfText, keccak256, toBeHex } from "ethers";
import { computeCeremonyId, computeTranscriptHash, deserializeTranscript, serializeTranscript, verifyTranscript, type Transcript } from "../src/ceremony.ts";
import { decryptionChallenge, proveDecryptionShareWithNonce, verifyDecryptionShare } from "../src/chaum-pedersen.ts";
import { hexOfBytes, parseHex32, parseHexBytes } from "../src/encoding.ts";
import { lagrangeCoefficientsAtZero } from "../src/lagrange.ts";
import { CEREMONY_TAG, DKG_TAG, G, PDEC_TAG, SUBGROUP_ORDER as L, TEST_CONTEXT, TRANSCRIPT_TAG } from "../src/params.ts";
import { mul, parsePointWire, pointToWire } from "../src/point.ts";
import { proofToWire } from "../src/proof.ts";
import { pokChallenge, proveKnowledgeWithNonce, verifyKnowledge } from "../src/schnorr.ts";
import { hex32 } from "../src/encoding.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const v = JSON.parse(fs.readFileSync(path.join(ROOT, "spec", "vectors.json"), "utf8"));
const coder = AbiCoder.defaultAbiCoder();
const u = (...values: bigint[]): string => coder.encode(values.map(() => "uint256"), values);
/** the Fiat-Shamir challenge, independently: uint256(keccak256(preimage)) mod l */
const keccakMod = (encoded: string): bigint => BigInt(keccak256(encoded)) % L;
const big = (hex: string): bigint => BigInt(hex);

describe("vectors: tags, scalar field and context", () => {
  it("the four domain tags are keccak256 of their labels", () => {
    assert.equal(v.tags.CEREMONY_TAG, keccakOfText("VOTECHAIN-V3-DKG-CEREMONY-1"));
    assert.equal(v.tags.DKG_TAG, keccakOfText("VOTECHAIN-V3-DKG-1"));
    assert.equal(v.tags.TRANSCRIPT_TAG, keccakOfText("VOTECHAIN-V3-DKG-TRANSCRIPT-1"));
    assert.equal(v.tags.PDEC_TAG, keccakOfText("VOTECHAIN-V3-PDEC-1"));
    assert.equal(parseHex32(v.tags.CEREMONY_TAG, "t"), CEREMONY_TAG);
    assert.equal(parseHex32(v.tags.DKG_TAG, "t"), DKG_TAG);
    assert.equal(parseHex32(v.tags.TRANSCRIPT_TAG, "t"), TRANSCRIPT_TAG);
    assert.equal(parseHex32(v.tags.PDEC_TAG, "t"), PDEC_TAG);
  });

  it("the file states the Fiat-Shamir rule: uint256(keccak256(preimage)) mod l", () => {
    assert.match(v.fiatShamir, /uint256\(keccak256\(preimage\)\) mod l/);
    assert.doesNotMatch(JSON.stringify(v), new RegExp("sha" + "-?" + "(512|384)", "i"), "no other challenge hash is mentioned anywhere in the vectors");
  });

  it("l and the placeholder election context are the frozen ones", () => {
    assert.equal(v.subgroupOrder, "2736030358979909402780800718157159386076813972158567259200215660948447373041");
    assert.equal(BigInt(v.subgroupOrder), L);
    assert.equal(v.context.chainId, "31337");
    assert.equal(big(v.context.contractAddress), TEST_CONTEXT.contractAddress);
    assert.equal(big(v.context.electionId), TEST_CONTEXT.electionId);
  });
});

describe("vectors: Lagrange coefficients at zero", () => {
  it("equal the implementation and an independent computation (lambda_a = b/(b-a) mod l for a pair)", () => {
    const inverse = (a: bigint): bigint => {
      let r = 1n;
      let b = ((a % L) + L) % L;
      for (let e = L - 2n; e > 0n; e >>= 1n) {
        if (e & 1n) r = (r * b) % L;
        b = (b * b) % L;
      }
      return r;
    };
    for (const [key, [la, lb]] of Object.entries(v.lagrangeAtZero) as [string, [string, string]][]) {
      const [a, b] = key.split(",").map(BigInt) as [bigint, bigint];
      assert.deepEqual(lagrangeCoefficientsAtZero(key.split(",").map(Number)).map(String), [la, lb]);
      assert.equal(BigInt(la), (((b * inverse(b - a)) % L) + L) % L, `lambda_${a} for (${key})`);
      assert.equal(BigInt(lb), (((((a * inverse(a - b)) % L) + L) % L)), `lambda_${b} for (${key})`);
      assert.equal((BigInt(la) + BigInt(lb)) % L, 1n, "the coefficients of a pair sum to 1");
    }
  });
});

describe("vectors: ceremony id and Schnorr proof of knowledge", () => {
  const keys = new Map<number, Uint8Array>((v.ceremonyId.transportKeys as string[]).map((k, i) => [i + 1, parseHexBytes(k, 32, "key")] as const));

  it("ceremony id = keccak256(abi.encode(CEREMONY_TAG, chainId, contract, electionId, n, t, key_1, key_2, key_3)): implementation and independent", () => {
    assert.equal(hex32(computeCeremonyId(TEST_CONTEXT, { n: 3, t: 2 }, keys)), v.ceremonyId.ceremonyId);
    const independent = keccak256(u(big(v.tags.CEREMONY_TAG), TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, 3n, 2n, ...(v.ceremonyId.transportKeys as string[]).map(big)));
    assert.equal(independent, v.ceremonyId.ceremonyId);
  });

  it("Schnorr: R = nonce*G, e = uint256(keccak256(abi.encode(DKG_TAG, context, ceremony, trustee, coefficient, K, R))) mod l, z = nonce + e*secret mod l", () => {
    const s = v.schnorr;
    const binding = { context: TEST_CONTEXT, ceremonyId: big(s.binding.ceremonyId), trusteeIndex: s.binding.trusteeIndex, coefficientIndex: s.binding.coefficientIndex };
    const K = parsePointWire(s.commitment, "K");
    const R = parsePointWire(s.nonceCommitment, "R");
    assert.deepEqual(pointToWire(mul(G, big(s.secret))), s.commitment);
    assert.deepEqual(pointToWire(mul(G, big(s.nonce))), s.nonceCommitment);
    assert.equal(hex32(pokChallenge(binding, K, R)), s.challenge);
    const preimage = u(big(v.tags.DKG_TAG), TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, big(s.binding.ceremonyId), BigInt(s.binding.trusteeIndex), BigInt(s.binding.coefficientIndex), K[0], K[1], R[0], R[1]);
    assert.equal(preimage, s.preimage, "the frozen preimage: 11 static words, tag first");
    assert.equal((preimage.length - 2) / 2, 11 * 32);
    assert.equal(keccak256(preimage), s.challengeHash, "the raw 256-bit hash");
    assert.equal(BigInt(s.challengeHash) % L, big(s.challenge), "challenge = uint256(hash) mod l");
    assert.equal(keccakMod(preimage), big(s.challenge));
    const proof = proveKnowledgeWithNonce(binding, big(s.secret), big(s.nonce));
    assert.deepEqual(proofToWire(proof), s.proof);
    assert.equal(proof.z, (big(s.nonce) + big(s.challenge) * big(s.secret)) % L);
    assert.ok(verifyKnowledge(binding, K, proof));
  });
});

describe("vectors: Chaum-Pedersen partial decryption", () => {
  it("D = s*A, a = u*G, b = u*A, e = uint256(keccak256(abi.encode(PDEC_TAG, context, constituency, slot, trustee, vk, A, D, a, b))) mod l, z = u + e*s mod l", () => {
    const c = v.chaumPedersen;
    const binding = { context: TEST_CONTEXT, constituencyId: big(c.binding.constituencyId), slot: c.binding.slot, trusteeIndex: c.binding.trusteeIndex };
    const vk = parsePointWire(c.verificationKey, "vk");
    const A = parsePointWire(c.A, "A");
    const D = parsePointWire(c.D, "D");
    const a = mul(G, big(c.nonce));
    const b = mul(A, big(c.nonce));
    assert.deepEqual(pointToWire(mul(G, big(c.secretShare))), c.verificationKey);
    assert.deepEqual(pointToWire(mul(A, big(c.secretShare))), c.D);
    assert.equal(hex32(decryptionChallenge(binding, vk, A, D, a, b)), c.challenge);
    const preimage = u(big(v.tags.PDEC_TAG), TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, big(c.binding.constituencyId), BigInt(c.binding.slot), BigInt(c.binding.trusteeIndex), vk[0], vk[1], A[0], A[1], D[0], D[1], a[0], a[1], b[0], b[1]);
    assert.equal(preimage, c.preimage, "the frozen preimage: 17 static words, tag first");
    assert.equal((preimage.length - 2) / 2, 17 * 32);
    assert.equal(keccak256(preimage), c.challengeHash, "the raw 256-bit hash");
    assert.equal(BigInt(c.challengeHash) % L, big(c.challenge), "challenge = uint256(hash) mod l");
    assert.equal(keccakMod(preimage), big(c.challenge));
    const result = proveDecryptionShareWithNonce(binding, big(c.secretShare), A, big(c.nonce));
    assert.deepEqual(pointToWire(result.D), c.D);
    assert.deepEqual(proofToWire(result.proof), c.proof);
    assert.equal(result.proof.z, (big(c.nonce) + big(c.challenge) * big(c.secretShare)) % L);
    assert.ok(verifyDecryptionShare(binding, vk, A, D, result.proof));
  });
});

describe("vectors: the transcript", () => {
  const transcript = v.transcript.object as Transcript;

  it("verifies: every proof of knowledge, H, every verification key, pair consistency and the hash", () => {
    assert.ok(verifyTranscript(transcript, { context: TEST_CONTEXT, params: { n: 3, t: 2 } }).ok);
  });

  it("the transcript hash equals an independent keccak256(abi.encode(...)) of its public fields in the documented order", () => {
    const words: bigint[] = [big(v.tags.TRANSCRIPT_TAG), TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, 3n, 2n, big(transcript.ceremonyId)];
    for (const p of transcript.participants) {
      words.push(BigInt(p.index), big(p.transportPublicKey));
      for (const K of p.commitments) words.push(big(K[0]), big(K[1]));
      for (const pr of p.proofs) words.push(big(pr.e), big(pr.z));
    }
    words.push(big(transcript.electionPublicKey[0]), big(transcript.electionPublicKey[1]));
    for (const vk of transcript.verificationKeys) words.push(big(vk[0]), big(vk[1]));
    assert.equal(words.length, 7 + 3 * 10 + 2 + 6);
    assert.equal(keccak256(u(...words)), transcript.transcriptHash);
    assert.equal(transcript.transcriptHash, v.transcript.object.transcriptHash);
  });

  it("canonical serialisation is frozen: the exact JSON text and its SHA-256", () => {
    assert.equal(serializeTranscript(transcript), v.transcript.canonicalJson);
    assert.deepEqual(deserializeTranscript(v.transcript.canonicalJson), transcript);
    assert.equal("0x" + createHash("sha256").update(v.transcript.canonicalJson).digest("hex"), v.transcript.canonicalJsonSha256);
  });

  it("the implementation recomputes the same hash from the parsed fields", () => {
    const result = verifyTranscript(transcript);
    assert.ok(result.ok);
    if (result.ok) {
      const t = result.transcript;
      assert.equal(hex32(computeTranscriptHash(t.context, t.params, t.ceremonyId, t.participants, t.electionPublicKey, t.verificationKeys)), v.transcript.object.transcriptHash);
      assert.equal(hexOfBytes(t.participants[0]!.transportKey), v.ceremonyId.transportKeys[0]);
    }
  });
});

describe("vectors: drift", () => {
  const generate = (args: string[]) => spawnSync(process.execPath, [path.join("scripts", "make-vectors.ts"), ...args], { cwd: ROOT, encoding: "utf8" });

  it("spec/vectors.json is exactly what scripts/make-vectors.ts emits now: regenerating would change nothing", () => {
    const result = generate(["--check"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /vectors are up to date/);
  });

  it("the drift check really detects drift: a copy with ONE changed digit, a missing file or an old-format file fails it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trustee-v3-test-"));
    try {
      const text = fs.readFileSync(path.join(ROOT, "spec", "vectors.json"), "utf8");
      const index = text.indexOf('"challenge": "0x') + '"challenge": "0x'.length + 5;
      const tampered = text.slice(0, index) + (text[index] === "0" ? "1" : "0") + text.slice(index + 1);
      const variants: [string, string | null][] = [["one changed digit", tampered], ["a missing file", null], ["an old-format file", JSON.stringify({ description: "old" }) + "\n"]];
      for (const [name, content] of variants) {
        const file = path.join(dir, `${name.replace(/ /g, "-")}.json`);
        if (content !== null) fs.writeFileSync(file, content);
        const result = generate(["--check", "--file", file]);
        assert.equal(result.status, 1, name);
        assert.match(result.stderr, /DRIFT/, name);
      }
      const fresh = path.join(dir, "fresh.json");
      assert.equal(generate(["--file", fresh]).status, 0);
      assert.equal(fs.readFileSync(fresh, "utf8"), text, "generation is deterministic: the same bytes every time");
      assert.equal(generate(["--check", "--file", fresh]).status, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
