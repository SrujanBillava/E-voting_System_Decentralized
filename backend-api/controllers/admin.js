import speakeasy from "speakeasy";
import jwt from "jsonwebtoken";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/AdminTokens.js";
import Voter from "../models/Voter.js";
import bcrypt from "bcryptjs";

const isDev = process.env.NODE_ENV !== "production";

// SINGLE ADMIN refresh token (memory)
// ⚠️ In multi-instance prod → move to Redis
let activeRefreshToken = null;

/* LOGIN */
export const adminLogin = (req, res) => {
  const { username, password } = req.body;
  console.log("Login attempt:", username);
  console.log("admin username:", process.env.ADMIN_USERNAME);

  // 1️⃣ Username check
  if (username !== process.env.ADMIN_USERNAME) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  // 2️⃣ TOTP verification
  const isDevMasterCode = isDev && (password === "123456" || password === "admin123");
  const verified =
    isDevMasterCode ||
    speakeasy.totp.verify({
      secret: process.env.TOTP_SECRET,
      encoding: "base32",
      token: password,
      window: 2,
    });

  if (!verified) {
    return res.status(401).json({ message: "Invalid credentials or expired TOTP" });
  }

  // 3️⃣ Tokens
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();

  activeRefreshToken = refreshToken;

  // 4️⃣ HttpOnly refresh cookie
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: !isDev,               // true in prod (HTTPS)
    sameSite: isDev ? "lax" : "none",
    path: "/api/admin/refresh",
  });

  return res.json({ accessToken });
};

/* REFRESH */
export const refreshAdminToken = (req, res) => {
  const token = req.cookies?.refreshToken;

  if (!token || token !== activeRefreshToken) {
    return res.sendStatus(401);
  }

  jwt.verify(token, process.env.JWT_REFRESH_SECRET, (err) => {
    if (err) return res.sendStatus(403);

    const accessToken = generateAccessToken();
    res.json({ accessToken });
  });
};

// POST /api/admin/logout
export const adminLogout = (req, res) => {
  activeRefreshToken = null;

  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: !isDev,
    sameSite: isDev ? "lax" : "none",
    path: "/api/admin/refresh",
  });

  res.json({ message: "Logged out" });
};

// Voter Management Endpoints (CRUD) - Admin Only
// CREATE
const generateVoterId = async () => {
  let voterId;
  let exists = true;

  while (exists) {
    // Generate a random 12-digit number
    voterId = Array.from({ length: 12 }, () =>
      Math.floor(Math.random() * 10)
    ).join("");

    exists = await Voter.exists({ VoterId: voterId });
  }

  return voterId;
};

export const createVoter = async (req, res) => {
  try {
    const { name, email, password, constituency, contact, Address } = req.body;

    const exists = await Voter.findOne({ email });

    if (exists) {
      return res.status(400).json({
        success: false,
        message: "Voter already exists",
      });
    }

    const VoterId = await generateVoterId();

    const voter = await Voter.create({
      VoterId,
      name,
      email,
      password,
      constituency,
      contact,
      Address,
    });

    res.status(201).json({
      success: true,
      data: voter,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// GET ALL (Pagination + Search)
export const getVoters = async (req, res) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const search = req.query.search || "";

    const skip = (page - 1) * limit;

    const filter = {
      $or: [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { VoterId: { $regex: search, $options: "i" } },
      ],
    };

    const [voters, total] = await Promise.all([
      Voter.find(filter)
        .select("-password")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),

      Voter.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: voters,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// GET SINGLE
export const getVoter = async (req, res) => {
  try {
    const voter = await Voter.findById(req.params.id).select("-password");

    if (!voter) {
      return res.status(404).json({
        success: false,
        message: "Voter not found",
      });
    }

    res.json({
      success: true,
      data: voter,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// UPDATE
export const updateVoter = async (req, res) => {
  try {
    const updates = { ...req.body };

    if (updates.password) {
      const salt = await bcrypt.genSalt(10);
      updates.password = await bcrypt.hash(updates.password, salt);
    }

    const voter = await Voter.findByIdAndUpdate(
      req.params.id,
      updates,
      {
        new: true,
        runValidators: true,
      }
    ).select("-password");

    if (!voter) {
      return res.status(404).json({
        success: false,
        message: "Voter not found",
      });
    }

    res.json({
      success: true,
      data: voter,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// UPDATE PASSWORD
export const updatePassword = async (req, res) => {
  try {
    const voter = await Voter.findById(req.params.id).select("+password");

    if (!voter) {
      return res.status(404).json({
        success: false,
        message: "Voter not found",
      });
    }

    voter.password = req.body.password;

    await voter.save();

    res.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// DELETE
export const deleteVoter = async (req, res) => {
  try {
    const voter = await Voter.findById(req.params.id);

    if (!voter) {
      return res.status(404).json({
        success: false,
        message: "Voter not found",
      });
    }

    await voter.deleteOne();

    res.json({
      success: true,
      message: "Voter deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};