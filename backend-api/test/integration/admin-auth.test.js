import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Admin } from "../../src/models/Admin.js";
import { AdminSession } from "../../src/models/AdminSession.js";
import { AuditLog } from "../../src/models/AuditLog.js";
import { PASSWORD, adminWorld, sha256 } from "../helpers/admin.js";

// Needs a disposable MongoDB:  MONGODB_TEST_URI=mongodb://127.0.0.1:27017/evoting-test npm run test:integration
const uri = process.env.MONGODB_TEST_URI;

describe("admin auth (real MongoDB)", { skip: uri ? false : "set MONGODB_TEST_URI to run" }, () => {
  before(() => mongoose.connect(uri));
  after(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  let w;
  beforeEach(async () => {
    w = await adminWorld();
  });

  describe("admin creation", () => {
    it("hashes the password, encrypts the TOTP secret, normalises the email", async () => {
      const a = await w.createAdmin();
      const raw = await mongoose.connection.collection("admins").findOne({});
      assert.equal(raw.email, "root@example.org");
      assert.match(raw.passwordHash, /^\$2[aby]\$/);
      const dump = JSON.stringify(raw);
      assert.ok(!dump.includes(PASSWORD));
      assert.ok(!dump.includes(a.totpSecret), "TOTP secret stored in clear");
      assert.ok(raw.totpSecretEncrypted.ct && raw.totpSecretEncrypted.iv && raw.totpSecretEncrypted.tag);
      assert.ok(a.otpauthUri.startsWith("otpauth://totp/") && a.otpauthUri.includes(a.totpSecret));
    });

    it("rejects a duplicate email (case-insensitively) and a short password", async () => {
      await w.createAdmin();
      await assert.rejects(w.createAdmin({ email: "ROOT@example.ORG" }), /E11000|duplicate/i);
      await assert.rejects(w.createAdmin({ email: "b@example.org", password: "short" }), /at least 12/);
    });

    it("the default query never returns the hash or the encrypted secret", async () => {
      await w.createAdmin();
      const plain = JSON.stringify(await Admin.findOne({}));
      assert.ok(!plain.includes("passwordHash") && !plain.includes("totpSecretEncrypted"));
    });
  });

  describe("login", () => {
    it("valid password + valid TOTP succeeds; refresh token only in an HttpOnly cookie", async () => {
      const a = await w.createAdmin();
      const res = await w.loginAs(a);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data).sort(), ["accessToken", "admin"]);
      assert.deepEqual(res.body.data.admin, { id: res.body.data.admin.id, email: "root@example.org", name: "Root Admin", role: "ADMIN" });
      const cookie = res.headers["set-cookie"].find((c) => c.startsWith("vc_admin_rt="));
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Strict/i);
      assert.match(cookie, /Path=\/api\/v1\/admin\/auth/);
      const refresh = cookie.split(";")[0].split("=")[1];
      assert.ok(!JSON.stringify(res.body).includes(refresh), "refresh token leaked in JSON");
    });

    it("wrong email, wrong password and wrong TOTP all give the SAME generic response", async () => {
      const a = await w.createAdmin();
      const responses = [
        await w.login({ email: "nobody@example.org", password: PASSWORD, totp: a.code() }),
        await w.login({ email: a.admin.email, password: "wrong password here!", totp: a.code() }),
        await w.login({ email: a.admin.email, password: PASSWORD, totp: "000000" }),
      ];
      for (const r of responses) {
        assert.equal(r.status, 401);
        assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
        assert.equal(r.body.error.message, "Invalid credentials");
      }
      assert.deepEqual(new Set(responses.map((r) => JSON.stringify({ ...r.body.error, requestId: 0 }))).size, 1);
    });

    it("a reused TOTP code is rejected, and the replay is audited", async () => {
      const a = await w.createAdmin();
      const code = a.code();
      assert.equal((await w.loginAs(a, { totp: code })).status, 200);
      const again = await w.loginAs(a, { totp: code });
      assert.equal(again.status, 401);
      assert.equal(await AuditLog.countDocuments({ action: "TOTP_REPLAY_REJECTED" }), 1);
      w.clock.advance(31);
      assert.equal((await w.loginAs(a)).status, 200, "a fresh code works");
    });

    it("5 consecutive failures lock the account temporarily; success after the lock resets the counter", async () => {
      const a = await w.createAdmin();
      for (let i = 0; i < 5; i++) await w.loginAs(a, { password: "definitely wrong pw" });
      assert.ok((await Admin.findOne({})).lockUntil);
      const locked = await w.loginAs(a);
      assert.equal(locked.status, 401, "correct credentials must fail while locked");
      assert.equal(locked.body.error.code, "INVALID_CREDENTIALS");
      w.clock.advance(16 * 60);
      assert.equal((await w.loginAs(a)).status, 200);
      const after = await Admin.findOne({});
      assert.equal(after.failedLoginCount, 0);
      assert.equal(after.lockUntil, null);
    });

    it("a success in the middle resets the failure counter", async () => {
      const a = await w.createAdmin();
      for (let i = 0; i < 4; i++) await w.loginAs(a, { password: "definitely wrong pw" });
      assert.equal((await w.loginAs(a)).status, 200);
      assert.equal((await Admin.findOne({})).failedLoginCount, 0);
    });

    it("login is rate limited per IP", async () => {
      const limited = await adminWorld({ loginRateLimit: { windowMs: 60_000, limit: 3 } });
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await limited.login({ email: "x@example.org", password: "whatever-pw", totp: "123456" })).status);
      assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
    });

    it("rejects malformed bodies without echoing values", async () => {
      const res = await w.login({ email: "not-an-email", password: "secret-value-123", totp: "12", extra: 1 });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_FAILED");
      assert.ok(!JSON.stringify(res.body).includes("secret-value-123"));
    });

    it("the legacy master values are not a bypass", async () => {
      const a = await w.createAdmin();
      assert.notEqual(a.code(), "123456");
      for (const body of [
        { email: a.admin.email, password: PASSWORD, totp: "123456" },
        { email: a.admin.email, password: "admin123", totp: a.code() },
        { email: a.admin.email, password: "admin123", totp: "123456" },
        { email: "admin", password: "admin123", totp: "123456" },
        { email: "admin@example.org", password: "admin123", totp: "123456" },
      ]) {
        assert.equal((await w.login(body)).status, body.email === "admin" ? 400 : 401);
      }
    });
  });

  describe("tokens, sessions, refresh", () => {
    it("access JWT has minimal claims, issuer and audience", async () => {
      const a = await w.createAdmin();
      const { accessToken } = (await w.loginAs(a)).body.data;
      const claims = jwt.decode(accessToken);
      assert.deepEqual(Object.keys(claims).sort(), ["aud", "exp", "iat", "iss", "jti", "role", "sid", "sub"]);
      assert.equal(claims.role, "ADMIN");
      assert.equal(claims.iss, "votechain-api");
      assert.equal(claims.aud, "votechain-admin");
      assert.equal(claims.exp - claims.iat, 900);
    });

    const sign = (w, over = {}, secret) => {
      const t = Math.floor(w.clock.now() / 1000);
      return jwt.sign({ sub: "x", sid: "y", role: "ADMIN", jti: "j", iat: t, exp: t + 900, iss: "votechain-api", aud: "votechain-admin", ...over }, secret ?? w.config.secrets.jwtAccessSecret, { algorithm: "HS256" });
    };

    it("rejects wrong issuer, audience, secret, algorithm none, and expired tokens (401)", async () => {
      const t = Math.floor(w.clock.now() / 1000);
      const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "x", role: "ADMIN", iss: "votechain-api", aud: "votechain-admin", exp: t + 900 })).toString("base64url")}.`;
      for (const token of [sign(w, { iss: "evil" }), sign(w, { aud: "voters" }), sign(w, {}, Buffer.alloc(32, 1)), sign(w, { exp: t - 10, iat: t - 1000 }), none, "garbage"]) {
        const res = await w.request().get("/api/v1/admin/auth/me").set(w.bearer(token));
        assert.equal(res.status, 401, token.slice(0, 20));
      }
    });

    it("a validly signed token with another role is 403; no token is 401", async () => {
      assert.equal((await w.request().get("/api/v1/admin/auth/me")).status, 401);
      assert.equal((await w.request().get("/api/v1/admin/election")).status, 401);
      assert.equal((await w.request().get("/api/v1/admin/auth/me").set(w.bearer(sign(w, { role: "VOTER" })))).status, 403);
    });

    it("a valid ADMIN token works; GET /me returns a safe identity", async () => {
      const a = await w.createAdmin();
      const { accessToken } = (await w.loginAs(a)).body.data;
      const res = await w.request().get("/api/v1/admin/auth/me").set(w.bearer(accessToken));
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data.admin).sort(), ["email", "id", "name", "role"]);
      assert.equal((await w.request().get("/api/v1/admin/election").set(w.bearer(accessToken))).status, 200);
    });

    it("an expired access token stops working after 15 minutes", async () => {
      const a = await w.createAdmin();
      const { accessToken } = (await w.loginAs(a)).body.data;
      w.clock.advance(901);
      assert.equal((await w.request().get("/api/v1/admin/auth/me").set(w.bearer(accessToken))).status, 401);
    });

    it("the refresh token is stored only as a hash", async () => {
      const a = await w.createAdmin();
      const cookie = w.cookieOf(await w.loginAs(a));
      const token = cookie.split("=")[1];
      const row = await mongoose.connection.collection("adminsessions").findOne({});
      assert.equal(row.tokenHash, sha256(token));
      assert.ok(!JSON.stringify(row).includes(token));
    });

    it("refresh rotates the token; the old one is dead and its reuse revokes the whole family", async () => {
      const a = await w.createAdmin();
      const login = await w.loginAs(a);
      const oldCookie = w.cookieOf(login);
      const refreshed = await w.request().post("/api/v1/admin/auth/refresh").set("Cookie", oldCookie);
      assert.equal(refreshed.status, 200);
      const newCookie = w.cookieOf(refreshed);
      assert.notEqual(newCookie, oldCookie);
      assert.ok(!JSON.stringify(refreshed.body).includes(newCookie.split("=")[1]));
      assert.equal((await w.request().get("/api/v1/admin/auth/me").set(w.bearer(refreshed.body.data.accessToken))).status, 200);

      const reuse = await w.request().post("/api/v1/admin/auth/refresh").set("Cookie", oldCookie);
      assert.equal(reuse.status, 401);
      // theft response: the legitimately rotated token is dead too, and so is its access token
      assert.equal((await w.request().post("/api/v1/admin/auth/refresh").set("Cookie", newCookie)).status, 401);
      assert.equal((await w.request().get("/api/v1/admin/auth/me").set(w.bearer(refreshed.body.data.accessToken))).status, 401);
      assert.ok((await AuditLog.countDocuments({ action: "ADMIN_REFRESH_REUSE_DETECTED" })) >= 1);
    });

    it("refresh without or with a bogus cookie is 401", async () => {
      assert.equal((await w.request().post("/api/v1/admin/auth/refresh")).status, 401);
      assert.equal((await w.request().post("/api/v1/admin/auth/refresh").set("Cookie", "vc_admin_rt=" + "a".repeat(43))).status, 401);
    });

    it("logout revokes the session: refresh and the access token both stop working", async () => {
      const a = await w.createAdmin();
      const login = await w.loginAs(a);
      const cookie = w.cookieOf(login);
      const out = await w.request().post("/api/v1/admin/auth/logout").set("Cookie", cookie);
      assert.equal(out.status, 204);
      assert.match(out.headers["set-cookie"].join(";"), /vc_admin_rt=;/);
      assert.equal((await w.request().post("/api/v1/admin/auth/refresh").set("Cookie", cookie)).status, 401);
      assert.equal((await w.request().get("/api/v1/admin/auth/me").set(w.bearer(login.body.data.accessToken))).status, 401);
      assert.equal((await w.request().post("/api/v1/admin/auth/logout")).status, 204, "logout is idempotent");
    });

    it("a disabled admin loses access immediately", async () => {
      const a = await w.createAdmin();
      const { accessToken } = (await w.loginAs(a)).body.data;
      await Admin.updateOne({}, { $set: { status: "disabled" } });
      assert.equal((await w.request().get("/api/v1/admin/auth/me").set(w.bearer(accessToken))).status, 401);
    });
  });

  describe("secrets and audit hygiene", () => {
    it("no response, log line or audit row contains passwords, codes, tokens, hashes or the TOTP secret", async () => {
      const a = await w.createAdmin();
      const codeUsed = a.code();
      const login = await w.loginAs(a, { totp: codeUsed });
      const cookie = w.cookieOf(login);
      const refresh = await w.request().post("/api/v1/admin/auth/refresh").set("Cookie", cookie);
      await w.loginAs(a, { totp: codeUsed }); // replay
      await w.login({ email: a.admin.email, password: "Wrong-password-xyz", totp: "654321" });
      await w.request().post("/api/v1/admin/auth/logout").set("Cookie", w.cookieOf(refresh));

      const hash = (await mongoose.connection.collection("admins").findOne({})).passwordHash;
      const audit = JSON.stringify(await mongoose.connection.collection("auditlogs").find({}).toArray());
      const everything = audit + w.memory.lines.join("") + JSON.stringify(login.body) + JSON.stringify(refresh.body);
      const forbidden = [PASSWORD, "Wrong-password-xyz", codeUsed, "654321", a.totpSecret, hash, cookie.split("=")[1], w.config.secrets.jwtAccessSecret.toString("hex")];
      for (const f of forbidden) assert.ok(!everything.includes(f), `leaked ${f.slice(0, 6)}...`);
      for (const action of ["ADMIN_LOGIN_SUCCESS", "ADMIN_LOGIN_FAILURE", "ADMIN_REFRESH", "ADMIN_LOGOUT", "TOTP_REPLAY_REJECTED"]) assert.ok(audit.includes(action), action);
    });

    it("audit rows are append-only at the application level", async () => {
      await w.createAdmin();
      await w.login({ email: "x@example.org", password: "whatever-pw-1", totp: "111111" });
      const row = await AuditLog.findOne({});
      assert.ok(row);
      await assert.rejects(AuditLog.updateOne({ _id: row._id }, { $set: { result: "success" } }), /append-only/);
      await assert.rejects(AuditLog.deleteMany({}), /append-only/);
      row.result = "success";
      await assert.rejects(row.save(), /append-only/);
    });
  });
});
