import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet } from "ethers";
import { ConfigError, describeConfig, loadEnv, secretValuesOf } from "../../src/config/env.js";
import { KEYS, TEST_NULLIFIER_SECRET, hardhatAccount, validEnv } from "../helpers/env.js";

const issuePaths = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
    return { paths: err.issues.map((i) => i.path), text: err.message };
  }
  assert.fail("expected loadEnv to throw");
};

const productionEnv = (overrides = {}) =>
  validEnv({
    NODE_ENV: "production",
    CHAIN_ID: "11155111",
    OWNER_PRIVATE_KEY: Wallet.createRandom().privateKey,
    AUTHORITY_PRIVATE_KEY: Wallet.createRandom().privateKey,
    RELAYER_PRIVATE_KEY: Wallet.createRandom().privateKey,
    CORS_ORIGINS: "https://vote.example.org",
    ...overrides,
  });

describe("config: valid", () => {
  it("accepts a complete valid environment and normalises it", () => {
    const config = loadEnv(validEnv());
    assert.equal(config.nodeEnv, "test");
    assert.equal(config.port, 5050);
    assert.equal(config.chain.chainId, 31337);
    assert.equal(config.chain.contractAddress, "0x5FbDB2315678afecb367f032d93F642f64180aa3");
    assert.deepEqual(config.corsOrigins, ["http://localhost:5173", "http://127.0.0.1:5173"]);
    assert.equal(config.signerAddresses.owner, hardhatAccount(0).address);
    assert.equal(config.secrets.nullifierSecret.length, 32);
    assert.ok(Object.isFrozen(config));
  });

  it("accepts a lowercase address and returns its checksummed form", () => {
    const config = loadEnv(validEnv({ VOTING_CONTRACT_ADDRESS: "0x5fbdb2315678afecb367f032d93f642f64180aa3" }));
    assert.equal(config.chain.contractAddress, "0x5FbDB2315678afecb367f032d93F642f64180aa3");
  });

  it("treats empty values as unset", () => {
    const config = loadEnv(validEnv({ CHAIN_ID: "", VOTING_CONTRACT_ADDRESS: "", ELECTION_ID: "" }));
    assert.equal(config.chain.chainId, undefined);
  });

  it("accepts a 0x-prefixed and a longer nullifier secret", () => {
    assert.equal(loadEnv(validEnv({ NULLIFIER_SECRET: "0x" + TEST_NULLIFIER_SECRET })).secrets.nullifierSecret.length, 32);
    assert.equal(loadEnv(validEnv({ NULLIFIER_SECRET: TEST_NULLIFIER_SECRET + TEST_NULLIFIER_SECRET.split("").reverse().join("") })).secrets.nullifierSecret.length, 64);
  });
});

