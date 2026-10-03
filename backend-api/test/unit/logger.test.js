import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Writable } from "node:stream";
import { createLogger, createMemoryLogger } from "../../src/utils/logger.js";

const parse = (lines) => lines.map((l) => JSON.parse(l));

describe("logger: long hex blobs", () => {
  it("never writes a signed transaction / signature sized hex string, but keeps 32-byte hashes", () => {
    const { logger, lines } = createMemoryLogger();
    const rawTx = "0x02f9" + "ab".repeat(300);
    const signature = "0x" + "cd".repeat(65);
    const txHash = "0x" + "ef".repeat(32);
    logger.error({ err: new Error(`broadcast failed transaction="${rawTx}" sig=${signature}`), note: signature }, `boom ${rawTx}`);
    logger.info({ txHash }, "mined");
    const text = lines.join("");
    assert.ok(!text.includes("abababab") && !text.includes("cdcdcdcd"));
    assert.match(text, /REDACTED_HEX/);
    assert.ok(text.includes(txHash), "ordinary 32-byte hashes stay readable");
  });
});

describe("logger", () => {
  it("writes JSON lines with time, level and message", () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ requestId: "r1" }, "hello");
    const [entry] = parse(lines);
    assert.equal(entry.level, "info");
    assert.equal(entry.msg, "hello");
    assert.equal(entry.requestId, "r1");
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
  });

  it("honours the level threshold", () => {
    const { logger, lines } = createMemoryLogger({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    assert.deepEqual(parse(lines).map((l) => l.level), ["warn", "error"]);
  });

  it("redacts sensitive FIELD NAMES at any depth", () => {
    const { logger, lines } = createMemoryLogger();
    logger.info(
      {
        privateKey: "0xabc",
        password: "hunter2",
        NULLIFIER_SECRET: "s",
        nested: { Authorization: "Bearer abc", cookie: "sid=1", totp: "123456", faceDescriptor: [1, 2, 3], mongodbUri: "mongodb://u:p@h/db", rpcUrl: "https://x/KEY", deep: { mnemonic: "w w w", accessToken: "t" } },
        ok: "visible",
      },
      "x",
    );
    const text = lines[0];
    for (const leaked of ["0xabc", "hunter2", "Bearer abc", "sid=1", "123456", "w w w", "KEY", "mongodb://u:p"]) assert.ok(!text.includes(leaked), `leaked ${leaked}`);
    assert.match(text, /visible/);
    assert.equal(JSON.parse(text).password, "[REDACTED]");
  });

  it("scrubs registered secret VALUES wherever they appear, including inside error messages", () => {
    const secret = "0x" + "ab".repeat(32);
    const { logger, lines } = createMemoryLogger({ secrets: [secret, secret.slice(2)] });
    logger.error({ err: new Error(`provider failed for key ${secret} and again ${secret.slice(2)}`), note: `value=${secret}` }, `boom ${secret}`);
    assert.ok(!lines[0].includes("abababab"), lines[0]);
    assert.match(lines[0], /\[REDACTED\]/);
  });

  it("scrubs credentials embedded in URLs even when not registered", () => {
    const { logger, lines } = createMemoryLogger();
    logger.warn({ target: "mongodb://appuser:s3cr3t@db.internal:27017/evoting?x=1" }, "connect failed for postgres://u:pw@host/db");
    assert.ok(!lines[0].includes("s3cr3t") && !lines[0].includes("appuser") && !lines[0].includes(":pw@"));
    assert.match(lines[0], /db\.internal/);
  });

  it("serialises errors without stack traces unless debugging", () => {
    const info = createMemoryLogger();
    info.logger.error({ err: Object.assign(new Error("bad"), { code: "E_BAD" }) }, "x");
    assert.deepEqual(parse(info.lines)[0].err, { name: "Error", code: "E_BAD", message: "bad" });

    const debug = createMemoryLogger({ level: "debug" });
    debug.logger.error({ err: new Error("bad") }, "x");
    assert.ok(parse(debug.lines)[0].err.stack);
  });

  it("handles bigint, binary, circular references and functions without throwing", () => {
    const { logger, lines } = createMemoryLogger();
    const circular = { name: "c" };
    circular.self = circular;
    logger.info({ big: 12345678901234567890n, bytes: new Uint8Array(32), circular, fn: () => 1 }, "x");
    const entry = parse(lines)[0];
    assert.equal(entry.big, "12345678901234567890");
    assert.equal(entry.bytes, "[binary 32 bytes]");
    assert.equal(entry.circular.self, "[Truncated]");
  });

  it("child loggers keep bindings and secrets", () => {
    const { logger, lines } = createMemoryLogger({ secrets: ["supersecret-value"] });
    logger.child({ component: "chain" }).info({ detail: "supersecret-value" }, "x");
    const entry = parse(lines)[0];
    assert.equal(entry.component, "chain");
    assert.equal(entry.detail, "[REDACTED]");
  });
});

