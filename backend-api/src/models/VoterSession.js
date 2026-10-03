import mongoose from "mongoose";
import { STAGE_ORDER, STAGES } from "../auth/voterStages.js";

/**
 * Server-side voter session. The browser holds only an opaque random token; we store its SHA-256.
 * `active` exists so a PARTIAL UNIQUE index can allow exactly one live session per voter atomically.
 */
const schema = new mongoose.Schema({
  voterId: { type: mongoose.Schema.Types.ObjectId, required: true },
  tokenHash: { type: String, required: true, unique: true },
  stage: { type: String, enum: STAGE_ORDER, default: STAGES.AUTHENTICATED },
  createdAt: { type: Date, required: true },
  lastActivityAt: { type: Date, required: true },
  absoluteExpiresAt: { type: Date, required: true },
  stageExpiresAt: { type: Date, required: true },
  active: { type: Boolean, default: true },
  revokedAt: { type: Date, default: null },
  faceMethod: { type: String, default: null },
  ticketId: { type: String, default: null },
});
schema.index({ voterId: 1 }, { unique: true, partialFilterExpression: { active: true } });
schema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 3600 }); // housekeeping only; expiry is also checked in code

export const VoterSession = mongoose.models.VcVoterSession ?? mongoose.model("VcVoterSession", schema, "votersessions");
