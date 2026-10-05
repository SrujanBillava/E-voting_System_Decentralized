// Generates spec/vectors.json: known-answer vectors for every encoding and derivation the future contract or another implementation must reproduce,
// computed from FIXED scalars, nonces and transport keys through the deterministic cores (the production API always draws fresh randomness).
// All inputs are public test values with no value as secrets. test/vectors.test.ts recomputes every output here AND independently with ethers.
//   node scripts/make-vectors.ts            regenerate spec/vectors.json
//   node scripts/make-vectors.ts --check    exit 1 if spec/vectors.json is not exactly what this generator emits now (drift check, writes nothing)
//   --file <path>                           use another file than spec/vectors.json (with or without --check)
import fs from "node:fs";
import path from "node:path";
import { computeCeremonyId, computeTranscriptHash, deriveKeys, serializeTranscript, type ParsedParticipant, type Transcript } from "../src/ceremony.ts";
import { contextToWire, contextWords } from "../src/context.ts";
import { decryptionChallenge, proveDecryptionShareWithNonce } from "../src/chaum-pedersen.ts";
import { encodeWords, hex32, hexOfBytes } from "../src/encoding.ts";
import { lagrangeCoefficientsAtZero } from "../src/lagrange.ts";
import { CEREMONY_TAG, DKG_TAG, G, PDEC_TAG, SUBGROUP_ORDER, TEST_CONTEXT, TRANSCRIPT_TAG, type Point } from "../src/params.ts";
import { mul, pointToWire } from "../src/point.ts";
import { proofToWire } from "../src/proof.ts";
import { pokChallenge, proveKnowledgeWithNonce } from "../src/schnorr.ts";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";

// Fixed public test values, derived from labels so nobody mistakes them for random: scalar(label) = keccak256(label) mod l.
const scalarOf = (label: string): bigint => (BigInt("0x" + Buffer.from(keccak_256(utf8ToBytes(label))).toString("hex")) % (SUBGROUP_ORDER - 1n)) + 1n;
const n = 3;
const t = 2;
const params = { n, t };
const keys = new Map([1, 2, 3].map((i) => [i, keccak_256(utf8ToBytes(`votechain-v3 test transport key ${i}`))] as const));
const ceremonyId = computeCeremonyId(TEST_CONTEXT, params, keys);

const participants: ParsedParticipant[] = [1, 2, 3].map((i) => {
  const coefficients = [scalarOf(`trustee ${i} coefficient 0`), scalarOf(`trustee ${i} coefficient 1`)];
  return {
    index: i,
    transportKey: keys.get(i) as Uint8Array,
    commitments: coefficients.map((a) => mul(G, a)),
    proofs: coefficients.map((a, k) => proveKnowledgeWithNonce({ context: TEST_CONTEXT, ceremonyId, trusteeIndex: i, coefficientIndex: k }, a, scalarOf(`trustee ${i} nonce ${k}`))),
  };
});
const { electionPublicKey, verificationKeys } = deriveKeys(participants, params);
const transcriptHash = computeTranscriptHash(TEST_CONTEXT, params, ceremonyId, participants, electionPublicKey, verificationKeys);
const transcript: Transcript = {
  version: "votechain-v3-dkg-transcript-1",
  context: contextToWire(TEST_CONTEXT),
  threshold: t,
  trustees: n,
  ceremonyId: hex32(ceremonyId),
  participants: participants.map((p) => ({ index: p.index, transportPublicKey: hexOfBytes(p.transportKey), commitments: p.commitments.map(pointToWire), proofs: p.proofs.map(proofToWire) })),
  electionPublicKey: pointToWire(electionPublicKey),
  verificationKeys: verificationKeys.map(pointToWire),
  transcriptHash: hex32(transcriptHash),
};

// one Schnorr challenge and one partial decryption with fixed inputs
const pokBinding = { context: TEST_CONTEXT, ceremonyId, trusteeIndex: 2, coefficientIndex: 1 };
const pokSecret = scalarOf("vector schnorr secret");
const pokNonce = scalarOf("vector schnorr nonce");
const K = mul(G, pokSecret);
const R = mul(G, pokNonce);
const pokProof = proveKnowledgeWithNonce(pokBinding, pokSecret, pokNonce);
const decBinding = { context: TEST_CONTEXT, constituencyId: BigInt(hex32(BigInt("0x" + Buffer.from(keccak_256(utf8ToBytes("KA-BLR"))).toString("hex")))), slot: 1, trusteeIndex: 3 };
const decSecret = scalarOf("vector decryption share");
const decNonce = scalarOf("vector decryption nonce");
const A: Point = mul(G, scalarOf("vector aggregate A"));
const dec = proveDecryptionShareWithNonce(decBinding, decSecret, A, decNonce);
const vk = mul(G, decSecret);

