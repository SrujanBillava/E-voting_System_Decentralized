import http from "node:http";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { createChainServices } from "./chain/index.js";
import { runPreflight } from "./chain/preflight.js";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "./config/env.js";
import { createMongo } from "./db/mongo.js";
import { Admin } from "./models/Admin.js";
import { AdminSession } from "./models/AdminSession.js";
import { AuditLog } from "./models/AuditLog.js";
import { createAdminAuthService } from "./services/adminAuth.service.js";
import { createAuditService } from "./services/audit.service.js";
import { Voter } from "./models/Voter.js";
import { createOwnerQueue } from "./chain/ownerQueue.js";
import { createBallotConfigService } from "./services/ballotConfig.service.js";
import { VoterSession } from "./models/VoterSession.js";
import { VoteTicket } from "./models/VoteTicket.js";
import { createRelayerQueue } from "./chain/relayerQueue.js";
import { createAuthorizationService } from "./services/authorization.service.js";
import { createCastService } from "./services/cast.service.js";
import { createEligibilityService } from "./services/eligibility.service.js";
import { createVoterAuthService } from "./services/voterAuth.service.js";
import { createVoterService } from "./services/voter.service.js";
import { createElectionService } from "./services/election.service.js";
import { createHealthService } from "./services/health.service.js";
import { createLogger } from "./utils/logger.js";

export class StartupError extends Error {
  constructor(message, preflight) {
    super(message);
    this.name = "StartupError";
    this.preflight = preflight;
  }
}

/**
 * Validates configuration, connects MongoDB, builds the blockchain services and runs the deep
 * preflight. Resolves with the ready application, or throws (ConfigError / StartupError / a Mongo
 * error) after releasing anything it opened. It does not listen on a port; main() does.
 *
 * `deps` lets tests substitute MongoDB and the logger.
 */
export async function bootstrap({ env = process.env, deps = {} } = {}) {
  const config = loadEnv(env);
  const logger = deps.logger ?? createLogger({ level: config.logLevel, secrets: secretValuesOf(config) });

  logger.info(describeConfig(config), "configuration loaded");

  // Resolving the deployment is pure configuration: fail on it before touching any connection.
  const chain = createChainServices(config);
  const mongo = (deps.createMongo ?? createMongo)({ uri: config.secrets.mongodbUri, logger });

  const release = async () => {
    chain.destroy();
    await mongo.disconnect().catch(() => {});
  };

  try {
    await mongo.connect();
    const realDb = mongoose.connection.readyState === 1; // false only when tests substitute a fake Mongo
    if (realDb) await Promise.all([VoteTicket.init(), VoterSession.init()]); // the unique indexes are load-bearing

    const healthService = createHealthService({
      runPreflight: ({ deep }) =>
        runPreflight({ deployment: chain.deployment, provider: chain.provider, contract: chain.contract, signers: chain.signers, mongo, deep }),
    });

    const preflight = await healthService.getSystemPreflight();
    for (const check of preflight.checks) {
      const log = check.status === "fail" ? logger.error : check.status === "warn" ? logger.warn : logger.info;
      log({ check: check.name, status: check.status, message: check.message, details: check.details }, "preflight");
    }
    if (!preflight.ok) throw new StartupError("blockchain/database preflight failed; refusing to start", preflight);

    const audit = createAuditService({ AuditLog, logger });
    const authService = createAdminAuthService({ Admin, AdminSession, audit, secrets: config.secrets });
    const ownerQueue = createOwnerQueue();
    const voterService = createVoterService({ Voter, chain, audit });
    const configService = createBallotConfigService({ chain, audit, ownerQueue });
    const electionService = createElectionService({ chain, healthService, auth: authService, audit, ownerQueue, voterStats: () => voterService.stats() });
    const voterWiring = (a) => {
      const authService = createVoterAuthService({ Voter, VoterSession, chain, audit: a });
      const relayerQueue = createRelayerQueue();
      return { authService, authorizationService: createAuthorizationService({ Voter, VoteTicket, authService, chain, nullifierSecret: config.secrets.nullifierSecret, audit: a }), castService: createCastService({ Voter, VoteTicket, authService, chain, relayerQueue, audit: a }), eligibilityService: createEligibilityService({ Voter, authService, chain, nullifierSecret: config.secrets.nullifierSecret, audit: a }) };
    };
    const voter = voterWiring(audit);
    const app = createApp({ config, logger, healthService, admin: { authService, electionService, voterService, configService }, voter });

    // Recovery sweep: completes votes whose voter can no longer ask (session expired, backend restarted, election closed).
    const sweep = () => voter.castService.recoverPending().catch((err) => logger.warn({ err }, "recovery sweep failed"));
    const sweepTimer = realDb ? setInterval(sweep, 30_000) : null;
    sweepTimer?.unref();
    if (realDb) void sweep();
    const close = async () => {
      if (sweepTimer) clearInterval(sweepTimer);
      await release();
    };
    return { app, config, logger, healthService, chain, mongo, preflight, close, recoverPending: () => voter.castService.recoverPending() };
  } catch (err) {
    await release();
    throw err;
  }
}

/**
 * Start listening and wait until the socket is really bound. (Express 5's app.listen(port, callback)
 * calls the callback with the error when binding fails, so a "listening" log line there would lie.)
 */
export function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * Graceful shutdown: stop accepting connections, release MongoDB and the provider, exit. Calling it
 * again (a second Ctrl-C, SIGINT then SIGTERM) does nothing; a hung close is cut off after `forceAfterMs`.
 */
export function createShutdown({ server, close, logger, exit = (code) => process.exit(code), forceAfterMs = 10_000 }) {
  let started = false;
  return (signal) => {
    if (started) return;
    started = true;
    logger.info({ signal }, "shutting down");
    const timer = setTimeout(() => exit(1), forceAfterMs);
    server.close(async () => {
      let code = 0;
      try {
        await close();
      } catch {
        code = 1;
      }
      clearTimeout(timer);
      exit(code);
    });
  };
}

/**
 * Crashes are logged through the scrubbing logger instead of Node's default printer, which dumps every
 * property of the error (an ethers error carries the RPC URL, request and response) to stderr. Then it exits, as Node would.
 */
export function installCrashHandlers({ logger, proc = process, exit = (code) => process.exit(code) }) {
  const crash = (kind) => (reason) => {
    logger.error({ err: reason }, kind);
    exit(1);
  };
  proc.on("uncaughtException", crash("uncaught exception"));
  proc.on("unhandledRejection", crash("unhandled rejection"));
}

async function main() {
  dotenv.config({ quiet: true });

  let ready;
  try {
    ready = await bootstrap();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message); // names and reasons only, never values
    } else if (err instanceof StartupError) {
      // Name root causes only; checks that were merely "not checked" because of them are noise.
      const roots = err.preflight.checks.filter((c) => c.status === "fail" && !c.message?.startsWith("not checked"));
      console.error(`${err.message}: ${roots.map((c) => c.name).join(", ")}`);
    } else {
      console.error(`startup failed: ${err?.name ?? "Error"}${err?.code ? ` (${err.code})` : ""}`);
    }
    process.exit(1);
  }

  const { app, config, logger, close } = ready;
  installCrashHandlers({ logger });

  let server;
  try {
    server = await listen(app, config.port);
  } catch (err) {
    logger.error({ port: config.port, code: err?.code, name: err?.name }, "cannot listen");
    await close().catch(() => {});
    process.exit(1);
  }
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, "api listening");

  const shutdown = createShutdown({ server, close, logger });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Run only when executed directly (node src/server.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
