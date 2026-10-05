// THE COMPLETE V3 ELECTION. Real VoteChainV3, real Semaphore depth-20 proofs, real Groth16 validity proofs, real identity-v3 and relay-v3 (separate processes, separate
// databases), the real kiosk engine, real trustees. One constituency, 3 candidates, 13 voters in three epoch cohorts: A = 7, B = 4, C = 2. Only the webcam is a stand-in.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createVoter } from "../../identity-v3/test/helpers/journey.js";
import { Group, Identity } from "../../kiosk-v3/src/crypto/privacy.ts";
import { assertReceiptSafe, KEYS } from "../../kiosk-v3/src/core/index.ts";
import { shutdownProver } from "../../privacy-v3/src/validity.js";
import { auditFromChain, endorseAuditedResult, publishPartialDecryption, readVerifiedFinalResult } from "../../trustee-v3/chain/index.ts";
import { nodeKiosk, testFace } from "../lib/node-kiosk.mjs";
import { findLeaks, storageText } from "../lib/scan.mjs";
import { CANDIDATES, ROOT, startStack } from "../lib/stack.mjs";

const identityUri = process.env.MONGODB_TEST_URI;
const relayUri = process.env.MONGODB_RELAY_TEST_URI;
const skip = identityUri && relayUri ? false : "set MONGODB_TEST_URI and MONGODB_RELAY_TEST_URI (disposable databases whose names contain 'test'; the relay's also 'relay')";

