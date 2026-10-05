// Generates spec/integration-vectors.json: known-answer vectors for the two encodings shared with VoteChainV3: the partial-decryption bundle hash and the results hash.
// Fixed public inputs only (no secret, no randomness). test/tally-encodings.test.ts checks every value against this implementation AND an independent ethers
// recomputation; smart-contract-v3/test/trustees.test.js checks the same file against the Solidity library, so JS and Solidity are pinned to the same bytes.
//   node scripts/make-integration-vectors.ts            regenerate
//   node scripts/make-integration-vectors.ts --check    exit 1 on drift (writes nothing);  --file <path> uses another file
import fs from "node:fs";
import path from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { padBundle, bundleHash } from "../src/bundle.ts";
import { contextToWire } from "../src/context.ts";
import { encodeWords, hex32, hexOfBytes } from "../src/encoding.ts";
import { PDEC_BUNDLE_TAG, RESULTS_TAG, TEST_CONTEXT } from "../src/params.ts";
import { padTotals, resultsHash } from "../src/results.ts";

const word = (label: string): bigint => BigInt("0x" + Buffer.from(keccak_256(utf8ToBytes(label))).toString("hex"));
const wordList = (label: string, count: number): bigint[] => Array.from({ length: count }, (_, i) => word(`${label}/${i}`));

const bundleCases = [
  { name: "kc=3 trustee 2 (13 ballots)", trusteeIndex: 2, constituency: "KA-BLR", ballotCount: 13, candidateCount: 3 },
  { name: "kc=1 trustee 1 (a single ballot)", trusteeIndex: 1, constituency: "TN-CHE", ballotCount: 1, candidateCount: 1 },
  { name: "kc=16 trustee 3 (a million ballots)", trusteeIndex: 3, constituency: "MH-MUM", ballotCount: 1_000_000, candidateCount: 16 },
];
const transcriptHash = word("votechain-v3 integration vector transcript");

const bundles = bundleCases.map((c) => {
  const active = wordList(`bundle ${c.name}`, 4 * c.candidateCount);
  const words = padBundle(active, c.candidateCount);
  const header = { context: TEST_CONTEXT, transcriptHash, trusteeIndex: c.trusteeIndex, constituencyId: word(c.constituency), ballotCount: c.ballotCount, candidateCount: c.candidateCount };
  const preimage = encodeWords([PDEC_BUNDLE_TAG, TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, transcriptHash, BigInt(c.trusteeIndex), header.constituencyId, BigInt(c.ballotCount), BigInt(c.candidateCount), ...words]);
  return {
    name: c.name,
    trusteeIndex: c.trusteeIndex,
    constituencyId: hex32(header.constituencyId),
    ballotCount: c.ballotCount,
    candidateCount: c.candidateCount,
    words: words.map(hex32),
    preimageBytes: preimage.length,
    bundleHash: hex32(bundleHash(header, words)),
    keccakOfPreimage: hexOfBytes(keccak_256(preimage)),
  };
});

const resultCases = [
  { name: "kc=3 [7,4,2] (13 ballots)", constituency: "KA-BLR", totals: [7, 4, 2] },
  { name: "kc=1 a single ballot", constituency: "TN-CHE", totals: [1] },
  { name: "kc=16 (1,048,576 ballots, the depth-20 maximum)", constituency: "MH-MUM", totals: [524288, 262144, 131072, 65536, 32768, 16384, 8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 32] },
  { name: "kc=2 an empty constituency", constituency: "C02", totals: [0, 0] },
];
const results = resultCases.map((c) => {
  const ballotCount = c.totals.reduce((a, b) => a + b, 0);
  const totals = padTotals(c.totals, c.totals.length);
  const header = { context: TEST_CONTEXT, transcriptHash, constituencyId: word(c.constituency), ballotCount, candidateCount: c.totals.length };
  const preimage = encodeWords([RESULTS_TAG, TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, transcriptHash, header.constituencyId, BigInt(ballotCount), BigInt(c.totals.length), ...totals]);
  return {
    name: c.name,
    constituencyId: hex32(header.constituencyId),
    ballotCount,
    candidateCount: c.totals.length,
    totals: totals.map(hex32),
    preimageBytes: preimage.length,
    resultsHash: hex32(resultsHash(header, totals)),
    keccakOfPreimage: hexOfBytes(keccak_256(preimage)),
  };
});

const vectors = {
  description:
    "Known-answer vectors of the trustee tally encodings shared by trustee-v3 and VoteChainV3. Fixed public inputs. Regenerate with `node scripts/make-integration-vectors.ts` (`--check` detects drift).",
  encodings: {
    partialBundleHash: "keccak256(abi.encode(PDEC_BUNDLE_TAG, chainId, contractAddress, electionId, transcriptHash, trusteeIndex, constituencyId, ballotCount, candidateCount, uint256[64] words)); words = D.x, D.y, e, z per active slot, four zero words per padded slot",
    resultsHash: "keccak256(abi.encode(RESULTS_TAG, chainId, contractAddress, electionId, transcriptHash, constituencyId, ballotCount, candidateCount, uint256[16] totals)); totals zero in padded slots",
  },
  tags: { PDEC_BUNDLE_TAG: hex32(PDEC_BUNDLE_TAG), RESULTS_TAG: hex32(RESULTS_TAG) },
  context: contextToWire(TEST_CONTEXT),
  transcriptHash: hex32(transcriptHash),
  bundles,
  results,
};

const fileArgument = process.argv.includes("--file") ? process.argv[process.argv.indexOf("--file") + 1] : undefined;
const out = fileArgument ? path.resolve(fileArgument) : path.join(path.dirname(new URL(import.meta.url).pathname), "..", "spec", "integration-vectors.json");
const text = JSON.stringify(vectors, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (current !== text) {
    console.error(`DRIFT: ${path.relative(process.cwd(), out)} is not what the generator emits now; run \`node scripts/make-integration-vectors.ts\` and review the diff`);
    process.exit(1);
  }
  console.log("integration vectors are up to date");
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`written ${path.relative(process.cwd(), out)}`);
}