describe("config: required values and malformed input", () => {
  for (const name of ["MONGODB_URI", "CHAIN_RPC_URL", "OWNER_PRIVATE_KEY", "AUTHORITY_PRIVATE_KEY", "RELAYER_PRIVATE_KEY", "NULLIFIER_SECRET"]) {
    it(`rejects a missing ${name}`, () => {
      const { paths } = issuePaths(() => loadEnv(validEnv({ [name]: undefined })));
      assert.ok(paths.includes(name), `paths: ${paths}`);
    });
  }

  it("reports every problem at once, not just the first", () => {
    const { paths } = issuePaths(() => loadEnv({ NODE_ENV: "development" }));
    for (const name of ["MONGODB_URI", "CHAIN_RPC_URL", "OWNER_PRIVATE_KEY", "AUTHORITY_PRIVATE_KEY", "RELAYER_PRIVATE_KEY", "NULLIFIER_SECRET"]) {
      assert.ok(paths.includes(name), `${name} not reported`);
    }
  });

  it("rejects malformed addresses (short, non-hex, bad checksum)", () => {
    for (const bad of ["0x123", "5FbDB2315678afecb367f032d93F642f64180aa3", "0xZZbDB2315678afecb367f032d93F642f64180aa3", "0x5fbdB2315678afecb367f032d93F642f64180aa3"]) {
      const { paths } = issuePaths(() => loadEnv(validEnv({ VOTING_CONTRACT_ADDRESS: bad })));
      assert.deepEqual(paths, ["VOTING_CONTRACT_ADDRESS"], bad);
    }
  });

  it("rejects malformed private keys and never echoes them", () => {
    const secretLooking = "0x" + "12".repeat(31) + "zz";
    const cases = [
      KEYS.owner.slice(2), // no 0x
      KEYS.owner.slice(0, -2), // too short
      secretLooking, // not hex
      "0x" + "00".repeat(32), // zero is not a valid key
      "0x" + "ff".repeat(32), // above the curve order
    ];
    for (const bad of cases) {
      const { paths, text } = issuePaths(() => loadEnv(validEnv({ OWNER_PRIVATE_KEY: bad })));
      assert.deepEqual(paths, ["OWNER_PRIVATE_KEY"]);
      assert.ok(!text.includes(bad.slice(4)), "error text leaked the offending value");
    }
  });

  it("rejects non-numeric or non-positive CHAIN_ID", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "0x7a69", "31337 "]) {
      assert.deepEqual(issuePaths(() => loadEnv(validEnv({ CHAIN_ID: bad }))).paths, ["CHAIN_ID"], bad);
    }
  });

  it("rejects unparsable URLs and wrong protocols", () => {
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ MONGODB_URI: "not a url" }))).paths, ["MONGODB_URI"]);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ MONGODB_URI: "http://127.0.0.1/evoting" }))).paths, ["MONGODB_URI"]);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ CHAIN_RPC_URL: "ftp://127.0.0.1:8545" }))).paths, ["CHAIN_RPC_URL"]);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ CHAIN_RPC_URL: "127.0.0.1:8545" }))).paths, ["CHAIN_RPC_URL"]);
    loadEnv(validEnv({ MONGODB_URI: "mongodb+srv://user:pw@cluster0.example.mongodb.net/evoting" }));
  });

  it("rejects a bad ELECTION_ID, PORT and LOG_LEVEL", () => {
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ ELECTION_ID: "0x1234" }))).paths, ["ELECTION_ID"]);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ PORT: "70000" }))).paths, ["PORT"]);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ PORT: "http" }))).paths, ["PORT"]);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ LOG_LEVEL: "verbose" }))).paths, ["LOG_LEVEL"]);
  });
});

describe("config: signers", () => {
  it("rejects two identical keys (owner, authority and relayer must differ)", () => {
    const { text } = issuePaths(() => loadEnv(validEnv({ RELAYER_PRIVATE_KEY: KEYS.authority })));
    assert.match(text, /three DIFFERENT keys/);
    issuePaths(() => loadEnv(validEnv({ OWNER_PRIVATE_KEY: KEYS.relayer })));
  });
});

describe("config: NULLIFIER_SECRET strength", () => {
  const bad = {
    "too short (16 bytes)": "ab12".repeat(8),
    "not hex": "z".repeat(64),
    "odd number of digits": TEST_NULLIFIER_SECRET + "a",
    "all zeros": "0".repeat(64),
    "all the same digit": "7".repeat(64),
    "repeating pair": "ab".repeat(32),
    "repeating pattern": "0123456789abcdef".repeat(4),
    "few distinct digits": "0101010111110000".repeat(4),
    "a plain word": "changeme".repeat(8),
  };
  for (const [name, value] of Object.entries(bad)) {
    it(`rejects ${name}`, () => {
      const { paths, text } = issuePaths(() => loadEnv(validEnv({ NULLIFIER_SECRET: value })));
      assert.deepEqual(paths, ["NULLIFIER_SECRET"]);
      assert.ok(!text.includes(value), "error text leaked the secret");
    });
  }

  it("rejects reusing a signing key as the nullifier secret", () => {
    const { text } = issuePaths(() => loadEnv(validEnv({ NULLIFIER_SECRET: KEYS.owner.slice(2) })));
    assert.match(text, /must not reuse OWNER_PRIVATE_KEY/);
  });
});

describe("config: CORS origins", () => {
  it("accepts exact origins", () => {
    const config = loadEnv(validEnv({ CORS_ORIGINS: "https://vote.example.org, http://localhost:3000" }));
    assert.deepEqual(config.corsOrigins, ["https://vote.example.org", "http://localhost:3000"]);
  });
  for (const bad of ["*", "https://vote.example.org/", "https://vote.example.org/path", "vote.example.org", "ftp://x.example.org", "https://ok.example.org,*"]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.deepEqual(issuePaths(() => loadEnv(validEnv({ CORS_ORIGINS: bad }))).paths, ["CORS_ORIGINS"]);
    });
  }
});

