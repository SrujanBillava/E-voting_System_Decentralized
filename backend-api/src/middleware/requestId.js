import { randomUUID } from "node:crypto";

const SAFE_INBOUND_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Assigns every request an id (accepting a well-formed inbound X-Request-Id) and echoes it back. */
export function requestId(req, res, next) {
  const inbound = req.get("x-request-id");
  req.id = inbound && SAFE_INBOUND_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader("X-Request-Id", req.id);
  next();
}