describe("logger: every sensitive field-name family is redacted (one assertion per family)", () => {
  const families = {
    password: ["password", "Password", "dbPassword", "PASSWORD_HASH"],
    passphrase: ["passphrase", "walletPassphrase"],
    secret: ["secret", "clientSecret", "NULLIFIER_SECRET"],
    privateKey: ["privateKey", "private_key", "OWNER_PRIVATE_KEY", "PrivateKey"],
    mnemonic: ["mnemonic", "seedMnemonic"],
    token: ["token", "accessToken", "refresh_token", "csrfToken"],
    authorization: ["authorization", "Authorization", "proxyAuthorization"],
    cookie: ["cookie", "Cookie", "setCookie"],
    totp: ["totp", "totpSecret", "totpCode"],
    descriptor: ["descriptor", "faceDescriptor", "FaceDescriptors"],
    signature: ["signature", "authoritySignature", "Signature"],
    credential: ["credential", "credentials", "dbCredentials"],
    uri: ["uri", "mongodbUri", "MONGODB_URI", "dbURI"],
    url: ["url", "rpcUrl", "CHAIN_RPC_URL", "requestURL"],
    dsn: ["dsn", "sentryDsn", "DSN"],
  };

  for (const [family, names] of Object.entries(families)) {
    it(`${family}: ${names.join(", ")}`, () => {
      const { logger, lines } = createMemoryLogger();
      const fields = Object.fromEntries(names.map((name, i) => [name, `value-${family}-${i}-must-not-appear`]));
      logger.info({ ...fields, nested: { deep: { ...fields } } }, "x");
      assert.ok(!lines[0].includes("must-not-appear"), lines[0]);
      for (const name of names) assert.equal(JSON.parse(lines[0])[name], "[REDACTED]", name);
    });
  }

  it("ordinary field names are left alone", () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ requestId: "r-1", method: "GET", path: "/p", status: 200, durationMs: 4, address: "0xabc", urlCount: 3, tokens: undefined, host: "db.internal" }, "x");
    const entry = JSON.parse(lines[0]);
    assert.deepEqual([entry.requestId, entry.method, entry.path, entry.status, entry.durationMs, entry.address, entry.urlCount, entry.host], ["r-1", "GET", "/p", 200, 4, "0xabc", 3, "db.internal"]);
  });
});

