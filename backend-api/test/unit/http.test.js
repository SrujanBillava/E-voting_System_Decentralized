import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { request as httpRequest } from "node:http";
import net from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import request from "supertest";
import express from "express";
import { createApp } from "../../src/app.js";
import { createErrorHandler } from "../../src/middleware/errorHandler.js";
import { AppError } from "../../src/utils/errors.js";
import { loadEnv } from "../../src/config/env.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { validEnv } from "../helpers/env.js";

const ALLOWED = "http://localhost:5173";

function build({ health = { getPublicHealth: async () => ({ status: "ok" }) }, env } = {}) {
  const config = loadEnv(validEnv(env));
  const memory = createMemoryLogger();
  return { app: createApp({ config, logger: memory.logger, healthService: health }), ...memory };
}

describe("http: health", () => {
  it("GET /api/v1/health returns only {status:'ok'}", async () => {
    const { app } = build();
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("answers 503 {status:'degraded'} when the system is unhealthy, still with no detail", async () => {
    const { app } = build({ health: { getPublicHealth: async () => ({ status: "degraded" }) } });
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { status: "degraded" });
  });

  it("the old unversioned paths do not exist", async () => {
    const { app } = build();
    assert.equal((await request(app).get("/health")).status, 404);
    assert.equal((await request(app).get("/api/health")).status, 404);
  });
});

describe("http: security headers", () => {
  it("removes x-powered-by and sets helmet headers and Cache-Control: no-store", async () => {
    const { app } = build();
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.headers["x-powered-by"], undefined);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.ok(res.headers["content-security-policy"]);
    assert.ok(res.headers["strict-transport-security"]);
    assert.ok(res.headers["referrer-policy"]);
    assert.ok(res.headers["x-frame-options"] || /frame-ancestors/.test(res.headers["content-security-policy"]));
    assert.equal(res.headers["etag"], undefined);
  });

  it("error responses are also no-store and carry the helmet headers", async () => {
    const { app } = build();
    const res = await request(app).get("/nope");
    assert.equal(res.status, 404);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-powered-by"], undefined);
  });
});

describe("http: request ids", () => {
  it("generates an id, returns it in the header, and uses it in error bodies", async () => {
    const { app } = build();
    const res = await request(app).get("/api/v1/missing");
    assert.match(res.headers["x-request-id"], /^[0-9a-f-]{36}$/);
    assert.equal(res.body.error.requestId, res.headers["x-request-id"]);
  });

  it("echoes a well-formed inbound id and replaces a malformed one", async () => {
    const { app } = build();
    assert.equal((await request(app).get("/api/v1/health").set("X-Request-Id", "client-req-12345")).headers["x-request-id"], "client-req-12345");
    const replaced = (await request(app).get("/api/v1/health").set("X-Request-Id", "bad id\twith spaces!")).headers["x-request-id"];
    assert.match(replaced, /^[0-9a-f-]{36}$/);
  });
});

describe("http: structured errors", () => {
  it("unknown route -> 404 {error:{code,message,requestId}}", async () => {
    const { app } = build();
    const res = await request(app).get("/api/v1/does-not-exist");
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(res.body), ["error"]);
    assert.deepEqual(Object.keys(res.body.error).sort(), ["code", "message", "requestId"]);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  it("an unexpected exception -> generic 500 that leaks neither message nor stack", async () => {
    const { app, lines } = build({
      health: {
        getPublicHealth: async () => {
          throw new Error("connect ECONNREFUSED mongodb://admin:hunter2@10.0.0.5:27017 at /srv/api/db.js:42");
        },
      },
    });
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 500);
    assert.deepEqual(res.body.error.code, "INTERNAL_ERROR");
    assert.equal(res.body.error.message, "Internal server error");
    const text = JSON.stringify(res.body);
    for (const leaked of ["hunter2", "ECONNREFUSED", "10.0.0.5", "db.js", " at ", "stack"]) assert.ok(!text.includes(leaked), `response leaked "${leaked}"`);
    // ...while the server-side log has the event (with credentials scrubbed by the logger)
    const logged = lines.join("");
    assert.match(logged, /unhandled error/);
    assert.ok(!logged.includes("hunter2"));
  });

  it("malformed JSON -> 400 INVALID_JSON with a fixed message", async () => {
    const { app } = build();
    const res = await request(app).post("/api/v1/anything").set("Content-Type", "application/json").send('{"a": ');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "INVALID_JSON");
    assert.ok(!JSON.stringify(res.body).includes("Unexpected"));
  });

  it("oversized body -> 413 PAYLOAD_TOO_LARGE (limit 100kb)", async () => {
    const { app } = build();
    const res = await request(app).post("/api/v1/anything").set("Content-Type", "application/json").send(JSON.stringify({ blob: "x".repeat(150_000) }));
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE");
  });
});

