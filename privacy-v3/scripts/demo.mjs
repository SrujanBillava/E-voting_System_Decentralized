// Deterministic-SCENARIO demo of the isolated Privacy V3 core: 5 fake Bengaluru voters, 3 of them vote (A, B, A), only the AGGREGATE is decrypted.
//   node scripts/demo.mjs     the voters, their votes and the outcome (A=2 B=1 C=0) are fixed; the TEST election key, the ballot randomness and
//                             the proofs are fresh from the operating system's CSPRNG on every run, exactly as in production code.
import { BallotBox } from "../src/ballotbox.js";
import { generateTestKeyPair } from "../src/elgamal.js";
import { TEST_CONTEXT, constituencyField, electionScope } from "../src/params.js";
import { makeGroup, nullifierOf, verifyMembership } from "../src/semaphore.js";
import { fakeVoter } from "../testing/fake-voters.js";
import { shutdownProver, verifyValidity } from "../src/validity.js";
import { validityPublicSignals } from "../src/ballot.js";
import { castBallot } from "../src/voter.js";

const short = (v, n = 14) => {
  const s = v.toString();
  return s.length > n + 2 ? `${s.slice(0, n)}…` : s;
};
const ms = (n) => `${Math.round(n)} ms`;
const hr = (title) => console.log(`\n=== ${title}`);

const ctx = TEST_CONTEXT;
const CONSTITUENCY = "KA-BLR"; // Bengaluru
const CANDIDATES = ["A", "B", "C"];
const kc = CANDIDATES.length;

hr("0. election setup (public)");
const { secret, publicKey: H } = generateTestKeyPair();
console.log(`election context   chainId=${ctx.chainId} contract=0x${ctx.contractAddress.toString(16)} electionId=${short(ctx.electionId)}`);
console.log(`election scope     ${short(electionScope(ctx))}   (ONE scope for the whole election)`);
console.log(`encryption key H   x=${short(H[0])} y=${short(H[1])}   (the matching secret is a TEST key held in memory; the real system uses threshold decryption)`);
console.log(`constituency       ${CONSTITUENCY}  id=${short(constituencyField(CONSTITUENCY))}  candidates=${CANDIDATES.join(", ")} (kc=${kc}, circuit K_MAX=16)`);

hr("1-3. identities, commitments, group (Semaphore V4)");
const voters = [1, 2, 3, 4, 5].map((n) => fakeVoter(`demo-bengaluru-${n}`));
voters.forEach((v, i) => console.log(`voter ${i + 1}  commitment=${short(v.commitment)}   (identity secret never leaves the voter)`));
const group = makeGroup(voters);
console.log(`group              members=${group.size} depth=${group.depth} root=${short(group.root)}`);
const box = new BallotBox({ ctx, publicKey: H, constituencies: { [CONSTITUENCY]: { kc, group } } });

const plan = [[0, "A"], [1, "B"], [2, "A"]]; // voter index, PRIVATE choice
let step = 0;
for (const [index, candidate] of plan) {
  step++;
  hr(`vote ${step}: voter ${index + 1} (choice stays on the voter's device)`);
  const choice = CANDIDATES.indexOf(candidate);
  const { submission, timings, internals } = await castBallot({ identity: voters[index], group, ctx, constituency: CONSTITUENCY, kc, choice, H });
  console.log(`[voter]  one-hot vector (PRIVATE)  [${internals.m.slice(0, kc).join(",")}] + ${16 - kc} padded zeros`);
  console.log(`[voter]  encrypted ${kc} slots, fresh randomness each; padded slots = canonical identity  (${ms(timings.encryptMs)})`);
  console.log(`[voter]  ballot hash (Semaphore message) ${short(internals.hash)}`);
  console.log(`[voter]  nullifier ${short(internals.nullifier)}  == poseidon(scope, secret)  (unlinkable to the commitment)`);
  console.log(`[voter]  Semaphore proof ${ms(timings.semaphoreProveMs)}, validity Groth16: witness ${ms(timings.validityWitnessMs)} + prove ${ms(timings.validityProveMs)}`);

  const wire = JSON.parse(JSON.stringify(submission));
  console.log(`[server] submission = ${JSON.stringify(wire).length} bytes of JSON: ${kc} ciphertexts + Semaphore proof + validity proof (no identity, no choice)`);
  const statement = validityPublicSignals({ ctx, constituencyId: internals.constituencyId, kc, H, nullifier: internals.nullifier, ciphertexts: internals.ciphertexts, hash: internals.hash });
  const t = performance.now();
  const sem = await verifyMembership(wire.semaphore);
  const val = await verifyValidity(wire.validity.proof, statement);
  console.log(`[server] Semaphore proof valid: ${sem} | validity proof valid: ${val} | same nullifier in both: ${statement[8] === wire.semaphore.nullifier} | Semaphore message == ballotHash: ${statement[0] === wire.semaphore.message}  (${ms(performance.now() - t)})`);
  const res = await box.submit(wire);
  console.log(`[server] ballot box: ${res.accepted ? `ACCEPTED as ballot #${res.ballotIndex}` : `REJECTED ${res.reason}`}`);
}

hr("a second ballot from voter 1 (same election => same nullifier)");
const again = await castBallot({ identity: voters[0], group, ctx, constituency: CONSTITUENCY, kc, choice: 2, H });
const dup = await box.submit(JSON.parse(JSON.stringify(again.submission)));
console.log(`[server] ballot box: ${dup.accepted ? "ACCEPTED (BUG!)" : `REJECTED ${dup.reason}`}`);

hr("homomorphic aggregation (public, needs no secret)");
const agg = box.aggregate(CONSTITUENCY);
agg.forEach((ct, j) => console.log(`candidate ${CANDIDATES[j]}  sum C1=(${short(ct.c1[0], 8)}, ${short(ct.c1[1], 8)})  sum C2=(${short(ct.c2[0], 8)}, ${short(ct.c2[1], 8)})`));
console.log(`ballots on the ledger: ${box.ledger.length}; no individual ballot was decrypted`);

hr("decrypting ONLY the aggregate with the TEST key");
const totals = box.decryptTotals(CONSTITUENCY, secret);
CANDIDATES.forEach((c, j) => console.log(`${c} = ${totals[j]}`));
const expected = [2n, 1n, 0n];
const ok = totals.every((t, j) => t === expected[j]);
console.log(ok ? "\nRESULT OK: A=2, B=1, C=0 (as voted), 5 members, 3 voted, 2 abstained" : "\nRESULT MISMATCH");
await shutdownProver();
process.exit(ok ? 0 : 1);
