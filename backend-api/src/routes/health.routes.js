import { Router } from "express";

export function createHealthRoutes({ healthController }) {
  const router = Router();
  router.get("/health", healthController.getHealth);
  return router;
}
