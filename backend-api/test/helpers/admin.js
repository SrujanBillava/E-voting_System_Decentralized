import { createHash } from "node:crypto";
import { generateSync } from "otplib";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { Admin } from "../../src/models/Admin.js";
import { AdminSession } from "../../src/models/AdminSession.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { createOwnerQueue } from "../../src/chain/ownerQueue.js";
import { createAdminAuthService } from "../../src/services/adminAuth.service.js";
import { createAuditService } from "../../src/services/audit.service.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { validEnv } from "./env.js";

export const PASSWORD = "correct horse battery staple";
export const sha256 = (t) => createHash("sha256").update(t).digest("hex");

/** Fresh database + fake clock + real auth service. `electionService` is optional (stubbed otherwise). */
export async function adminWorld({ electionFactory, extras, loginRateLimit = { windowMs: 60_000, limit: 1000 }, stepUpRateLimit = { windowMs: 60_000, limit: 1000 }, env } = {}) {
  await mongoose.connection.dropDatabase();
  await Promise.all([Admin.syncIndexes(), AdminSession.syncIndexes(), AuditLog.syncIndexes()]);

  const config = loadEnv(validEnv(env));
  const memory = createMemoryLogger();
  let t = Date.parse("2026-10-03T10:00:00Z");
  const clock = { now: () => t, advance: (seconds) => (t += seconds * 1000) };
  const audit = createAuditService({ AuditLog, logger: memory.logger, now: clock.now });
  const auth = createAdminAuthService({ Admin, AdminSession, audit, secrets: config.secrets, now: clock.now, bcryptCost: 4 });
  const ownerQueue = createOwnerQueue();
  const election = electionFactory ? electionFactory({ auth, audit, clock, ownerQueue }) : { getElection: async () => ({ stub: true }), open: async () => ({}), close: async () => ({}) };
  const app = createApp({
    config,
    logger: memory.logger,
    healthService: { getPublicHealth: async () => ({ status: "ok" }) },
    admin: { authService: auth, electionService: election, ...(extras ? extras({ auth, audit, clock, ownerQueue }) : {}) },
    loginRateLimit,
    stepUpRateLimit,
  });

  const code = (secret) => generateSync({ secret, epoch: Math.floor(clock.now() / 1000) });
  const createAdmin = async (over = {}) => {
    const created = await auth.createAdmin({ email: "Root@Example.org", name: "Root Admin", password: PASSWORD, ...over });
    return { ...created, code: () => code(created.totpSecret) };
  };
  const login = (body) => request(app).post("/api/v1/admin/auth/login").send(body);
  const loginAs = async (admin, over = {}) => login({ email: admin.admin.email, password: PASSWORD, totp: admin.code(), ...over });
  const cookieOf = (res) => (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]).find((c) => c.startsWith("vc_admin_rt="));
  const bearer = (token) => ({ Authorization: `Bearer ${token}` });

  return { app, config, auth, audit, clock, memory, code, createAdmin, login, loginAs, cookieOf, bearer, request: () => request(app) };
}
