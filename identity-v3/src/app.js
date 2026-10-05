import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createErrorHandler, noStore, notFound, requestId, requestLogger } from "./middleware/http.js";
import { createVoterRouter } from "./routes/voter.routes.js";
import { AppError } from "./utils/errors.js";

/**
 * Builds the identity Express application. Importing or calling this opens NO port and makes NO external connection: everything is passed in.
 * The API is mounted at /api/v3/voter. The only other route is /api/v3/health.
 */
export function createApp({ config, logger, healthService, voter, voterLoginRateLimit, faceRateLimit }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  app.set("env", "production"); // Express's fallback handler must never print a stack trace

  const allowedOrigins = new Set(config.corsOrigins);
  app.use(requestId);
  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(noStore);
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        return callback(new AppError(403, "CORS_ORIGIN_NOT_ALLOWED", "Origin is not allowed"));
      },
      credentials: true, // the identity session IS a cookie session; the anonymous relayer is the opposite (credentials: "omit")
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.get("/api/v3/health", async (_req, res) => res.json({ data: await healthService.getPublicHealth() }));
  app.use("/api/v3/voter", createVoterRouter({ authService: voter.authService, faceService: voter.faceService, credentialService: voter.credentialService, config, loginRateLimit: voterLoginRateLimit, faceRateLimit }));

  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  return app;
}
