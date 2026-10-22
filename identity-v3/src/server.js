import fs from "node:fs";
import mongoose from "mongoose";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "./config/env.js";
import { PreflightError, runPreflight } from "./chain/preflight.js";
import { isTransientRpcError } from "./chain/provider.js";
import { composeIdentity, ensureIndexes } from "./compose.js";
import { createLogger } from "./utils/logger.js";

// A local .env is a development convenience; production passes real environment variables.
if (fs.existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

async function main() {
  let config;
  try {
    config = loadEnv(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger({ level: config.logLevel, secrets: secretValuesOf(config), base: { service: "identity-v3" } });
  logger.info(describeConfig(config), "starting the identity service");

  // A stop request is honoured at every point, including while waiting for an unreachable chain node below (replaced once the service is up).
  let stop = async () => {
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => stop());
  process.on("SIGTERM", () => stop());

  mongoose.set("strictQuery", true);
  await mongoose.connect(config.secrets.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await ensureIndexes();

  const retryMaxMs = config.chain.retryMaxMs;
  const identity = composeIdentity({ config, logger, batch: { backoffBaseMs: config.batch.intervalMs, backoffMaxMs: retryMaxMs } });
  // The preflight needs the chain. A node that does not answer (an outage, a restart during one) is waited for with backoff: nothing is cancelled meanwhile, and
  // every pending credential request is continued once it answers. A node that answers WRONGLY (another chain, no contract, not the issuer) stops the process.
  for (let attempt = 1; ; attempt++) {
    try {
      const facts = await runPreflight(identity.chain, config);
      logger.info({ issuer: facts.issuer, maxBatch: facts.maxBatch, attempts: attempt }, "chain preflight passed");
      break;
    } catch (err) {
      if (err instanceof PreflightError) {
        logger.error({ code: err.code }, err.message);
        await mongoose.disconnect();
        process.exit(1);
      }
      if (!isTransientRpcError(err)) throw err;
      const retryInMs = Math.min(retryMaxMs, 1000 * 2 ** Math.min(attempt - 1, 20));
      const fields = { code: err.code ?? null, attempt, retryInMs, rpcHost: describeConfig(config).rpcHost };
      if (attempt >= 5) logger.error(fields, "the chain node is still unreachable at startup; the service waits for it (pending credential requests are kept and continue when it answers)");
      else logger.warn(fields, "the chain node is unreachable at startup; waiting before the preflight is retried");
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }

  await identity.batcher.recover(); // finish whatever a previous process left half-done, exactly where it stopped
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await identity.batcher.tick();
    } catch (err) {
      logger.error({ err }, "batch tick failed; it will be retried");
    } finally {
      ticking = false;
    }
  }, config.batch.intervalMs);

  const server = identity.app.listen(config.port, "127.0.0.1", () => logger.info({ port: config.port }, "identity service listening (loopback only; put it behind id.votechain.<domain>)"));
  stop = async () => {
    clearInterval(timer);
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
