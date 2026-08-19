import express from "express";
import {
  adminLogin,
  refreshAdminToken,
  adminLogout,
  createVoter,
  deleteVoter,
  getVoter,
  getVoters,
  updatePassword,
  updateVoter
} from "../controllers/admin.js";
import { adminProtect } from "../middleware/adminProtect.js";

const router = express.Router();

router.post("/login", adminLogin);
router.get("/refresh", refreshAdminToken);
router.post("/logout", adminLogout);

// Protected routes
router.use(adminProtect);

router
  .route("/voters/")
  .post(createVoter)
  .get(getVoters);

router
  .route("/voters/:id")
  .get(getVoter)
  .put(updateVoter)
  .delete(deleteVoter);

export default router;