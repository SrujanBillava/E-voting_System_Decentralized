import { STATUS_CODES } from "node:http";
import { AppError } from "../utils/errors.js";

// body-parser errors carry a stable `type`; we map them to our own fixed messages.
// (A Map, not an object literal: `err.type === "constructor"` must not find anything.)
const BODY_PARSER_ERRORS = new Map([
  ["entity.parse.failed", [400, "INVALID_JSON", "Request body is not valid JSON"]],
  ["entity.too.large", [413, "PAYLOAD_TOO_LARGE", "Request body is too large"]],
  ["charset.unsupported", [415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported character set"]],
  ["encoding.unsupported", [415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported content encoding"]],
]);

/**
 * Other client mistakes arrive as http-errors with a 4xx status and no stable type (a corrupt gzip body,
 * an aborted upload, ...). They are the client's fault, not a 500; the wording is the standard status text,
 * never the library's message.
 */
function clientErrorOf(err) {
  const status = err?.status ?? err?.statusCode;
  if (!Number.isInteger(status) || status < 400 || status > 499 || !STATUS_CODES[status]) return undefined;
  return [status, STATUS_CODES[status].toUpperCase().replace(/[^A-Z0-9]+/g, "_"), STATUS_CODES[status]];
}

const FALLBACK_BODY = '{"error":{"code":"INTERNAL_ERROR","message":"Internal server error"}}';

/**
 * The single place errors become responses. Only AppError (our own, deliberately worded errors)
 * and a few mapped client errors reach the client with their text. Everything else is logged
 * in full and answered with a generic INTERNAL_ERROR: no err.message, no stack.
 *
 * It must never throw: Express's own fallback handler would print a stack trace to the client
 * unless NODE_ENV=production.
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
