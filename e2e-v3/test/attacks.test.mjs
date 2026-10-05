// INTEGRATION-LEVEL ATTACKS AND RETRIES against the real stack (real contract, real proofs, real identity/relay processes). Low-level crypto is not re-tested here:
// each case drives the kiosk, the relayer or the node into a hostile or failing state and checks the system's answer AND that nothing was recorded that should not be.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Interface } from "ethers";
import { createVoter } from "../../identity-v3/test/helpers/journey.js";
import { buildBallot, createKiosk, createChainReader, expectedOf, KEYS, memoryStorage, toRelayPackage } from "../../kiosk-v3/src/core/index.ts";
import { Group, Identity, proveMembership } from "../../kiosk-v3/src/crypto/privacy.ts";
import { mul } from "../../privacy-v3/src/elgamal.js";
import { shutdownProver } from "../../privacy-v3/src/validity.js";
import { createCookieFetch } from "../lib/cookie-fetch.mjs";
import { nodeKiosk, testFace } from "../lib/node-kiosk.mjs";
import { startStack } from "../lib/stack.mjs";

const identityUri = process.env.MONGODB_TEST_URI;
const relayUri = process.env.MONGODB_RELAY_TEST_URI;
const skip = identityUri && relayUri ? false : "set MONGODB_TEST_URI and MONGODB_RELAY_TEST_URI";
const clone = (v) => JSON.parse(JSON.stringify(v));
const rejects = (promise, code) => assert.rejects(promise, (err) => err.code === code, code);
const keyViews = new Interface(["function electionKeyX() view returns (uint256)", "function electionKeyY() view returns (uint256)"]);
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");

