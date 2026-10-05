// scripts/serve.mjs sends the production headers on EVERY answer and never serves anything outside the directory it was given.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCsp } from "../../scripts/csp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const services = { identityBase: "http://id.test:1/api", relayBase: "http://relay.test:2/v1", rpcUrl: "http://rpc.test:3" };
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); }); });
/** raw request: the client library must not normalise the path for us */
const raw = (port: number, requestPath: string) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET" }, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body })); });
  req.on("error", reject);
  req.end();
});

describe("scripts/serve.mjs", () => {
  let base: string, dir: string, sibling: string, child: ReturnType<typeof spawn>, port: number;
  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-serve-"));
    dir = path.join(base, "dist");
    sibling = path.join(base, "dist-secret"); // shares the served directory's name as a PREFIX
    fs.mkdirSync(dir);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><meta http-equiv="Content-Security-Policy" content="${buildCsp(services, { meta: true })}"><p>kiosk</p>`);
    fs.writeFileSync(path.join(dir, "model.wasm"), "wasm");
    fs.writeFileSync(path.join(sibling, "secret.txt"), "TOP SECRET");
    fs.writeFileSync(path.join(base, "outside.txt"), "OUTSIDE");
    port = await freePort();
    child = spawn(process.execPath, [path.join(root, "scripts", "serve.mjs"), "--dir", dir, "--port", String(port)], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) { try { await raw(port, "/"); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  });
  after(() => { child.kill("SIGTERM"); fs.rmSync(base, { recursive: true, force: true }); });

  it("sends the CSP and the hardening headers on pages, assets and errors alike; the page is never cached, assets are typed", async () => {
    for (const p of ["/", "/model.wasm", "/missing.js", "/%zz"]) {
      const res = await raw(port, p);
      assert.ok(res.headers["content-security-policy"]?.includes("default-src 'none'"), p);
      assert.equal(res.headers["x-content-type-options"], "nosniff", p);
      assert.equal(res.headers["x-frame-options"], "DENY", p);
      assert.equal(res.headers["referrer-policy"], "no-referrer", p);
    }
    assert.equal((await raw(port, "/")).headers["cache-control"], "no-store");
    assert.equal((await raw(port, "/model.wasm")).headers["content-type"], "application/wasm");
    assert.match((await raw(port, "/")).body, /kiosk/);
    assert.equal((await raw(port, "/missing.js")).status, 404);
    assert.equal((await raw(port, "/%zz")).status, 400);
  });

  it("never leaves the served directory: not by .., not by an encoded .., not into a sibling directory that merely shares its prefix", async () => {
    for (const p of ["/../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/../dist-secret/secret.txt", "/%2e%2e/dist-secret/secret.txt", "/..%2fdist-secret%2fsecret.txt", "/..%2f..%2f..%2f..%2fetc%2fpasswd"]) {
      const res = await raw(port, p);
      assert.ok(res.status === 403 || res.status === 404, `${p} -> ${res.status}`);
      assert.ok(!/OUTSIDE|TOP SECRET|root:/.test(res.body), p);
    }
  });
});
