import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCsp, securityHeaders } from "../../scripts/csp.mjs";

const services = { identityBase: "http://id.votechain.localhost:5100/api/v3/voter", relayBase: "http://relay.votechain.localhost:5200/v1", rpcUrl: "http://rpc.votechain.localhost:8545" };

describe("the Content-Security-Policy", () => {
  const csp: string = buildCsp(services);
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(name + " ") || d === name);
  it("denies everything by default and allows only what the kiosk needs", () => {
    assert.equal(directive("default-src"), "default-src 'none'");
    assert.equal(directive("script-src"), "script-src 'self' 'wasm-unsafe-eval'");
    assert.equal(directive("style-src"), "style-src 'self'");
    assert.equal(directive("font-src"), "font-src 'none'");
    assert.equal(directive("object-src"), "object-src 'none'");
    assert.equal(directive("base-uri"), "base-uri 'none'");
    assert.equal(directive("form-action"), "form-action 'none'");
    assert.equal(directive("frame-src"), "frame-src 'none'");
    assert.equal(directive("frame-ancestors"), "frame-ancestors 'none'");
    assert.equal(directive("worker-src"), "worker-src 'self' blob:");
    assert.ok(!csp.replace("'wasm-unsafe-eval'", "").includes("unsafe"), "no unsafe-inline, no unsafe-eval");
    assert.ok(!/\*|https:\s|data:/.test(csp), "no wildcard, no blanket scheme");
  });
  it("lets the page connect to itself and the three configured ORIGINS only (paths dropped, duplicates removed)", () => {
    assert.equal(directive("connect-src"), "connect-src 'self' http://id.votechain.localhost:5100 http://relay.votechain.localhost:5200 http://rpc.votechain.localhost:8545");
    assert.equal(buildCsp({ identityBase: "http://a.test:1/x", relayBase: "http://a.test:1/y", rpcUrl: "http://a.test:1" }).match(/http:\/\/a\.test:1/g)?.length, 1);
    assert.throws(() => buildCsp({ ...services, rpcUrl: "not a url" }));
  });
  it("the <meta> variant omits frame-ancestors (a meta tag cannot carry it); the header variant has it", () => {
    assert.ok(!buildCsp(services, { meta: true }).includes("frame-ancestors"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
  });
  it("the response headers add the rest of the hardening", () => {
    const headers = securityHeaders(csp) as Record<string, string>;
    assert.equal(headers["Content-Security-Policy"], csp);
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["X-Frame-Options"], "DENY");
    assert.equal(headers["Referrer-Policy"], "no-referrer");
    assert.match(headers["Permissions-Policy"]!, /camera=\(self\)/);
    assert.match(headers["Permissions-Policy"]!, /microphone=\(\)/);
  });
});
