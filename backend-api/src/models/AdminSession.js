import mongoose from "mongoose";

/** One row per refresh token. Only the SHA-256 of the token is stored. A family is one login chain. */
const schema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true },
  familyId: { type: String, required: true, index: true },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
  replacedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
});

export const AdminSession = mongoose.models.VcAdminSession ?? mongoose.model("VcAdminSession", schema, "adminsessions");