describe("integration attacks and retries (real stack)", { skip }, () => {
  let stack;
  const V = {};
  const totalBallots = async () => Number(await stack.world.voteChain.totalBallots());
  const relayHost = () => new URL(stack.origins.relay).host;
  const identityHost = () => new URL(stack.origins.identity).host;

  /** a voter who has logged in, passed the face step and sent a commitment (reservation pending) */
  async function requestedVoter(label, n, constituencyCode = "KA-BLR", overrides = {}) {
    const voter = await createVoter(stack.identityConfig, { n, constituencyCode });
    const ctx = nodeKiosk(stack, overrides);
    await ctx.kiosk.login(voter.email, voter.password);
    await ctx.kiosk.verifyFace(testFace(n));
    await ctx.kiosk.beginCredential();
    return (V[label] = { n, voter, ...ctx });
  }
  /** a NEW tab for the same voter: same sessionStorage contents, same browser cookie jar (a page reload), or a copy of the credential into a fresh tab */
  const reload = (v, overrides = {}) => nodeKiosk(stack, { storage: v.storage, fetch: v.fetch, ...overrides });
  const forkCredential = (v, overrides = {}) => {
    const storage = memoryStorage();
    for (const key of [KEYS.identity, KEYS.flow]) if (v.storage.getItem(key) !== null) storage.setItem(key, v.storage.getItem(key));
    return nodeKiosk(stack, { storage, ...overrides });
  };
  const relayTamper = (base, mutate) => {
    const f = async (url, init) => {
      const res = await base(url, init);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return new Response(text, { status: res.status, headers: res.headers });
      }
      return new Response(JSON.stringify(mutate(new URL(url).pathname, json) ?? json), { status: res.status, headers: res.headers });
    };
    Object.assign(f, { log: base.log, jar: base.jar, cookiesFor: base.cookiesFor });
    return f;
  };
  const issueAll = async (labels) => {
    await stack.world.nextEpoch();
    for (const label of labels) assert.equal(await V[label].kiosk.awaitCredential(), "ISSUED", label);
  };

  before(async () => {
    stack = await startStack({ identityUri, relayUri, extraConstituencies: [{ code: "MH-MUM", name: "Mumbai" }] });
    for (const [label, n] of [["A", 1], ["B", 2], ["C", 3], ["D", 4], ["E", 5], ["F", 6], ["G", 7], ["G2", 8], ["H", 9], ["I", 10], ["K", 11]]) await requestedVoter(label, n);
    await requestedVoter("M", 12, "MH-MUM");
    // L: the network drops the ONE response that delivers the credential (the server has already processed it: the identity session is over). Dropped BEFORE the browser sees it,
    // so its cookie jar is not told either.
    let dropped = false;
    const dropIssuedOnce = async (url, init = {}) => {
      const res = await fetch(url, init);
      if (!dropped && new URL(url).pathname.endsWith("/credential") && (init.method ?? "GET") === "GET" && (await res.clone().text()).includes("CREDENTIAL_ISSUED")) {
        dropped = true;
        throw new TypeError("the connection dropped before the answer arrived");
      }
      return res;
    };
    await requestedVoter("L", 13, "KA-BLR", { fetch: createCookieFetch({ origin: stack.origins.kiosk, base: dropIssuedOnce }) });

    // C: the page is reloaded WHILE WAITING for the credential
    assert.equal(await V.C.kiosk.boot(), "waiting");
    const reloaded = reload(V.C);
    assert.equal(await reloaded.kiosk.boot(), "waiting", "same tab storage, same cookie: it simply resumes waiting");
    V.C.kiosk = reloaded.kiosk;
    // I: the TAB IS DESTROYED while waiting (sessionStorage gone, the browser's cookie jar remains)
    const lost = nodeKiosk(stack, { fetch: V.I.fetch });
    assert.equal(await lost.kiosk.boot(), "credential-lost", "the identity service says a credential is pending but this tab has no private identity: FAIL CLOSED");
    assert.equal(V.I.fetch.log.filter((e) => e.method === "POST" && e.path.endsWith("/credential")).length, 1, "and no second commitment was ever sent");

    await issueAll(["A", "B", "C", "D", "E", "F", "G", "G2", "H", "K", "M"]);
    // I (continued): the credential is now ISSUED on-chain, the identity service holds the voter's terminal session (the result was never fetched) and the tab with the private
    // identity is gone. A new tab finds a credential that exists and a private identity that does not: FAIL CLOSED, and it never asks for another one.
    const lostAfterIssuance = nodeKiosk(stack, { fetch: V.I.fetch });
    assert.equal(await lostAfterIssuance.kiosk.boot(), "credential-lost");
  });
  after(async () => {
    await shutdownProver();
    await stack?.stop();
  });

  describe("the public group and the election parameters are verified, never trusted", () => {
    it("a commitment that is not in the public group (a wrong or never-issued credential) is refused locally", async () => {
      const fresh = new Identity();
      const { kiosk, storage } = forkCredential(V.A);
      storage.setItem(KEYS.identity, JSON.stringify({ v: 1, identity: fresh.export() }));
      storage.setItem(KEYS.flow, JSON.stringify({ ...JSON.parse(storage.getItem(KEYS.flow)), commitment: fresh.commitment.toString() }));
      const tab = nodeKiosk(stack, { storage });
      await rejects(tab.kiosk.openBallot(), "COMMITMENT_NOT_IN_GROUP");
      assert.equal(tab.fetch.log.filter((e) => e.method === "POST").length, 0, "nothing was sent");
      void kiosk;
    });

    it("a commitment that appears only in ANOTHER constituency's group is refused (the kiosk checks its own constituency's group)", async () => {
      const { storage } = forkCredential(V.M);
      storage.setItem(KEYS.flow, JSON.stringify({ ...JSON.parse(storage.getItem(KEYS.flow)), constituency: stack.constituency }));
      const tab = nodeKiosk(stack, { storage });
      await rejects(tab.kiosk.openBallot(), "COMMITMENT_NOT_IN_GROUP");
      const honest = forkCredential(V.M);
      assert.equal((await honest.kiosk.openBallot()).params.constituency.code, "MH-MUM", "in its OWN group it is found");
    });

    it("a relayer that lies about the group is caught: a reordered leaf set, a false root, a false size, another constituency, a self-consistent group that is not the contract's", async () => {
      const lies = {
        "reordered leaves": (path, json) => (path.includes("/groups/") ? { data: { ...json.data, leaves: [json.data.leaves[1], json.data.leaves[0], ...json.data.leaves.slice(2)] } } : undefined),
        "false root": (path, json) => (path.includes("/groups/") ? { data: { ...json.data, root: "12345" } } : undefined),
        "false size": (path, json) => (path.includes("/groups/") ? { data: { ...json.data, size: json.data.size + 1 } } : undefined),
        "another constituency": (path, json) => (path.includes("/groups/") ? { data: { ...json.data, constituencyId: stack.world.ids?.["TN-CHE"] ?? "0x" + "11".repeat(32) } } : undefined),
      };
      const expected = { "reordered leaves": "ROOT_MISMATCH", "false root": "ROOT_MISMATCH", "false size": "GROUP_MISMATCH", "another constituency": "GROUP_MISMATCH" };
      for (const [name, mutate] of Object.entries(lies)) {
        const base = createCookieFetch({ origin: stack.origins.kiosk });
        const tab = forkCredential(V.A, { fetch: relayTamper(base, mutate) });
        await rejects(tab.kiosk.openBallot(), expected[name]);
      }
      // a fake group that is perfectly self-consistent (the relayer appends a leaf and recomputes the root) does not match the CONTRACT's root
      const base = createCookieFetch({ origin: stack.origins.kiosk });
      const forged = relayTamper(base, (path, json) => {
        if (!path.includes("/groups/")) return undefined;
        const leaves = [...json.data.leaves, "123456789123456789"];
        return { data: { ...json.data, leaves, size: leaves.length, root: new Group(leaves.map(BigInt)).root.toString() } };
      });
      await rejects(forkCredential(V.A, { fetch: forged }).kiosk.openBallot(), "ROOT_MISMATCH");
    });

    it("a node that reports a DIFFERENT election key makes the ballot unprovable, not wrong: the contract refuses the proof and nothing is recorded; an off-curve key is refused outright", async () => {
      const before = await totalBallots();
      const { kiosk: probe } = forkCredential(V.A);
      const real = (await probe.chain.pinElection("KA-BLR")).H;
      const other = mul(real, 2n);
      stack.rpc.hooks.tamper = (req, res) => {
        const data = req.params?.[0]?.data ?? "";
        if (req.method !== "eth_call") return null;
        if (data.startsWith(keyViews.getFunction("electionKeyX").selector)) return { ...res, result: word(other[0]) };
        if (data.startsWith(keyViews.getFunction("electionKeyY").selector)) return { ...res, result: word(other[1]) };
        return null;
      };
      try {
        const tab = forkCredential(V.A);
        const open = await tab.kiosk.openBallot();
        assert.deepEqual(open.params.H, other, "the kiosk used what the (malicious) node said");
        await rejects(tab.kiosk.castVote({ choice: 0, open }), "INVALID_VALIDITY_PROOF");
        stack.rpc.hooks.tamper = (req, res) => (req.method === "eth_call" && (req.params?.[0]?.data ?? "").startsWith(keyViews.getFunction("electionKeyX").selector) ? { ...res, result: word(real[0] + 1n) } : null);
        await rejects(forkCredential(V.A).kiosk.openBallot(), "ELECTION_KEY_INVALID");
      } finally {
        stack.rpc.hooks.tamper = null;
      }
      assert.equal(await totalBallots(), before);
    });

    it("a wrong candidate count (K_c) never leaves the kiosk: the contract's own ballot fingerprint refuses the shape before any proof is made", async () => {
      for (const delta of [-1, 1]) {
        const tab = forkCredential(V.A);
        const open = await tab.kiosk.openBallot();
        const wrongChain = { ...tab.chain, pinElection: async (c) => ({ ...(await tab.chain.pinElection(c)), kc: 3 + delta }) };
        const skewed = forkCredential(V.A, { chain: wrongChain });
        const params = await wrongChain.pinElection("KA-BLR");
        await rejects(skewed.kiosk.castVote({ choice: 0, open: { ...open, params } }), "BALLOT_HASH_MISMATCH");
        assert.equal(skewed.fetch.log.filter((e) => e.host === relayHost() && e.method === "POST").length, 0);
      }
    });
  });

  describe("the package cannot be altered: not by the kiosk's own integrity check, and not by the relayer or the contract either", () => {
    let record;
    let open;
    before(async () => {
      const tab = forkCredential(V.A);
      open = await tab.kiosk.openBallot();
      const id = Identity.import(JSON.parse(tab.storage.getItem(KEYS.identity)).identity);
      record = (await buildBallot({ identity: id, params: open.params, choice: 0, group: open.verified.group, chain: tab.chain })).record;
    });
    const send = async (pkg) => (await createCookieFetch()(`${stack.kioskConfig.relayBase}/ballots`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(pkg) })).json();
    const stored = (mutate) => {
      const tab = forkCredential(V.A);
      tab.storage.setItem(KEYS.ballot, JSON.stringify(mutate(clone(record))));
      return tab;
    };

    it("the stored package is intact as built, and ANY edit is refused by the kiosk before it is sent: a ciphertext, the validity proof, the ballot hash, the nullifier of the membership proof", async () => {
      const edits = {
        "a ciphertext coordinate": (r) => ([r.ciphertexts[0].c1[0], r.ciphertexts[1].c1[0]] = [r.ciphertexts[1].c1[0], r.ciphertexts[0].c1[0]]),
        "the validity proof": (r) => (r.validity.proof.pi_a[0] = (BigInt(r.validity.proof.pi_a[0]) + 1n).toString()),
        "the ballot hash": (r) => (r.ballotHash = (BigInt(r.ballotHash) + 1n).toString()),
        "the membership nullifier": (r) => (r.membership.nullifier = (BigInt(r.membership.nullifier) + 1n).toString()),
      };
      for (const [name, edit] of Object.entries(edits)) {
        const tab = stored((r) => (edit(r), r));
        await rejects(tab.kiosk.submit(), "PACKAGE_DAMAGED");
        assert.equal(tab.fetch.log.filter((e) => e.host === relayHost() && e.method === "POST").length, 0, `${name}: nothing was sent`);
      }
    });

    it("sent DIRECTLY to the relayer, bypassing the kiosk, every alteration is still refused (and costs nothing): modified ciphertext, validity proof, Semaphore proof, a nullifier that differs between the two proofs, a changed ballot message", async () => {
      const before = await totalBallots();
      const pkg = toRelayPackage(record);
      const bad = {
        "modified ciphertext": { ...pkg, coords: pkg.coords.map((c, i) => (i === 0 ? pkg.coords[4] : i === 4 ? pkg.coords[0] : c)) },
        "modified validity proof": { ...pkg, validity: { ...pkg.validity, a: [(BigInt(pkg.validity.a[0]) + 1n).toString(), pkg.validity.a[1]] } },
        "modified Semaphore proof": { ...pkg, membership: { ...pkg.membership, points: pkg.membership.points.map((p, i) => (i === 0 ? (BigInt(p) + 1n).toString() : p)) } },
      };
      const expected = { "modified ciphertext": ["INVALID_MEMBERSHIP_PROOF"], "modified validity proof": ["INVALID_VALIDITY_PROOF", "REJECTED_BY_CONTRACT"], "modified Semaphore proof": ["INVALID_MEMBERSHIP_PROOF", "REJECTED_BY_CONTRACT"] };
      for (const [name, p] of Object.entries(bad)) assert.ok(expected[name].includes((await send(p)).error?.code), name);
      // a membership proof by ANOTHER member of the same group, for the same message: its nullifier is not the one the validity proof is about
      const otherId = Identity.import(JSON.parse(V.B.storage.getItem(KEYS.identity)).identity);
      const other = await proveMembership({ identity: otherId, group: open.verified.group, message: BigInt(record.ballotHash), scope: BigInt(record.scope), depth: 20 });
      assert.notEqual(other.nullifier, record.nullifier);
      const differentNullifier = { ...pkg, membership: { merkleTreeDepth: "20", merkleTreeRoot: other.merkleTreeRoot, nullifier: other.nullifier, points: other.points.map(String) } };
      assert.equal((await send(differentNullifier)).error?.code, "INVALID_VALIDITY_PROOF");
      // a membership proof whose MESSAGE is not the ballot hash the contract computes
      const idA = Identity.import(JSON.parse(V.A.storage.getItem(KEYS.identity)).identity);
      const wrongMessage = await proveMembership({ identity: idA, group: open.verified.group, message: BigInt(record.ballotHash) + 1n, scope: BigInt(record.scope), depth: 20 });
      const changedMessage = { ...pkg, membership: { merkleTreeDepth: "20", merkleTreeRoot: wrongMessage.merkleTreeRoot, nullifier: wrongMessage.nullifier, points: wrongMessage.points.map(String) } };
      assert.equal((await send(changedMessage)).error?.code, "INVALID_MEMBERSHIP_PROOF");
      assert.equal(await totalBallots(), before, "none of it was recorded");
    });

    it("a membership proof that is invalid while its root is STILL the contract's current root is not 'refreshed': it is refused as invalid (the kiosk does not loop)", async () => {
      const tab = stored((r) => ((r.membership.points[0] = (BigInt(r.membership.points[0]) + 1n).toString()), r));
      await rejects(tab.kiosk.submit(), "PROOF_REJECTED");
      assert.equal(tab.fetch.log.filter((e) => e.host === relayHost() && e.method === "POST").length, 1, "one attempt, no refresh loop");
    });
  });

  describe("an expired root: ONLY the membership proof is regenerated, for the SAME ballot", () => {
    it("the group moves on and the old root expires: the kiosk keeps the same ciphertexts, validity proof, nullifier and ballot hash, proves membership again against the current root, and the ballot is recorded once", async () => {
      const b = V.B;
      const open = await b.kiosk.openBallot();
      const id = Identity.import(JSON.parse(b.storage.getItem(KEYS.identity)).identity);
      const { record } = await buildBallot({ identity: id, params: open.params, choice: 2, group: open.verified.group, chain: b.chain });
      b.storage.setItem(KEYS.ballot, JSON.stringify(record));
      const oldRoot = record.membership.merkleTreeRoot;
      const before = await totalBallots();

      // more than the root window (one hour) passes, then another voter's cohort changes the group: the old root is now neither current nor recent
      await stack.world.mineAt((await stack.world.clock.nowSeconds()) + 3700);
      await requestedVoter("J", 13);
      await stack.world.nextEpoch();
      assert.equal(await V.J.kiosk.awaitCredential(), "ISSUED");
      const current = await b.chain.currentRoot(open.params.groupId);
      assert.notEqual(current.root.toString(), oldRoot);

      const outcome = await b.kiosk.submit();
      assert.equal(outcome.kind, "RECORDED");
      const posts = b.fetch.log.filter((e) => e.host === relayHost() && e.method === "POST").map((e) => JSON.parse(e.body));
      assert.equal(posts.length, 2, "the first attempt was refused, the second recorded");
      assert.equal(posts[0].membership.merkleTreeRoot, oldRoot);
      assert.equal(posts[1].membership.merkleTreeRoot, current.root.toString(), "a membership proof against the CURRENT root");
      assert.deepEqual(posts[1].coords, posts[0].coords, "same ciphertext");
      assert.deepEqual(posts[1].validity, posts[0].validity, "same validity proof");
      assert.equal(posts[1].membership.nullifier, posts[0].membership.nullifier, "same nullifier");
      assert.notDeepEqual(posts[1].membership.points, posts[0].membership.points, "only the membership proof is new");
      assert.equal(outcome.receipt.ballotHash, "0x" + BigInt(record.ballotHash).toString(16).padStart(64, "0"), "the recorded ballot is the one that was built");
      assert.equal(await totalBallots(), before + 1);
    });
  });

  describe("duplicates, conflicts and a lying confirmation", () => {
    it("the same package again is the same result; a different package under the same nullifier is a conflict; the ballot exists exactly once", async () => {
      const before = await totalBallots();
      const { kiosk, fetch } = V.F;
      const open = await kiosk.openBallot();
      const outcome = await kiosk.castVote({ choice: 1, open });
      assert.equal(outcome.kind, "RECORDED");
      const pkg = JSON.parse(fetch.log.find((e) => e.host === relayHost() && e.method === "POST").body);
      const plain = createCookieFetch();
      const post = async (body) => ({ status: (await plain(`${stack.kioskConfig.relayBase}/ballots`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })), body });
      const again = await post(pkg);
      const json = await again.status.json();
      assert.equal(again.status.status, 200);
      assert.equal(json.data.txHash, outcome.receipt.txHash, "recovered, not resent");
      const conflicting = await post({ ...pkg, coords: pkg.coords.map((c, i) => (i === 0 ? pkg.coords[4] : i === 4 ? pkg.coords[0] : c)) });
      assert.equal(conflicting.status.status, 409);
      assert.equal((await conflicting.status.json()).error.code, "NULLIFIER_CONFLICT");
      assert.equal(await totalBallots(), before + 1);
    });

    it("a node that reports the recorded ballot with a DIFFERENT ballot hash is not believed: no receipt, and the ballot (recorded for real) is confirmed once the node is honest", async () => {
      const g = V.G;
      const before = await totalBallots();
      const flip = (result) => ({ ...result, data: "0x" + "00".repeat(31) + "ff" + result.data.slice(66) });
      stack.rpc.hooks.tamper = (req, res) => {
        if (req.method === "eth_getLogs" && Array.isArray(res.result)) return { ...res, result: res.result.map(flip) };
        if (req.method === "eth_getTransactionReceipt" && res.result?.logs) return { ...res, result: { ...res.result, logs: res.result.logs.map(flip) } };
        return null;
      };
      try {
        const open = await g.kiosk.openBallot();
        await rejects(g.kiosk.castVote({ choice: 0, open }), "CONFIRMATION_MISMATCH");
        assert.equal(g.kiosk.session.getReceipt(), null, "no receipt from a confirmation that does not match");
        assert.ok(g.kiosk.session.getBallot(), "the package is kept");
      } finally {
        stack.rpc.hooks.tamper = null;
      }
      assert.equal(await totalBallots(), before + 1, "the relayer really recorded it");
      assert.equal((await g.kiosk.submit()).kind, "RECORDED", "and the honest chain confirms it, without sending anything again");
      assert.equal(await totalBallots(), before + 1);
    });
  });

  describe("browser and network failures at every boundary: the vote still happens at most once", () => {
    it("C: reload after CREDENTIAL_ISSUED but before the proofs (anonymous from storage, never the identity service), reload after the proofs but before the relay POST: the SAME package is sent", async () => {
      const before = await totalBallots();
      const tab1 = reload(V.C);
      assert.equal(await tab1.kiosk.boot(), "ballot");
      assert.equal(tab1.kiosk.guard.locked, true, "a reloaded tab with an issued credential starts anonymous");
      const logLength = V.C.fetch.log.length;
      const open = await tab1.kiosk.openBallot();
      const id = Identity.import(JSON.parse(tab1.storage.getItem(KEYS.identity)).identity);
      const { record } = await buildBallot({ identity: id, params: open.params, choice: 0, group: open.verified.group, chain: tab1.chain });
      tab1.storage.setItem(KEYS.ballot, JSON.stringify(record));
      const tab2 = reload(V.C);
      assert.equal(await tab2.kiosk.boot(), "submit");
      const outcome = await tab2.kiosk.submit();
      assert.equal(outcome.kind, "RECORDED");
      const sent = V.C.fetch.log.slice(logLength).filter((e) => e.host === identityHost());
      assert.deepEqual(sent, [], "no identity request after issuance, in any tab");
      assert.equal(JSON.parse(V.C.fetch.log.filter((e) => e.method === "POST" && e.host === relayHost()).at(-1).body).membership.nullifier, record.nullifier);
      assert.equal(await totalBallots(), before + 1);
    });

    it("D: the relayer is down: the package is kept and sent when it is back; one ballot", async () => {
      const before = await totalBallots();
      let down = 3;
      const base = createCookieFetch({ origin: stack.origins.kiosk });
      const flaky = (url, init) => {
        if (url.startsWith(stack.kioskConfig.relayBase) && init?.method === "POST" && down > 0) {
          down--;
          return Promise.reject(new TypeError("fetch failed"));
        }
        return base(url, init);
      };
      Object.assign(flaky, { log: base.log, jar: base.jar, cookiesFor: base.cookiesFor });
      const tab = forkCredential(V.D, { fetch: flaky });
      const open = await tab.kiosk.openBallot();
      await assert.rejects(tab.kiosk.castVote({ choice: 1, open }), (err) => err.code === "RELAY_UNREACHABLE" && err.retryable === true);
      const stored = tab.storage.getItem(KEYS.ballot);
      assert.ok(stored, "the package survived");
      for (let i = 0; i < 2; i++) await assert.rejects(tab.kiosk.submit(), (err) => err.code === "RELAY_UNREACHABLE");
      const outcome = await tab.kiosk.submit();
      assert.equal(outcome.kind, "RECORDED");
      assert.equal(await totalBallots(), before + 1);
      assert.ok(base.log.filter((e) => e.method === "POST" && e.host === relayHost()).every((e) => JSON.parse(e.body).membership.nullifier === JSON.parse(stored).nullifier), "every attempt carried the same nullifier");
    });

    it("E: the RPC node is down after the relayer confirmed, then answers but cannot show the event yet (confirmation timeout): PENDING, then recovery; one ballot", async () => {
      const before = await totalBallots();
      const tab = forkCredential(V.E, { config: { confirmTimeoutMs: 600, pollMs: 100 } });
      const open = await tab.kiosk.openBallot();
      stack.rpc.hooks.failNext = 0;
      stack.rpc.hooks.tamper = (req, res) => (req.method === "eth_getLogs" ? { ...res, result: [] } : req.method === "eth_getTransactionReceipt" ? { ...res, result: null } : null); // the node cannot show the event yet
      let first;
      try {
        first = await tab.kiosk.castVote({ choice: 2, open });
      } finally {
        stack.rpc.hooks.tamper = null;
      }
      assert.deepEqual(first, { kind: "PENDING", reason: "CONFIRMATION" });
      assert.equal(tab.storage.getItem(KEYS.receipt), null);
      assert.equal(await totalBallots(), before + 1, "the ballot IS recorded");
      stack.rpc.hooks.failNext = 3;
      await assert.rejects(tab.kiosk.submit(), (err) => err.code === "CHAIN_UNREACHABLE" && err.retryable);
      stack.rpc.hooks.failNext = 0;
      const outcome = await tab.kiosk.submit();
      assert.equal(outcome.kind, "RECORDED");
      assert.equal(await totalBallots(), before + 1, "recovered without sending anything again");
    });

    it("G2: the relayer recorded the ballot but the kiosk never saw the answer and the page was reloaded: the chain is asked first, the receipt is produced, nothing is resent", async () => {
      const before = await totalBallots();
      const base = createCookieFetch({ origin: stack.origins.kiosk });
      let dropped = false;
      const lossy = async (url, init) => {
        const res = await base(url, init);
        if (!dropped && url.startsWith(stack.kioskConfig.relayBase) && init?.method === "POST") {
          dropped = true;
          throw new TypeError("connection reset");
        }
        return res;
      };
      Object.assign(lossy, { log: base.log, jar: base.jar, cookiesFor: base.cookiesFor });
      const tab = forkCredential(V.G2, { fetch: lossy });
      const open = await tab.kiosk.openBallot();
      await rejects(tab.kiosk.castVote({ choice: 0, open }), "RELAY_UNREACHABLE");
      assert.equal(await totalBallots(), before + 1);
      const afterReload = reload({ storage: tab.storage, fetch: base });
      assert.equal(await afterReload.kiosk.boot(), "submit");
      const posts = base.log.filter((e) => e.method === "POST" && e.host === relayHost()).length;
      assert.equal((await afterReload.kiosk.submit()).kind, "RECORDED");
      assert.equal(base.log.filter((e) => e.method === "POST" && e.host === relayHost()).length, posts, "the chain already showed the ballot: no second POST");
      assert.equal(await totalBallots(), before + 1);
    });
  });

  describe("device loss fails CLOSED: no second credential, ever", () => {
    it("L: the credential was DELIVERED but the answer was lost on the way: the next poll finds no session, the PUBLIC chain shows the commitment, and the kiosk continues anonymously (one commitment in total, no identity request after the 401)", async () => {
      assert.equal(await V.L.kiosk.boot(), "waiting");
      await stack.world.nextEpoch(); // the cohort (with L's commitment) is inserted; the delivery to L is then dropped
      const lost = await V.L.kiosk.awaitCredential().catch((err) => err);
      assert.equal(lost.code, "IDENTITY_UNREACHABLE", "the voter sees a retryable network error");
      assert.equal(V.L.kiosk.guard.locked, false);
      assert.equal(await V.L.kiosk.awaitCredential(), "ISSUED", "the retry finds the credential on the PUBLIC chain");
      assert.equal(V.L.kiosk.guard.locked, true, "anonymous mode");
      const calls = V.L.fetch.log.filter((e) => e.host === identityHost());
      const unauthorized = calls.findIndex((e) => e.status === 401);
      assert.ok(unauthorized >= 0, "the session really was gone");
      assert.equal(unauthorized, calls.length - 1, "and the 401 was the LAST identity request");
      assert.equal(calls.filter((e) => e.method === "POST" && e.path.endsWith("/credential")).length, 1, "one commitment in total");
      const open = await V.L.kiosk.openBallot();
      const outcome = await V.L.kiosk.castVote({ choice: 0, open });
      assert.equal(outcome.kind, "RECORDED", "and the voter votes");
      assert.equal(V.L.fetch.log.filter((e) => e.host === identityHost()).length, calls.length, "no identity request after the vote either");
      const record = (await stack.dumpIdentityDb()).includes(V.L.voter.id) ? "present" : "absent";
      assert.equal(record, "present", "the voter's identity record exists on the identity side (and nothing of the ballot: scanned elsewhere)");
    });

    it("H: the credential was issued and the tab is gone: logging in again is refused by the identity service, the kiosk never asks for another commitment, nothing changes on-chain or in the identity store", async () => {
      const groupSize = (await V.H.chain.currentRoot((await V.H.kiosk.openBallot()).params.groupId)).size;
      const fresh = nodeKiosk(stack); // an empty tab with an empty cookie jar
      assert.equal(await fresh.kiosk.boot(), "login");
      await rejects(fresh.kiosk.login(V.H.voter.email, V.H.voter.password), "CREDENTIAL_ALREADY_ISSUED");
      assert.equal(fresh.fetch.log.filter((e) => e.path.endsWith("/credential")).length, 0, "no credential request at all");
      assert.equal(await fresh.kiosk.boot(), "login", "and no session exists");
      const after = JSON.parse(await stack.dumpIdentityDb()).credentialissuances_v3.filter((r) => String(r.voterId?.$oid ?? r.voterId) === String(V.H.voter.doc._id));
      assert.deepEqual(after.map((r) => r.state), ["ISSUED"]);
      assert.equal((await V.H.chain.currentRoot((await V.H.kiosk.openBallot()).params.groupId)).size, groupSize);
    });

    it("I: a credential was requested, the tab was destroyed while waiting and again after issuance: the kiosk said credential-lost both times and sent exactly ONE commitment in total", async () => {
      assert.equal(V.I.fetch.log.filter((e) => e.method === "POST" && e.path.endsWith("/credential")).length, 1);
      const records = JSON.parse(await stack.dumpIdentityDb()).credentialissuances_v3.filter((r) => String(r.voterId?.$oid ?? r.voterId) === String(V.I.voter.doc._id));
      assert.deepEqual(records.map((r) => r.state), ["ISSUED"], "one record, issued once");
    });
  });

  describe("phase changes", () => {
    it("the election closes before the ballot is recorded: the kiosk refuses to start a vote, and a prepared package is refused by the relayer (nothing is recorded, nothing is retried forever)", async () => {
      const k = V.K;
      const open = await k.kiosk.openBallot();
      const id = Identity.import(JSON.parse(k.storage.getItem(KEYS.identity)).identity);
      const { record } = await buildBallot({ identity: id, params: open.params, choice: 1, group: open.verified.group, chain: k.chain });
      k.storage.setItem(KEYS.ballot, JSON.stringify(record));
      await (await stack.world.voteChain.closeIssuance()).wait();
      await stack.world.mineAt((await stack.world.clock.nowSeconds()) + stack.CLOSE_GRACE + 5);
      await (await stack.world.voteChain.closeElection()).wait();
      const before = await totalBallots();
      await assert.rejects(k.kiosk.submit(), (err) => err.code === "ELECTION_CLOSED" && err.retryable === false);
      await rejects(forkCredential(V.J).kiosk.openBallot(), "ELECTION_CLOSED");
      assert.equal(await totalBallots(), before);
      assert.equal(k.storage.getItem(KEYS.receipt), null);
    });
  });
});
