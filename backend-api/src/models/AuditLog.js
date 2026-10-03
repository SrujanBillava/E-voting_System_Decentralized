import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    action: { type: String, required: true, index: true },
    result: { type: String, enum: ["success", "failure"], required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, default: null },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
    txHash: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { versionKey: false },
);

// Append-only at the application level: nothing in this codebase may modify or delete audit rows.
const forbidden = () => {
  throw new Error("audit log is append-only");
};
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  schema.pre(op, forbidden);
}
schema.pre("save", function () {
  if (!this.isNew) forbidden();
});

export const AuditLog = mongoose.models.VcAuditLog ?? mongoose.model("VcAuditLog", schema, "auditlogs");
