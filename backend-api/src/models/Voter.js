import mongoose from "mongoose";

/**
 * V2 voter. MongoDB is authoritative; nothing here ever goes on-chain.
 * `uid` is the secret input to the nullifier derivation: random, unique, never derived from voterId,
 * and `select:false` so no ordinary query returns it. `voterId` is the human-facing VoteChain id.
 */
const schema = new mongoose.Schema(
  {
    uid: { type: String, required: true, unique: true, select: false, immutable: true },
    voterId: { type: String, required: true, unique: true, immutable: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    constituencyCode: { type: String, required: true, index: true },
    status: { type: String, enum: ["ACTIVE", "SUSPENDED"], default: "ACTIVE", index: true },
    faceEnrolled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export const Voter = mongoose.models.VcVoter ?? mongoose.model("VcVoter", schema, "voters_v2");
