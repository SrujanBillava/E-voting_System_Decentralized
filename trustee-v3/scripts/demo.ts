// Standalone homomorphic election demo: dealer-less 2-of-3 key ceremony, A=7 / B=4 / C=2 encrypted one-hot ballots (privacy-v3 exponential ElGamal), the
// aggregate recomputed from the public ballot log, and threshold decryption by trustees 1+3, 1+2 and 2+3: all must give [7, 4, 2].
// Individual ballots are NEVER decrypted: only the aggregate is. Everything printed is PUBLIC (no share, coefficient, nonce or password ever is).
//
//   node scripts/demo.ts                      in-memory trustees
//   node scripts/demo.ts --store demo         also write each trustee's ENCRYPTED share to demo/trustee-N/share.json, then decrypt with trustees RELOADED from
//                                             those files. Needs TRUSTEE_V3_PASSWORD_1, _2 and _3 in the environment (>= 12 characters each; nothing is hard-coded)
//   --json                                    print one JSON object instead of the narrated output
//   --out <file>                              also write the public summary JSON to <file>
import fs from "node:fs";
import path from "node:path";
import { AggregateCiphertext, DEFAULT_PARAMS, KDF_MODERATE, TEST_CONTEXT, Trustee, buildTranscript, confirmCeremony, readShareFile, tallyAggregate, writeShareFile } from "../src/index.ts";
import type { Announcement, PartialDecryption } from "../src/index.ts";
import { clone } from "../testing/ceremony.ts";
import { encryptedBallot, pv3 } from "../testing/pv3.ts";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const json = flag("--json");
const storeDir = option("--store");
const outFile = option("--out");
const say = (line = ""): void => {
  if (!json) console.log(line);
};
const ms = (t0: number): number => Math.round(performance.now() - t0);

const COUNTS = [7, 4, 2];
const NAMES = ["Candidate A", "Candidate B", "Candidate C"];
const CONSTITUENCY = BigInt("0x" + Buffer.from("KA-BLR").toString("hex").padEnd(64, "0"));
const timings: Record<string, number> = {};

// ------------------------------------------------------------------------------------------------------------------------ 1. key ceremony
say("1. KEY CEREMONY: 3 trustees, threshold 2, no dealer (the full secret is never computed by anybody)");
let t0 = performance.now();
let trustees = [1, 2, 3].map((index) => new Trustee({ index, context: TEST_CONTEXT, params: DEFAULT_PARAMS }));
const announcements: Announcement[] = trustees.map((t) => clone(t.announce()));
say("   round 0  each trustee announced a fresh temporary X25519 transport public key");
const commitmentMessages = trustees.map((t) => clone(t.commit(clone(announcements))));
say("   round 1  each trustee published K_i0 = a_i0*G and K_i1 = a_i1*G with a Schnorr proof of knowledge of both coefficients");
const encryptedShares = trustees.flatMap((t) => t.deal(clone(commitmentMessages)).map(clone));
say(`   round 2  ${encryptedShares.length} encrypted shares f_i(j) sent (crypto_box, one per ordered pair of trustees)`);
trustees.forEach((t) => t.receive(clone(encryptedShares.filter((m) => m.to === t.index))));
say("   round 3  every trustee verified f_i(j)*G == K_i0 + j*K_i1 for every sender and computed s_j = sum_i f_i(j); s_j*G matches vk_j from the public data");
const transcript = buildTranscript({ context: TEST_CONTEXT, announcements, commitmentMessages });
const confirmations = trustees.map((t) => clone(t.finalize(clone(transcript))));
const verified = confirmCeremony(transcript, confirmations, { context: TEST_CONTEXT, params: DEFAULT_PARAMS });
timings.ceremonyMs = ms(t0);
say(`   done in ${timings.ceremonyMs} ms: every trustee independently confirmed the same transcript`);
say(`   election public key H.x = ${transcript.electionPublicKey[0]}`);
say(`   transcript hash       = ${transcript.transcriptHash}`);
transcript.verificationKeys.forEach((vk, i) => say(`   vk_${i + 1}.x               = ${vk[0]}`));
if (!pv3.elgamal.validatePublicKey([...verified.electionPublicKey])) throw new Error("privacy-v3 refuses the election key");
say("   privacy-v3 validatePublicKey(H): accepted (on the curve, prime-order subgroup, not the identity)");

// optional: persist each share encrypted, drop every Trustee object, reload from disk
let stored: { directory: string; mode: string }[] | undefined;
if (storeDir) {
  const passwords = [1, 2, 3].map((i) => process.env[`TRUSTEE_V3_PASSWORD_${i}`]);
  if (passwords.some((p) => !p || p.length < 12)) throw new Error("--store needs TRUSTEE_V3_PASSWORD_1, TRUSTEE_V3_PASSWORD_2 and TRUSTEE_V3_PASSWORD_3 (each at least 12 characters) in the environment");
  say();
  say(`   storing each trustee's share ENCRYPTED (Argon2id ${KDF_MODERATE.opslimit} passes / ${KDF_MODERATE.memlimit / 1048576} MiB + XChaCha20-Poly1305), one directory per trustee:`);
  t0 = performance.now();
  stored = trustees.map((t, i) => {
    const file = path.join(storeDir, `trustee-${t.index}`, "share.json");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    const { mode } = writeShareFile(file, t.exportEncryptedShare(passwords[i] as string));
    say(`     ${file}  mode ${mode.toString(8)}${mode === 0o600 ? "" : "   WARNING: this filesystem does not enforce owner-only permissions; the file is encrypted, but keep real shares on a filesystem that does"}`);
    return { directory: path.dirname(file), mode: mode.toString(8) };
  });
  trustees = [1, 2, 3].map((i) => Trustee.restore({ file: readShareFile(path.join(storeDir, `trustee-${i}`, "share.json")), password: passwords[i - 1] as string, transcript }));
  timings.storeAndReloadMs = ms(t0);
  say(`   all three trustees were dropped and RELOADED from their files (${timings.storeAndReloadMs} ms); decryption below uses the reloaded trustees`);
}