describe("config: production refuses development material", () => {
  it("accepts a proper production configuration", () => {
    const config = loadEnv(productionEnv());
    assert.equal(config.isProduction, true);
    assert.deepEqual(config.corsOrigins, ["https://vote.example.org"]);
  });

  it("rejects the public Hardhat development keys, per role", () => {
    for (const [name, key] of [["OWNER_PRIVATE_KEY", KEYS.owner], ["AUTHORITY_PRIVATE_KEY", KEYS.authority], ["RELAYER_PRIVATE_KEY", KEYS.relayer], ["RELAYER_PRIVATE_KEY", hardhatAccount(7).privateKey]]) {
      const { paths } = issuePaths(() => loadEnv(productionEnv({ [name]: key })));
      assert.ok(paths.includes(name), `${name} should be rejected`);
    }
  });

  it("rejects the local chain id 31337", () => {
    assert.ok(issuePaths(() => loadEnv(productionEnv({ CHAIN_ID: "31337" }))).paths.includes("CHAIN_ID"));
  });

  it("requires explicit deployment coordinates and CORS origins", () => {
    for (const name of ["CHAIN_ID", "VOTING_CONTRACT_ADDRESS", "ELECTION_ID", "CORS_ORIGINS"]) {
      assert.ok(issuePaths(() => loadEnv(productionEnv({ [name]: undefined }))).paths.includes(name), name);
    }
  });

  it("the same development keys are fine outside production", () => {
    loadEnv(validEnv({ NODE_ENV: "development" }));
  });
});

describe("config: secrets stay out of sight", () => {
  const config = loadEnv(validEnv());

  it("secrets are non-enumerable: JSON, inspect and spread do not expose them", () => {
    const dumped = JSON.stringify(config) + JSON.stringify({ ...config }) + JSON.stringify(Object.entries(config));
    for (const secret of [KEYS.owner, KEYS.authority, KEYS.relayer, TEST_NULLIFIER_SECRET, "127.0.0.1:27017"]) {
      assert.ok(!dumped.includes(secret.replace(/^0x/, "")), `leaked ${secret.slice(0, 6)}...`);
    }
  });

  it("describeConfig exposes public addresses and hosts only", () => {
    const text = JSON.stringify(describeConfig(config));
    for (const secret of [KEYS.owner, KEYS.authority, KEYS.relayer, TEST_NULLIFIER_SECRET]) assert.ok(!text.includes(secret.replace(/^0x/, "")));
    assert.match(text, new RegExp(hardhatAccount(0).address));
    assert.match(text, /rpcHost/);
  });

  it("describeConfig omits URL credentials", () => {
    const c = loadEnv(validEnv({ MONGODB_URI: "mongodb://appuser:s3cretPw@db.internal:27017/evoting", CHAIN_RPC_URL: "https://rpc.example.org/v2/APIKEY123456" }));
    const text = JSON.stringify(describeConfig(c));
    assert.ok(!text.includes("s3cretPw") && !text.includes("appuser") && !text.includes("APIKEY123456"));
    assert.match(text, /db\.internal:27017/);
  });

  it("secretValuesOf lists every value the logger must scrub", () => {
    const values = secretValuesOf(config);
    for (const s of [KEYS.owner, KEYS.authority, KEYS.relayer, TEST_NULLIFIER_SECRET, "mongodb://127.0.0.1:27017/evoting-test"]) {
      assert.ok(values.includes(s), `missing ${s.slice(0, 8)}...`);
    }
  });
});

describe("config: NODE_ENV cannot be spoofed past the production guard", () => {
  it("accepts exactly development, test and production (unset means development)", () => {
    for (const value of ["development", "test", "production"]) {
      assert.equal(loadEnv(productionEnv({ NODE_ENV: value, ...(value === "production" ? {} : { CORS_ORIGINS: undefined }) })).nodeEnv, value);
    }
    assert.equal(loadEnv(validEnv({ NODE_ENV: undefined })).nodeEnv, "development");
  });

  it("rejects look-alikes instead of silently treating them as non-production", () => {
    for (const bad of ["Production", "PRODUCTION", "prod", "prd", " production", "production ", "staging", "live", "dev"]) {
      assert.deepEqual(issuePaths(() => loadEnv(validEnv({ NODE_ENV: bad }))).paths, ["NODE_ENV"], JSON.stringify(bad));
    }
  });
});

