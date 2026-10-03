import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";
import request from "supertest";
import { CLOSED_OK_STAGES, COMPLETED_TTL_MS, STAGES, STAGE_TTL_MS } from "../../src/auth/voterStages.js";
import { ConfigError, loadEnv } from "../../src/config/env.js";
import { createErrorHandler } from "../../src/middleware/errorHandler.js";
import { createPublicRouter } from "../../src/routes/public.routes.js";
import { AppError } from "../../src/utils/errors.js";
import { validEnv } from "../helpers/env.js";

const HASH = "0x" + "ab".repeat(32);

function publicApp(service, receiptRateLimit) {
  const app = express();
  app.use("/api/v1/public", createPublicRouter({ publicService: service, receiptRateLimit }));
  app.use(createErrorHandler({ logger: { error() {} } }));
  return app;
}
const fakeService = (over = {}) => ({
  getElection: async () => ({ phase: "Open" }),
  getResults: async () => ({ phase: "Closed" }),
  verifyReceipt: async (txHash) => ({ http: 200, body: { found: true, txHash } }),
  ...over,
});

describe("step 10: stage rules", () => {
  it("COMPLETED is a short-lived stage (60 s) and only chain-reaching stages may continue after close", () => {
    assert.equal(COMPLETED_TTL_MS, 60_000);
    assert.equal(STAGE_TTL_MS[STAGES.COMPLETED], 60_000);
    assert.deepEqual([...CLOSED_OK_STAGES], [STAGES.AUTH_ISSUED, STAGES.SUBMITTED, STAGES.COMPLETED]);
    for (const early of [STAGES.AUTHENTICATED, STAGES.FACE_VERIFIED, STAGES.ELIGIBLE]) assert.ok(!CLOSED_OK_STAGES.includes(early), early);
  });
});

describe("step 10: CHAIN_CONFIRMATIONS", () => {
  it("defaults to 1 and accepts 1..99", () => {
    assert.equal(loadEnv(validEnv()).chain.confirmations, 1);
    assert.equal(loadEnv(validEnv({ CHAIN_CONFIRMATIONS: "12" })).chain.confirmations, 12);
  });
  it("rejects zero, negatives, decimals and text, naming only the variable", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "100", "01"]) {
      assert.throws(() => loadEnv(validEnv({ CHAIN_CONFIRMATIONS: bad })), (err) => err instanceof ConfigError && err.issues.map((i) => i.path).join() === "CHAIN_CONFIRMATIONS" && !err.message.includes(`"${bad}"`), bad);
    }
  });
});

describe("step 10: AppError details", () => {
  const send = (error) => {
    const out = {};
    const res = { headersSent: false, status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    createErrorHandler({ logger: { error() {} } })(error, { id: "rid", method: "GET", path: "/p" }, res, () => {});
    return out;
  };
  it("are returned next to the code when set, and omitted otherwise", () => {
    assert.deepEqual(send(new AppError(409, "ALREADY_VOTED", "m", { details: { receiptAvailable: true } })).body, { error: { code: "ALREADY_VOTED", message: "m", details: { receiptAvailable: true }, requestId: "rid" } });
    assert.deepEqual(send(new AppError(409, "X", "m")).body, { error: { code: "X", message: "m", requestId: "rid" } });
  });
  it("never come from a non-AppError", () => {
    assert.deepEqual(send(Object.assign(new Error("boom"), { details: { secret: 1 } })).body.error, { code: "INTERNAL_ERROR", message: "Internal server error", requestId: "rid" });
  });
});

describe("step 10: public routes", () => {
  it("validate the hash strictly before calling the service", async () => {
    let calls = 0;
    const app = publicApp(fakeService({ verifyReceipt: async (h) => (calls++, { http: 200, body: { txHash: h } }) }));
    for (const bad of ["0x12", "xyz", "0x" + "g".repeat(64), "0x" + "a".repeat(65), "a".repeat(64)]) assert.equal((await request(app).get(`/api/v1/public/receipts/${bad}`)).status, 400, bad);
    assert.equal(calls, 0);
    assert.equal((await request(app).get(`/api/v1/public/receipts/${HASH}`)).status, 200);
    assert.equal((await request(app).get(`/api/v1/public/receipts/${HASH}?x=1`)).status, 400);
    assert.equal(calls, 1);
  });

  it("rate limit receipt verification only (election and results are cached by the service instead)", async () => {
    const app = publicApp(fakeService(), { windowMs: 60_000, limit: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app).get(`/api/v1/public/receipts/${HASH}`)).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    for (let i = 0; i < 6; i++) assert.equal((await request(app).get("/api/v1/public/election")).status, 200);
  });

  it("only GET exists; results get a cache header only on success", async () => {
    const app = publicApp(fakeService());
    for (const path of ["/election", "/results", `/receipts/${HASH}`]) assert.equal((await request(app).post(`/api/v1/public${path}`).send({})).status, 404, path);
    const ok = await request(app).get("/api/v1/public/results");
    assert.match(ok.headers["cache-control"], /public/);
    const refused = await request(publicApp(fakeService({ getResults: async () => { throw new AppError(403, "RESULTS_NOT_AVAILABLE", "no"); } }))).get("/api/v1/public/results");
    assert.equal(refused.status, 403);
    assert.doesNotMatch(refused.headers["cache-control"] ?? "", /public/);
    assert.equal((await request(app).get("/api/v1/public/results?x=1")).status, 400);
  });
});