describe("http: CORS allow-list", () => {
  it("an allow-listed origin gets CORS headers", async () => {
    const { app } = build();
    const res = await request(app).get("/api/v1/health").set("Origin", ALLOWED);
    assert.equal(res.status, 200);
    assert.equal(res.headers["access-control-allow-origin"], ALLOWED);
    assert.equal(res.headers["access-control-allow-credentials"], "true");
    assert.match(res.headers["access-control-expose-headers"], /X-Request-Id/i);
  });

  it("a non-allow-listed origin is refused with 403 and no CORS headers", async () => {
    const { app } = build();
    for (const origin of ["http://evil.example", "http://localhost:5174", "https://localhost:5173", "null", "http://localhost:5173.evil.example"]) {
      const res = await request(app).get("/api/v1/health").set("Origin", origin);
      assert.equal(res.status, 403, origin);
      assert.equal(res.body.error.code, "CORS_ORIGIN_NOT_ALLOWED");
      assert.equal(res.headers["access-control-allow-origin"], undefined, origin);
    }
  });

  it("is refused for state-changing methods too, before any body is processed", async () => {
    const { app } = build();
    const res = await request(app).post("/api/v1/anything").set("Origin", "http://evil.example").set("Content-Type", "application/json").send("{}");
    assert.equal(res.status, 403);
  });

  it("preflight: allowed origin 204 with methods; disallowed origin 403", async () => {
    const { app } = build();
    const ok = await request(app).options("/api/v1/health").set("Origin", ALLOWED).set("Access-Control-Request-Method", "POST");
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], ALLOWED);
    assert.match(ok.headers["access-control-allow-methods"], /POST/);
    const bad = await request(app).options("/api/v1/health").set("Origin", "http://evil.example").set("Access-Control-Request-Method", "POST");
    assert.equal(bad.status, 403);
  });

  it("requests without an Origin header (curl, server-to-server) are allowed", async () => {
    const { app } = build();
    assert.equal((await request(app).get("/api/v1/health")).status, 200);
  });

  it("the allow-list comes from configuration", async () => {
    const { app } = build({ env: { CORS_ORIGINS: "https://vote.example.org" } });
    assert.equal((await request(app).get("/api/v1/health").set("Origin", "https://vote.example.org")).status, 200);
    assert.equal((await request(app).get("/api/v1/health").set("Origin", ALLOWED)).status, 403);
  });
});

