import { Router } from "express";
import { createHealthController } from "../controllers/health.controller.js";
import { createHealthRoutes } from "./health.routes.js";

/** All /api/v1 routes. Later steps add voter, admin and public election routes here. */
export function createApiRouter({ healthService }) {
  const router = Router();
  router.use(createHealthRoutes({ healthController: createHealthController({ healthService }) }));
  return router;
}
