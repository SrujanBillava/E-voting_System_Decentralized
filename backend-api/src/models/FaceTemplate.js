import mongoose from "mongoose";

/**
 * One row per enrolled voter. `box` is the AES-256-GCM ciphertext of the 3-5 sample descriptors
 * (see src/biometrics/templateBox.js); it is `select: false`, so ordinary queries cannot return it.
 * No image and no plaintext descriptor is ever stored.
 */
const schema = new mongoose.Schema(
  {
    voterId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, immutable: true },
    box: {
      type: { ct: String, iv: String, tag: String, v: Number, _id: false },
      required: true,
      select: false,
    },
    sampleCount: { type: Number, required: true },
    dimension: { type: Number, required: true },
    algorithm: { type: String, required: true },
    templateVersion: { type: Number, required: true },
    enrolledBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    enrolledAt: { type: Date, required: true },
  },
  { versionKey: false },
);

export const FaceTemplate = mongoose.models.VcFaceTemplate ?? mongoose.model("VcFaceTemplate", schema, "facetemplates");