describe("logger: hardening", () => {
  it("caller fields can never overwrite time, level or msg", () => {
    const { logger, lines } = createMemoryLogger();
    logger.warn({ time: "1999-01-01T00:00:00.000Z", level: "debug", msg: "forged entry" }, "the real message");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.level, "warn");
    assert.equal(entry.msg, "the real message");
    assert.notEqual(entry.time, "1999-01-01T00:00:00.000Z");
    assert.ok(Date.now() - Date.parse(entry.time) < 5000);
  });

  it("the same holds for child-logger bindings", () => {
    const { logger, lines } = createMemoryLogger();
    logger.child({ level: "debug", msg: "forged" }).error("real");
    const entry = JSON.parse(lines[0]);
    assert.deepEqual([entry.level, entry.msg], ["error", "real"]);
  });

  it("never throws: a hostile getter, a throwing proxy or a failing stream cannot take the caller down", () => {
    const { logger, lines } = createMemoryLogger();
    const getter = Object.defineProperty({}, "boom", { enumerable: true, get() { throw new Error("getter ran"); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("ownKeys ran"); } });
    assert.doesNotThrow(() => logger.error({ getter }, "with getter"));
    assert.doesNotThrow(() => logger.error({ proxy }, "with proxy"));
    assert.equal(lines.length, 2);
    for (const line of lines) {
      const entry = JSON.parse(line);
      assert.equal(entry.level, "error");
      assert.match(entry.msg, /could not be serialised/);
      assert.ok(!line.includes("getter ran") && !line.includes("ownKeys ran"));
    }
    const broken = new Writable({ write() { throw new Error("EPIPE"); } });
    assert.doesNotThrow(() => createLogger({ stream: broken }).info("x"));
    const brokenWrite = { write() { throw new Error("EPIPE"); } };
    assert.doesNotThrow(() => createLogger({ stream: brokenWrite }).info("x"));
  });

  it("hex secrets are scrubbed whatever the letter case or 0x/0X prefix", () => {
    const secret = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const { logger, lines } = createMemoryLogger({ secrets: [secret, secret.slice(2)] });
    logger.error({ a: secret.toUpperCase(), b: "0X" + secret.slice(2).toUpperCase(), c: secret.slice(2).toUpperCase(), d: `key=${secret}` }, `again ${secret.toUpperCase()}`);
    assert.ok(!/ac0974bec39a17e36ba4a6b4/i.test(lines[0]), lines[0]);
  });

  it("non-hex secrets (a URI, a password) are matched exactly and everywhere in a string", () => {
    const { logger, lines } = createMemoryLogger({ secrets: ["https://rpc.example.org/v2/KEY-0123456789", "p@ssw0rd-long"] });
    logger.info({ a: "x https://rpc.example.org/v2/KEY-0123456789 y p@ssw0rd-long z p@ssw0rd-long" }, "m");
    assert.equal(JSON.parse(lines[0]).a, "x [REDACTED] y [REDACTED] z [REDACTED]");
  });

  it("secrets shorter than 8 characters are ignored (they would mangle ordinary text)", () => {
    const { logger, lines } = createMemoryLogger({ secrets: ["abc", "1234567"] });
    logger.info({ a: "abc 1234567" }, "m");
    assert.equal(JSON.parse(lines[0]).a, "abc 1234567");
    const { logger: eight, lines: eightLines } = createMemoryLogger({ secrets: ["12345678"] });
    eight.info({ a: "x 12345678 y" }, "m");
    assert.equal(JSON.parse(eightLines[0]).a, "x [REDACTED] y");
  });

  it("errors are reduced to name, code and (scrubbed) message: attached request/response/info objects are dropped", () => {
    const { logger, lines } = createMemoryLogger();
    const err = Object.assign(new Error("server response 401"), {
      code: "SERVER_ERROR",
      info: { requestUrl: "https://rpc.example.org/v2/KEY", responseBody: "nope" },
      request: { headers: { authorization: "Bearer t" } },
      cause: new Error("inner"),
    });
    logger.error({ err }, "x");
    assert.deepEqual(JSON.parse(lines[0]).err, { name: "Error", code: "SERVER_ERROR", message: "server response 401" });
  });

  it("deeply nested values are cut off instead of exploding the line or the stack", () => {
    const { logger, lines } = createMemoryLogger();
    let nested = { leaf: "bottom" };
    for (let i = 0; i < 5000; i++) nested = { next: nested };
    logger.info({ nested }, "x");
    assert.ok(lines[0].includes("[Truncated]"));
    assert.ok(lines[0].length < 2000);
    assert.ok(!lines[0].includes("bottom"));
  });

  it("repeated references to the same object are shown once and then marked, never looping", () => {
    const { logger, lines } = createMemoryLogger();
    const shared = { n: 1 };
    logger.info({ a: shared, b: shared }, "x");
    const entry = JSON.parse(lines[0]);
    assert.deepEqual(entry.a, { n: 1 });
    assert.equal(entry.b, "[Truncated]");
  });

  it("multi-line values stay on one line (no log injection through newlines)", () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ path: "/a\n{\"level\":\"error\",\"msg\":\"forged\"}" }, "line1\nline2");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].trimEnd().split("\n").length, 1);
    assert.equal(JSON.parse(lines[0]).level, "info");
  });

  it("Buffers and typed arrays are summarised, never dumped (a key held as bytes cannot leak)", () => {
    const { logger, lines } = createMemoryLogger();
    logger.info({ key: Buffer.from("deadbeef", "hex"), view: new Uint8Array([1, 2, 3]) }, "x");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.key, "[binary 4 bytes]");
    assert.equal(entry.view, "[binary 3 bytes]");
  });

  it("the default stream is stdout, the default level is info, and silent writes nothing", () => {
    const { logger, lines } = createMemoryLogger({ level: "silent" });
    logger.error("nothing");
    assert.deepEqual(lines, []);
    const info = createMemoryLogger();
    info.logger.debug("hidden");
    info.logger.info("shown");
    assert.equal(info.lines.length, 1);
  });
});