describe("config: NULLIFIER_SECRET strength (more)", () => {
  it("rejects a 16-byte secret even when it looks random", () => {
    const { paths } = issuePaths(() => loadEnv(validEnv({ NULLIFIER_SECRET: "9f86d081884c7d659a2feaa0c55ad015" })));
    assert.deepEqual(paths, ["NULLIFIER_SECRET"]);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ NULLIFIER_SECRET: "0x9f86d081884c7d659a2feaa0c55ad015" }))).paths, ["NULLIFIER_SECRET"]);
  });

  it("rejects a non-repeating secret that uses fewer than 8 distinct hex digits", () => {
    // 64 digits from {0..6}, no period: passes the "repeating" test but has ~2.8 bits per digit
    const lowAlphabet = "0123456012345601234560123456012345601234560123456012345601234560";
    assert.equal(lowAlphabet.length, 64);
    assert.ok(new Set(lowAlphabet).size < 8);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ NULLIFIER_SECRET: lowAlphabet }))).paths, ["NULLIFIER_SECRET"]);
  });

  it("recognises a repeating pattern regardless of letter case", () => {
    // four copies of the same 16 digits, with their letter case varied so that only a case-insensitive comparison sees the repetition
    const lower = "abcdef0123456789";
    const upper = "ABCDEF0123456789";
    const mixed = lower + upper + upper + lower;
    assert.ok(new Set(mixed).size >= 8);
    assert.deepEqual(issuePaths(() => loadEnv(validEnv({ NULLIFIER_SECRET: mixed }))).paths, ["NULLIFIER_SECRET"]);
  });

  it("accepts upper-case hex and keeps its bytes", () => {
    const config = loadEnv(validEnv({ NULLIFIER_SECRET: TEST_NULLIFIER_SECRET.toUpperCase() }));
    assert.equal(config.secrets.nullifierSecret.toString("hex"), TEST_NULLIFIER_SECRET);
  });
});

describe("config: CHAIN_ID is held exactly", () => {
  it("accepts the largest safe integer and rejects anything that Number() would round", () => {
    assert.equal(loadEnv(validEnv({ CHAIN_ID: "9007199254740991" })).chain.chainId, 9007199254740991);
    for (const bad of ["9007199254740992", "9007199254740993", "9999999999999999"]) {
      assert.deepEqual(issuePaths(() => loadEnv(validEnv({ CHAIN_ID: bad }))).paths, ["CHAIN_ID"], bad);
    }
  });
});

describe("config: URL values", () => {
  it("rejects surrounding or embedded whitespace and control characters (new URL() would silently trim them)", () => {
    for (const bad of [" http://127.0.0.1:8545", "http://127.0.0.1:8545 ", "http://127.0.0.1:8545\n", "http://127.0.0.1:8545\t", "http://127.0.0.1 :8545", "http://127.0.0.1:8545\u0000"]) {
      assert.deepEqual(issuePaths(() => loadEnv(validEnv({ CHAIN_RPC_URL: bad }))).paths, ["CHAIN_RPC_URL"], JSON.stringify(bad));
    }
    for (const bad of [" mongodb://127.0.0.1/evoting", "mongodb://127.0.0.1/evoting\n", "mongodb://127.0.0.1/evo ting"]) {
      assert.deepEqual(issuePaths(() => loadEnv(validEnv({ MONGODB_URI: bad }))).paths, ["MONGODB_URI"], JSON.stringify(bad));
    }
  });

  it("accepts replica-set (multi-host), IPv6, credentialed and +srv MongoDB URIs", () => {
    for (const good of [
      "mongodb://a.example.org:27017,b.example.org:27017,c.example.org:27017/evoting?replicaSet=rs0",
      "mongodb://user:p%40ss@a.example.org,b.example.org/evoting?authSource=admin&tls=true",
      "mongodb://[::1]:27017/evoting",
      "mongodb://localhost/evoting",
      "mongodb+srv://user:pw@cluster0.example.mongodb.net/evoting?retryWrites=true",
      "mongodb://127.0.0.1:27017",
    ]) {
      assert.equal(loadEnv(validEnv({ MONGODB_URI: good })).secrets.mongodbUri, good);
    }
  });

  it("rejects malformed MongoDB URIs", () => {
    for (const bad of [
      "mongodb://",
      "mongodb:///evoting",
      "mongodb://:27017/evoting", // empty host
      "mongodb://a,,b/evoting", // empty host in the list
      "mongodb://a:27017,/evoting",
      "mongodb://host:0/evoting",
      "mongodb://host:65536/evoting",
      "mongodb://host:99999/evoting",
      "mongodb://a:b:c/evoting", // too many colons
      "mongodb://[::1/evoting", // unclosed bracket
      "mongodb+srv://a.example.net,b.example.net/evoting", // SRV takes exactly one host
      "mongodb+srv://a.example.net:27017/evoting", // and no port
      "xmongodb://host/evoting",
      "http://host/?x=mongodb://a/evoting",
      "postgres://host/evoting",
      "host/evoting",
    ]) {
      assert.deepEqual(issuePaths(() => loadEnv(validEnv({ MONGODB_URI: bad }))).paths, ["MONGODB_URI"], bad);
    }
  });

  it("describeConfig lists every MongoDB host and nothing else from the URI", () => {
    const c = loadEnv(validEnv({ MONGODB_URI: "mongodb://appuser:s3cretPw@a.internal:27017,b.internal:27018/evoting?authSource=admin" }));
    const described = describeConfig(c);
    assert.equal(described.mongoHost, "a.internal:27017,b.internal:27018");
    const text = JSON.stringify(described);
    assert.ok(!text.includes("s3cretPw") && !text.includes("appuser") && !text.includes("authSource"));
  });
});

