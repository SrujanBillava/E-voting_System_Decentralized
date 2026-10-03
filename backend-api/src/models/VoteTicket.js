import mongoose from "mongoose";

export const TICKET_STATUS = Object.freeze({ AUTH_ISSUED: "AUTH_ISSUED", SUBMITTING: "SUBMITTING", SUBMITTED: "SUBMITTED", CONFIRMED: "CONFIRMED", FAILED: "FAILED" });

/**
 * One vote attempt per voter per election. It holds correctness-critical data (the confirmed candidate and the
 * nullifier) because the backend must submit exactly what the voter confirmed. That is NOT ballot secrecy:
 * whoever can read this collection can link voter to vote. `rawTx` is kept only until confirmation (crash-safe rebroadcast).
 */
const schema = new mongoose.Schema(
  {
    voterId: { type: mongoose.Schema.Types.ObjectId, required: true },
    electionId: { type: String, required: true },
    constituencyCode: { type: String, required: true },
    constituencyId: { type: String, required: true, select: false },
    nullifier: { type: String, required: true, select: false },
    candidateId: { type: String, required: true, select: false },
    status: { type: String, enum: Object.values(TICKET_STATUS), default: TICKET_STATUS.AUTH_ISSUED },
    authorizationExpiresAt: { type: Date, required: true },
    idempotencyKey: { type: String, default: null },
    lockUntil: { type: Date, default: null },
    claimToken: { type: String, default: null }, // identifies the request currently allowed to write submission state (fences stale writers)
    submissionAttempts: { type: Number, default: 0 },
    authDeadline: { type: Number, default: null }, // unix seconds inside the signed authorization
    nonce: { type: Number, default: null },
    txHash: { type: String, default: null },
    lastTxHash: { type: String, default: null }, // the transaction a reset discarded as "unknown": lets a lagging-RPC false alarm heal later
    rawTx: { type: String, default: null, select: false },
    confirmedAt: { type: Date, default: null },
    failureCode: { type: String, default: null },
  },
  { timestamps: true },
);
schema.index({ electionId: 1, voterId: 1 }, { unique: true });
schema.index({ electionId: 1, nullifier: 1 }, { unique: true });

export const VoteTicket = mongoose.models.VcVoteTicket ?? mongoose.model("VcVoteTicket", schema, "votetickets");
