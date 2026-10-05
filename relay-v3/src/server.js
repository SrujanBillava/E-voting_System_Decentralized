import fs from "node:fs";
import mongoose from "mongoose";
import { PreflightError, runPreflight } from "./chain/preflight.js";
import { composeRelay, ensureIndexes } from "./compose.js";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "./config/env.js";
import { createLogger } from "./utils/logger.js";

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
  const logger = createLogger({ level: config.logLevel, secrets: secretValuesOf(config), base: { service: "relay-v3" } });
  logger.info(describeConfig(config), "starting the anonymous relayer");

  mongoose.set("strictQuery", true);
  await mongoose.connect(config.secrets.mongodbUri, { serverSelectionTimeoutMS: 5000 });
  await ensureIndexes();

  const relay = composeRelay({ config, logger });
  try {
    const facts = await runPreflight(relay.chain, config);
    logger.info({ relayer: facts.relayer }, "chain preflight passed");
  } catch (err) {
    if (err instanceof PreflightError) {
      logger.error({ code: err.code }, err.message);
      await mongoose.disconnect();
      process.exit(1);
    }
    throw err;
  }

  await relay.submitService.recover(); // continue every submission a previous process left in flight, byte for byte
  const sweep = setInterval(() => relay.submitService.recoverPending().catch((err) => logger.error({ err }, "recovery sweep failed")), 5000);
  const server = relay.app.listen(config.port, "127.0.0.1", () => logger.info({ port: config.port }, "relayer listening (loopback only; put it behind relay.votechain.<domain>)"));
  const shutdown = async () => {
    clearInterval(sweep);
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
