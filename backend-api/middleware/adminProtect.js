import jwt from "jsonwebtoken";

export const adminProtect = (req, res, next) => {
  const auth = req.headers.authorization;

  if (!auth?.startsWith("Bearer ")) {
    return res.sendStatus(401);
  }

  const token = auth.split(" ")[1];

  jwt.verify(token, process.env.JWT_ACCESS_SECRET, (err, payload) => {
    if (err) {
      return res.sendStatus(401); //  CHANGE THIS
    }

    if (payload.role !== "admin") {
      return res.sendStatus(403);
    }

    next();
  });
};
