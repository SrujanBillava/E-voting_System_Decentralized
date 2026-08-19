import jwt from "jsonwebtoken";

export const generateAccessToken = () =>
  jwt.sign(
    { role: "admin" },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "15m" }
  );

export const generateRefreshToken = () =>
  jwt.sign(
    { role: "admin" },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" }
  );
