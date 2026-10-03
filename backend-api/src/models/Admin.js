import mongoose from "mongoose";

/**
 * The only admin identity. Created by `npm run admin:create` (there is no signup endpoint).
 * Secrets are never stored in clear: the password is a bcrypt hash and the TOTP secret is
 * AES-256-GCM ciphertext. Both are `select: false`, so ordinary queries cannot leak them.
 */
const schema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    totpSecretEncrypted: {
      type: { ct: String, iv: String, tag: String, v: Number, _id: false },
      required: true,
      select: false,
    },
    totpEnrolledAt: { type: Date, required: true },
    lastUsedTotpStep: { type: Number, default: null },
    failedLoginCount: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Admin = mongoose.models.VcAdmin ?? mongoose.model("VcAdmin", schema, "admins");
