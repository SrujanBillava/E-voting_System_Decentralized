// THE COMPLETE V3 ELECTION, EVERY VOTER IN A REAL BROWSER. 13 voters, one constituency, 3 candidates, three epoch cohorts: A = 7, B = 4, C = 2. Real Chrome, the production kiosk UI
// under its strict CSP, real in-browser Groth16 + Semaphore proofs, the real identity-v3 and relay-v3 (separate processes, separate databases), the real contract, the real trustees,
// and the public result page. Only the webcam is a stand-in (Chrome's fake device + the test face engine of the TEST build).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { createVoter } from "../../identity-v3/test/helpers/journey.js";
import { freePort } from "../../identity-v3/test/helpers/node.js";
import { shutdownProver } from "../../privacy-v3/src/validity.js";
import { auditFromChain, endorseAuditedResult, publishPartialDecryption, readVerifiedFinalResult } from "../../trustee-v3/chain/index.ts";
import { buildKiosk, castChoice, faceDescriptor, localDump, login, newVoterContext, receiptOf, serveKiosk, sessionDump, streamsEnded, toCredentialWait, traceOf, writesOf, launchChrome } from "../lib/browser.mjs";
import { findLeaks } from "../lib/scan.mjs";
import { CANDIDATES, ROOT, startStack } from "../lib/stack.mjs";

const identityUri = process.env.MONGODB_TEST_URI;
const relayUri = process.env.MONGODB_RELAY_TEST_URI;
const skip = identityUri && relayUri ? false : "set MONGODB_TEST_URI and MONGODB_RELAY_TEST_URI (disposable databases whose names contain 'test'; the relay's also 'relay')";

