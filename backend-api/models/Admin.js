import mongoose, { Schema } from "mongoose";

const AdminSchema = new Schema(
  {
    name: { type: String },
    email: { type: String, unique: true },
    organization: { type: String },
    lastLogin: { type: Date }, // queue data structure which stores last two login times. when admin logs in, update this field but don't use it for anything else. This is just to know when the admin last logged in, and can be used for analytics or to show last login time on the admin dashboard.
  },
  { timestamps: true }
);

export const Admin = mongoose.model("Admin", AdminSchema);