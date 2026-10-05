import mongoose from "mongoose";

export const CRED = Object.freeze({ RESERVED: "RESERVED", BATCHED: "BATCHED", ISSUED: "ISSUED", CANCELLED: "CANCELLED" });
export const PENDING_STATES = Object.freeze([CRED.RESERVED, CRED.BATCHED]);

/**
 * ONE credential per voter per election. The unique index on (electionId, voterId) is the enforcement: a voter has at most one record, and a record in
 * RESERVED / BATCHED / ISSUED can never be replaced by another commitment.
 *
 * DATA MINIMISATION. While a reservation is in flight the record carries LINKAGE data (the voter's public commitment, the constituency, the epoch, the batch
 * it travels in). Every one of those fields is REMOVED when the record reaches ISSUED (or CANCELLED). What stays forever is only
 *
 *     { _id, electionId, voterId, state }
 *
 * i.e. "this voter already received a credential for this election". `_id` is a random UUID, not an ObjectId (an ObjectId embeds its creation time), and
 * the schema has no timestamps. `reservedAt` exists only while pending (it orders the queue and decides the epoch cohort).
 * Residual metadata that this framework cannot remove: MongoDB's own oplog/journal and the physical order of documents on disk.
 */
export const DURABLE_FIELDS = Object.freeze(["_id", "electionId", "voterId", "state"]);
export const LINKAGE_FIELDS = Object.freeze(["commitment", "constituencyId", "reservedAt", "reservedEpoch", "batchId", "failures"]);

const schema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    electionId: { type: String, required: true },
    voterId: { type: mongoose.Schema.Types.ObjectId, required: true },
    state: { type: String, enum: Object.values(CRED), required: true },

    commitment: { type: String },
    constituencyId: { type: String },
    reservedAt: { type: Number }, // seconds (chain clock)
    reservedEpoch: { type: Number },
    batchId: { type: String },
    failures: { type: Number },
  },
  { versionKey: false, timestamps: false, autoIndex: false },
);
schema.index({ electionId: 1, voterId: 1 }, { unique: true });
// The same commitment can never be reserved for two voters (the chain's own uniqueness covers issued ones: it is checked before every reservation and batch).
schema.index({ electionId: 1, commitment: 1 }, { unique: true, partialFilterExpression: { commitment: { $type: "string" } } });
schema.index({ electionId: 1, state: 1, constituencyId: 1, reservedEpoch: 1 });
schema.index({ batchId: 1 }, { partialFilterExpression: { batchId: { $type: "string" } } });

export const CredentialIssuance = mongoose.models.V3CredentialIssuance ?? mongoose.model("V3CredentialIssuance", schema, "credentialissuances_v3");
