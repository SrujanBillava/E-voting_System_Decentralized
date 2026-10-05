import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnonymousGuard, KioskError, createIdentityClient, createRelayClient } from "../../src/core/index.ts";

const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
function spy(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  return { calls, fetch: async (url: string, init: RequestInit = {}) => (calls.push({ url, init }), handler(url, init)) };
}
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (err: unknown) => err instanceof KioskError && err.code === code);

describe("the identity client: the ONLY code that sends the identity cookie", () => {
  it("sends credentials: include, to the identity base only, with no redirects, no referrer, no cache", async () => {
    const { calls, fetch } = spy(() => reply(200, { data: { stage: "AUTHENTICATED" } }));
    const client = createIdentityClient({ fetch, base: "http://id.example:1/api", guard: new AnonymousGuard() });
    await client.status();
    await client.login("a@b.c", "pw");
    assert.equal(calls.length, 2);
    for (const { url, init } of calls) {
      assert.ok(url.startsWith("http://id.example:1/api/"));
      assert.equal(init.credentials, "include");
      assert.equal(init.redirect, "error");
      assert.equal(init.referrerPolicy, "no-referrer");
      assert.equal(init.cache, "no-store");
    }
    assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { identifier: "a@b.c", password: "pw" });
  });

  it("once the guard is locked EVERY method refuses BEFORE touching the network (there is no unlock)", async () => {
    const { calls, fetch } = spy(() => reply(200, { data: {} }));
    const guard = new AnonymousGuard();
    const client = createIdentityClient({ fetch, base: "http://id.example:1/api", guard });
    guard.lock();
    assert.equal(guard.locked, true);
    const calls2 = [() => client.login("a", "b"), () => client.logout(), () => client.status(), () => client.faceStatus(), () => client.faceChallenge(), () => client.faceVerify({ challenge: "c", descriptor: [] }), () => client.eligibility(), () => client.requestCredential("1"), () => client.pollCredential()];
    for (const call of calls2) await rejects(call(), "IDENTITY_LOCKED");
    assert.equal(calls.length, 0, "not one request was made");
    assert.equal(typeof (guard as unknown as { unlock?: unknown }).unlock, "undefined");
  });

  it("offers identity operations only: no ballot, receipt, result or relay method exists on it", () => {
    const client = createIdentityClient({ fetch: spy(() => reply(200, {})).fetch, base: "http://x", guard: new AnonymousGuard() });
    assert.deepEqual(Object.keys(client).sort(), ["eligibility", "faceChallenge", "faceStatus", "faceVerify", "login", "logout", "pollCredential", "requestCredential", "status"]);
  });

  it("maps failures to stable codes: service errors keep their code; 5xx and 429 are retryable; a dead network and a non-JSON answer are their own codes", async () => {
    const make = (handler: Parameters<typeof spy>[0]) => createIdentityClient({ fetch: spy(handler).fetch, base: "http://x", guard: new AnonymousGuard() });
    await assert.rejects(make(() => reply(409, { error: { code: "CREDENTIAL_ALREADY_ISSUED", message: "A credential has already been issued" } })).status(), (e: unknown) => e instanceof KioskError && e.code === "CREDENTIAL_ALREADY_ISSUED" && e.status === 409 && !e.retryable);
    await assert.rejects(make(() => reply(503, { error: { code: "CHAIN_UNAVAILABLE", message: "x" } })).status(), (e: unknown) => e instanceof KioskError && e.retryable);
    await assert.rejects(make(() => reply(429, { error: { code: "RATE_LIMITED", message: "x" } })).status(), (e: unknown) => e instanceof KioskError && e.retryable);
    await rejects(make(() => reply(200, "<html>not json")).status(), "IDENTITY_BAD_RESPONSE");
    await rejects(make(() => reply(200, { nodata: true })).status(), "BAD_RESPONSE");
    await assert.rejects(make(() => Promise.reject(new TypeError("fetch failed"))).status(), (e: unknown) => e instanceof KioskError && e.code === "IDENTITY_UNREACHABLE" && e.retryable);
    await assert.rejects(make(() => reply(500, {})).status(), (e: unknown) => e instanceof KioskError && e.code === "UNKNOWN" && e.retryable, "a 5xx without a recognisable body is an UNKNOWN, retryable failure");
  });
});

describe("the relay client: anonymous by construction", () => {
  it("sends credentials: omit on EVERY call, and no header but Accept and Content-Type", async () => {
    const { calls, fetch } = spy((url) => reply(url.includes("/groups/") ? 200 : 202, { data: { state: "QUEUED", nullifier: "1", constituencyId: "0x1" } }));
    const client = createRelayClient({ fetch, base: "http://relay.example:2/v1" });
    await client.getGroup("0xabc");
    await client.postBallot({ constituencyId: "0x1", membership: { merkleTreeDepth: "20", merkleTreeRoot: "1", nullifier: "2", points: [] }, coords: [], validity: { a: [], b: [], c: [] } });
    await client.getBallot("123");
    assert.equal(calls.length, 3);
    for (const { init } of calls) {
      assert.equal(init.credentials, "omit");
      const names = Object.keys(init.headers as Record<string, string>).map((h) => h.toLowerCase());
      assert.ok(names.every((n) => ["accept", "content-type"].includes(n)), names.join());
      assert.equal(init.referrerPolicy, "no-referrer");
    }
    assert.equal(calls[2]!.url, "http://relay.example:2/v1/ballots/123");
  });

  it("is a different set of operations from the identity client's, and cannot be given the identity guard or base", () => {
    const client = createRelayClient({ fetch: spy(() => reply(200, {})).fetch, base: "http://x" });
    assert.deepEqual(Object.keys(client).sort(), ["getBallot", "getGroup", "postBallot"]);
  });

  it("returns the relay's refusal as data (a code the engine decides on), and turns a failed group read into RELAY_<code>", async () => {
    const client = createRelayClient({ fetch: spy((url) => (url.includes("/groups/") ? reply(404, { error: { code: "UNKNOWN_CONSTITUENCY", message: "x" } }) : reply(422, { error: { code: "INVALID_MEMBERSHIP_PROOF", message: "stale" } }))).fetch, base: "http://x" });
    assert.deepEqual(await client.postBallot({} as never), { ok: false, status: 422, code: "INVALID_MEMBERSHIP_PROOF", message: "stale" });
    await rejects(client.getGroup("0x1"), "RELAY_UNKNOWN_CONSTITUENCY");
  });
});
