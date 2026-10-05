// The proving artifacts are fetched from the kiosk's own origin and checked against pinned hashes BEFORE any proof can use them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { KioskError } from "../../src/core/index.ts";
import { artifactsInstalled, loadProvingArtifacts } from "../../src/crypto/artifacts.ts";

const dir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."), "public", "artifacts");
const have = fs.existsSync(path.join(dir, "ballot_validity_final.zkey"));
const serve = (tamper?: string, calls: { url: string; init?: RequestInit }[] = []) => async (url: string | URL | Request, init?: RequestInit) => {
  const name = String(url).split("/").pop()!;
  calls.push({ url: String(url), init });
  if (tamper === "404" && name === "semaphore-20.zkey") return new Response("nope", { status: 404 });
  const bytes = fs.readFileSync(path.join(dir, name));
  return new Response(tamper === name ? Buffer.concat([bytes.subarray(0, 100), Buffer.from("TAMPERED"), bytes.subarray(108)]) : bytes);
};

describe("loadProvingArtifacts", { skip: have ? false : 'run "npm run assets" first' }, () => {
  it("refuses a file whose SHA-256 is not the pinned one, installs NOTHING, and says so", async () => {
    await assert.rejects(loadProvingArtifacts({ fetch: serve("ballot_validity.wasm") as typeof fetch }), (e: unknown) => e instanceof KioskError && e.code === "PROVING_FILES_REJECTED" && !e.retryable);
    assert.equal(artifactsInstalled(), false);
  });

  it("a network failure is a retryable error, and a failure is never cached: the next call tries again", async () => {
    await assert.rejects(loadProvingArtifacts({ fetch: serve("404") as typeof fetch }), (e: unknown) => e instanceof KioskError && e.code === "PROVING_FILES_UNAVAILABLE" && e.retryable);
    await assert.rejects(loadProvingArtifacts({ fetch: (async () => Promise.reject(new TypeError("offline"))) as typeof fetch }), (e: unknown) => e instanceof KioskError && e.code === "PROVING_FILES_UNAVAILABLE");
    assert.equal(artifactsInstalled(), false);
  });

  it("accepts exactly the pinned files, asks the kiosk's own origin only, with no credentials and no referrer, then remembers", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    await loadProvingArtifacts({ base: "/artifacts/", fetch: serve(undefined, calls) as typeof fetch });
    assert.equal(artifactsInstalled(), true);
    assert.deepEqual(calls.map((c) => c.url).sort(), ["/artifacts/ballot_validity.wasm", "/artifacts/ballot_validity_final.zkey", "/artifacts/semaphore-20.wasm", "/artifacts/semaphore-20.zkey"]);
    assert.ok(calls.every((c) => c.init?.credentials === "omit" && c.init?.referrerPolicy === "no-referrer"));
    const again: unknown[] = [];
    await loadProvingArtifacts({ fetch: (async (u: string) => (again.push(u), new Response("x"))) as unknown as typeof fetch });
    assert.equal(again.length, 0, "already loaded: nothing is fetched twice");
  });
});