// A = 7, B = 4, C = 2, in a fixed pseudo-random order (so cohorts mix the choices)
const mulberry32 = (seed) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffled = (items) => {
  const random = mulberry32(20261005);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const CHOICES = shuffled([...Array(7).fill(0), ...Array(4).fill(1), ...Array(2).fill(2)]);
const COHORTS = [[0, 1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]];
const READ_ONLY_RPC = new Set(["eth_chainId", "eth_call", "eth_getLogs", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_blockNumber", "eth_getCode", "net_version", "eth_getBalance"]);

describe("the complete V3 election: 13 voters, [7, 4, 2], trustees, public result", { skip }, () => {
  let stack;
  const voters = [];
  const perf = { perVoter: [] };
  const identityHost = () => new URL(stack.origins.identity).host;
  const relayHost = () => new URL(stack.origins.relay).host;

  before(async () => {
    stack = await startStack({ identityUri, relayUri });
    // cohorts are chain-time epochs; keep "now" at the head block (15 minutes ahead of the wall clock) so a cohort can never straddle a wall-clock epoch boundary
    await stack.world.mineAt(Math.floor(Date.now() / 1000) + 900);
  });
  after(async () => {
    await shutdownProver();
    await stack?.stop();
  });

  it("each voter: identity (login, face, local Semaphore identity, commitment), epoch issuance, local group verification, local encryption and proofs, anonymous relay, chain confirmation, receipt", async () => {
    for (const cohort of COHORTS) {
      // ---- identity side, voter by voter
      for (const i of cohort) {
        const n = i + 1;
        const voter = await createVoter(stack.identityConfig, { n });
        const { kiosk, storage, fetch } = nodeKiosk(stack);
        const t0 = performance.now();
        await kiosk.login(voter.email, voter.password);
        const token = fetch.cookiesFor(identityHost())["vc3_voter"];
        assert.ok(token, "the identity session cookie exists while the identity session does");
        await kiosk.verifyFace(testFace(n));
        const began = await kiosk.beginCredential();
        assert.equal(began.constituency.code, "KA-BLR");
        const exported = JSON.parse(storage.getItem(KEYS.identity)).identity; // the PRIVATE identity: it lives in this tab's sessionStorage only
        const commitment = kiosk.session.getFlow().commitment;
        // what the identity service was sent about the anonymous identity: the commitment, nothing else
        const credentialRequests = fetch.log.filter((e) => e.host === identityHost() && e.method === "POST" && e.path.endsWith("/credential"));
        assert.deepEqual(credentialRequests.map((e) => JSON.parse(e.body)), [{ commitment }]);
        assert.ok(!credentialRequests[0].body.includes(exported));
        voters.push({ n, voter, kiosk, storage, fetch, choice: CHOICES[i], token, exported, commitment, identityMs: performance.now() - t0 });
      }
      // ---- the epoch closes: the cohort is inserted on-chain as ONE batch
      await stack.world.nextEpoch();
      // ---- each voter of the cohort continues, anonymously
      for (const i of cohort) {
        const v = voters[i];
        assert.equal(await v.kiosk.awaitCredential(), "ISSUED");
        assert.equal(v.kiosk.guard.locked, true, "anonymous mode: the identity client is locked for good");
        await assert.rejects(v.kiosk.identityApi.status(), (err) => err.code === "IDENTITY_LOCKED");
        assert.equal(v.fetch.cookiesFor(identityHost())["vc3_voter"], undefined, "the identity cookie is cleared");

        const open = await v.kiosk.openBallot();
        assert.equal(open.params.kc, 3);
        assert.deepEqual(open.params.candidates, CANDIDATES);
        assert.ok(open.verified.index >= 0 && open.verified.size >= cohort.length, "own commitment found in the rebuilt group, root == the contract's");
        const t1 = performance.now();
        const outcome = await v.kiosk.castVote({ choice: v.choice, open });
        const castMs = performance.now() - t1;
        assert.equal(outcome.kind, "RECORDED", `voter ${v.n}`);
        v.receipt = outcome.receipt;
        v.timings = v.kiosk.lastTimings;
        perf.perVoter.push({ voter: v.n, identityMs: Math.round(v.identityMs), groupSize: open.verified.size, ...Object.fromEntries(Object.entries(v.timings).map(([k, x]) => [k, Math.round(x)])), castToReceiptMs: Math.round(castMs) });
        // after the receipt: every voting secret is gone from this tab, only the public receipt remains
        assert.deepEqual(v.kiosk.session.keys(), [KEYS.receipt]);
      }
    }
    assert.equal(voters.length, 13);
  });

  it("every receipt is public recording data only and matches exactly one BallotRecorded event on the chain", async () => {
    assert.equal(Number(await stack.world.voteChain.totalBallots()), 13);
    const events = await stack.world.voteChain.queryFilter(stack.world.voteChain.filters.BallotRecorded());
    assert.equal(events.length, 13);
    const indexes = voters.map((v) => v.receipt.ballotIndex).sort((a, b) => a - b);
    assert.deepEqual(indexes, Array.from({ length: 13 }, (_, i) => i + 1));
    for (const v of voters) {
      const event = events.find((e) => Number(e.args.ballotIndex) === v.receipt.ballotIndex);
      assert.equal(event.transactionHash, v.receipt.txHash);
      assert.equal("0x" + BigInt(event.args.ballotHash).toString(16).padStart(64, "0"), v.receipt.ballotHash);
      assert.equal(event.blockNumber, v.receipt.blockNumber);
      const sent = JSON.parse(v.fetch.log.find((e) => e.host === relayHost() && e.method === "POST").body);
      assert.equal(event.args.nullifier.toString(), sent.membership.nullifier, "the event is the package this kiosk sent");
      assert.doesNotThrow(() => assertReceiptSafe(v.receipt, { nullifier: sent.membership.nullifier, commitment: v.commitment, root: sent.membership.merkleTreeRoot }));
      assert.deepEqual(Object.keys(v.receipt).sort(), ["ballotHash", "ballotIndex", "blockHash", "blockNumber", "blockTimestamp", "chainId", "constituency", "contract", "electionId", "statement", "txHash", "v"]);
      assert.match(v.receipt.statement, /does not prove which candidate was selected/);
    }
    const nullifiers = new Set(voters.map((v) => JSON.parse(v.fetch.log.find((e) => e.host === relayHost() && e.method === "POST").body).membership.nullifier));
    assert.equal(nullifiers.size, 13, "13 distinct nullifiers");
  });

  it("ORIGIN SEPARATION: relay and public-group requests carry no credentials and no cookie; after CREDENTIAL_ISSUED no request ever goes to the identity service again; the kiosk only READS the chain", async () => {
    for (const v of voters) {
      const log = v.fetch.log;
      const relayCalls = log.filter((e) => e.host === relayHost());
      assert.ok(relayCalls.length >= 2, "the public group and the ballot");
      for (const call of relayCalls) {
        assert.equal(call.credentials, "omit");
        assert.equal(call.cookieSent, false);
        assert.ok(!call.headers.includes("cookie") && !call.headers.includes("authorization"), call.headers.join());
        assert.deepEqual(call.headers.filter((h) => !["accept", "content-type", "origin"].includes(h)), []);
      }
      const identityCalls = log.filter((e) => e.host === identityHost());
      assert.ok(identityCalls.every((e) => e.credentials === "include"));
      const issuedAt = identityCalls.findLastIndex((e) => e.responseText.includes("CREDENTIAL_ISSUED"));
      assert.ok(issuedAt >= 0, "the issuance was delivered");
      assert.equal(log.indexOf(identityCalls[issuedAt]), log.findLastIndex((e) => e.host === identityHost()), "the issuance poll is the LAST identity request");
      assert.ok(log.indexOf(identityCalls[issuedAt]) < log.findIndex((e) => e.host === relayHost()), "and it precedes every anonymous request");
      assert.ok(!relayCalls.some((e) => (e.body ?? "").includes(v.voter.id) || (e.body ?? "").includes(v.voter.email)), "no voter identity in any anonymous request");
    }
    const methods = new Set(stack.rpc.methods);
    assert.ok(methods.size > 0);
    for (const m of methods) assert.ok(READ_ONLY_RPC.has(m), `the kiosk called ${m}`);
    for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTransaction", "eth_accounts", "eth_requestAccounts"]) assert.ok(!methods.has(m), m);
  });

  it("NO RESULT BEFORE FINALIZATION: with the election still open, and again after it closes, the public result is 'not finalized' and nothing of the count is read", async () => {
    const { kiosk } = nodeKiosk(stack);
    assert.deepEqual(await kiosk.results("KA-BLR"), { finalized: false });
    await (await stack.world.voteChain.closeIssuance()).wait();
    await stack.world.mineAt((await stack.world.clock.nowSeconds()) + stack.CLOSE_GRACE + 5);
    await (await stack.world.voteChain.closeElection()).wait();
    assert.deepEqual(await kiosk.results("KA-BLR"), { finalized: false });
    // a closed election: nobody can cast any more (the kiosk refuses at the pin, the contract at the call)
    const late = nodeKiosk(stack);
    await assert.rejects(late.chain.pinElection("KA-BLR"), (err) => err.code === "ELECTION_CLOSED");
  });

  it("trustees 1 + 3: the aggregate is rebuilt from the chain log, partial decryptions are published, the auditor verifies every proof and recovers [7, 4, 2]; both endorse; the constituency finalizes", async () => {
    const { world, ceremony, constituency } = stack;
    const asTrustee = (i) => world.voteChain.connect(world.trustees[i - 1]);
    for (const i of [1, 3]) await publishPartialDecryption({ contract: asTrustee(i), trustee: ceremony.trustees[i - 1], transcript: ceremony.transcript, constituencyId: constituency.id });
    const audit = await auditFromChain({ contract: world.voteChain, transcript: ceremony.transcript, constituencyId: constituency.id });
    assert.deepEqual(audit.totals, [7, 4, 2]);
    assert.deepEqual(audit.validTrustees, [1, 3]);
    assert.deepEqual(audit.invalid, []);
    assert.equal(audit.aggregate.aggregate.ballotCount, 13);
    const { kiosk } = nodeKiosk(stack);
    assert.deepEqual(await kiosk.results("KA-BLR"), { finalized: false }, "partial decryptions are not a result");
    assert.equal((await endorseAuditedResult({ contract: asTrustee(1), trusteeIndex: 1, transcript: ceremony.transcript, constituencyId: constituency.id })).finalized, false);
    assert.equal((await endorseAuditedResult({ contract: asTrustee(3), trusteeIndex: 3, transcript: ceremony.transcript, constituencyId: constituency.id })).finalized, true);
    const final = await readVerifiedFinalResult({ contract: world.voteChain, transcript: ceremony.transcript, constituencyId: constituency.id });
    assert.deepEqual(final.totals, [7, 4, 2]);
    assert.equal(final.ballotCount, 13);
  });

  it("the PUBLIC result page data (no login, no identity) shows exactly [7, 4, 2]", async () => {
    const { kiosk, fetch } = nodeKiosk(stack);
    const result = await kiosk.results("KA-BLR");
    assert.equal(result.finalized, true);
    assert.deepEqual(result.candidates, [{ name: "Candidate A", votes: 7 }, { name: "Candidate B", votes: 4 }, { name: "Candidate C", votes: 2 }]);
    assert.equal(result.ballotCount, 13);
    assert.equal(fetch.log.length, 0, "reading the result needs no service at all: public chain reads only");
    // and the totals are what the voters chose (the harness knows the choices)
    const expected = [0, 1, 2].map((c) => CHOICES.filter((x) => x === c).length);
    assert.deepEqual(result.candidates.map((c) => c.votes), expected);
  });

  it("PRIVACY-BOUNDARY SCANS: the identity side holds nothing of any ballot; the relayer holds nothing of any voter; no kiosk tab holds a voting secret; and the scanners are proven to catch planted leaks", async () => {
    const identityDb = await stack.dumpIdentityDb();
    const relayDb = await stack.dumpRelayDb();
    const { identity: identityLogs, relay: relayLogs } = stack.logs();
    const idTraffic = voters.flatMap((v) => v.fetch.log.filter((e) => e.host === identityHost())).map((e) => `${e.body ?? ""}\n${e.responseText}\n${e.responseHeaders}`).join("\n");
    const relayTraffic = voters.flatMap((v) => v.fetch.log.filter((e) => e.host === relayHost())).map((e) => `${e.responseText}\n${e.responseHeaders}`).join("\n");
    for (const [name, text] of [["identity database", identityDb], ["relay database", relayDb], ["identity logs", identityLogs], ["relay logs", relayLogs], ["identity traffic", idTraffic], ["relay traffic", relayTraffic]]) assert.ok(text.length > 500, `${name} was read (${text.length})`);

    // ---- what the IDENTITY side must never contain: anything of a ballot
    const sent = voters.map((v) => JSON.parse(v.fetch.log.find((e) => e.host === relayHost() && e.method === "POST").body));
    const ballotSecrets = sent.flatMap((p) => [p.membership.nullifier, ...p.coords, ...p.validity.a, ...p.validity.b.flat(), ...p.validity.c, ...p.membership.points]);
    ballotSecrets.push(...voters.flatMap((v) => [v.receipt.txHash, v.receipt.ballotHash]), ...CANDIDATES);
    assert.ok(ballotSecrets.length > 13 * 25);
    for (const [name, text] of [["identity database", identityDb], ["identity logs", identityLogs], ["identity traffic", idTraffic]]) assert.deepEqual(findLeaks(text, ballotSecrets), [], name);

    // ---- what the RELAYER must never contain: anything of a voter or of the identity side
    const issuance = JSON.parse(identityDb).credentialissuances_v3;
    assert.equal(issuance.length, 13);
    assert.ok(issuance.every((r) => r.state === "ISSUED" && Object.keys(r).sort().join() === "_id,electionId,state,voterId"), "the durable identity record is {electionId, voterId, state} only");
    const batches = JSON.parse(identityDb).commitmentbatches_v3;
    assert.ok(batches.length === 3 && batches.every((b) => b.state === "FINALIZED"), "three epoch cohorts");
    assert.deepEqual(batches.map((b) => b.count).sort(), [4, 4, 5]);
    // Commitments are PUBLIC group data: the relayer serves every one of them (that is its public group endpoint), so they legitimately appear in what it ANSWERED. What must not exist
    // is any voter IDENTITY next to anything, so identity values are scanned for everywhere; commitments are additionally scanned for at rest and in its logs (it keeps none).
    const identityValues = voters.flatMap((v) => [v.voter.id, String(v.voter.doc._id), v.voter.email, v.voter.doc.name, v.voter.doc.uid, v.token, v.exported]);
    identityValues.push(...issuance.map((r) => r._id), ...batches.map((b) => b._id));
    for (const [name, text] of [["relay database", relayDb], ["relay logs", relayLogs], ["relay traffic", relayTraffic]]) assert.deepEqual(findLeaks(text, identityValues), [], name);
    const commitments = voters.map((v) => v.commitment);
    for (const [name, text] of [["relay database", relayDb], ["relay logs", relayLogs]]) assert.deepEqual(findLeaks(text, commitments), [], `${name}: no commitment at rest`);
    assert.ok(findLeaks(relayTraffic, commitments).length === 13, "the public group answer lists the 13 commitments, and nothing else about anybody");
    const descriptors = voters.map((v) => JSON.stringify(v.fetch.log.filter((e) => e.path.endsWith("/face/verify")).map((e) => JSON.parse(e.body).descriptor)[0]));
    for (const [name, text] of [["relay database", relayDb], ["relay logs", relayLogs], ["relay traffic", relayTraffic]]) assert.deepEqual(findLeaks(text, descriptors), [], `${name}: no biometric`);
    // the relay stores every ballot (13 CONFIRMED), and it stores NO commitment and no identity: nothing links a stored ballot to a voter
    const relayRows = JSON.parse(relayDb).anonymous_submissions;
    assert.equal(relayRows.length, 13);
    assert.ok(relayRows.every((r) => r.state === "CONFIRMED" && r.rawTx === null));

    // ---- the kiosk tabs after completion: only the public receipt remains
    for (const v of voters) {
      const text = storageText(v.storage);
      assert.deepEqual(v.kiosk.session.keys(), [KEYS.receipt]);
      assert.deepEqual(findLeaks(text, [v.exported, v.commitment, ...sent[voters.indexOf(v)].coords, sent[voters.indexOf(v)].membership.nullifier, ...v.fetch.log.filter((e) => e.path.endsWith("/face/verify")).map((e) => JSON.stringify(JSON.parse(e.body).descriptor))]), [], `kiosk ${v.n}`);
      assert.ok(!/choice|oneHot|one-hot|randomness|"m":/i.test(text), "no plaintext selection, one-hot vector or randomness field");
      assert.equal(v.storage.getItem(KEYS.ballot), null);
      assert.equal(v.storage.getItem(KEYS.identity), null);
    }

    // ---- CONTROLS: the scanners are not blind. A planted forbidden value is caught on every side.
    const plantedNullifier = sent[0].membership.nullifier;
    assert.deepEqual(findLeaks(identityDb + `{"planted":"${plantedNullifier}"}`, [plantedNullifier]), [plantedNullifier], "identity database");
    assert.deepEqual(findLeaks(identityLogs + `\nserved ${sent[0].coords[0]}`, [sent[0].coords[0]]), [sent[0].coords[0]], "identity logs");
    assert.deepEqual(findLeaks(relayDb + `{"planted":"${voters[0].voter.email}"}`, [voters[0].voter.email]), [voters[0].voter.email], "relay database");
    assert.deepEqual(findLeaks(relayLogs + `\nuser ${voters[0].voter.id}`, [voters[0].voter.id]), [voters[0].voter.id], "relay logs");
    const dirty = voters[0].storage.dump();
    dirty["vc3.oops"] = voters[0].exported;
    assert.deepEqual(findLeaks(JSON.stringify(dirty), [voters[0].exported]), [voters[0].exported], "kiosk storage");
  });

  it("performance (this machine, Node, 20 threads): recorded for the report", async () => {
    const t = performance.now();
    const id = new Identity();
    const identityMs = performance.now() - t;
    const groupMs = {};
    const leaves = Array.from({ length: 5000 }, (_, i) => BigInt(i + 1) * 982451653n);
    for (const size of [13, 128, 1000, 5000]) {
      const g0 = performance.now();
      const g = new Group(leaves.slice(0, size));
      void g.root;
      groupMs[size] = Math.round(performance.now() - g0);
    }
    const mean = (key) => Math.round(perf.perVoter.reduce((s, v) => s + v[key], 0) / perf.perVoter.length);
    const summary = { machine: "development machine, Node 24, snarkjs worker threads", semaphoreIdentityMs: Math.round(identityMs), groupRebuildMs: groupMs, meanOverVoters: { encryptMs: mean("encryptMs"), validityWitnessMs: mean("validityWitnessMs"), validityProveMs: mean("validityProveMs"), semaphoreProveMs: mean("semaphoreProveMs"), preparationMs: mean("totalMs"), castToReceiptMs: mean("castToReceiptMs") }, perVoter: perf.perVoter };
    fs.mkdirSync(path.join(ROOT, "e2e-v3", "results"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "e2e-v3", "results", "performance-node.json"), JSON.stringify(summary, null, 2) + "\n");
    assert.ok(id.commitment > 0n);
  });
});
