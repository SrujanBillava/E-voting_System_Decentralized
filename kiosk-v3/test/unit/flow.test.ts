// The kiosk ENGINE's decisions, with a fake identity service, a fake chain and an in-memory sessionStorage (no network, no proofs).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KEYS, KioskError, createKiosk, memoryStorage } from "../../src/core/index.ts";
import type { ChainReader, FetchLike, KioskConfig } from "../../src/core/index.ts";
import { constituencyIdOf } from "../../src/crypto/privacy.ts";

const CID = constituencyIdOf("KA-BLR");
const config: KioskConfig = { identityBase: "http://id.test/api", relayBase: "http://relay.test/v1", rpcUrl: "http://rpc.test", chainId: 31337, contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", pollMs: 1, issuanceTimeoutMs: 50, confirmTimeoutMs: 50 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const data = (d: unknown) => json(200, { data: d });
const err = (status: number, code: string) => json(status, { error: { code, message: code } });

/** a scripted identity service: `script.get` answers GET /credential in order */
function identity(over: { status?: () => Response; polls?: (() => Response)[]; afterPolls?: () => Response; onCredentialPost?: () => Response } = {}) {
  const log: { method: string; path: string; body: string | null; credentials: unknown }[] = [];
  const polls = [...(over.polls ?? [])];
  const fetch: FetchLike = async (url, init = {}) => {
    const path = new URL(url).pathname.replace("/api", "");
    log.push({ method: init.method ?? "GET", path, body: (init.body as string | undefined) ?? null, credentials: init.credentials });
    if (path === "/status") return over.status?.() ?? err(401, "UNAUTHENTICATED");
    if (path === "/eligibility/check") return data({ eligible: true, stage: "ELIGIBLE", constituency: { code: "KA-BLR", name: "Bengaluru South" } });
    if (path === "/credential" && init.method === "POST") return over.onCredentialPost?.() ?? json(202, { data: { state: "PENDING" } });
    if (path === "/credential") return (polls.shift() ?? over.afterPolls ?? (() => data({ state: "PENDING" })))();
    throw new Error(`unexpected ${path}`);
  };
  return { fetch, log };
}
const issued = () => data({ state: "CREDENTIAL_ISSUED", constituency: { code: "KA-BLR", id: CID }, group: { groupId: "7", merkleTreeDepth: 20, root: "1", size: 1 } });
const chain = (member = true) => ({ pinElection: async () => ({ groupId: 7n }), hasMember: async () => member }) as unknown as ChainReader;
function kiosk(svc: ReturnType<typeof identity>, over: { storage?: ReturnType<typeof memoryStorage>; chain?: ChainReader; clock?: { t: number } } = {}) {
  const storage = over.storage ?? memoryStorage();
  const clock = over.clock ?? { t: 0 };
  return { storage, engine: createKiosk({ config, fetch: svc.fetch, storage, chain: over.chain ?? chain(), sleep: async () => void (clock.t += 10), now: () => clock.t }) };
}
const flow = (stage: string) => JSON.stringify({ v: 1, stage, constituency: { code: "KA-BLR", id: CID }, commitment: "123" });

describe("boot(): where a page load resumes", () => {
  it("a finished vote shows the receipt; a stored package is resent; a held credential resumes", async () => {
    const svc = identity();
    const a = kiosk(svc);
    a.storage.setItem(KEYS.receipt, JSON.stringify({ v: 1, txHash: "0x1" }));
    assert.equal(await a.engine.boot(), "receipt");
    const b = kiosk(svc);
    b.storage.setItem(KEYS.ballot, JSON.stringify({ v: 1, nullifier: "1", digest: "d", ciphertexts: [] }));
    assert.equal(await b.engine.boot(), "submit");
    assert.equal(svc.log.length, 0, "none of these asked the identity service anything");
  });

  it("with a flow but NO private identity it fails closed ('credential-lost') without any request; with both it resumes", async () => {
    const svc = identity();
    const lost = kiosk(svc);
    lost.storage.setItem(KEYS.flow, flow("CREDENTIAL_REQUESTED"));
    assert.equal(await lost.engine.boot(), "credential-lost");
    const waiting = kiosk(svc);
    waiting.storage.setItem(KEYS.flow, flow("CREDENTIAL_REQUESTED"));
    waiting.storage.setItem(KEYS.identity, JSON.stringify({ v: 1, identity: "x" }));
    // an export that is not this tab's identity (damaged, or from elsewhere) is as good as none: it is never used and never replaced
    assert.equal(await waiting.engine.boot(), "credential-lost");
    await assert.rejects(waiting.engine.beginCredential(), (e: unknown) => e instanceof KioskError && e.code === "CREDENTIAL_LOST");
    assert.equal(JSON.parse(waiting.storage.getItem(KEYS.flow)!).commitment, "123", "the recorded request was not overwritten with a new commitment");
    // and a real identity that matches the recorded commitment resumes
    const real = kiosk(svc);
    await real.engine.beginCredential();
    const stored = real.storage.dump();
    const resumed = kiosk(svc, { storage: Object.assign(memoryStorage(), {}) });
    for (const [k, v] of Object.entries(stored)) resumed.storage.setItem(k, v);
    assert.equal(await resumed.engine.boot(), "waiting");
  });

  it("a fresh page asks the identity service where the voter is; a session that is gone means 'login'", async () => {
    for (const [status, expected] of [[() => err(401, "UNAUTHENTICATED"), "login"], [() => err(401, "SESSION_EXPIRED"), "login"], [() => err(409, "ISSUANCE_CLOSED"), "login"], [() => data({ stage: "AUTHENTICATED" }), "face"], [() => data({ stage: "FACE_VERIFIED" }), "eligibility"], [() => data({ stage: "ELIGIBLE" }), "eligibility"], [() => data({ stage: "COMMITMENT_PENDING" }), "credential-lost"], [() => data({ stage: "CREDENTIAL_ISSUED" }), "credential-lost"]] as const) {
      assert.equal(await kiosk(identity({ status })).engine.boot(), expected);
    }
    await assert.rejects(kiosk(identity({ status: () => err(503, "CHAIN_UNAVAILABLE") })).engine.boot(), (e: unknown) => e instanceof KioskError && e.retryable);
  });
});

describe("the credential: the identity service learns ONLY the public commitment, once", () => {
  it("creates the Semaphore identity locally and sends exactly {commitment}; a second call REUSES the identity (same commitment, never a fresh one)", async () => {
    const svc = identity();
    const { engine, storage } = kiosk(svc);
    const first = await engine.beginCredential();
    assert.deepEqual(first.constituency.code, "KA-BLR");
    const exported = JSON.parse(storage.getItem(KEYS.identity)!).identity as string;
    const commitment = JSON.parse(storage.getItem(KEYS.flow)!).commitment as string;
    await engine.beginCredential(); // e.g. after a network error
    const posts = svc.log.filter((e) => e.method === "POST" && e.path === "/credential");
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map((p) => JSON.parse(p.body!)), [{ commitment }, { commitment }], "the same commitment both times");
    assert.ok(posts.every((p) => p.credentials === "include"));
    assert.ok(!svc.log.some((e) => (e.body ?? "").includes(exported)), "the private identity was never sent");
    assert.equal(JSON.parse(storage.getItem(KEYS.identity)!).identity, exported, "and the stored identity did not change");
  });

  it("on CREDENTIAL_ISSUED the guard locks for good: the identity service is never asked again", async () => {
    const svc = identity({ polls: [() => data({ state: "PENDING" }), () => data({ state: "PENDING" }), issued] });
    const { engine, storage } = kiosk(svc);
    await engine.beginCredential();
    assert.equal(await engine.awaitCredential(), "ISSUED");
    assert.equal(engine.guard.locked, true);
    assert.equal(JSON.parse(storage.getItem(KEYS.flow)!).stage, "CREDENTIAL_ISSUED");
    const before = svc.log.length;
    await assert.rejects(engine.identityApi.status(), (e: unknown) => e instanceof KioskError && e.code === "IDENTITY_LOCKED");
    await assert.rejects(engine.login("a", "b"), (e: unknown) => e instanceof KioskError && e.code === "IDENTITY_LOCKED");
    assert.equal(svc.log.length, before, "not a single further identity request");
    // a page that reloads AFTER issuance starts locked
    const reloaded = kiosk(identity(), { storage });
    assert.equal(reloaded.engine.guard.locked, true);
  });

  it("LOST DELIVERY: if the 'issued' answer never arrived, the next poll finds no session (401); the PUBLIC chain says the commitment landed, so the kiosk continues without asking the identity service anything more", async () => {
    const svc = identity({ polls: [() => err(401, "UNAUTHENTICATED")], afterPolls: () => err(401, "UNAUTHENTICATED") });
    const { engine, storage } = kiosk(svc, { chain: chain(true) });
    await engine.beginCredential();
    assert.equal(await engine.awaitCredential(), "ISSUED");
    assert.equal(engine.guard.locked, true);
    assert.equal(JSON.parse(storage.getItem(KEYS.flow)!).stage, "CREDENTIAL_ISSUED");
    assert.equal(svc.log.filter((e) => e.path === "/credential" && e.method === "GET").length, 1, "one poll, and no more after the 401");
  });

  it("…and if the chain does not list it yet, the kiosk keeps waiting on the CHAIN (not the identity service) and reports PENDING at the timeout", async () => {
    const svc = identity({ polls: [() => err(401, "SESSION_EXPIRED")], afterPolls: () => err(401, "SESSION_EXPIRED") });
    const { engine } = kiosk(svc, { chain: chain(false) });
    await engine.beginCredential();
    assert.equal(await engine.awaitCredential(), "PENDING");
    assert.equal(svc.log.filter((e) => e.path === "/credential" && e.method === "GET").length, 1);
    assert.equal(engine.guard.locked, false, "nothing is issued yet");
  });

  it("a reload between 'sent' and 'recorded' (STAGE_REQUIRED) re-sends the SAME commitment; a cancelled request wipes the tab; a credential for ANOTHER constituency is refused", async () => {
    const same = identity({ polls: [() => err(409, "STAGE_REQUIRED"), issued] });
    const a = kiosk(same);
    await a.engine.beginCredential();
    assert.equal(await a.engine.awaitCredential(), "ISSUED");
    const commitments = same.log.filter((e) => e.method === "POST" && e.path === "/credential").map((e) => JSON.parse(e.body!).commitment);
    assert.equal(commitments.length, 2);
    assert.equal(commitments[0], commitments[1]);

    const cancelled = identity({ polls: [() => err(409, "CREDENTIAL_CANCELLED")] });
    const b = kiosk(cancelled);
    await b.engine.beginCredential();
    await assert.rejects(b.engine.awaitCredential(), (e: unknown) => e instanceof KioskError && e.code === "CREDENTIAL_CANCELLED");
    assert.deepEqual(b.engine.session.keys(), [], "nothing was issued, so the tab starts again from the login");

    const other = identity({ polls: [() => data({ state: "CREDENTIAL_ISSUED", constituency: { code: "KA-MYS", id: "0x" + "cd".repeat(32) }, group: {} })] });
    const c = kiosk(other);
    await c.engine.beginCredential();
    await assert.rejects(c.engine.awaitCredential(), (e: unknown) => e instanceof KioskError && e.code === "CONSTITUENCY_CHANGED");
    assert.equal(c.engine.guard.locked, false);
  });
});
