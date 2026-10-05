import cors from "cors";
import express from "express";
import helmet from "helmet";
import { accessLog, createErrorHandler, globalLimit, noStore, notFound, requestId } from "./middleware/http.js";
import { createRelayRouter } from "./routes/relay.routes.js";
import { AppError } from "./utils/errors.js";

/**
 * Builds the relayer's Express application. Importing or calling this opens NO port and makes NO external connection.
 *
 * What is deliberately ABSENT: a cookie parser (cookies are never read, so they can neither be required nor consumed), any authentication, any session,
 * any per-client throttle, `trust proxy` (the caller's address is never looked at), and every identity-side import. CORS answers with
 * `credentials: false`: the future frontend calls this service with `credentials: "omit"`.
 */
export function createApp({ config, logger, health, relay, globalLimitPerMinute = config.globalLimitPerMinute, now }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("env", "production");

  const allowedOrigins = new Set(config.corsOrigins);
  app.use(requestId);
  app.use(accessLog(logger));
  app.use(helmet());
  app.use(noStore);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        return callback(new AppError(403, "CORS_ORIGIN_NOT_ALLOWED", "Origin is not allowed"));
      },
      credentials: false,
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type"],
      exposedHeaders: [],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "64kb" }));
  app.use(globalLimit({ limit: globalLimitPerMinute, ...(now ? { now } : {}) }));

  app.get("/v1/health", async (_req, res) => res.json({ data: await health.getPublicHealth() }));
  app.use("/v1", createRelayRouter(relay));

  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  return app;
}
