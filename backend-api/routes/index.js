// routes/index.js
import express from "express";
import adminRoutes from "./admin.js";
import voterRoutes from "./voter.js";

const router = express.Router();

/**
 *  PUBLIC ROUTES (NO AUTH)
 */
router.use("/admin", adminRoutes);
router.use("/voter", voterRoutes);
// router.use("/testing", testingRoutes);

/**
 * (optional) Testing — remove in prod
 */

export default router;