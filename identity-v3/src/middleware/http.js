import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { AppError } from "../utils/errors.js";

const SAFE_INBOUND_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Assigns every request an id (accepting a well-formed inbound X-Request-Id) and echoes it back. */
export function requestId(req, res, next) {
  const inbound = req.get("x-request-id");
  req.id = inbound && SAFE_INBOUND_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}

/** One access-log line per response. Logs the path only: never query strings, headers, cookies or bodies. */
export function requestLogger(logger) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    const path = req.path;
    res.on("finish", () => {
      logger.info({ requestId: req.id, method: req.method, path, status: res.statusCode, durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n) }, "request");
    });
    next();
  };
}

export const noStore = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

export const notFound = (_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Route not found"));

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

/**
 * The single place errors become responses. Only AppError (our own, deliberately worded errors) and a few mapped client errors reach the client with their
 * text. Everything else is logged in full and answered with a generic INTERNAL_ERROR: no err.message, no stack. It must never throw.
 */
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
      if (status >= 500) logger.error({ requestId: req.id, method: req.method, path: req.path, err }, "unhandled error");
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
