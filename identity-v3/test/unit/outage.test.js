import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { makeError } from "ethers";
import { ConfigError, loadEnv } from "../../src/config/env.js";
import { isTransientRpcError } from "../../src/chain/provider.js";
import { unavailable } from "../../src/chain/chain.js";
import { PreflightError } from "../../src/chain/preflight.js";
import { classifySimulationError, retryDelayMs, selectGasLimit } from "../../src/services/batcher.service.js";

// The error shapes below are the ones ethers v6.17 produced against a real Hardhat node behind a fault-injecting proxy (measured, see test/helpers/rpcProxy.js):
// a JSON-RPC error object answering eth_call becomes a CALL_EXCEPTION WITHOUT any data, and network failures keep their system code.
const rpcErrorOnCall = (message) => makeError("missing revert data", "CALL_EXCEPTION", { action: "call", data: null, reason: null, transaction: {}, invocation: null, revert: null, info: { error: { code: -32603, message } } });
const hardhatOutOfGas = () => makeError("missing revert data", "CALL_EXCEPTION", { action: "call", data: null, reason: null, transaction: {}, invocation: null, revert: null, info: { error: { code: -32603, message: "Transaction ran out of gas" } } });
const emptyRevert = () => makeError("execution reverted (no data present; likely require(false) occurred", "CALL_EXCEPTION", { action: "call", data: "0x", reason: null, transaction: {}, invocation: null, revert: null });
const decoded = (name) => makeError(`execution reverted: ${name}`, "CALL_EXCEPTION", { action: "call", data: "0x31e63ea0", reason: null, transaction: {}, invocation: null, revert: { name, signature: `${name}()`, args: [] } });
const system = (code) => Object.assign(new Error(`connect ${code} 127.0.0.1:8545`), { code });

describe("identity-v3: outages are temporary, never a decision about a voter (pure policy)", () => {
  describe("classifySimulationError and isTransientRpcError", () => {
    it("a JSON-RPC error object answering the simulation (rate limit, 'header not found', internal error) is TRANSIENT, not an out-of-gas verdict", () => {
      for (const message of ["Internal error: header not found", "limit exceeded", "Too Many Requests", "upstream request timeout"]) {
        assert.equal(classifySimulationError(rpcErrorOnCall(message)), "TRANSIENT", message);
        assert.equal(isTransientRpcError(rpcErrorOnCall(message)), true, message);
      }
    });
    it("a real out-of-gas still escalates the gas ladder: the local network says so in its message, other clients spell it differently, or the call ends with empty revert data", () => {
      assert.equal(classifySimulationError(hardhatOutOfGas()), "OUT_OF_GAS");
      assert.equal(classifySimulationError(rpcErrorOnCall("OutOfGas")), "OUT_OF_GAS", "Nethermind's spelling");
      assert.equal(classifySimulationError(rpcErrorOnCall("out of gas")), "OUT_OF_GAS", "geth's spelling");
      assert.equal(classifySimulationError(emptyRevert()), "OUT_OF_GAS");
      assert.equal(isTransientRpcError(emptyRevert()), false, "the node executed the call: deterministic");
    });
    it("network failures of every kind are TRANSIENT; decoded reverts and decoding failures are not", () => {
      for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EHOSTUNREACH"]) {
        assert.equal(classifySimulationError(system(code)), "TRANSIENT", code);
        assert.equal(isTransientRpcError(system(code)), true, code);
      }
      for (const err of [makeError("request timeout", "TIMEOUT", {}), makeError("server response 503", "SERVER_ERROR", {}), makeError("could not coalesce error", "UNKNOWN_ERROR", { error: { message: "limit exceeded" } }), unavailable()]) {
        assert.equal(isTransientRpcError(err), true, err.code);
      }
      assert.equal(classifySimulationError(decoded("IssuanceNotOpen")), "REVERT");
      assert.equal(isTransientRpcError(decoded("IssuanceNotOpen")), false);
      assert.equal(isTransientRpcError(makeError("could not decode result data", "BAD_DATA", { value: "0x" })), false, "a wrong contract is a configuration error, not an outage");
      assert.equal(isTransientRpcError(new PreflightError("ISSUER_MISMATCH", "x")), false);
      assert.equal(isTransientRpcError(new TypeError("a bug")), false);
      assert.equal(isTransientRpcError(null), false);
    });
    it("a JSON-RPC error during the gas ladder stops it at the first attempt as TRANSIENT (it is not escalated to the cap and never splits the cohort)", async () => {
      const calls = [];
      const r = await selectGasLimit({
        count: 4,
        treeSize: 31,
        estimate: async () => {
          throw rpcErrorOnCall("limit exceeded");
        },
        simulate: async (gasLimit) => {
          calls.push(gasLimit);
          throw rpcErrorOnCall("limit exceeded");
        },
      });
      assert.equal(r.ok, false);
      assert.equal(r.kind, "TRANSIENT");
      assert.equal(calls.length, 1);
    });
  });

  describe("retryDelayMs: controlled backoff, never a busy loop and never unbounded", () => {
    const opts = { after: 3, baseMs: 2000, maxMs: 60_000 };
    it("the first failures retry at the normal tick, then the wait doubles up to the cap", () => {
      assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 50, 10_000].map((n) => retryDelayMs(n, opts)), [0, 0, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000, 60_000]);
    });
    it("is monotonic, positive once backing off, and capped for any count", () => {
      let previous = 0;
      for (let n = 1; n <= 2000; n++) {
        const d = retryDelayMs(n, opts);
        assert.ok(d >= previous && d <= 60_000 && Number.isFinite(d), String(n));
        if (n >= 3) assert.ok(d > 0);
        previous = d;
      }
    });
  });

  describe("CHAIN_RETRY_MAX_MS", () => {
    const env = (over = {}) => ({
      NODE_ENV: "test",
      IDENTITY_MONGODB_URI: "mongodb://127.0.0.1:27017/votechain_identity_v3_test",
      CHAIN_RPC_URL: "http://127.0.0.1:8545",
      CHAIN_ID: "31337",
      VOTECHAIN_V3_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      ISSUER_PRIVATE_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // public Hardhat account #2 (refused in production)
      FACE_TEMPLATE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ...over,
    });
    it("defaults to one minute and accepts 100 ms .. 10 min; anything else is refused by name", () => {
      assert.equal(loadEnv(env()).chain.retryMaxMs, 60_000);
      assert.equal(loadEnv(env({ CHAIN_RETRY_MAX_MS: "500" })).chain.retryMaxMs, 500);
      for (const bad of ["99", "600001", "abc", "-5", "1e4"]) {
        assert.throws(() => loadEnv(env({ CHAIN_RETRY_MAX_MS: bad })), (err) => err instanceof ConfigError && err.issues.some((i) => i.path === "CHAIN_RETRY_MAX_MS"), bad);
      }
    });
  });
});
