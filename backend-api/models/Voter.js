import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const voterSchema = new mongoose.Schema(
  {
    VoterId: {
      type: String,
      required: true,
      unique: true,
    },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true, select: false },
    constituency: { type: String, required: true },
    contact: { type: String },
    Address: { type: String }
  },
  { timestamps: true }
);

voterSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

voterSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

const Voter = mongoose.model('Voter', voterSchema);
export default Voter;