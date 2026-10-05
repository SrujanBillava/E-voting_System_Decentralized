// THE KIOSK IN A REAL BROWSER: real Chrome, the real identity-v3 / relay-v3 / contract, the real in-browser Groth16 + Semaphore proofs, under the production Content-Security-Policy.
// Only the camera is a stand-in (Chrome's fake device + the TEST face engine that exists only in the test build). Every test that votes uses real proofs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { createVoter } from "../../identity-v3/test/helpers/journey.js";
import { freePort } from "../../identity-v3/test/helpers/node.js";
import { shutdownProver } from "../../privacy-v3/src/validity.js";
import { nodeKiosk, testFace } from "../lib/node-kiosk.mjs";
import { buildKiosk, castChoice, faceDescriptor, KIOSK_DIR, launchChrome, localDump, login, newVoterContext, receiptOf, serveKiosk, sessionDump, streamsEnded, toCredentialWait, traceOf, writesOf } from "../lib/browser.mjs";
import { findLeaks } from "../lib/scan.mjs";
import { startStack } from "../lib/stack.mjs";
import { execFileSync } from "node:child_process";

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
const KEYS = ["vc3.identity", "vc3.flow", "vc3.ballot", "vc3.receipt"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
let counter = 100; // distinct imaginary people for this file

describe("the kiosk in a real browser", { skip }, () => {
  let stack, server, browser, kioskPort;
  const perf = { votes: [], proofsInBrowser: [] };
  const voterNo = () => ++counter;
  const isIdentity = (e) => e.host === new URL(stack.origins.identity).host;
  const isRelay = (e) => e.host === new URL(stack.origins.relay).host;

  /** a new voter in a new browser context, ready to start */
  async function newVoter() {
    const n = voterNo();
    const voter = await createVoter(stack.identityConfig, { n });
    const v = await newVoterContext(browser, stack, { descriptor: faceDescriptor(n) });
    v.page = await v.context.newPage();
    v.voter = voter;
    v.n = n;
    return v;
  }
  const ballotsOnChain = async () => Number(await stack.world.voteChain.totalBallots());
  /** a second member for the next cohort (a one-member group has root == commitment, which would make a root-vs-commitment check meaningless) */
  async function fillGroup() {
    const other = await createVoter(stack.identityConfig, { n: voterNo() });
    const tab = nodeKiosk(stack);
    await tab.kiosk.login(other.email, other.password);
    await tab.kiosk.verifyFace(testFace(other.n));
    await tab.kiosk.beginCredential();
    return tab;
  }

  before(async () => {
    kioskPort = await freePort();
    stack = await startStack({ identityUri, relayUri, hostnames: true, kioskPort, extraConstituencies: [{ code: "KA-MYS", name: "Mysuru" }] });
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

  // ------------------------------------------------------------------------------------------------------------------------------------------------ security headers + CSP

  it("CSP: the page is served with the strict policy; inline script, eval, remote script / image / frame / socket / beacon and <base> are all refused, while WebAssembly and blob workers (the provers) work", async () => {
    const res = await fetch(`http://127.0.0.1:${kioskPort}/`);
    const csp = res.headers.get("content-security-policy");
    for (const d of ["default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "font-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "worker-src 'self' blob:"]) assert.ok(csp.includes(d), d);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp.replace("wasm-unsafe-eval", "")));
    const connect = /connect-src ([^;]+)/.exec(csp)[1].split(" ");
    assert.deepEqual(connect, ["'self'", stack.origins.identity, stack.origins.relay, stack.kioskConfig.rpcUrl], "the page may talk only to itself and the three configured services");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(res.headers.get("permissions-policy"), /camera=\(self\)/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.ok(html.includes(`content="${csp.replace(/; frame-ancestors 'none'/, "")}"`), "the <meta> policy is the header policy (without frame-ancestors, which a meta tag cannot carry)");
    assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), "no inline script");

    const v = await newVoterContext(browser, stack, {});
    try {
      const page = await v.context.newPage();
      await page.goto(stack.origins.kiosk + "/");
      await page.getByRole("heading", { name: "Sign in to vote" }).waitFor();
      const probe = await page.evaluate(async () => {
        const violations = [];
        document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.effectiveDirective} <- ${e.blockedURI}`));
        const out = {};
        await new Promise((resolve) => setTimeout(resolve, 0)); // Playwright's own evaluation is exempt from the eval ban; a later task is not
        try { eval("1 + 1"); out.eval = "ran"; } catch (e) { out.eval = e.name; }
        try { new Function("return 1")(); out.newFunction = "ran"; } catch (e) { out.newFunction = e.name; }
        window.__pwned = undefined;
        const inline = document.createElement("script");
        inline.textContent = "window.__pwned = 'inline script ran'";
        document.head.appendChild(inline);
        out.inlineScript = window.__pwned ?? "blocked";
        out.remoteScript = await new Promise((resolve) => {
          const s = document.createElement("script");
          s.src = "http://cdn.votechain.invalid/x.js";
          s.onerror = () => resolve("blocked");
          s.onload = () => resolve("ran");
          document.head.appendChild(s);
          setTimeout(() => resolve("timeout"), 4000);
        });
        out.dynamicImport = await import("http://cdn.votechain.invalid/m.js").then(() => "ran", () => "blocked");
        out.fetchOther = await fetch("https://example.com/", { mode: "no-cors" }).then(() => "allowed", () => "blocked");
        out.beacon = navigator.sendBeacon("http://analytics.votechain.invalid/collect", "x") ? "queued" : "blocked";
        out.websocket = await new Promise((resolve) => { try { const w = new WebSocket("ws://socket.votechain.invalid/"); w.onerror = () => resolve("blocked"); w.onopen = () => resolve("open"); setTimeout(() => resolve("timeout"), 3000); } catch { resolve("blocked"); } });
        out.image = await new Promise((resolve) => { const i = new Image(); i.onerror = () => resolve("blocked"); i.onload = () => resolve("loaded"); i.src = "http://pixel.votechain.invalid/p.gif"; setTimeout(() => resolve("timeout"), 3000); });
        const frame = document.createElement("iframe");
        frame.src = "http://frame.votechain.invalid/";
        document.body.appendChild(frame);
        const base = document.createElement("base");
        base.href = "http://base.votechain.invalid/";
        document.head.appendChild(base);
        out.fontRemote = await new FontFace("x", "url(http://font.votechain.invalid/f.woff2)").load().then(() => "loaded", () => "blocked");
        // what MUST work: the provers' WebAssembly and blob workers, and talking to ourselves
        out.wasm = await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => "works", (e) => String(e));
        out.blobWorker = await new Promise((resolve) => {
          const w = new Worker(URL.createObjectURL(new Blob(["postMessage('hello from a worker')"], { type: "text/javascript" })));
          w.onmessage = (e) => resolve(e.data);
          w.onerror = () => resolve("blocked");
          setTimeout(() => resolve("timeout"), 3000);
        });
        out.self = await fetch("/favicon.svg").then((r) => r.status);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { out, violations };
      });
      assert.equal(probe.out.eval, "EvalError");
      assert.equal(probe.out.newFunction, "EvalError");
      assert.equal(probe.out.inlineScript, "blocked");
      for (const key of ["remoteScript", "dynamicImport", "fetchOther", "websocket", "image", "fontRemote"]) assert.equal(probe.out[key], "blocked", key);
      assert.ok(["blocked", "queued"].includes(probe.out.beacon));
      assert.equal(probe.out.wasm, "works");
      assert.equal(probe.out.blobWorker, "hello from a worker");
      assert.equal(probe.out.self, 200);
      const directives = new Set(probe.violations.map((x) => x.split(" ")[0]));
      for (const d of ["script-src", "script-src-elem", "connect-src", "img-src", "frame-src", "base-uri", "font-src"]) assert.ok(directives.has(d), `a ${d} violation was reported (${[...directives].join(", ")})`);
      assert.equal(await page.evaluate(() => window.__pwned), undefined, "the injected script never ran");
      assert.ok(v.traffic.every((e) => !e.host.endsWith(".invalid") || e.failed || e.status === 0), "nothing reached an unapproved origin");
    } finally {
      await v.context.close();
    }
  });

  // ------------------------------------------------------------------------------------------------------------------------------------------------ the full voter, observed from outside

  it("one voter, observed: cookie only to the identity origin; relay requests carry no cookie / credentials / referrer; NO identity request after CREDENTIAL_ISSUED; the camera stops; sessionStorage holds only the four documented keys and is cleaned; localStorage / IndexedDB / cookies stay empty; the receipt is public data only; nothing leaks to the console", async () => {
    const v = await newVoter();
    const { page, voter } = v;
    const t0 = performance.now();
    await toCredentialWait(page, stack, voter);

    // --- while the identity session exists: a host-only, HttpOnly, SameSite=Strict cookie on the identity origin and nowhere else
    const before = await v.context.cookies();
    assert.deepEqual(before.map((c) => [c.name, c.domain, c.httpOnly, c.sameSite]), [["vc3_voter", new URL(stack.origins.identity).hostname, true, "Strict"]]);
    assert.deepEqual(await localDump(page), { local: {}, indexedDb: [], cookie: "" });
    const identityEntries = Object.keys(await sessionDump(page));
    assert.deepEqual(identityEntries.sort(), ["vc3.flow", "vc3.identity"], "only the private identity and the flow marker while the credential is pending");
    const exported = JSON.parse((await sessionDump(page))["vc3.identity"]).identity;
    const flow = JSON.parse((await sessionDump(page))["vc3.flow"]);
    assert.deepEqual(await streamsEnded(page), { opened: 1, live: 0 }, "the camera was opened once and every track is stopped after the face check");

    await fillGroup();
    await stack.world.nextEpoch();
    await page.getByRole("heading", { name: "Choose your candidate" }).waitFor({ timeout: 120_000 });
    assert.deepEqual(await v.context.cookies(), [], "the identity cookie is gone after CREDENTIAL_ISSUED");
    assert.deepEqual(Object.keys(await sessionDump(page)).sort(), ["vc3.flow", "vc3.identity"]);
    assert.equal(JSON.parse((await sessionDump(page))["vc3.flow"]).stage, "CREDENTIAL_ISSUED");

    // --- the ballot page lists the candidates the CONTRACT reports, in order, reachable by keyboard
    assert.deepEqual(await page.getByRole("radio").evaluateAll((els) => els.map((el) => el.parentElement.textContent)), ["Candidate A", "Candidate B", "Candidate C"]);
    const tCast = performance.now();
    await castChoice(page, "Candidate C");
    const castMs = performance.now() - tCast;
    await v.settled();

    // --- network, request by request
    const withCookie = v.traffic.filter((e) => "cookie" in e.headers);
    assert.ok(withCookie.length > 0 && withCookie.every(isIdentity), "a cookie is only ever sent to the identity origin");
    const relay = v.traffic.filter(isRelay);
    assert.ok(relay.length >= 2);
    for (const e of relay) {
      assert.ok(!("cookie" in e.headers) && !("authorization" in e.headers) && !("referer" in e.headers), `${e.method} ${e.path}: ${Object.keys(e.headers).join()}`);
      assert.ok(Object.keys(e.headers).every((h) => ["accept", "content-type", "origin", "user-agent", "accept-language", "accept-encoding", "content-length", "connection", "host", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "cache-control", "pragma", "priority"].includes(h)), Object.keys(e.headers).join());
    }
    for (const e of v.traffic.filter((x) => x.host === new URL(stack.kioskConfig.rpcUrl).host)) assert.ok(!("cookie" in e.headers) && !("referer" in e.headers));
    const idReqs = v.traffic.filter(isIdentity);
    const last = idReqs.at(-1);
    assert.equal(`${last.method} ${last.path}`, "GET /api/v3/voter/credential");
    assert.ok(last.responseText.includes("CREDENTIAL_ISSUED"), "the last identity request is the one that delivered the credential");
    assert.ok(v.traffic.indexOf(last) < v.traffic.indexOf(relay[0]), "and it precedes every anonymous request");
    const posts = idReqs.filter((e) => e.method === "POST" && e.path.endsWith("/credential"));
    assert.deepEqual(posts.map((e) => Object.keys(JSON.parse(e.body))), [["commitment"]], "exactly one credential request, carrying only the public commitment");
    assert.equal(JSON.parse(posts[0].body).commitment, flow.commitment);
    assert.ok(!v.traffic.some((e) => (e.body ?? "").includes(exported)), "the private identity was never sent anywhere");
    const face = idReqs.filter((e) => e.path.endsWith("/face/verify"));
    assert.ok(face.length >= 1);
    for (const e of face) {
      assert.deepEqual(Object.keys(JSON.parse(e.body)).sort(), ["challenge", "descriptor", "liveness"], "a face check sends numbers only");
      assert.equal(JSON.parse(e.body).descriptor.length, 512);
      assert.equal(e.headers["content-type"], "application/json");
      assert.ok(!/data:image|base64|multipart/i.test(e.body));
    }
    assert.ok(!v.traffic.some((e) => e.type === "image" && e.host !== new URL(stack.origins.kiosk).host), "no image went anywhere");
    assert.ok(v.traffic.filter((e) => !/^https?:/.test(e.url)).every((e) => /^(blob|data):/.test(e.url)), "the only non-HTTP URLs are blob: / data: (the provers' own workers)");
    const origins = new Set(v.traffic.filter((e) => /^https?:/.test(e.url)).map((e) => e.host));
    assert.deepEqual([...origins].sort(), [new URL(stack.origins.kiosk).host, new URL(stack.origins.identity).host, new URL(stack.origins.relay).host, new URL(stack.kioskConfig.rpcUrl).host].sort(), "four origins and no other");

    // --- the relay got the public package only
    const posted = JSON.parse(relay.find((e) => e.method === "POST").body);
    assert.deepEqual(Object.keys(posted).sort(), ["constituencyId", "coords", "membership", "validity"]);
    for (const [what, value] of [["email", voter.email], ["voter id", voter.id], ["commitment", flow.commitment]]) assert.ok(!JSON.stringify(posted).includes(value), `the relay package contains the voter's ${what}`);

    // --- storage: every write ever made, and what is left
    const writes = await writesOf(page);
    assert.ok(writes.every((w) => w.area === "session" && KEYS.includes(w.key)), "the kiosk wrote only its four documented sessionStorage keys");
    assert.ok(writes.filter((w) => w.key === "vc3.identity").every((w) => w.value.includes(exported)));
    const ballotWrites = writes.filter((w) => w.key === "vc3.ballot").map((w) => JSON.parse(w.value));
    assert.ok(ballotWrites.length >= 2, "the package, then its relay state");
    for (const b of ballotWrites) {
      assert.ok(!JSON.stringify(b).includes(exported), "the private identity is not in the package");
      assert.ok(!/choice|oneHot|one-hot|"m"|"r"|randomness|plaintext/i.test(JSON.stringify(Object.keys(b))), "no plaintext selection, one-hot or randomness field");
      assert.equal(b.digest, ballotWrites[0].digest, "the immutable part never changes");
    }
    assert.deepEqual(Object.keys(await sessionDump(page)), ["vc3.receipt"], "only the public receipt remains");
    assert.deepEqual(await localDump(page), { local: {}, indexedDb: [], cookie: "" });
    assert.deepEqual(await v.context.cookies(), []);
    assert.deepEqual(findLeaks(JSON.stringify(await sessionDump(page)), [exported, flow.commitment, posted.membership.nullifier, voter.email, voter.password, ...posted.coords]), []);

    // --- the receipt, on screen and on the chain
    const receipt = await receiptOf(page);
    assert.deepEqual(Object.keys(receipt.rows), ["Election", "Chain ID", "Contract", "Constituency", "Ballot number", "Ballot hash", "Transaction", "Block number", "Block hash", "Block time (UTC)"]);
    assert.equal(receipt.statement, "This receipt proves that an encrypted ballot was recorded. It does not prove which candidate was selected.");
    const text = await page.locator("body").innerText();
    for (const secret of [posted.membership.nullifier, flow.commitment, posted.membership.merkleTreeRoot, exported, voter.email, voter.id]) assert.ok(!text.includes(secret), "the receipt page shows no identity, commitment, nullifier or root");
    assert.ok(!/Candidate [ABC]/.test(text), "the receipt page does not show the candidate");
    assert.ok(!(await page.content()).includes("Candidate C"), "the choice is not in the page any more");
    const events = await stack.world.voteChain.queryFilter(stack.world.voteChain.filters.BallotRecorded(null, BigInt(posted.membership.nullifier)));
    assert.equal(events.length, 1);
    assert.equal(events[0].transactionHash, receipt.rows.Transaction);
    assert.equal(String(Number(events[0].args.ballotIndex)), receipt.rows["Ballot number"]);

    // --- the console never carried a secret
    const secrets = [exported, voter.password, voter.email, voter.id, flow.commitment, posted.membership.nullifier, ...posted.coords];
    assert.deepEqual(findLeaks(v.consoleLines.join("\n"), secrets), [], "nothing secret in the console");
    assert.deepEqual(v.consoleLines.filter((l) => /Content Security Policy|Refused to|violat/i.test(l)), [], "the whole voter flow ran without a single CSP violation");
    assert.deepEqual(v.pageErrors, []);

    // --- a second sign-in after the vote is refused before any session exists; nothing new is requested
    const mark = v.traffic.length;
    const page2 = await v.context.newPage();
    await login(page2, stack, voter);
    await page2.getByText(/credential has already been issued/i).waitFor();
    await v.settled();
    assert.equal(v.traffic.slice(mark).filter((e) => e.method === "POST" && e.path.endsWith("/credential")).length, 0);
    assert.deepEqual(await v.context.cookies(), [], "no session cookie was created");
    assertReadOnly(stack);
    assert.equal(await ballotsOnChain(), 1);
    const trace = await traceOf(page);
    perf.votes.push({ wholeVoterMs: Math.round(performance.now() - t0), castToReceiptMs: Math.round(castMs), trace: trace.map((x) => ({ t: Math.round(x.t), title: x.title, step: x.step.replace(/^…/, "").replace(/ \(in progress\)$/, "") })) });
    await v.context.close();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------------------ recovery

  it("REFRESH while the credential is pending: the same private identity is reused, exactly ONE commitment is ever requested, and the voter still votes", async () => {
    const v = await newVoter();
    const { page, voter } = v;
    await toCredentialWait(page, stack, voter);
    const before = await sessionDump(page);
    await page.reload();
    await page.getByRole("heading", { name: "Getting your voting credential" }).waitFor({ timeout: 30_000 });
    assert.deepEqual(await sessionDump(page), before, "the same identity and flow after the refresh");
    await stack.world.nextEpoch();
    await castChoice(page, "Candidate A");
    await v.settled();
    const posts = v.traffic.filter((e) => isIdentity(e) && e.method === "POST" && e.path.endsWith("/credential"));
    assert.equal(posts.length, 1, "no second commitment was requested");
    const writes = (await writesOf(page)).filter((w) => w.key === "vc3.identity");
    assert.ok(writes.length === 0, "after the refresh the identity was only READ (a fresh page's instrumentation saw no new identity)");
    await v.context.close();
  });

  it("REFRESH after issuance, before voting: the tab recovers from sessionStorage alone and never contacts the identity service again", async () => {
    const v = await newVoter();
    const { page, voter } = v;
    await toCredentialWait(page, stack, voter);
    await stack.world.nextEpoch();
    await page.getByRole("heading", { name: "Choose your candidate" }).waitFor({ timeout: 120_000 });
    await v.settled();
    const mark = v.traffic.length;
    await page.reload();
    await page.getByRole("heading", { name: "Choose your candidate" }).waitFor({ timeout: 60_000 });
    await castChoice(page, "Candidate B");
    await v.settled();
    assert.equal(v.traffic.slice(mark).filter(isIdentity).length, 0, "no identity request after CREDENTIAL_ISSUED, not even after a refresh");
    await v.context.close();
  });

  it("RELAY OUTAGE then REFRESH: the immutable package survives, is resent (not rebuilt) and the vote is recorded exactly once", async () => {
    const v = await newVoter();
    const { page, voter } = v;
    await toCredentialWait(page, stack, voter);
    await stack.world.nextEpoch();
    await page.getByRole("heading", { name: "Choose your candidate" }).waitFor({ timeout: 120_000 });
    const total = await ballotsOnChain();
    await page.route("**/v1/ballots", (route) => (route.request().method() === "POST" ? route.abort("connectionrefused") : route.continue()));
    await page.getByRole("radio", { name: "Candidate A" }).check();
    await page.getByRole("button", { name: "Review my choice" }).click();
    await page.getByRole("button", { name: "Cast my vote" }).click();
    await page.getByRole("heading", { name: "Your vote has not been recorded yet" }).waitFor({ timeout: 120_000 });
    await page.getByText(/saved in this tab and will be sent again, not created again/).waitFor();
    const stored = JSON.parse((await sessionDump(page))["vc3.ballot"]);
    assert.equal(await ballotsOnChain(), total, "nothing recorded while the relay is unreachable");
    assert.equal(JSON.parse((await sessionDump(page))["vc3.identity"]) !== null, true, "the identity is still held for a membership refresh");
    // the tab is refreshed in the middle of the outage: the stored package is picked up and offered again, without a choice and without any new proof
    await page.reload();
    await page.getByRole("heading", { name: "Your vote has not been recorded yet" }).waitFor({ timeout: 60_000 });
    const trace = await traceOf(page);
    assert.ok(!trace.some((x) => /Proving|Encrypting/.test(x.step)), "no proof or encryption after the refresh");
    assert.equal(JSON.parse((await sessionDump(page))["vc3.ballot"]).digest, stored.digest);
    await page.unroute("**/v1/ballots");
    await page.getByRole("button", { name: "Send again" }).click();
    await page.getByRole("heading", { name: "Your vote was recorded" }).waitFor({ timeout: 120_000 });
    assert.equal(await ballotsOnChain(), total + 1);
    const events = await stack.world.voteChain.queryFilter(stack.world.voteChain.filters.BallotRecorded(null, BigInt(stored.nullifier)));
    assert.equal(events.length, 1, "recorded exactly once");
    await v.settled();
    const posts = v.traffic.filter((e) => isRelay(e) && e.method === "POST");
    assert.ok(posts.length >= 2);
    const bodies = new Set(posts.filter((e) => e.body).map((e) => JSON.parse(e.body).coords.join()));
    assert.equal(bodies.size, 1, "every attempt carried the same ciphertexts");
    await v.context.close();
  });

  it("ROOT EXPIRY: when the group moved on and the old root expired, ONLY the Semaphore membership proof is regenerated: same ciphertexts, same validity proof, same nullifier, same digest", async () => {
    const v = await newVoter();
    const { page, voter } = v;
    await toCredentialWait(page, stack, voter);
    await stack.world.nextEpoch();
    await page.getByRole("heading", { name: "Choose your candidate" }).waitFor({ timeout: 120_000 });
    await page.route("**/v1/ballots", (route) => (route.request().method() === "POST" ? route.abort("connectionrefused") : route.continue()));
    await page.getByRole("radio", { name: "Candidate B" }).check();
    await page.getByRole("button", { name: "Review my choice" }).click();
    await page.getByRole("button", { name: "Cast my vote" }).click();
    await page.getByRole("heading", { name: "Your vote has not been recorded yet" }).waitFor({ timeout: 120_000 });
    const held = JSON.parse((await sessionDump(page))["vc3.ballot"]);
    // while the ballot is held back, another voter joins the group (the root moves) and more than the root window passes
    const other = await createVoter(stack.identityConfig, { n: voterNo() });
    const tab = nodeKiosk(stack);
    await tab.kiosk.login(other.email, other.password);
    await tab.kiosk.verifyFace(testFace(other.n));
    await tab.kiosk.beginCredential();
    await stack.world.nextEpoch();
    assert.equal(await tab.kiosk.awaitCredential(), "ISSUED");
    await stack.world.mineAt((await stack.world.clock.nowSeconds()) + 2 * 3600);
    await page.unroute("**/v1/ballots");
    await page.getByRole("button", { name: "Send again" }).click();
    await page.getByRole("heading", { name: "Your vote was recorded" }).waitFor({ timeout: 180_000 });
    const trace = await traceOf(page);
    assert.ok(trace.some((x) => /Sending/.test(x.step)));
    await v.settled();
    const posts = v.traffic.filter((e) => isRelay(e) && e.method === "POST").map((e) => JSON.parse(e.body));
    assert.ok(posts.length >= 2);
    assert.notEqual(posts[0].membership.merkleTreeRoot, posts.at(-1).membership.merkleTreeRoot, "the membership proof was made against a newer root");
    assert.equal(posts[0].membership.nullifier, posts.at(-1).membership.nullifier);
    assert.deepEqual(posts[0].coords, posts.at(-1).coords, "same ciphertexts");
    assert.deepEqual(posts[0].validity, posts.at(-1).validity, "same validity proof");
    const events = await stack.world.voteChain.queryFilter(stack.world.voteChain.filters.BallotRecorded(null, BigInt(held.nullifier)));
    assert.equal(events.length, 1);
    await v.context.close();
  });

  it("CREDENTIAL LOST (tab storage cleared while the credential is pending): the kiosk fails closed and never asks for another credential", async () => {
    const v = await newVoter();
    const { page, voter } = v;
    await toCredentialWait(page, stack, voter);
    await page.evaluate(() => sessionStorage.clear());
    const mark = v.traffic.length;
    await page.reload();
    await page.getByRole("heading", { name: "This kiosk cannot continue your vote" }).waitFor({ timeout: 30_000 });
    await page.getByText(/does not create a second credential/).waitFor();
    await v.settled();
    assert.equal(v.traffic.slice(mark).filter((e) => e.method === "POST").length, 0, "no request of any kind was made");
    await stack.world.nextEpoch();
    await v.context.close();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------------------ the face step's states

  it("FACE STEP states: a wrong face costs attempts and then LOCKS (no way around it, also after a refresh); an unenrolled voter, a refused camera and a failed model load each get a clear message", async () => {
    // ---- a different person than the enrolled one: attempts run down, then the voter is locked out
    const n = voterNo();
    const voter = await createVoter(stack.identityConfig, { n });
    const wrong = await newVoterContext(browser, stack, { descriptor: faceDescriptor(n + 5000) });
    const page = await wrong.context.newPage();
    await login(page, stack, voter);
    await page.getByRole("heading", { name: "Check your face" }).waitFor({ timeout: 30_000 });
    let locked = false;
    for (let round = 0; round < 6 && !locked; round++) {
      const outcome = await Promise.race([
        page.locator(".alert", { hasText: "Face could not be verified." }).waitFor({ timeout: 60_000 }).then(() => "mismatch"),
        page.locator(".alert", { hasText: "Face verification is locked." }).waitFor({ timeout: 60_000 }).then(() => "locked"),
      ]);
      if (outcome === "locked") locked = true;
      else await page.getByRole("button", { name: "Try again" }).click();
    }
    assert.equal(locked, true, "three failed attempts lock the voter");
    await page.locator(".alert", { hasText: /ask a polling official/i }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0, "the kiosk cannot unlock itself");
    await page.reload(); // boot -> status is still AUTHENTICATED -> face step -> the SERVER says locked, before any camera starts
    await page.locator(".alert", { hasText: "Face verification is locked." }).waitFor({ timeout: 30_000 });
    assert.deepEqual(await streamsEnded(page), { opened: 0, live: 0 }, "a locked voter's camera is never even started");
    await wrong.settled();
    assert.equal(wrong.traffic.filter((e) => e.path.endsWith("/credential")).length, 0, "no credential was requested");
    await wrong.context.close();

    // ---- not enrolled
    const stranger = await createVoter(stack.identityConfig, { n: voterNo(), enrolled: false });
    const unenrolled = await newVoterContext(browser, stack, { descriptor: faceDescriptor(1) });
    const page2 = await unenrolled.context.newPage();
    await login(page2, stack, stranger);
    await page2.locator(".alert", { hasText: "No face is enrolled for this voter. Please ask a polling official." }).waitFor({ timeout: 30_000 });
    assert.deepEqual(await streamsEnded(page2), { opened: 0, live: 0 });
    await unenrolled.context.close();

    // ---- the browser refuses the camera
    const m = voterNo();
    const refuser = await createVoter(stack.identityConfig, { n: m });
    const denied = await newVoterContext(browser, stack, { descriptor: faceDescriptor(m) });
    await denied.context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    });
    const page3 = await denied.context.newPage();
    await login(page3, stack, refuser);
    await page3.locator(".alert", { hasText: /Camera access was refused/ }).waitFor({ timeout: 30_000 });
    await page3.getByRole("button", { name: "Try again" }).waitFor();
    await denied.context.close();

    // ---- the face models cannot be loaded
    const k = voterNo();
    const broken = await createVoter(stack.identityConfig, { n: k });
    const failing = await newVoterContext(browser, stack, { descriptor: faceDescriptor(k) });
    await failing.context.addInitScript(() => {
      window.__E2E_FACE__ = { ...window.__E2E_FACE__, failLoad: true };
    });
    const page4 = await failing.context.newPage();
    await login(page4, stack, broken);
    await page4.locator(".alert", { hasText: /face recognition files could not be loaded/ }).waitFor({ timeout: 30_000 });
    await page4.getByRole("button", { name: "Try again" }).waitFor();
    assert.deepEqual(await streamsEnded(page4), { opened: 1, live: 0 }, "a failed start leaves no camera running");
    await failing.context.close();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------------------ accessibility

  it("ACCESSIBILITY: no axe violations (WCAG 2.1 A/AA + best practice) on the login, face, credential, ballot, review, receipt and results screens; the whole ballot works from the keyboard", async () => {
    const v = await newVoter();
    const { page, voter } = v;
    const found = [];
    const scan = async (name) => {
      const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
      found.push(...results.violations.map((x) => `${name}: ${x.id} (${x.impact}) ${x.nodes.map((n) => n.target.join(" ")).join(" | ")}`));
      return results;
    };
    await page.goto(stack.origins.kiosk + "/");
    await page.getByRole("heading", { name: "Sign in to vote" }).waitFor();
    await scan("login");
    await page.getByLabel("Voter ID or email").fill(voter.email);
    await page.getByLabel("Password").fill(voter.password);
    await page.keyboard.press("Enter"); // submit from the keyboard
    await page.getByRole("heading", { name: "Check your face" }).waitFor({ timeout: 30_000 });
    await page.getByText(/Blink now|Turn your head|Hold still|Look straight|Verifying|Capturing/).first().waitFor({ timeout: 30_000 });
    await scan("face");
    await page.getByText(/Waiting for the next batch of credentials/).waitFor({ timeout: 90_000 });
    await scan("credential");
    await stack.world.nextEpoch();
    await page.getByRole("heading", { name: "Choose your candidate" }).waitFor({ timeout: 120_000 });
    await scan("ballot");
    // keyboard only: Tab to the radio group, arrow to the second candidate, Tab to the button, Enter; then the confirm button
    await page.locator("body").press("Tab");
    for (let i = 0; i < 6 && !(await page.evaluate(() => document.activeElement?.getAttribute("type") === "radio")); i++) await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.getByRole("radio", { name: "Candidate B" }).isChecked(), true, "arrow keys move the selection");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Review my choice");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Confirm your vote" }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Cast my vote", "focus moves to the irreversible button's panel");
    await scan("review");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Your vote was recorded" }).waitFor({ timeout: 180_000 });
    await scan("receipt");
    await page.goto(stack.origins.kiosk + "/#/results");
    await page.getByRole("heading", { name: "Public results" }).waitFor();
    await page.getByText("Result not finalized").first().waitFor();
    await scan("results");
    assert.deepEqual(found, [], found.join("\n"));
    await v.context.close();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------------------ public results before finalization

  it("PUBLIC RESULTS before finalization: no sign-in, every constituency says 'Result not finalized', no count of any kind is shown", async () => {
    const v = await newVoterContext(browser, stack, {});
    const page = await v.context.newPage();
    await page.goto(stack.origins.kiosk + "/#/results");
    await page.getByRole("heading", { name: "Public results" }).waitFor();
    await page.getByRole("heading", { name: "Bengaluru South" }).waitFor();
    await page.getByRole("heading", { name: "Mysuru" }).waitFor();
    assert.equal(await page.getByText("Result not finalized").count(), 2);
    const text = await page.locator("main").innerText();
    assert.ok(!/Votes|Ballots counted|Candidate [ABC]/.test(text), "no tally, no candidate list, no interim number");
    await v.settled();
    assert.ok(v.traffic.filter((e) => isIdentity(e) || isRelay(e)).length === 0, "the result page needs neither the identity service nor the relay");
    assert.ok(v.traffic.every((e) => !("cookie" in e.headers)));
    await v.context.close();
  });

  // ------------------------------------------------------------------------------------------------------------------------------------------------ performance record + the production-like build with the REAL face engine

  it("PRODUCTION-LIKE BUILD: contains no test hook; the REAL face engine (Human + TensorFlow WASM + GhostNet) loads and runs under the strict CSP, nothing is uploaded; the build's own checker passes", async () => {
    server.stop();
    await server.exited;
    const dir = buildKiosk(stack, { outDir: "dist-prodlike", e2eFace: false });
    execFileSync(process.execPath, [path.join(KIOSK_DIR, "scripts", "check-bundle.mjs"), "--dir", dir, "--no-manifest"], { cwd: KIOSK_DIR, stdio: "pipe" });
    const prod = await serveKiosk({ dir, port: kioskPort });
    try {
      const n = voterNo();
      const voter = await createVoter(stack.identityConfig, { n });
      const v = await newVoterContext(browser, stack, { descriptor: faceDescriptor(n) }); // the test hook is set, and the production build must ignore it
      const page = await v.context.newPage();
      await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__violations ??= []).push(`${e.effectiveDirective} <- ${e.blockedURI}`)));
      await login(page, stack, voter);
      await page.getByRole("heading", { name: "Check your face" }).waitFor({ timeout: 30_000 });
      await page.locator("strong", { hasText: "No face detected. Look at the camera." }).waitFor({ timeout: 120_000 });
      await v.settled();
      assert.deepEqual(await page.evaluate(() => window.__violations ?? []), [], "no CSP violation while the real face engine loads and runs");
      const loaded = v.traffic.filter((e) => e.host === new URL(stack.origins.kiosk).host && e.path.startsWith("/face/"));
      assert.ok(loaded.some((e) => e.path.includes("/face/wasm/")) && loaded.some((e) => e.path.includes("/face/ghostnet/")) && loaded.some((e) => e.path.includes("/face/human/")), loaded.map((e) => e.path).join());
      assert.ok(loaded.every((e) => e.status === 200 && e.host === new URL(stack.origins.kiosk).host), `every model file came from the kiosk's own origin: ${loaded.filter((e) => e.status !== 200 || e.host !== new URL(stack.origins.kiosk).host).map((e) => `${e.status} ${e.url}`).join(", ")}`);
      assert.ok(!v.traffic.some((e) => e.path.endsWith("/face/verify")), "the test descriptor was ignored: nothing was verified without a real capture");
      assert.ok(!v.traffic.some((e) => e.method === "POST" && !e.path.endsWith("/auth/login")), "no frame, image or descriptor was uploaded");
      assert.equal(await page.evaluate(() => typeof window.__E2E_FACE__), "object", "the hook exists only because this test set it");
      assert.ok(!(await page.content()).includes("e2e-fake"));
      await v.context.close();
    } finally {
      prod.stop();
      await prod.exited;
    }
  });

  it("performance (real Chrome, this machine): recorded for the report", async () => {
    const [vote] = perf.votes;
    assert.ok(vote, "the observed voter ran");
    const at = (title, step = "") => vote.trace.find((x) => x.title === title && (!step || x.step.startsWith(step)));
    const next = (item) => vote.trace[vote.trace.indexOf(item) + 1];
    const span = (a) => (a && next(a) ? next(a).t - a.t : null);
    const phases = {
      faceStepMs: span(at("Check your face")),
      credentialMs: (() => { const a = at("Getting your voting credential"); const b = at("Preparing your ballot"); return a && b ? b.t - a.t : null; })(),
      groupVerifyMs: span(at("Preparing your ballot")),
      checkMs: span(at("Casting your vote", "Checking")),
      validityProofMs: span(at("Casting your vote", "Proving the ballot is valid")),
      membershipProofMs: span(at("Casting your vote", "Proving you are an eligible voter")),
      sendAndConfirmMs: span(at("Casting your vote", "Sending")),
    };
    const summary = { machine: "development machine, real Chrome 154 (headless), 20 logical cores, test face engine", note: "validity = frozen 68-signal Groth16 circuit; membership = Semaphore depth-20; both run in the browser's WebAssembly with worker threads; the 26 MB proving key is read from the kiosk's own origin", wholeVoterMs: vote.wholeVoterMs, castToReceiptMs: vote.castToReceiptMs, phases };
    fs.mkdirSync(path.join(KIOSK_DIR, "..", "e2e-v3", "results"), { recursive: true });
    fs.writeFileSync(path.join(KIOSK_DIR, "..", "e2e-v3", "results", "performance-browser.json"), JSON.stringify(summary, null, 2) + "\n");
    assert.ok(phases.validityProofMs > 0);
  });
});
