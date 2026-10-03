import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createErrorHandler } from "./middleware/errorHandler.js";
import { noStore } from "./middleware/noStore.js";
import { notFound } from "./middleware/notFound.js";
import { requestId } from "./middleware/requestId.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { createVoterRouter } from "./routes/voter.routes.js";
import { createAdminRouter } from "./routes/admin.routes.js";
import { createApiRouter } from "./routes/index.js";
import { createFaceAdminRouter, createFaceVoterRouter } from "./routes/face.routes.js";
import { AppError } from "./utils/errors.js";

/**
 * Builds the Express application. Importing or calling this opens NO port and makes NO external
 * connection: everything it needs is passed in. server.js wires the real services.
 *
 * @param {{ config: { corsOrigins: readonly string[] }, logger: object, healthService: object }} deps
 */
export function createApp({ config, logger, healthService, admin, voter, loginRateLimit, voterLoginRateLimit }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);
  // Express's built-in fallback handler prints stack traces unless env is "production". Our error handler
  // answers every error itself, but this makes sure a stack can never reach a client even if it fails.
  app.set("env", "production");

  const allowedOrigins = new Set(config.corsOrigins);

  app.use(requestId);
  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(noStore);
  app.use(
    cors({
      // Requests without an Origin header (curl, server-to-server, same-origin navigations) pass;
      // browsers always send Origin on cross-origin requests, and anything not allow-listed is refused.
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) return callback(null, true);
        return callback(new AppError(403, "CORS_ORIGIN_NOT_ALLOWED", "Origin is not allowed"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  app.use("/api/v1", createApiRouter({ healthService }));
  // Biometrics (AUTHENTICATED -> FACE_VERIFIED, and admin face enrolment). Mounted first so its admin routes authenticate once.
  if (voter?.faceService) app.use("/api/v1/voter/face", createFaceVoterRouter({ authService: voter.authService, faceService: voter.faceService, config, faceRateLimit: voter.faceRateLimit }));
  if (admin?.faceService) app.use("/api/v1/admin", createFaceAdminRouter({ authService: admin.authService, faceService: admin.faceService }));
  if (voter) app.use("/api/v1/voter", createVoterRouter({ authService: voter.authService, config, loginRateLimit: voterLoginRateLimit }));
  if (admin) app.use("/api/v1/admin", createAdminRouter({ ...admin, config, loginRateLimit }));

  app.use(notFound);
  app.use(createErrorHandler({ logger }));
  return app;
}
