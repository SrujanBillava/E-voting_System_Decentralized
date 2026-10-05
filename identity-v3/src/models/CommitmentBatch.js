import mongoose from "mongoose";

export const BATCH = Object.freeze({
  PREPARED: "PREPARED", // reservations claimed, nothing signed yet
  SIGNED: "SIGNED", // the exact raw transaction is persisted (before any broadcast)
  BROADCAST: "BROADCAST", // sent at least once
  CONFIRMED: "CONFIRMED", // receipt success and both events verified; the voters' records are being finalized
  FINALIZED: "FINALIZED", // every voter record is ISSUED and the linkage data is gone
  FAILED: "FAILED", // the chain proved it never registered the commitments
  RECONCILE_REQUIRED: "RECONCILE_REQUIRED", // a mined success without the expected evidence: a human decides (never auto-released, never auto-issued)
});
export const UNFINISHED = Object.freeze([BATCH.PREPARED, BATCH.SIGNED, BATCH.BROADCAST, BATCH.CONFIRMED, BATCH.RECONCILE_REQUIRED]);

/**
 * One on-chain commitment batch. It is NOT linked to any voter (no voter id anywhere in it): it is operational chain data. Voter records point at it by
 * `batchId` only while pending. When it is FINALIZED the commitments and the raw transaction are removed; the tx hash, block, epoch and root stay.
 */
const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // batchId (random UUID)
    electionId: { type: String, required: true },
    constituencyId: { type: String, required: true },
    state: { type: String, enum: Object.values(BATCH), required: true },
    commitments: { type: [String], default: undefined }, // decimal, sorted ascending (so the order says nothing about who reserved first)
    count: { type: Number, required: true },
    startBlock: { type: Number, default: 0 }, // the head when the batch was prepared: where an "already mined?" scan starts

    nonce: { type: Number, default: null },
    gasLimit: { type: String, default: null },
    txHash: { type: String, default: null },
    rawTx: { type: String, default: null, select: false },

    epoch: { type: Number, default: null },
    firstIndex: { type: Number, default: null },
    issuedTotal: { type: Number, default: null },
    blockNumber: { type: Number, default: null },
    merkleRoot: { type: String, default: null },
    failureCode: { type: String, default: null },

    claimToken: { type: String, default: null }, // fences stale drivers
    lockUntil: { type: Date, default: null },
  },
  { versionKey: false, timestamps: false, autoIndex: false },
);
schema.index({ electionId: 1, state: 1, constituencyId: 1 });

export const CommitmentBatch = mongoose.models.V3CommitmentBatch ?? mongoose.model("V3CommitmentBatch", schema, "commitmentbatches_v3");
