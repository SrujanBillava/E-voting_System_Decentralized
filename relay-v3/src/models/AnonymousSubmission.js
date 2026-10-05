import mongoose from "mongoose";

export const SUBMISSION = Object.freeze({ QUEUED: "QUEUED", SIGNED: "SIGNED", BROADCAST: "BROADCAST", CONFIRMED: "CONFIRMED", FAILED: "FAILED" });
export const IN_FLIGHT = Object.freeze([SUBMISSION.QUEUED, SUBMISSION.SIGNED, SUBMISSION.BROADCAST]);

/**
 * One anonymous ballot submission, keyed by its NULLIFIER (the anonymous idempotency key). Everything in it is public-chain material or relayer bookkeeping:
 * the canonical call data (the encrypted ballot and its proofs, which end up on the public chain anyway), the package hash, the transaction. There is no field
 * that could name a voter, a session, a caller or a device, and `_id` is a random UUID. `rawTx` is kept until confirmation (crash-safe rebroadcast).
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    nullifier: { type: String, required: true, unique: true },
    constituencyId: { type: String, required: true },
    packageHash: { type: String, required: true },
    calldata: { type: String, required: true, select: false },
    state: { type: String, enum: Object.values(SUBMISSION), required: true },

    nonce: { type: Number, default: null },
    txHash: { type: String, default: null },
    lastTxHash: { type: String, default: null }, // a transaction proven dead and replaced: lets a lagging-RPC false alarm heal
    rawTx: { type: String, default: null, select: false },
    claimToken: { type: String, default: null },
    lockUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    touchedAt: { type: Number, required: true }, // ms; recovery only touches submissions idle for a while

    blockNumber: { type: Number, default: null },
    ballotIndex: { type: Number, default: null },
    failureCode: { type: String, default: null },
  },
  { versionKey: false, timestamps: false, autoIndex: false },
);
schema.index({ state: 1, touchedAt: 1 });

export const AnonymousSubmission = mongoose.models.RelayAnonymousSubmission ?? mongoose.model("RelayAnonymousSubmission", schema, "anonymous_submissions");
