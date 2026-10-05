import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "../../src/config/env.js";
import { createLogger } from "../../src/utils/logger.js";

const KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"; // public Hardhat account #4
const base = () => ({
  NODE_ENV: "test",
  RELAY_MONGODB_URI: "mongodb://127.0.0.1:27017/votechain_relay_v3_test",
  CHAIN_RPC_URL: "http://127.0.0.1:8545",
  CHAIN_ID: "31337",
  VOTECHAIN_V3_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  RELAYER_PRIVATE_KEY: KEY,
});
const problems = (env) => {
  try {
    loadEnv(env);
    return [];
  } catch (err) {
    assert.ok(err instanceof ConfigError, String(err));
    return err.issues.map((i) => i.path);
  }
};

describe("relay-v3 environment validation", () => {
  it("a valid environment loads; the relayer key stays off every serialisation", () => {
    const config = loadEnv(base());
    assert.equal(config.port, 5200);
    assert.equal(config.globalLimitPerMinute, 600);
    assert.ok(!JSON.stringify(config).includes(KEY.slice(2)));
    assert.ok(!Object.keys(config).includes("secrets"));
    assert.ok(!JSON.stringify(describeConfig(config)).includes(KEY.slice(2)));
    assert.ok(secretValuesOf(config).includes(KEY));
  });

  it("REFUSES TO START with anything of the identity side or another role in its environment: issuer, owner, trustee keys, identity store, face key, JWT, session, cookie, voter settings, the shared MONGODB_URI", () => {
    for (const name of ["ISSUER_PRIVATE_KEY", "OWNER_PRIVATE_KEY", "AUTHORITY_PRIVATE_KEY", "TRUSTEE_1_PRIVATE_KEY", "SOME_OTHER_PRIVATE_KEY", "IDENTITY_MONGODB_URI", "FACE_TEMPLATE_ENCRYPTION_KEY", "JWT_ACCESS_SECRET", "ADMIN_TOTP_ENCRYPTION_KEY", "NULLIFIER_SECRET", "VOTER_SESSION_SECRET", "SESSION_SECRET", "COOKIE_SECRET", "BATCH_MAX_SIZE", "MONGODB_URI"]) {
      assert.ok(problems({ ...base(), [name]: "0x" + "ab".repeat(32) }).includes(name), name);
    }
  });

  it("the relayer's store is its OWN: the database name must say so (a name like the identity service's is refused)", () => {
    assert.ok(problems({ ...base(), RELAY_MONGODB_URI: "mongodb://127.0.0.1:27017/votechain_identity_v3" }).includes("RELAY_MONGODB_URI"));
    assert.ok(problems({ ...base(), RELAY_MONGODB_URI: "mongodb://127.0.0.1:27017/evoting" }).includes("RELAY_MONGODB_URI"));
    assert.ok(problems({ ...base(), RELAY_MONGODB_URI: "mongodb://127.0.0.1:27017" }).includes("RELAY_MONGODB_URI"));
    assert.deepEqual(problems({ ...base(), RELAY_MONGODB_URI: "mongodb://u:p%40ss@a:27017,b:27017/relay_prod?replicaSet=rs0" }), []);
  });

  it("invalid values are named, never printed; the global budget has bounds", () => {
    const found = problems({ ...base(), CHAIN_ID: "x", RELAYER_PRIVATE_KEY: "0x12", VOTECHAIN_V3_ADDRESS: "nope", RELAY_GLOBAL_LIMIT_PER_MINUTE: "0" });
    for (const name of ["CHAIN_ID", "RELAYER_PRIVATE_KEY", "VOTECHAIN_V3_ADDRESS", "RELAY_GLOBAL_LIMIT_PER_MINUTE"]) assert.ok(found.includes(name), name);
    try {
      loadEnv({ ...base(), RELAYER_PRIVATE_KEY: "0x" + "cd".repeat(31) + "zz" });
    } catch (err) {
      assert.ok(!err.message.includes("zz"));
    }
  });

  it("production refuses the public Hardhat key and the local chain id, and requires an explicit CORS list", () => {
    const prod = { ...base(), NODE_ENV: "production", CORS_ORIGINS: "https://vote.votechain.example" };
    const found = problems(prod);
    assert.ok(found.includes("RELAYER_PRIVATE_KEY") && found.includes("CHAIN_ID"));
    assert.deepEqual(problems({ ...prod, RELAYER_PRIVATE_KEY: "0x" + "12".repeat(16) + "34".repeat(16), CHAIN_ID: "1" }), []);
    assert.ok(problems({ ...base(), NODE_ENV: "production", RELAYER_PRIVATE_KEY: "0x" + "12".repeat(16) + "34".repeat(16), CHAIN_ID: "1" }).includes("CORS_ORIGINS"));
    assert.ok(problems({ ...base(), CORS_ORIGINS: "*" }).includes("CORS_ORIGINS"));
  });

  it("the logger scrubs the relayer key, the Mongo password and the RPC API key", () => {
    const config = loadEnv({ ...base(), RELAY_MONGODB_URI: "mongodb://app:s3cr3tPassw0rd@127.0.0.1:27017/relay_test", CHAIN_RPC_URL: "https://rpc.example/v3/0123456789abcdef0123456789abcdef" });
    const lines = [];
    const logger = createLogger({ stream: { write: (l) => lines.push(l) }, secrets: secretValuesOf(config) });
    logger.error({ detail: `${KEY} mongodb://app:s3cr3tPassw0rd@x/db https://rpc.example/v3/0123456789abcdef0123456789abcdef` }, KEY.slice(2));
    const out = lines.join("");
    for (const secret of [KEY, KEY.slice(2), "s3cr3tPassw0rd", "0123456789abcdef0123456789abcdef"]) assert.ok(!out.includes(secret), secret);
  });
});