const READ_ONLY_RPC = new Set(["eth_chainId", "eth_call", "eth_getLogs", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_blockNumber", "eth_getCode", "net_version", "eth_getBalance"]);
/** the browser has no wallet and no key: every JSON-RPC method it ever used (the proxy in front of the node records them all) is a READ */
const assertReadOnly = (stack) => {
  const methods = new Set(stack.rpc.methods);
  assert.ok(methods.size > 0, "the kiosk did use the node");
  for (const m of methods) assert.ok(READ_ONLY_RPC.has(m), `the browser called ${m}`);
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign", "eth_signTransaction", "eth_accounts", "eth_requestAccounts"]) assert.ok(!methods.has(m), m);
};
// A = 7, B = 4, C = 2 in a fixed pseudo-random order (same as the Node-engine election), so cohorts mix the choices
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

describe("the complete V3 election in real browsers: 13 voters, [7, 4, 2], trustees, public result page", { skip }, () => {
  let stack, server, browser;
  const voters = [];
  const idHost = () => new URL(stack.origins.identity).host;
  const relayHost = () => new URL(stack.origins.relay).host;
  const rpcHost = () => new URL(stack.kioskConfig.rpcUrl).host;
  const relayPost = (v) => v.traffic.find((e) => e.host === relayHost() && e.method === "POST");

  before(async () => {
    const kioskPort = await freePort();
    stack = await startStack({ identityUri, relayUri, hostnames: true, kioskPort });
    // Cohorts are defined by CHAIN-TIME epochs of 30 s, and the identity service reads "now" as the later of its own clock and the head block. A browser voter takes seconds, so a cohort
    // could straddle a wall-clock epoch boundary and be batched in two (correct behaviour, but a non-deterministic test). Put the chain 15 minutes ahead of the wall clock once: from then on
    // "now" is the head block's timestamp, which only moves when a block is mined, and the test decides when an epoch ends (nextEpoch).
    await stack.world.mineAt(Math.floor(Date.now() / 1000) + 900);
    server = await serveKiosk({ dir: buildKiosk(stack, { outDir: "dist-e2e", e2eFace: true }), port: kioskPort });
    browser = await launchChrome();
  });
  after(async () => {
    await browser?.close();
    server?.stop();
    await shutdownProver();
    await stack?.stop();
  });

  it("PUBLIC RESULT PAGE while the election is open: 'Result not finalized', nothing else", async () => {
    const v = await newVoterContext(browser, stack, {});
    const page = await v.context.newPage();
    await page.goto(stack.origins.kiosk + "/#/results");
    await page.getByRole("heading", { name: "Bengaluru South" }).waitFor();
    await page.getByText("Result not finalized").waitFor();
    assert.ok(!/Votes|Ballots counted/.test(await page.locator("main").innerText()));
    await v.context.close();
  });

  it("each voter, in their own browser: login, face, local Semaphore identity, commitment, epoch issuance, public-group verification, local encryption + proofs, anonymous relay, chain confirmation, receipt", async () => {
    for (const cohort of COHORTS) {
      const live = [];
      // ---- identity side, voter by voter, in their own browser context (own cookies, own sessionStorage)
      for (const i of cohort) {
        const n = i + 1;
        const voter = await createVoter(stack.identityConfig, { n });
        const v = await newVoterContext(browser, stack, { descriptor: faceDescriptor(n) });
        const page = await v.context.newPage();
        const t0 = performance.now();
        await toCredentialWait(page, stack, voter);
        const cookies = await v.context.cookies();
        assert.equal(cookies.length, 1);
        assert.equal(cookies[0].name, "vc3_voter");
        const session = await sessionDump(page);
        live.push({ n, voter, v, page, choice: CHOICES[i], token: cookies[0].value, exported: JSON.parse(session["vc3.identity"]).identity, commitment: JSON.parse(session["vc3.flow"]).commitment, identityMs: performance.now() - t0 });
      }
      // ---- the epoch closes: the cohort enters the group as ONE batch
      await stack.world.nextEpoch();
      // ---- each voter continues, anonymously
      for (const r of live) {
        const t1 = performance.now();
        await castChoice(r.page, CANDIDATES[r.choice]);
        r.castMs = performance.now() - t1;
        r.receipt = await receiptOf(r.page);
        await r.v.settled();
        r.traffic = r.v.traffic;
        r.writes = await writesOf(r.page);
        r.sessionAfter = await sessionDump(r.page);
        r.cookiesAfter = await r.v.context.cookies();
        r.local = await localDump(r.page);
        r.streams = await streamsEnded(r.page);
        r.trace = await traceOf(r.page);
        r.consoleLines = r.v.consoleLines;
        r.pageErrors = r.v.pageErrors;
        r.sent = JSON.parse(relayPost(r).body);
        await r.v.context.close(); // a finished kiosk tab is gone
        voters.push(r);
      }
    }
    assert.equal(voters.length, 13);
  });

  it("every receipt is public recording data only and matches exactly one BallotRecorded event on the chain", async () => {
    assert.equal(Number(await stack.world.voteChain.totalBallots()), 13);
    const events = await stack.world.voteChain.queryFilter(stack.world.voteChain.filters.BallotRecorded());
    assert.equal(events.length, 13);
    assert.deepEqual(voters.map((v) => Number(v.receipt.rows["Ballot number"])).sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => i + 1));
    for (const v of voters) {
      const event = events.find((e) => Number(e.args.ballotIndex) === Number(v.receipt.rows["Ballot number"]));
      assert.equal(event.transactionHash, v.receipt.rows.Transaction);
      assert.equal("0x" + BigInt(event.args.ballotHash).toString(16).padStart(64, "0"), v.receipt.rows["Ballot hash"]);
      assert.equal(String(event.blockNumber), v.receipt.rows["Block number"]);
      assert.equal(event.args.nullifier.toString(), v.sent.membership.nullifier, "the event is the package this browser sent");
      assert.deepEqual(Object.keys(v.receipt.rows), ["Election", "Chain ID", "Contract", "Constituency", "Ballot number", "Ballot hash", "Transaction", "Block number", "Block hash", "Block time (UTC)"]);
      assert.equal(v.receipt.statement, "This receipt proves that an encrypted ballot was recorded. It does not prove which candidate was selected.");
      const text = JSON.stringify(v.receipt).toLowerCase();
      for (const secret of [v.sent.membership.nullifier, v.commitment, v.sent.membership.merkleTreeRoot, v.exported, v.voter.email, v.voter.id]) assert.ok(!text.includes(String(secret).toLowerCase()), "the receipt has no identity, commitment, nullifier or root");
    }
    assert.equal(new Set(voters.map((v) => v.sent.membership.nullifier)).size, 13);
  });

  it("ORIGIN SEPARATION, per browser: a cookie goes only to the identity origin; relay and RPC requests carry no cookie / authorization / referrer; the last identity request is the credential delivery; the camera stopped; four origins and no other", async () => {
    for (const v of voters) {
      const http = v.traffic.filter((e) => /^https?:/.test(e.url));
      assert.deepEqual([...new Set(http.map((e) => e.host))].sort(), [new URL(stack.origins.kiosk).host, idHost(), relayHost(), rpcHost()].sort(), `voter ${v.n}`);
      assert.ok(http.filter((e) => "cookie" in e.headers).every((e) => e.host === idHost()), `voter ${v.n}: cookie only to identity`);
      for (const e of http.filter((x) => x.host === relayHost() || x.host === rpcHost())) assert.ok(!("cookie" in e.headers) && !("authorization" in e.headers) && !("referer" in e.headers), `voter ${v.n} ${e.method} ${e.path}`);
      const idReqs = http.filter((e) => e.host === idHost());
      const last = idReqs.at(-1);
      assert.equal(`${last.method} ${last.path}`, "GET /api/v3/voter/credential");
      assert.ok(last.responseText.includes("CREDENTIAL_ISSUED"));
      assert.ok(v.traffic.indexOf(last) < v.traffic.indexOf(v.traffic.find((e) => e.host === relayHost())), "and it precedes every anonymous request");
      assert.deepEqual(v.cookiesAfter, [], "no cookie remains");
      assert.deepEqual(v.streams, { opened: 1, live: 0 });
      assert.ok(!v.traffic.some((e) => e.host === relayHost() && ((e.body ?? "").includes(v.voter.id) || (e.body ?? "").includes(v.voter.email))));
      assert.deepEqual(v.pageErrors, []);
      assert.deepEqual(findLeaks(v.consoleLines.join("\n"), [v.exported, v.voter.password, v.voter.email, v.voter.id, v.commitment, v.sent.membership.nullifier, ...v.sent.coords]), [], "nothing secret in the console");
    }
    assertReadOnly(stack);
  });

  it("NO RESULT BEFORE FINALIZATION, in the browser: after the election closes the page still says 'Result not finalized'; a late voter is refused at sign-in", async () => {
    const v = await newVoterContext(browser, stack, {});
    const page = await v.context.newPage();
    await (await stack.world.voteChain.closeIssuance()).wait();
    await stack.world.mineAt((await stack.world.clock.nowSeconds()) + stack.CLOSE_GRACE + 5);
    await (await stack.world.voteChain.closeElection()).wait();
    await page.goto(stack.origins.kiosk + "/#/results");
    await page.getByText("Result not finalized").waitFor();
    // a voter who was never issued a credential cannot start any more
    const late = await createVoter(stack.identityConfig, { n: 99 });
    await page.goto(stack.origins.kiosk + "/");
    await page.getByLabel("Voter ID or email").fill(late.email);
    await page.getByLabel("Password").fill(late.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText(/closed/i).first().waitFor({ timeout: 30_000 });
    assert.equal(await page.getByRole("heading", { name: "Sign in to vote" }).isVisible(), true, "the late voter stays at the sign-in");
    await v.context.close();
  });

  it("trustees 1 + 3: the aggregate is rebuilt from the chain log, partial decryptions are published and audited ([7, 4, 2]), both endorse and the constituency finalizes; the page says 'not finalized' until the very last endorsement", async () => {
    const { world, ceremony, constituency } = stack;
    const asTrustee = (i) => world.voteChain.connect(world.trustees[i - 1]);
    const v = await newVoterContext(browser, stack, {});
    const page = await v.context.newPage();
    const notFinalized = async () => {
      await page.goto(stack.origins.kiosk + "/#/results");
      await page.reload();
      await page.getByRole("heading", { name: "Bengaluru South" }).waitFor();
      return page.getByText("Result not finalized").isVisible();
    };
    for (const i of [1, 3]) await publishPartialDecryption({ contract: asTrustee(i), trustee: ceremony.trustees[i - 1], transcript: ceremony.transcript, constituencyId: constituency.id });
    const audit = await auditFromChain({ contract: world.voteChain, transcript: ceremony.transcript, constituencyId: constituency.id });
    assert.deepEqual(audit.totals, [7, 4, 2]);
    assert.deepEqual(audit.validTrustees, [1, 3]);
    assert.deepEqual(audit.invalid, []);
    assert.equal(audit.aggregate.aggregate.ballotCount, 13);
    assert.equal(await notFinalized(), true, "partial decryptions are not a result");
    assert.equal((await endorseAuditedResult({ contract: asTrustee(1), trusteeIndex: 1, transcript: ceremony.transcript, constituencyId: constituency.id })).finalized, false);
    assert.equal(await notFinalized(), true, "one endorsement is not a result");
    assert.equal((await endorseAuditedResult({ contract: asTrustee(3), trusteeIndex: 3, transcript: ceremony.transcript, constituencyId: constituency.id })).finalized, true);
    const final = await readVerifiedFinalResult({ contract: world.voteChain, transcript: ceremony.transcript, constituencyId: constituency.id });
    assert.deepEqual(final.totals, [7, 4, 2]);
    await v.context.close();
  });

  it("the PUBLIC RESULT PAGE (no sign-in, no identity service, no relay) shows exactly [7, 4, 2] with the contract's own fingerprint, is accessible, and fits a phone", async () => {
    const v = await newVoterContext(browser, stack, {});
    const page = await v.context.newPage();
    await page.goto(stack.origins.kiosk + "/#/results");
    await page.getByRole("table").waitFor();
    const rows = await page.locator("table.tally tbody tr").evaluateAll((trs) => trs.map((tr) => [tr.querySelector("th")?.textContent, Number(tr.querySelector("td")?.textContent)]));
    assert.deepEqual(rows, [["Candidate A", 7], ["Candidate B", 4], ["Candidate C", 2]]);
    const expected = [0, 1, 2].map((c) => CHOICES.filter((x) => x === c).length);
    assert.deepEqual(rows.map((r) => r[1]), expected, "and these are what the 13 voters chose");
    const onChain = await stack.world.voteChain.finalResult(stack.constituency.id);
    assert.ok((await page.locator("main").innerText()).includes(`Ballots counted: ${Number(onChain.ballotCount)}`));
    assert.ok((await page.locator(".mono").first().innerText()).toLowerCase() === String(onChain.resultsHash).toLowerCase(), "the page shows the contract's result fingerprint");
    assert.equal(await page.getByText("Result not finalized").count(), 0);
    await v.settled();
    assert.equal(v.traffic.filter((e) => e.host === idHost() || e.host === relayHost()).length, 0, "no identity or relay request: public chain reads only");
    assert.ok(v.traffic.every((e) => !("cookie" in e.headers)));
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
    assert.deepEqual(axe.violations.map((x) => `${x.id} ${x.nodes.map((n) => n.target.join(" "))}`), []);
    for (const hash of ["#/results", ""]) {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(stack.origins.kiosk + "/" + hash);
      await page.reload();
      await page.getByRole("heading", { level: 1 }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no horizontal scroll on a 375 px phone (${hash || "voter"})`);
    }
    await v.context.close();
  });

  it("PRIVACY-BOUNDARY SCANS: the identity side holds nothing of any ballot; the relayer holds nothing of any voter; no kiosk tab holds a voting secret; and the scanners are proven to catch planted leaks", async () => {
    const identityDb = await stack.dumpIdentityDb();
    const relayDb = await stack.dumpRelayDb();
    const { identity: identityLogs, relay: relayLogs } = stack.logs();
    const traffic = (v, host) => v.traffic.filter((e) => e.host === host);
    const idTraffic = voters.flatMap((v) => traffic(v, idHost())).map((e) => `${e.body ?? ""}\n${e.responseText}\n${JSON.stringify(e.responseHeaders)}`).join("\n");
    const relayTraffic = voters.flatMap((v) => traffic(v, relayHost())).map((e) => `${e.responseText}\n${JSON.stringify(e.responseHeaders)}`).join("\n");
    for (const [name, text] of [["identity database", identityDb], ["relay database", relayDb], ["identity logs", identityLogs], ["relay logs", relayLogs], ["identity traffic", idTraffic], ["relay traffic", relayTraffic]]) assert.ok(text.length > 500, `${name} was read (${text.length})`);

    // ---- the IDENTITY side never contains anything of a ballot
    const ballotSecrets = voters.flatMap((v) => [v.sent.membership.nullifier, ...v.sent.coords, ...v.sent.validity.a, ...v.sent.validity.b.flat(), ...v.sent.validity.c, ...v.sent.membership.points, v.receipt.rows.Transaction, v.receipt.rows["Ballot hash"]]);
    ballotSecrets.push(...CANDIDATES);
    assert.ok(ballotSecrets.length > 13 * 25);
    for (const [name, text] of [["identity database", identityDb], ["identity logs", identityLogs], ["identity traffic", idTraffic]]) assert.deepEqual(findLeaks(text, ballotSecrets), [], name);

    // ---- the RELAYER never contains anything of a voter
    const issuance = JSON.parse(identityDb).credentialissuances_v3;
    assert.equal(issuance.length, 13);
    assert.ok(issuance.every((r) => r.state === "ISSUED" && Object.keys(r).sort().join() === "_id,electionId,state,voterId"), "the durable identity record is {electionId, voterId, state} only");
    const batches = JSON.parse(identityDb).commitmentbatches_v3;
    assert.ok(batches.length === 3 && batches.every((b) => b.state === "FINALIZED"));
    assert.deepEqual(batches.map((b) => b.count).sort(), [4, 4, 5]);
    const identityValues = voters.flatMap((v) => [v.voter.id, String(v.voter.doc._id), v.voter.email, v.voter.doc.name, v.voter.doc.uid, v.token, v.exported]);
    identityValues.push(...issuance.map((r) => r._id), ...batches.map((b) => b._id));
    for (const [name, text] of [["relay database", relayDb], ["relay logs", relayLogs], ["relay traffic", relayTraffic]]) assert.deepEqual(findLeaks(text, identityValues), [], name);
    const commitments = voters.map((v) => v.commitment);
    for (const [name, text] of [["relay database", relayDb], ["relay logs", relayLogs]]) assert.deepEqual(findLeaks(text, commitments), [], `${name}: no commitment at rest`);
    assert.ok(findLeaks(relayTraffic, commitments).length === 13, "the public group answer lists the 13 commitments and nothing else about anybody");
    const descriptors = voters.map((v) => JSON.stringify(JSON.parse(v.traffic.find((e) => e.path.endsWith("/face/verify")).body).descriptor));
    for (const [name, text] of [["relay database", relayDb], ["relay logs", relayLogs], ["relay traffic", relayTraffic]]) assert.deepEqual(findLeaks(text, descriptors), [], `${name}: no biometric`);
    const relayRows = JSON.parse(relayDb).anonymous_submissions;
    assert.equal(relayRows.length, 13);
    assert.ok(relayRows.every((r) => r.state === "CONFIRMED" && r.rawTx === null));

    // ---- every browser tab after completion: only the public receipt remains, and nothing was ever written elsewhere
    for (const v of voters) {
      assert.deepEqual(Object.keys(v.sessionAfter), ["vc3.receipt"]);
      assert.deepEqual(v.local, { local: {}, indexedDb: [], cookie: "" });
      assert.ok(v.writes.every((w) => w.area === "session" && ["vc3.identity", "vc3.flow", "vc3.ballot", "vc3.receipt"].includes(w.key)), `voter ${v.n}: only the documented keys were written`);
      const ballotKeys = v.writes.filter((w) => w.key === "vc3.ballot").flatMap((w) => Object.keys(JSON.parse(w.value)));
      assert.ok(!/choice|oneHot|one-hot|randomness|plaintext|^m$|^r$/i.test(ballotKeys.join()), "no plaintext selection, one-hot vector or randomness field in the stored package");
      assert.deepEqual(findLeaks(JSON.stringify(v.sessionAfter), [v.exported, v.commitment, v.sent.membership.nullifier, ...v.sent.coords, JSON.stringify(JSON.parse(v.traffic.find((e) => e.path.endsWith("/face/verify")).body).descriptor)]), [], `kiosk ${v.n}`);
      const stored = v.writes.filter((w) => w.key === "vc3.ballot").map((w) => w.value).join("\n");
      assert.deepEqual(findLeaks(stored, [v.exported, v.voter.email, v.voter.id, v.voter.password]), [], "the stored package never held an identity secret");
      assert.ok(v.writes.filter((w) => w.key === "vc3.identity").every((w) => w.value.includes(v.exported)));
    }

    // ---- CONTROLS: the scanners are not blind
    const v0 = voters[0];
    assert.deepEqual(findLeaks(identityDb + `{"planted":"${v0.sent.membership.nullifier}"}`, [v0.sent.membership.nullifier]), [v0.sent.membership.nullifier], "identity database");
    assert.deepEqual(findLeaks(identityLogs + `\nserved ${v0.sent.coords[0]}`, [v0.sent.coords[0]]), [v0.sent.coords[0]], "identity logs");
    assert.deepEqual(findLeaks(relayDb + `{"planted":"${v0.voter.email}"}`, [v0.voter.email]), [v0.voter.email], "relay database");
    assert.deepEqual(findLeaks(relayLogs + `\nuser ${v0.voter.id}`, [v0.voter.id]), [v0.voter.id], "relay logs");
    assert.deepEqual(findLeaks(JSON.stringify({ ...v0.sessionAfter, "vc3.oops": v0.exported }), [v0.exported]), [v0.exported], "kiosk storage");
    assert.deepEqual(findLeaks(v0.consoleLines.join("\n") + `\nlog ${v0.exported}`, [v0.exported]), [v0.exported], "console");
  });

  it("performance (real Chrome, 13 voters): recorded for the report", async () => {
    const phase = (v, title, step = "") => {
      const a = v.trace.find((x) => x.title === title && (!step || x.step.replace(/^…/, "").startsWith(step)));
      const b = a && v.trace[v.trace.indexOf(a) + 1];
      return a && b ? Math.round(b.t - a.t) : null;
    };
    const rows = voters.map((v) => ({
      voter: v.n,
      faceStepMs: phase(v, "Check your face"),
      groupVerifyMs: phase(v, "Preparing your ballot"),
      validityProofMs: phase(v, "Casting your vote", "Proving the ballot is valid"),
      membershipProofMs: phase(v, "Casting your vote", "Proving you are an eligible voter"),
      castToReceiptMs: Math.round(v.castMs),
    }));
    const mean = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) / rows.length);
    const summary = { machine: "development machine, real Chrome 154 (headless), 20 logical cores, test face engine", meanOverVoters: Object.fromEntries(["faceStepMs", "groupVerifyMs", "validityProofMs", "membershipProofMs", "castToReceiptMs"].map((k) => [k, mean(k)])), perVoter: rows };
    fs.mkdirSync(path.join(ROOT, "e2e-v3", "results"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "e2e-v3", "results", "performance-browser-election.json"), JSON.stringify(summary, null, 2) + "\n");
    assert.ok(rows.every((r) => r.validityProofMs > 0));
  });
});
