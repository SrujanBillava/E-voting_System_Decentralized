import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { AppError } from "../utils/errors.js";
import { parse } from "../utils/validate.js";

const Nothing = z.strictObject({});
const TxParams = z.strictObject({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

/**
 * Unauthenticated, read-only. Receipt verification is rate limited per IP; election info and (Closed-only) results are cheap
 * because they are cached by the service, so they carry no aggressive limit.
 */
export function createPublicRouter({ publicService, receiptRateLimit = { windowMs: 60_000, limit: 30 }, readRateLimit = { windowMs: 60_000, limit: 120 } }) {
  const router = Router();
  const limiter = rateLimit({ ...receiptRateLimit, standardHeaders: true, legacyHeaders: false, handler: (_q, _r, next) => next(new AppError(429, "RATE_LIMITED", "Too many requests, try again later")) });

  const readLimiter = rateLimit({ ...readRateLimit, standardHeaders: true, legacyHeaders: false, handler: (_q, _r, next) => next(new AppError(429, "RATE_LIMITED", "Too many requests, try again later")) });

  router.get("/election", readLimiter, async (req, res) => {
    parse(Nothing, req.query);
    res.json({ data: await publicService.getElection() });
  });

  router.get("/results", readLimiter, async (req, res) => {
    parse(Nothing, req.query);
    const data = await publicService.getResults();
    res.set("Cache-Control", "public, max-age=60"); // Closed results are immutable
    res.json({ data });
  });

  router.get("/receipts/:txHash", limiter, async (req, res) => {
    parse(Nothing, req.query);
    const { txHash } = parse(TxParams, req.params);
    const out = await publicService.verifyReceipt(txHash);
    res.status(out.http).json({ data: out.body });
  });

  return router;
}
