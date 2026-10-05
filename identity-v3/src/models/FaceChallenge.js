import mongoose from "mongoose";

/** The face step of ONE voter session: its current challenge and attempt counter (one row per session, so use + count are one atomic update). */
const schema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, immutable: true },
    voterId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    attempts: { type: Number, default: 0 },
    challengesIssued: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    tokenHash: { type: String, default: null },
    action: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    purgeAt: { type: Date, required: true }, // the session's absolute expiry
  },
  { versionKey: false, autoIndex: false },
);
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 3600 });

export const FaceChallenge = mongoose.models.V3FaceChallenge ?? mongoose.model("V3FaceChallenge", schema, "facechallenges_v3");
