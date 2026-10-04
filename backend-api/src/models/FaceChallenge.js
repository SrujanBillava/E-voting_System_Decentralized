import mongoose from "mongoose";

/**
 * The face step of ONE voter session: its current challenge and its attempt counter.
 *
 * One row per session (unique index), so "use the challenge" and "count the attempt" happen in a single
 * atomic update and two parallel requests can never both succeed. Only the SHA-256 of the challenge is
 * stored. Asking for a new challenge replaces the previous one.
 */
const schema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, immutable: true },
    voterId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    attempts: { type: Number, default: 0 }, // comparisons performed in this session
    challengesIssued: { type: Number, default: 0 },
    lockedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },

    tokenHash: { type: String, default: null },
    action: { type: String, default: null },
    issuedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },

    purgeAt: { type: Date, required: true }, // the session's absolute expiry
  },
  { versionKey: false },
);
schema.index({ purgeAt: 1 }, { expireAfterSeconds: 3600 }); // housekeeping only; expiry is checked in code

export const FaceChallenge = mongoose.models.VcFaceChallenge ?? mongoose.model("VcFaceChallenge", schema, "facechallenges");