// The two Fiat-Shamir preimages exactly as documented (static 32-byte words), and the raw 256-bit keccak256 BEFORE the reduction mod l.
const keccakHex = (bytes: Uint8Array): string => hexOfBytes(keccak_256(bytes));
const schnorrPreimage = encodeWords([DKG_TAG, ...contextWords(TEST_CONTEXT), ceremonyId, 2n, 1n, K[0], K[1], R[0], R[1]]);
const decA = mul(G, decNonce);
const decB = mul(A, decNonce);
const decryptionPreimage = encodeWords([PDEC_TAG, ...contextWords(TEST_CONTEXT), decBinding.constituencyId, 1n, 3n, vk[0], vk[1], A[0], A[1], dec.D[0], dec.D[1], decA[0], decA[1], decB[0], decB[1]]);

const vectors = {
  description: "Known-answer vectors of the VoteChain V3 trustee toolkit. Fixed public test inputs, deterministic cores. Regenerate with `node scripts/make-vectors.ts` (`--check` detects drift); test/vectors.test.ts checks every value against the implementation and against an independent ethers recomputation.",
  fiatShamir: "challenge e = uint256(keccak256(preimage)) mod l, where the preimage is abi.encode of static 32-byte words (tag first); challengeHash is the keccak256 before the reduction",
  tags: { CEREMONY_TAG: hex32(CEREMONY_TAG), DKG_TAG: hex32(DKG_TAG), TRANSCRIPT_TAG: hex32(TRANSCRIPT_TAG), PDEC_TAG: hex32(PDEC_TAG) },
  subgroupOrder: SUBGROUP_ORDER.toString(10),
  context: contextToWire(TEST_CONTEXT),
  lagrangeAtZero: { "1,2": lagrangeCoefficientsAtZero([1, 2]).map(String), "1,3": lagrangeCoefficientsAtZero([1, 3]).map(String), "2,3": lagrangeCoefficientsAtZero([2, 3]).map(String) },
  ceremonyId: { transportKeys: [1, 2, 3].map((i) => hexOfBytes(keys.get(i) as Uint8Array)), ceremonyId: hex32(ceremonyId) },
  schnorr: { binding: { trusteeIndex: 2, coefficientIndex: 1, ceremonyId: hex32(ceremonyId) }, secret: hex32(pokSecret), nonce: hex32(pokNonce), commitment: pointToWire(K), nonceCommitment: pointToWire(R), preimage: hexOfBytes(schnorrPreimage), challengeHash: keccakHex(schnorrPreimage), challenge: hex32(pokChallenge(pokBinding, K, R)), proof: proofToWire(pokProof) },
  chaumPedersen: {
    binding: { constituencyId: hex32(decBinding.constituencyId), slot: 1, trusteeIndex: 3 },
    secretShare: hex32(decSecret),
    nonce: hex32(decNonce),
    verificationKey: pointToWire(vk),
    A: pointToWire(A),
    D: pointToWire(dec.D),
    preimage: hexOfBytes(decryptionPreimage),
    challengeHash: keccakHex(decryptionPreimage),
    challenge: hex32(decryptionChallenge(decBinding, vk, A, dec.D, decA, decB)),
    proof: proofToWire(dec.proof),
  },
  transcript: { object: transcript, canonicalJson: serializeTranscript(transcript), canonicalJsonSha256: "0x" + Buffer.from(sha256(utf8ToBytes(serializeTranscript(transcript)))).toString("hex") },
};
const fileArgument = process.argv.includes("--file") ? process.argv[process.argv.indexOf("--file") + 1] : undefined;
const out = fileArgument ? path.resolve(fileArgument) : path.join(path.dirname(new URL(import.meta.url).pathname), "..", "spec", "vectors.json");
const text = JSON.stringify(vectors, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (current !== text) {
    console.error(`DRIFT: ${path.relative(process.cwd(), out)} is not what the generator emits now; run \`node scripts/make-vectors.ts\` and review the diff`);
    process.exit(1);
  }
  console.log(`vectors are up to date (transcript hash ${transcript.transcriptHash})`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`written ${path.relative(process.cwd(), out)}; transcript hash ${transcript.transcriptHash}`);
}