// ------------------------------------------------------------------------------------------------------------------------ 2. ballots
say();
say(`2. VOTING: ${COUNTS.reduce((a, b) => a + b, 0)} one-hot ballots encrypted under H (privacy-v3 exponential ElGamal): ${NAMES.map((n, i) => `${n} = ${COUNTS[i]}`).join(", ")}`);
t0 = performance.now();
const choices = COUNTS.flatMap((count, candidate) => Array.from({ length: count }, () => candidate));
for (let i = choices.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [choices[i], choices[j]] = [choices[j] as number, choices[i] as number]; // the order of ballots in the log reveals nothing about who voted for whom
}
const ballotLog = choices.map((choice) => encryptedBallot(verified.electionPublicKey, COUNTS.length, choice));
timings.encryptBallotsMs = ms(t0);
say(`   ${ballotLog.length} ciphertext sets generated in ${timings.encryptBallotsMs} ms; each ballot's choice is known only to its voter`);

// ------------------------------------------------------------------------------------------------------------------------ 3. aggregate
say();
say("3. AGGREGATION: A_c = sum of C1, B_c = sum of C2 over all ballots, recomputed from the PUBLIC ballot log (what VoteChainV3 keeps and emits)");
const aggregate = AggregateCiphertext.fromBallotLog({ context: TEST_CONTEXT, constituencyId: CONSTITUENCY, slotCount: COUNTS.length, ballots: ballotLog });
say(`   aggregate of ${aggregate.ballotCount} ballots over ${aggregate.slots.length} candidate slots; no individual ballot is decrypted by anything below`);

// ------------------------------------------------------------------------------------------------------------------------ 4. decryption
say();
say("4. THRESHOLD DECRYPTION of the aggregate (partial decryptions with Chaum-Pedersen proofs, combined by Lagrange interpolation, totals by baby-step giant-step)");
const partials = new Map<number, PartialDecryption>();
t0 = performance.now();
for (const t of trustees) partials.set(t.index, t.partialDecrypt(aggregate));
timings.partialDecryptionsMs = ms(t0);
const pairs: { trustees: number[]; totals: number[]; decryptedPoints: [string, string][]; tallyMs: number }[] = [];
for (const pair of [[1, 3], [1, 2], [2, 3]] as const) {
  t0 = performance.now();
  const result = tallyAggregate({ transcript: verified, aggregate, partials: pair.map((i) => partials.get(i) as PartialDecryption) });
  const tallyMs = ms(t0);
  pairs.push({ trustees: [...pair], totals: result.totals, decryptedPoints: result.decryptedPoints, tallyMs });
  say(`   trustees ${pair[0]}+${pair[1]}: both proofs verified, combined -> [${result.totals.join(", ")}]  (sum ${result.totals.reduce((a, b) => a + b, 0)} = ${result.ballotCount} ballots, ${tallyMs} ms)`);
}
const same = pairs.every((p) => JSON.stringify(p.totals) === JSON.stringify(COUNTS) && JSON.stringify(p.decryptedPoints) === JSON.stringify(pairs[0]?.decryptedPoints));
if (!same) throw new Error("the pairs disagree or do not recover the true counts");
say(`   all three pairs recovered ${JSON.stringify(COUNTS)} and decrypted to IDENTICAL group points`);
let alone = "refused";
try {
  tallyAggregate({ transcript: verified, aggregate, partials: [partials.get(1) as PartialDecryption] });
  alone = "NOT REFUSED";
} catch (error) {
  alone = (error as { code?: string }).code ?? "refused";
}
say(`   one trustee alone: ${alone}`);
if (alone === "NOT REFUSED") throw new Error("a single trustee must not be able to decrypt");

const summary = {
  context: { chainId: TEST_CONTEXT.chainId.toString(), contractAddress: "0x" + TEST_CONTEXT.contractAddress.toString(16), electionId: "0x" + TEST_CONTEXT.electionId.toString(16) },
  threshold: "2-of-3",
  transcriptHash: transcript.transcriptHash,
  electionPublicKey: transcript.electionPublicKey,
  verificationKeys: transcript.verificationKeys,
  ballotCount: aggregate.ballotCount,
  trueCounts: COUNTS,
  pairs,
  oneTrusteeAlone: alone,
  storedEncryptedShares: stored ?? null,
  timingsMs: timings,
};
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
}
if (json) console.log(JSON.stringify(summary));
else say("\nDEMO PASSED: [7, 4, 2] recovered by every trustee pair; no secret and no individual ballot was ever exposed.");
