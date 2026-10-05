import mongoose from "mongoose";

/** The enrolled face of one voter (AES-256-GCM box, `select:false`): the V2 collection, read-only here. Enrolment is a registration-time task, not V3's. */
const schema = new mongoose.Schema(
  {
    voterId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    box: { type: { ct: String, iv: String, tag: String, v: Number, _id: false }, required: true, select: false },
    sampleCount: { type: Number, required: true },
    dimension: { type: Number, required: true },
    algorithm: { type: String, required: true },
    templateVersion: { type: Number, required: true },
    enrolledBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    enrolledAt: { type: Date, required: true },
  },
  { versionKey: false, autoIndex: false }, // V2's collection: V3 never builds indexes on it
);

export const FaceTemplate = mongoose.models.V3FaceTemplate ?? mongoose.model("V3FaceTemplate", schema, "facetemplates");
