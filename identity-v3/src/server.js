import fs from "node:fs";
import mongoose from "mongoose";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "./config/env.js";
import { PreflightError, runPreflight } from "./chain/preflight.js";
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

  mongoose.set("strictQuery", true);
  await mongoose.connect(config.secrets.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await ensureIndexes();

  const identity = composeIdentity({ config, logger });
  try {
    const facts = await runPreflight(identity.chain, config);
    logger.info({ issuer: facts.issuer, maxBatch: facts.maxBatch }, "chain preflight passed");
  } catch (err) {
    if (err instanceof PreflightError) {
      logger.error({ code: err.code }, err.message);
      await mongoose.disconnect();
      process.exit(1);
    }
    throw err;
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
  const shutdown = async () => {
    clearInterval(timer);
    server.close();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
