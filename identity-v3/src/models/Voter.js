import mongoose from "mongoose";

/**
 * The voter REGISTRY, read-only from V3's point of view: the same collection the V2 backend uses (voters registered, constituency assigned, face enrolled),
 * so the one registry serves both systems. This service never writes it. `uid` is V2's secret nullifier input: it is declared here only to be EXCLUDED
 * (select:false), because V3 has no use for it and the identity side must never learn anything nullifier-like.
 */
export const VOTER_COLLECTION = "voters_v2";

const schema = new mongoose.Schema(
  {
    uid: { type: String, select: false },
    voterId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    constituencyCode: { type: String, required: true },
    status: { type: String, enum: ["ACTIVE", "SUSPENDED"], default: "ACTIVE" },
    faceEnrolled: { type: Boolean, default: false },
  },
  { versionKey: false, autoIndex: false }, // V2's collection: V3 never builds indexes on it
);

export const Voter = mongoose.models.V3Voter ?? mongoose.model("V3Voter", schema, VOTER_COLLECTION);
