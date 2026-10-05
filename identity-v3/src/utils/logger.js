import { Writable } from "node:stream";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Field NAMES whose values are never written, whatever they contain. Besides the usual secrets this lists the identity-side linkage data: a log line
// must never be able to tie a voter to a commitment, a batch or a transaction.
const SENSITIVE_KEY =
  /(pass(word|phrase)?|secret|private.?key|mnemonic|token|authorization|cookie|totp|descriptor|embedding|template|samples|challenge|signature|credential|commitment|voter.?id|(^|_)uid$|email|(^|_)(uri|url|dsn)$|(uri|url|dsn)$|rawtx)/i;

// user:password@ inside any URL-looking string.
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;

const LONG_HEX = /0x[0-9a-fA-F]{100,}/g;
const MAX_DEPTH = 6;
const REDACTED = "[REDACTED]";

/**
 * Minimal structured JSON-lines logger (the V2 logger, plus the linkage field names above).
 *
 * Defences, in order:
 *  1. values under sensitive field names are replaced;
 *  2. every string has registered secret VALUES (the issuer key, the face key, the Mongo URI, the RPC URL...) replaced, wherever they appear;
 *  3. credentials embedded in URLs are replaced; long hex blobs (signed transactions) are never written.
 * It cannot protect against secrets it was never told about, so never pass them as fields.
 */
export function createLogger({ level = "info", stream = process.stdout, secrets = [], base = {} } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const secretValues = new Set(secrets.filter((s) => typeof s === "string" && s.length >= 8));
  const matchers = [...secretValues].map((secret) => (/^(0x)?[0-9a-f]+$/i.test(secret) ? new RegExp(secret, "gi") : secret));

  const scrubString = (value) => {
    let out = value;
    for (const matcher of matchers) {
      out = typeof matcher === "string" ? (out.includes(matcher) ? out.split(matcher).join(REDACTED) : out) : out.replace(matcher, REDACTED);
    }
    return out.replace(URL_CREDENTIALS, `$1${REDACTED}@`).replace(LONG_HEX, "[REDACTED_HEX]");
  };

  const sanitize = (value, depth, seen) => {
    if (value === null || value === undefined) return value;
    switch (typeof value) {
      case "string":
        return scrubString(value);
      case "bigint":
        return value.toString();
      case "number":
      case "boolean":
        return value;
      case "function":
      case "symbol":
        return undefined;
    }
    if (value instanceof Error) {
      return { name: value.name, code: value.code, message: scrubString(String(value.message)), ...(level === "debug" && value.stack ? { stack: scrubString(value.stack) } : {}) };
    }
    if (value instanceof Uint8Array) return `[binary ${value.byteLength} bytes]`;
    if (depth >= MAX_DEPTH || seen.has(value)) return "[Truncated]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1, seen));
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitize(v, depth + 1, seen);
    return out;
  };

  const write = (name, fields, message) => {
    if (LEVELS[name] < threshold) return;
    const time = new Date().toISOString();
    const msg = typeof message === "string" ? scrubString(message) : message;
    let line;
    try {
      const entry = { time, level: name, msg, ...sanitize({ ...base, ...fields }, 0, new WeakSet()) };
      entry.time = time; // a field called "time", "level" or "msg" must never overwrite the real one (log forging)
      entry.level = name;
      entry.msg = msg;
      line = JSON.stringify(entry) + "\n";
    } catch {
      line = JSON.stringify({ time, level: name, msg: "[log entry could not be serialised]" }) + "\n";
    }
    try {
      stream.write(line);
    } catch {
      // logging must never throw
    }
  };

  const make = (name) => (fieldsOrMessage, message) => (typeof fieldsOrMessage === "string" ? write(name, {}, fieldsOrMessage) : write(name, fieldsOrMessage ?? {}, message));

  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child(bindings) {
      return createLogger({ level, stream, secrets: [...secretValues], base: { ...base, ...bindings } });
    },
  };
}

/** A logger that records lines in memory; for tests. */
export function createMemoryLogger(options = {}) {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ ...options, stream }), lines };
}