describe("config: production refuses a public key as the nullifier secret", () => {
  it("rejects a Hardhat development private key (also inside a longer secret) but only in production", () => {
    for (const secret of [hardhatAccount(5).privateKey, hardhatAccount(19).privateKey.slice(2), hardhatAccount(3).privateKey.slice(2) + "9f86d081884c7d659a2feaa0c55ad015"]) {
      assert.deepEqual(issuePaths(() => loadEnv(productionEnv({ NULLIFIER_SECRET: secret }))).paths, ["NULLIFIER_SECRET"], secret.slice(0, 10));
      loadEnv(validEnv({ NULLIFIER_SECRET: secret })); // fine outside production
    }
  });

  it("covers all twenty public development accounts", () => {
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(issuePaths(() => loadEnv(productionEnv({ RELAYER_PRIVATE_KEY: hardhatAccount(i).privateKey }))).paths.filter((p) => p === "RELAYER_PRIVATE_KEY"), ["RELAYER_PRIVATE_KEY"], `account #${i}`);
    }
  });
});

describe("config: logging defaults", () => {
  it("is silent under NODE_ENV=test, info otherwise, and LOG_LEVEL wins", () => {
    assert.equal(loadEnv(validEnv({ NODE_ENV: "test" })).logLevel, "silent");
    assert.equal(loadEnv(validEnv({ NODE_ENV: "development" })).logLevel, "info");
    assert.equal(loadEnv(productionEnv()).logLevel, "info");
    assert.equal(loadEnv(validEnv({ NODE_ENV: "test", LOG_LEVEL: "debug" })).logLevel, "debug");
  });
});

describe("config: secretValuesOf covers what libraries print on their own", () => {
  it("includes the MongoDB password (as written and URL-decoded) and the API-key-like parts of the RPC URL", () => {
    const c = loadEnv(
      validEnv({
        MONGODB_URI: "mongodb://appuser:p%40ssw0rd-long@db.internal:27017/evoting",
        CHAIN_RPC_URL: "https://rpc.example.org/v2/0123456789abcdef0123456789abcdef?apikey=k-1234567890",
      }),
    );
    const values = secretValuesOf(c);
    for (const expected of ["p%40ssw0rd-long", "p@ssw0rd-long", "/v2/0123456789abcdef0123456789abcdef?apikey=k-1234567890", "0123456789abcdef0123456789abcdef"]) {
      assert.ok(values.includes(expected), `missing ${expected}`);
    }
    assert.ok(!values.includes("v2"), "short, harmless path segments are not registered");
  });

  it("a password that is not valid percent-encoding is still registered as written, and nothing else is lost", () => {
    const c = loadEnv(validEnv({ MONGODB_URI: "mongodb://appuser:bad%ZZpassword@db.internal/evoting", CHAIN_RPC_URL: "https://user:pa%ZZss@rpc.example.org/v2/0123456789abcdef0123" }));
    const values = secretValuesOf(c);
    assert.ok(values.includes("bad%ZZpassword"));
    assert.ok(values.includes("pa%ZZss"));
    assert.ok(values.includes("/v2/0123456789abcdef0123"));
    assert.ok(values.includes("mongodb://appuser:bad%ZZpassword@db.internal/evoting"));
  });

  it("works for URIs without credentials and for a plain RPC URL", () => {
    const values = secretValuesOf(loadEnv(validEnv()));
    assert.ok(values.every((v) => typeof v === "string" && v.length > 0));
    assert.equal(new Set(values).size, values.length);
  });
});

