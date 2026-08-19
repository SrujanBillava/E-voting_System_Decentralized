import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import Voter from "./models/Voter.js";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/evoting";

const demoVoters = [
  {
    VoterId: "100000000001",
    name: "Aarav Sharma",
    email: "aarav@bengaluru.in",
    password: "password123",
    constituency: "Bengaluru",
    contact: "9876543210",
    Address: "123 MG Road, Bengaluru, Karnataka",
  },
  {
    VoterId: "100000000002",
    name: "Pooja Verma",
    email: "pooja@delhi.in",
    password: "password123",
    constituency: "Delhi",
    contact: "9876543211",
    Address: "45 Connaught Place, New Delhi",
  },
  {
    VoterId: "100000000003",
    name: "Rahul Patil",
    email: "rahul@mumbai.in",
    password: "password123",
    constituency: "Mumbai",
    contact: "9876543212",
    Address: "78 Marine Drive, Mumbai, Maharashtra",
  },
  {
    VoterId: "100000000004",
    name: "Sanya Rao",
    email: "sanya@bengaluru.in",
    password: "password123",
    constituency: "Bengaluru",
    contact: "9876543213",
    Address: "56 Indiranagar, Bengaluru, Karnataka",
  }
];

async function seed() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB:", MONGO_URI);

    for (const v of demoVoters) {
      const existing = await Voter.findOne({ email: v.email });
      if (!existing) {
        await Voter.create(v);
        console.log(`Created voter: ${v.name} (${v.email}) [${v.constituency}]`);
      } else {
        console.log(`Voter already exists: ${v.email}`);
      }
    }

    console.log("✅ Seeding completed successfully.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

seed();
