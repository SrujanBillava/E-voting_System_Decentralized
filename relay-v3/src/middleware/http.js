import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { AppError } from "../utils/errors.js";

/**
 * A fresh random id per request. An INBOUND request id is deliberately NOT accepted: a client-chosen id is a place to smuggle an identifier
 * (for example one that came from the identity service) into this service's logs.
 */
export function requestId(req, res, next) {
  req.id = randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

/**
 * One access-log line per response: method, the matched ROUTE PATTERN (never the concrete path: /v1/ballots/:nullifier, not the nullifier), status, duration.
 * Nothing about the caller is read: no ip, no user agent, no referer, no cookie, no header, no body.
 */
export function accessLog(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const route = req.route ? `${req.baseUrl ?? ""}${req.route.path}` : "(unmatched)";
      logger.info({ requestId: req.id, method: req.method, route, status: res.statusCode, durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n) }, "request");
    });
    next();
  };
}

export const noStore = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};
export const notFound = (_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Route not found"));

/**
 * A GLOBAL (not per-client) request budget: this process has no notion of who is calling, so it cannot throttle per caller. Per-client throttling belongs
 * at the network edge, where the source address is visible anyway.
 */
export function globalLimit({ limit, windowMs = 60_000, now = Date.now }) {
  let windowStart = now();
  let count = 0;
  return (_req, _res, next) => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      count = 0;
    }
    if (++count > limit) return next(new AppError(429, "RATE_LIMITED", "The relayer is busy, try again shortly"));
    next();
  };
}

const BODY_PARSER_ERRORS = new Map([
  ["entity.parse.failed", [400, "INVALID_JSON", "Request body is not valid JSON"]],
  ["entity.too.large", [413, "PAYLOAD_TOO_LARGE", "Request body is too large"]],
  ["charset.unsupported", [415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported character set"]],
  ["encoding.unsupported", [415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content encoding"]],
]);
function clientErrorOf(err) {
  const status = err?.status ?? err?.statusCode;
  if (!Number.isInteger(status) || status < 400 || status > 499 || !STATUS_CODES[status]) return undefined;
  return [status, STATUS_CODES[status].toUpperCase().replace(/[^A-Z0-9]+/g, "_"), STATUS_CODES[status]];
}
const FALLBACK_BODY = '{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}';

export function createErrorHandler({ logger }) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    try {
      let status = 500;
      let code = "INTERNAL_ERROR";
      let message = "Internal server error";
      let details;
      if (err instanceof AppError) {
        ({ status, code, message, details } = err);
      } else {
        const mapped = BODY_PARSER_ERRORS.get(err?.type) ?? clientErrorOf(err);
        if (mapped) [status, code, message] = mapped;
      }
      if (status >= 500) logger.error({ requestId: req.id, method: req.method, err }, "unhandled error");
      res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId: req.id } });
    } catch {
      try {
        res.status(500).type("application/json").send(FALLBACK_BODY);
      } catch {
        res.destroy();
      }
    }
  };
}
