import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { decryptSecret, encryptSecret } from "../auth/secretBox.js";
import { signAccessToken, verifyAccessToken, ROLE_ADMIN } from "../auth/tokens.js";
import { checkTotp, newTotpSecret, totpUri } from "../auth/totp.js";
import { AppError } from "../utils/errors.js";

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const invalidCredentials = () => new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Authentication required");

export const normalizeEmail = (email) => String(email).trim().toLowerCase();

/**
 * Admin authentication: password + TOTP, short-lived JWT access tokens, rotating opaque refresh tokens.
 * `now` and `bcryptCost` are injectable for tests.
 */
export function createAdminAuthService({ Admin, AdminSession, audit, secrets, now = Date.now, bcryptCost = 12 }) {
  // Compared against when the email is unknown, so unknown emails cost the same time as wrong passwords.
  const dummyHash = bcrypt.hashSync(randomBytes(16).toString("hex"), bcryptCost);

  const publicAdmin = (admin) => ({ id: String(admin._id), email: admin.email, name: admin.name, role: ROLE_ADMIN });

  async function issueSession(admin, familyId) {
    const refreshToken = randomBytes(32).toString("base64url");
    const t = now();
    const session = await AdminSession.create({
      adminId: admin._id,
      tokenHash: sha256(refreshToken),
      familyId,
      createdAt: new Date(t),
      expiresAt: new Date(t + REFRESH_TTL_MS),
    });
    const accessToken = signAccessToken({ secret: secrets.jwtAccessSecret, adminId: admin._id, sessionId: session._id, jti: randomUUID(), nowMs: t });
    return { accessToken, refreshToken, session, maxAgeMs: REFRESH_TTL_MS };
  }

  /** One-time use of a TOTP code: valid at the current time AND newer than the last accepted time step. */
  async function consumeTotp(adminWithSecret, code) {
    const secret = decryptSecret(secrets.adminTotpKey, adminWithSecret.totpSecretEncrypted, String(adminWithSecret._id));
    const step = checkTotp(secret, String(code), now());
    if (step === null) return "invalid";
    const res = await Admin.updateOne(
      { _id: adminWithSecret._id, $or: [{ lastUsedTotpStep: null }, { lastUsedTotpStep: { $lt: step } }] },
      { $set: { lastUsedTotpStep: step } },
    );
    return res.modifiedCount === 1 ? "ok" : "replay";
  }

  async function registerFailure(admin) {
    const updated = await Admin.findOneAndUpdate({ _id: admin._id }, { $inc: { failedLoginCount: 1 } }, { returnDocument: "after" });
    if (updated && updated.failedLoginCount >= MAX_FAILURES) {
      await Admin.updateOne({ _id: admin._id }, { $set: { lockUntil: new Date(now() + LOCK_MS), failedLoginCount: 0 } });
    }
  }

  return {
    normalizeEmail,
    publicAdmin,

    /** Used by the CLI. Returns the TOTP secret and URI ONCE; they are never retrievable afterwards. */
    async createAdmin({ email, name, password }) {
      if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      const _id = new mongoose.Types.ObjectId();
      const secret = newTotpSecret();
      const normalized = normalizeEmail(email);
      const admin = await Admin.create({
        _id,
        email: normalized,
        name: String(name).trim(),
        passwordHash: await bcrypt.hash(password, bcryptCost),
        totpSecretEncrypted: encryptSecret(secrets.adminTotpKey, secret, String(_id)),
        totpEnrolledAt: new Date(now()),
      });
      return { admin: publicAdmin(admin), totpSecret: secret, otpauthUri: totpUri(normalized, secret) };
    },

    async login({ email, password, totp, ip, requestId }) {
      const normalized = normalizeEmail(email);
      const admin = await Admin.findOne({ email: normalized }).select("+passwordHash +totpSecretEncrypted");
      const fail = async (reason) => {
        await audit.record({ action: "ADMIN_LOGIN_FAILURE", result: "failure", adminId: admin?._id ?? null, requestId, ip, meta: { reason, email: normalized } });
        throw invalidCredentials();
      };

      if (!admin) {
        await bcrypt.compare(password, dummyHash);
        return fail("unknown_email");
      }
      const locked = admin.lockUntil && admin.lockUntil.getTime() > now();
      const passwordOk = await bcrypt.compare(password, locked || admin.status !== "active" ? dummyHash : admin.passwordHash);
      if (locked) return fail("locked");
      if (admin.status !== "active") return fail("disabled");
      if (!passwordOk) {
        await registerFailure(admin);
        return fail("bad_password");
      }
      const outcome = await consumeTotp(admin, totp);
      if (outcome !== "ok") {
        await registerFailure(admin);
        if (outcome === "replay") await audit.record({ action: "TOTP_REPLAY_REJECTED", result: "failure", adminId: admin._id, requestId, ip, meta: { reason: "login" } });
        return fail(outcome === "replay" ? "totp_replay" : "bad_totp");
      }

      await Admin.updateOne({ _id: admin._id }, { $set: { failedLoginCount: 0, lockUntil: null } });
      const issued = await issueSession(admin, randomUUID());
      await audit.record({ action: "ADMIN_LOGIN_SUCCESS", result: "success", adminId: admin._id, requestId, ip });
      return { ...issued, admin: publicAdmin(admin) };
    },

    async refresh({ refreshToken, ip, requestId }) {
      if (typeof refreshToken !== "string" || refreshToken.length < 20) throw unauthenticated();
      const tokenHash = sha256(refreshToken);
      const t = now();
      // Atomically claim the token: only one caller can rotate it.
      const claimed = await AdminSession.findOneAndUpdate({ tokenHash, revokedAt: null, expiresAt: { $gt: new Date(t) } }, { $set: { revokedAt: new Date(t) } }, { returnDocument: "after" });
      if (!claimed) {
        const known = await AdminSession.findOne({ tokenHash });
        if (known?.revokedAt) {
          // A rotated/revoked token came back: assume theft and kill the whole family.
          await AdminSession.updateMany({ familyId: known.familyId, revokedAt: null }, { $set: { revokedAt: new Date(t) } });
          await audit.record({ action: "ADMIN_REFRESH_REUSE_DETECTED", result: "failure", adminId: known.adminId, requestId, ip });
        }
        throw unauthenticated();
      }
      const admin = await Admin.findById(claimed.adminId);
      if (!admin || admin.status !== "active") {
        await AdminSession.updateMany({ familyId: claimed.familyId, revokedAt: null }, { $set: { revokedAt: new Date(t) } });
        throw unauthenticated();
      }
      const issued = await issueSession(admin, claimed.familyId);
      await AdminSession.updateOne({ _id: claimed._id }, { $set: { replacedBy: issued.session._id } });
      await audit.record({ action: "ADMIN_REFRESH", result: "success", adminId: admin._id, requestId, ip });
      return { ...issued, admin: publicAdmin(admin) };
    },

    /** Idempotent: revokes the whole family of the presented refresh token, if it is known. */
    async logout({ refreshToken, ip, requestId }) {
      if (typeof refreshToken !== "string" || refreshToken.length < 20) return;
      const session = await AdminSession.findOne({ tokenHash: sha256(refreshToken) });
      if (!session) return;
      await AdminSession.updateMany({ familyId: session.familyId, revokedAt: null }, { $set: { revokedAt: new Date(now()) } });
      await audit.record({ action: "ADMIN_LOGOUT", result: "success", adminId: session.adminId, requestId, ip });
    },

    /** Validates a bearer access token and the session/admin behind it. Returns a minimal principal. */
    async authenticate(accessToken) {
      let claims;
      try {
        claims = verifyAccessToken({ secret: secrets.jwtAccessSecret, token: accessToken, nowMs: now() });
      } catch {
        throw unauthenticated();
      }
      if (claims.role !== ROLE_ADMIN) throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
      const session = await AdminSession.findById(claims.sid).catch(() => null);
      if (!session || session.revokedAt || session.expiresAt.getTime() <= now() || String(session.adminId) !== claims.sub) throw unauthenticated();
      const admin = await Admin.findById(claims.sub);
      if (!admin || admin.status !== "active") throw unauthenticated();
      return { adminId: String(admin._id), sessionId: String(session._id), admin: publicAdmin(admin) };
    },

    /**
     * Step-up for high-impact actions: a fresh, never-before-used TOTP code. Bad codes count toward the SAME failure counter and
     * lockout as login, and a locked (or disabled) admin cannot step up at all, so a stolen access token cannot be used to guess codes.
     */
    async verifyStepUp({ adminId, totp, ip, requestId }) {
      const admin = await Admin.findById(adminId).select("+totpSecretEncrypted");
      const refuse = async (reason) => {
        await audit.record({ action: "ADMIN_STEP_UP_FAILURE", result: "failure", adminId: admin?._id ?? null, requestId, ip, meta: { reason } });
        throw new AppError(401, "INVALID_STEP_UP", "A fresh authenticator code is required");
      };
      if (!admin) return refuse("unknown_admin");
      if (admin.status !== "active") return refuse("disabled");
      if (admin.lockUntil && admin.lockUntil.getTime() > now()) return refuse("locked"); // no code is even checked while locked
      const outcome = await consumeTotp(admin, totp);
      if (outcome === "ok") {
        await Admin.updateOne({ _id: admin._id }, { $set: { failedLoginCount: 0 } });
        return;
      }
      await registerFailure(admin);
      if (outcome === "replay") await audit.record({ action: "TOTP_REPLAY_REJECTED", result: "failure", adminId, requestId, ip, meta: { reason: "step_up" } });
      return refuse(outcome === "replay" ? "totp_replay" : "bad_totp");
    },
  };
}