describe("http: app.js is side-effect free", () => {
  it("importing app.js and building the app opens no handles (process exits by itself)", () => {
    const appUrl = new URL("../../src/app.js", import.meta.url).href;
    const script = `
      const { createApp } = await import(${JSON.stringify(appUrl)});
      createApp({ config: { corsOrigins: [] }, logger: { info(){}, warn(){}, error(){} }, healthService: { getPublicHealth: async () => ({ status: "ok" }) } });
      console.log("built");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(new URL("../..", import.meta.url)), timeout: 15_000, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /built/);
  });
});

const throwing = (error) => ({ getPublicHealth: async () => { throw error; } });
const parseLines = (lines) => lines.map((l) => JSON.parse(l));

describe("http: error handler never breaks and never leaks", () => {
  it("answers a thrown value whose `type` is an Object.prototype member with the generic 500 (not Express's HTML page), carrying the request id and logged", async () => {
    for (const type of ["constructor", "__proto__", "toString", "hasOwnProperty", "entity.parse.failed.extra"]) {
      const { app, lines } = build({ health: throwing(Object.assign(new Error("secret internals"), { type })) });
      const res = await request(app).get("/api/v1/health");
      assert.equal(res.status, 500, type);
      assert.match(res.headers["content-type"], /json/, type);
      assert.equal(res.body.error.code, "INTERNAL_ERROR", type);
      assert.equal(res.body.error.requestId, res.headers["x-request-id"], `${type}: the regular path, not the last-resort fallback`);
      assert.ok(!res.text.includes("secret internals") && !res.text.includes("    at "), type);
      assert.ok(parseLines(lines).some((l) => l.msg === "unhandled error" && l.requestId === res.headers["x-request-id"]), `${type}: must be logged`);
    }
  });

  it("answers non-Error throws (strings, null-ish objects, numbers) with the generic 500 and no detail", async () => {
    for (const thrown of ["a string with secret", { message: "plain object secret" }, 42, Symbol.for("x")]) {
      const { app } = build({ health: throwing(thrown) });
      const res = await request(app).get("/api/v1/health");
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.ok(!res.text.includes("secret"));
    }
  });

  it("still answers (generic JSON 500, no stack) when the logger itself blows up", async () => {
    const config = loadEnv(validEnv());
    const logger = { info() {}, warn() {}, error() { throw new Error("disk full: " + "/var/log/secret-path"); } };
    const app = createApp({ config, logger, healthService: throwing(new Error("boom")) });
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 500);
    assert.match(res.headers["content-type"], /json/);
    assert.deepEqual(Object.keys(res.body.error).sort().filter((k) => k !== "requestId"), ["code", "message"]);
    assert.ok(!res.text.includes("disk full") && !res.text.includes("secret-path") && !res.text.includes("    at "));
  });

  it("an AppError with a status that cannot be sent still produces a generic 500", async () => {
    const { app } = build({ health: throwing(new AppError(99999, "WEIRD", "never shown")) });
    const res = await request(app).get("/api/v1/health");
    assert.equal(res.status, 500);
    assert.ok(!res.text.includes("never shown"));
  });

  it("Express never prints stack traces on its own (env is production whatever NODE_ENV says)", () => {
    const { app } = build();
    assert.equal(app.get("env"), "production");
  });

  it("corrupt compressed bodies are a 400 from the client, not a 500 from us, with fixed wording", async () => {
    const { app, lines } = build();
    for (const encoding of ["gzip", "deflate", "br"]) {
      const res = await request(app).post("/api/v1/anything").set("Content-Type", "application/json").set("Content-Encoding", encoding).send("this is not compressed data");
      assert.equal(res.status, 400, encoding);
      assert.deepEqual({ code: res.body.error.code, message: res.body.error.message }, { code: "BAD_REQUEST", message: "Bad Request" }, encoding);
      assert.ok(!/header check|Decompression|Z_DATA|incorrect/i.test(res.text), `library wording leaked for ${encoding}`);
    }
    assert.ok(!parseLines(lines).some((l) => l.msg === "unhandled error"), "client mistakes are not logged as server errors");
  });

  it("a well-formed gzip body is still understood", async () => {
    const { app } = build();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const body = gzipSync(JSON.stringify({ ok: true }));
      const status = await new Promise((resolve, reject) => {
        const req = httpRequest({ port: server.address().port, host: "127.0.0.1", method: "POST", path: "/api/v1/anything", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip", "Content-Length": body.length } }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end(body);
      });
      assert.equal(status, 404); // parsed fine; there is simply no such route
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("an unsupported content encoding / charset keeps its specific code", async () => {
    const { app } = build();
    const enc = await request(app).post("/api/v1/anything").set("Content-Type", "application/json").set("Content-Encoding", "bogus").send("{}");
    assert.equal(enc.status, 415);
    assert.equal(enc.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
    const charset = await request(app).post("/api/v1/anything").set("Content-Type", "application/json; charset=iso-8859-1").send("{}");
    assert.equal(charset.status, 415);
    assert.equal(charset.body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("a JSON scalar or truncated body is INVALID_JSON; an object or array is accepted by the parser", async () => {
    const { app } = build();
    assert.equal((await request(app).post("/api/v1/anything").set("Content-Type", "application/json").send("123")).body.error.code, "INVALID_JSON");
    assert.equal((await request(app).post("/api/v1/anything").set("Content-Type", "application/json").send('"text"')).body.error.code, "INVALID_JSON");
    assert.equal((await request(app).post("/api/v1/anything").set("Content-Type", "application/json").send("[1]")).status, 404);
  });
});

describe("http: error handler (unit)", () => {
  const harness = (error, { headersSent = false } = {}) => {
    const calls = { next: [], status: [], json: [], logged: [] };
    const res = {
      headersSent,
      status(code) { calls.status.push(code); return this; },
      json(body) { calls.json.push(body); return this; },
    };
    const handler = createErrorHandler({ logger: { error: (...args) => calls.logged.push(args) } });
    handler(error, { id: "rid", method: "GET", path: "/p" }, res, (e) => calls.next.push(e));
    return calls;
  };

  it("hands the error on untouched when the response has already started", () => {
    const error = new Error("late");
    const calls = harness(error, { headersSent: true });
    assert.deepEqual(calls.next, [error]);
    assert.deepEqual(calls.status, []);
    assert.deepEqual(calls.json, []);
  });

  it("an AppError is shown exactly as written (status, code, message) and is not logged as a server error below 500", () => {
    const calls = harness(new AppError(418, "TEAPOT", "short and stout"));
    assert.deepEqual(calls.status, [418]);
    assert.deepEqual(calls.json, [{ error: { code: "TEAPOT", message: "short and stout", requestId: "rid" } }]);
    assert.deepEqual(calls.logged, []);
  });

  it("an AppError with 5xx is logged; its wording is still the one we chose", () => {
    const calls = harness(new AppError(503, "CHAIN_DOWN", "Blockchain unavailable"));
    assert.deepEqual(calls.json[0].error, { code: "CHAIN_DOWN", message: "Blockchain unavailable", requestId: "rid" });
    assert.equal(calls.logged.length, 1);
  });

  it("only 4xx statuses from libraries are treated as client errors; anything else is a generic 500", () => {
    for (const status of [200, 204, 302, 399, 500, 502, 503, 599, 600, 99, 0, -1, 404.5, "404", NaN, undefined, null]) {
      const calls = harness(Object.assign(new Error("lib says: private detail"), { status }));
      assert.deepEqual(calls.status, [500], String(status));
      assert.equal(calls.json[0].error.code, "INTERNAL_ERROR", String(status));
      assert.equal(calls.logged.length, 1, String(status));
    }
    for (const [status, code, message] of [[400, "BAD_REQUEST", "Bad Request"], [401, "UNAUTHORIZED", "Unauthorized"], [404, "NOT_FOUND", "Not Found"], [413, "PAYLOAD_TOO_LARGE", "Payload Too Large"], [499, undefined, undefined]]) {
      const calls = harness(Object.assign(new Error("lib says: private detail"), { status }));
      if (code === undefined) {
        assert.deepEqual(calls.status, [500], "499 has no standard text");
        continue;
      }
      assert.deepEqual(calls.status, [status]);
      assert.deepEqual(calls.json[0].error, { code, message, requestId: "rid" });
      assert.deepEqual(calls.logged, [], "not a server error");
    }
  });

  it("statusCode works like status", () => {
    const calls = harness(Object.assign(new Error("x"), { statusCode: 400 }));
    assert.deepEqual(calls.status, [400]);
  });

  it("a known body-parser type wins over the generic client-error text", () => {
    const calls = harness(Object.assign(new Error("Unexpected token"), { type: "entity.parse.failed", status: 400 }));
    assert.equal(calls.json[0].error.code, "INVALID_JSON");
  });
});

describe("http: access log", () => {
  it("records the full path (not the router-relative one), method, status, duration and request id, and nothing from the query", async () => {
    const { app, lines } = build();
    const res = await request(app).get("/api/v1/health?token=abc123&voter=V-0001").set("User-Agent", "agent-xyz");
    const entry = parseLines(lines).find((l) => l.msg === "request");
    assert.equal(entry.path, "/api/v1/health");
    assert.equal(entry.method, "GET");
    assert.equal(entry.status, 200);
    assert.equal(entry.requestId, res.headers["x-request-id"]);
    assert.equal(typeof entry.durationMs, "number");
    assert.ok(entry.durationMs >= 0);
    assert.ok(!lines.join("").includes("abc123") && !lines.join("").includes("V-0001"), "query string leaked");
  });

  it("never records headers, cookies or bodies", async () => {
    const { app, lines } = build();
    await request(app).post("/api/v1/anything").set("Authorization", "Bearer sekrit-token").set("Cookie", "sid=sekrit-cookie").set("Content-Type", "application/json").send(JSON.stringify({ password: "sekrit-pw" }));
    const text = lines.join("");
    for (const secret of ["sekrit-token", "sekrit-cookie", "sekrit-pw"]) assert.ok(!text.includes(secret), secret);
    const entry = parseLines(lines).find((l) => l.msg === "request");
    assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "level", "method", "msg", "path", "requestId", "status", "time"]);
  });

  it("logs rejected and unknown requests too", async () => {
    const { app, lines } = build();
    await request(app).get("/nope");
    await request(app).get("/api/v1/health").set("Origin", "http://evil.example");
    const entries = parseLines(lines).filter((l) => l.msg === "request");
    assert.deepEqual(entries.map((e) => [e.path, e.status]), [["/nope", 404], ["/api/v1/health", 403]]);
  });
});

describe("http: request id rules", () => {
  const idOf = async (value) => {
    const { app } = build();
    return (await request(app).get("/api/v1/health").set("X-Request-Id", value)).headers["x-request-id"];
  };

  it("accepts 8 to 64 characters of [A-Za-z0-9._-] and replaces everything else with a fresh UUID", async () => {
    for (const ok of ["abcdefgh", "A.b_c-d1", "x".repeat(64), "0123456789.abcdef_ABCDEF-"]) assert.equal(await idOf(ok), ok);
    for (const bad of ["short12", "x".repeat(65), "has space1", "semi;colon1", "slash/slash1", "uni-é-code1", "a".repeat(8) + "\u00e9", "<script>1"]) {
      assert.match(await idOf(bad), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, JSON.stringify(bad));
    }
  });

  it("two requests without an id get different ids", async () => {
    const { app } = build();
    const [a, b] = await Promise.all([request(app).get("/api/v1/health"), request(app).get("/api/v1/health")]);
    assert.notEqual(a.headers["x-request-id"], b.headers["x-request-id"]);
  });

  it("the id reaches the error body and the access log as the same value", async () => {
    const { app, lines } = build();
    const res = await request(app).get("/api/v1/missing").set("X-Request-Id", "trace-12345678");
    assert.equal(res.body.error.requestId, "trace-12345678");
    assert.equal(parseLines(lines).find((l) => l.msg === "request").requestId, "trace-12345678");
  });
});

describe("http: CORS edge cases", () => {
  it("origins are matched exactly: case, trailing slash, prefix, suffix, userinfo and port tricks are all refused", async () => {
    const { app } = build();
    for (const origin of [
      "HTTP://LOCALHOST:5173",
      "http://LOCALHOST:5173",
      "http://localhost:5173/",
      "http://localhost:5173/path",
      "http://localhost",
      "http://localhost:51730",
      "http://localhost:5173.evil.example",
      "http://evil.example/http://localhost:5173",
      "http://localhost:5173@evil.example",
      "http://user@localhost:5173",
      "http://localhost:5173, http://evil.example",
      "http://evil.example, http://localhost:5173",
      "*",
      "",
    ]) {
      const res = await request(app).get("/api/v1/health").set("Origin", origin);
      if (origin === "") {
        assert.equal(res.status, 200, "an empty Origin header is treated as absent");
        continue;
      }
      assert.equal(res.status, 403, JSON.stringify(origin));
      assert.equal(res.headers["access-control-allow-origin"], undefined, JSON.stringify(origin));
    }
  });

  it("two Origin header lines are refused even if one of them is allowed", async () => {
    const { app } = build();
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const raw = await new Promise((resolve, reject) => {
        const socket = net.connect(server.address().port, "127.0.0.1", () => {
          socket.write("GET /api/v1/health HTTP/1.1\r\nHost: x\r\nOrigin: http://localhost:5173\r\nOrigin: http://evil.example\r\nConnection: close\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      assert.match(raw, /^HTTP\/1\.1 403 /);
      assert.ok(!/access-control-allow-origin/i.test(raw));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("a preflight only ever advertises the fixed header and method lists, whatever is requested", async () => {
    const { app } = build();
    const res = await request(app).options("/api/v1/health").set("Origin", ALLOWED).set("Access-Control-Request-Method", "DELETE").set("Access-Control-Request-Headers", "X-Evil, Authorization");
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-headers"], "Content-Type,Authorization,X-Request-Id,Idempotency-Key");
    assert.equal(res.headers["access-control-allow-methods"], "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    assert.equal(res.headers["access-control-max-age"], "600");
    assert.equal(res.headers["access-control-allow-credentials"], "true");
  });

  it("responses vary on Origin so a cache can never hand one origin's answer to another", async () => {
    const { app } = build();
    const res = await request(app).get("/api/v1/health").set("Origin", ALLOWED);
    assert.match(res.headers.vary, /Origin/);
  });

  it("an empty allow-list (no CORS_ORIGINS in a locked-down deployment) refuses every browser origin but not origin-less clients", async () => {
    const config = { corsOrigins: [] };
    const app = createApp({ config, logger: createMemoryLogger().logger, healthService: { getPublicHealth: async () => ({ status: "ok" }) } });
    assert.equal((await request(app).get("/api/v1/health").set("Origin", ALLOWED)).status, 403);
    assert.equal((await request(app).get("/api/v1/health")).status, 200);
  });
});

describe("http: methods and routes", () => {
  it("only GET (and HEAD) reach the health route; other methods fall through to the JSON 404", async () => {
    const { app } = build();
    assert.equal((await request(app).head("/api/v1/health")).status, 200);
    for (const method of ["post", "put", "patch", "delete"]) {
      const res = await request(app)[method]("/api/v1/health").send({});
      assert.equal(res.status, 404, method);
      assert.equal(res.body.error.code, "NOT_FOUND", method);
    }
  });

  it("the health body is exactly {status}, and a degraded service cannot be told from outside why", async () => {
    const { app } = build({ health: { getPublicHealth: async () => ({ status: "degraded", checks: [{ name: "x" }], snapshot: {} }) } });
    const res = await request(app).get("/api/v1/health");
    assert.deepEqual(res.body, { status: "degraded" });
  });
});

describe("http: express error plumbing used by app.js", () => {
  it("an async handler that rejects reaches the error handler (Express 5 forwards it)", async () => {
    const app = express();
    app.use((req, _res, next) => { req.id = "rid"; next(); });
    app.get("/t", async () => { throw new Error("async boom"); });
    app.use(createErrorHandler({ logger: createMemoryLogger().logger }));
    const res = await request(app).get("/t");
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "INTERNAL_ERROR");
  });
});

