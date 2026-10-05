import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "../../src/config/env.js";
import { createLogger } from "../../src/utils/logger.js";

const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // public Hardhat account #2
const base = () => ({
  NODE_ENV: "test",
  IDENTITY_MONGODB_URI: "mongodb://127.0.0.1:27017/votechain_identity_v3_test",
  CHAIN_RPC_URL: "http://127.0.0.1:8545",
  CHAIN_ID: "31337",
  VOTECHAIN_V3_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  ISSUER_PRIVATE_KEY: KEY,
  FACE_TEMPLATE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
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

describe("identity-v3 environment validation", () => {
  it("a valid environment loads, with defaults, and secrets stay off every serialisation", () => {
    const config = loadEnv(base());
    assert.equal(config.port, 5100);
    assert.equal(config.batch.maxSize, 128);
    assert.equal(config.chain.confirmations, 1);
    assert.ok(!JSON.stringify(config).includes(KEY.slice(2)), "the issuer key is not in the JSON of the config");
    assert.ok(!Object.keys(config).includes("secrets"), "secrets is non-enumerable");
    assert.equal(config.secrets.issuerPrivateKey, KEY);
    assert.ok(!JSON.stringify(describeConfig(config)).includes(KEY.slice(2)));
    assert.ok(secretValuesOf(config).includes(KEY));
  });

  it("every missing or invalid variable is listed BY NAME and never by value", () => {
    const env = { ...base(), CHAIN_ID: "abc", ISSUER_PRIVATE_KEY: "0x1234", VOTECHAIN_V3_ADDRESS: "0x123" };
    delete env.IDENTITY_MONGODB_URI;
    const found = problems(env);
    for (const name of ["CHAIN_ID", "ISSUER_PRIVATE_KEY", "VOTECHAIN_V3_ADDRESS", "IDENTITY_MONGODB_URI"]) assert.ok(found.includes(name), name);
    try {
      loadEnv({ ...base(), ISSUER_PRIVATE_KEY: "0x" + "ab".repeat(31) + "zz" });
    } catch (err) {
      assert.ok(!err.message.includes("zz"), "the offending value is not in the message");
    }
  });

  it("REFUSES TO START with another service's or another role's secrets in its environment: the relayer's key, the owner key, trustee keys, V2 secrets", () => {
    for (const name of ["RELAYER_PRIVATE_KEY", "OWNER_PRIVATE_KEY", "AUTHORITY_PRIVATE_KEY", "TRUSTEE_1_PRIVATE_KEY", "SOME_OTHER_PRIVATE_KEY", "RELAY_MONGODB_URI", "RELAY_GLOBAL_LIMIT_PER_MINUTE", "NULLIFIER_SECRET", "JWT_ACCESS_SECRET", "ADMIN_TOTP_ENCRYPTION_KEY"]) {
      assert.ok(problems({ ...base(), [name]: "0x" + "ab".repeat(32) }).includes(name), name);
    }
  });

  it("the identity store must not be the relayer's: a database named like the relayer's is refused, and a database name is required", () => {
    assert.ok(problems({ ...base(), IDENTITY_MONGODB_URI: "mongodb://127.0.0.1:27017/votechain_relay_v3" }).includes("IDENTITY_MONGODB_URI"));
    assert.ok(problems({ ...base(), IDENTITY_MONGODB_URI: "mongodb://127.0.0.1:27017" }).includes("IDENTITY_MONGODB_URI"));
    assert.deepEqual(problems({ ...base(), IDENTITY_MONGODB_URI: "mongodb://user:pa%24%24@a:27017,b:27017/identity?replicaSet=rs0" }), []);
  });

  it("the batch settings stay inside the contract's frozen limits", () => {
    assert.ok(problems({ ...base(), BATCH_MAX_SIZE: "129" }).includes("BATCH_MAX_SIZE"));
    assert.ok(problems({ ...base(), BATCH_MAX_SIZE: "0" }).includes("BATCH_MAX_SIZE"));
    assert.equal(loadEnv({ ...base(), BATCH_MAX_SIZE: "32" }).batch.maxSize, 32);
  });

  it("production refuses development material: the public Hardhat issuer key, the local chain id, a missing CORS list; and a face key that reuses the issuer key", () => {
    const prod = { ...base(), NODE_ENV: "production", CORS_ORIGINS: "https://id.votechain.example" };
    const found = problems(prod);
    assert.ok(found.includes("ISSUER_PRIVATE_KEY") && found.includes("CHAIN_ID"));
    assert.ok(problems({ ...prod, ISSUER_PRIVATE_KEY: "0x" + randomBytes(32).toString("hex"), CHAIN_ID: "1" }).length === 0);
    assert.ok(problems({ ...base(), NODE_ENV: "production", ISSUER_PRIVATE_KEY: "0x" + randomBytes(32).toString("hex"), CHAIN_ID: "1" }).includes("CORS_ORIGINS"));
    assert.ok(problems({ ...base(), FACE_TEMPLATE_ENCRYPTION_KEY: KEY.slice(2) }).includes("FACE_TEMPLATE_ENCRYPTION_KEY"));
    assert.ok(problems({ ...base(), FACE_TEMPLATE_ENCRYPTION_KEY: "ab".repeat(32) }).includes("FACE_TEMPLATE_ENCRYPTION_KEY"), "low entropy");
  });

  it("the logger scrubs the issuer key, the Mongo password and the RPC API key wherever they appear", () => {
    const config = loadEnv({ ...base(), IDENTITY_MONGODB_URI: "mongodb://app:s3cr3tPassw0rd@127.0.0.1:27017/identity_test", CHAIN_RPC_URL: "https://rpc.example/v3/0123456789abcdef0123456789abcdef" });
    const lines = [];
    const logger = createLogger({ stream: { write: (l) => lines.push(l) }, secrets: secretValuesOf(config) });
    logger.error({ detail: `failed with ${KEY} at mongodb://app:s3cr3tPassw0rd@x/db via https://rpc.example/v3/0123456789abcdef0123456789abcdef` }, `key ${KEY.slice(2)}`);
    const out = lines.join("");
    for (const secret of [KEY, KEY.slice(2), "s3cr3tPassw0rd", "0123456789abcdef0123456789abcdef"]) assert.ok(!out.includes(secret), secret);
  });
});
