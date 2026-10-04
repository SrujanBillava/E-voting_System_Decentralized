import { HDNodeWallet, Mnemonic, Wallet, getAddress } from "ethers";
import { z } from "zod";

/**
 * Environment validation. Pure: `loadEnv(rawEnv)` reads nothing from disk and opens no connection,
 * so tests and app.js can use it freely. Secrets live on a NON-enumerable `secrets` property, so
 * JSON.stringify(config) / console.log(config) / logger fields cannot leak them by accident.
 */

const HARDHAT_PUBLIC_MNEMONIC = "test test test test test test test test test test test junk";

export class ConfigError extends Error {
  /** @param {{ path: string, message: string }[]} issues */
  constructor(rawIssues) {
    // One line per variable: the first problem found for it is enough to fix it.
    const issues = rawIssues.filter((issue, i) => rawIssues.findIndex((o) => o.path === issue.path) === i);
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i.path || "(config)"}: ${i.message}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

// ----------------------------------------------------------------------------- field schemas
// Messages NEVER include the offending value: some of these fields are secrets.

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex characters")
  .refine((k) => {
    try {
      new Wallet(k);
      return true;
    } catch {
      return false;
    }
  }, "is not a valid secp256k1 private key");

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte 0x address")
  .transform((a, ctx) => {
    try {
      return getAddress(a); // throws on a bad mixed-case checksum
    } catch {
      ctx.addIssue({ code: "custom", message: "has an invalid EIP-55 checksum" });
      return z.NEVER;
    }
  });

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex characters")
  .transform((v) => v.toLowerCase());

const chainId = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/, "must be a positive integer")
  .transform(Number)
  .refine(Number.isSafeInteger, "is too large to represent exactly"); // 9007199254740993 would silently become ...992

const port = z
  .string()
  .regex(/^[0-9]{1,5}$/, "must be a port number")
  .transform(Number)
  .refine((p) => p >= 1 && p <= 65535, "must be between 1 and 65535");

// Whitespace or control characters inside a URL value are always a mistake (a stray newline from a
// copy/paste, a trailing space). `new URL()` would silently trim them, so the raw string handed to
// ethers or MongoDB would differ from the validated one.
const PLAIN_URL_TEXT = /^[^\s\u0000-\u001f\u007f]+$/u;

const urlWithProtocols = (protocols, example) =>
  z.string().refine((value) => {
    if (!PLAIN_URL_TEXT.test(value)) return false;
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, `must be a valid URL such as ${example}`);

/**
 * MongoDB connection strings may list several hosts (replica sets: mongodb://a:27017,b:27017/db),
 * which `new URL()` cannot parse. Returns the host list, or null when the string is not a plausible
 * mongodb:// or mongodb+srv:// URI.
 */
function mongoHostsOf(value) {
  if (!PLAIN_URL_TEXT.test(value)) return null;
  const match = /^(mongodb(?:\+srv)?):\/\/(?:[^/?#@]*@)?([^/?#@]+)(?:[/?#].*)?$/.exec(value);
  if (!match) return null;
  const hosts = match[2].split(",");
  if (match[1] === "mongodb+srv" && hosts.length !== 1) return null;
  const hostPort = /^(?:\[[0-9a-fA-F:.]+\]|[^:,[\]\s]+)(?::([0-9]{1,5}))?$/;
  for (const host of hosts) {
    const parts = hostPort.exec(host);
    if (!parts) return null;
    if (parts[1] !== undefined && (match[1] === "mongodb+srv" || Number(parts[1]) < 1 || Number(parts[1]) > 65535)) return null;
  }
  return hosts;
}

const mongoUri = z.string().refine((value) => mongoHostsOf(value) !== null, "must be a MongoDB connection string such as mongodb://127.0.0.1:27017/evoting");

/** Keys that are 0x-hex-looking secrets are not allowed to be low entropy ("0000...", "abab..."). */
function isLowEntropyHex(value) {
  const hex = value.toLowerCase(); // "AbAb..." repeats exactly like "abab..."
  if (new Set(hex).size < 8) return true;
  for (let period = 1; period <= hex.length / 2; period++) {
    if (hex.length % period === 0 && hex.slice(0, period).repeat(hex.length / period) === hex) return true;
  }
  return false;
}

const nullifierSecret = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64,256}$/, "must be at least 32 bytes of random hex (generate with: openssl rand -hex 32)")
  .refine((v) => (v.length - (v.startsWith("0x") ? 2 : 0)) % 2 === 0, "must have an even number of hex digits")
  .refine((v) => !isLowEntropyHex(v.replace(/^0x/, "")), "has too little entropy (repeating or near-constant)");

// An AES-256 key: exactly 32 random bytes as hex.
const aes256Key = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be exactly 32 bytes of random hex (generate with: openssl rand -hex 32)")
  .refine((v) => !isLowEntropyHex(v.replace(/^0x/, "")), "has too little entropy (repeating or near-constant)");

const RAW = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: port.default(5000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),

  MONGODB_URI: mongoUri,

  CHAIN_RPC_URL: urlWithProtocols(["http:", "https:"], "http://127.0.0.1:8545"),
  CHAIN_ID: chainId.optional(),
  VOTING_CONTRACT_ADDRESS: address.optional(),
  ELECTION_ID: bytes32.optional(),
  DEPLOYMENT_METADATA_PATH: z.string().min(1).optional(),
  CHAIN_CONFIRMATIONS: z.string().regex(/^[1-9][0-9]?$/, "must be an integer from 1 to 99").transform(Number).optional(),

  OWNER_PRIVATE_KEY: privateKey,
  AUTHORITY_PRIVATE_KEY: privateKey,
  RELAYER_PRIVATE_KEY: privateKey,

  NULLIFIER_SECRET: nullifierSecret,

  // Admin authentication (see src/auth). Both are exactly/at least 32 random bytes as hex.
  JWT_ACCESS_SECRET: nullifierSecret,
  ADMIN_TOTP_ENCRYPTION_KEY: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be exactly 32 bytes of random hex (generate with: openssl rand -hex 32)")
    .refine((v) => !isLowEntropyHex(v.replace(/^0x/, "")), "has too little entropy (repeating or near-constant)"),

  // Biometrics (see src/biometrics): encrypts every voter's face template at rest. Its own key, shared with nothing.
  FACE_TEMPLATE_ENCRYPTION_KEY: aes256Key,

  CORS_ORIGINS: z.string().optional(),
});

const DEV_CORS_DEFAULT = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** Exact origins only: scheme://host[:port], no path, no trailing slash, no wildcard. */
function parseCorsOrigins(value) {
  const origins = value
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const valid = origins.every((origin) => {
    try {
      const url = new URL(origin);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
    } catch {
      return false;
    }
  });
  return valid ? { origins } : { error: "each entry must be an exact origin such as https://vote.example.org (no path, no trailing slash, no wildcard)" };
}

let hardhatAccountsCache;
/** The 20 publicly known Hardhat development accounts: { address, key (64 lowercase hex digits, no 0x) }. */
function hardhatDevAccounts() {
  if (!hardhatAccountsCache) {
    const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_PUBLIC_MNEMONIC), "m/44'/60'/0'/0");
    hardhatAccountsCache = Array.from({ length: 20 }, (_, i) => {
      const account = root.deriveChild(i);
      return { address: account.address, key: account.privateKey.slice(2).toLowerCase() };
    });
  }
  return hardhatAccountsCache;
}

// ----------------------------------------------------------------------------------- loadEnv

/**
 * @param {Record<string, string | undefined>} rawEnv usually process.env
 * @returns a frozen config object. Throws ConfigError listing every problem (names only).
 */
export function loadEnv(rawEnv) {
  // `VAR=` in a .env file means "unset".
  const input = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ""));

  const parsed = RAW.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const env = parsed.data;
  const issues = [];
  const isProduction = env.NODE_ENV === "production";

  // ---- CORS
  let corsOrigins = [];
  if (env.CORS_ORIGINS !== undefined) {
    const result = parseCorsOrigins(env.CORS_ORIGINS);
    if (result.error) issues.push({ path: "CORS_ORIGINS", message: result.error });
    else corsOrigins = result.origins;
  } else if (!isProduction) {
    corsOrigins = DEV_CORS_DEFAULT;
  }
  if (isProduction && corsOrigins.length === 0 && issues.length === 0) {
    issues.push({ path: "CORS_ORIGINS", message: "is required in production (explicit comma-separated list of exact origins)" });
  }

  // ---- signers must be three different identities
  const signerAddresses = {
    owner: new Wallet(env.OWNER_PRIVATE_KEY).address,
    authority: new Wallet(env.AUTHORITY_PRIVATE_KEY).address,
    relayer: new Wallet(env.RELAYER_PRIVATE_KEY).address,
  };
  if (new Set(Object.values(signerAddresses)).size !== 3) {
    issues.push({
      path: "OWNER_PRIVATE_KEY/AUTHORITY_PRIVATE_KEY/RELAYER_PRIVATE_KEY",
      message: "owner, authority and relayer must be three DIFFERENT keys",
    });
  }

  // ---- the nullifier secret must not be (or equal) a signing key
  const secretHex = env.NULLIFIER_SECRET.replace(/^0x/, "").toLowerCase();
  for (const [name, key] of [["OWNER_PRIVATE_KEY", env.OWNER_PRIVATE_KEY], ["AUTHORITY_PRIVATE_KEY", env.AUTHORITY_PRIVATE_KEY], ["RELAYER_PRIVATE_KEY", env.RELAYER_PRIVATE_KEY]]) {
    if (key.slice(2).toLowerCase() === secretHex) {
      issues.push({ path: "NULLIFIER_SECRET", message: `must not reuse ${name}` });
    }
  }

  const hexOf = (v) => v.replace(/^0x/, "").toLowerCase();
  if (hexOf(env.JWT_ACCESS_SECRET) === secretHex || hexOf(env.ADMIN_TOTP_ENCRYPTION_KEY) === secretHex || hexOf(env.JWT_ACCESS_SECRET) === hexOf(env.ADMIN_TOTP_ENCRYPTION_KEY)) {
    issues.push({ path: "JWT_ACCESS_SECRET/ADMIN_TOTP_ENCRYPTION_KEY", message: "NULLIFIER_SECRET, JWT_ACCESS_SECRET and ADMIN_TOTP_ENCRYPTION_KEY must be three different secrets" });
  }

  // ---- the face template key must differ from every other secret (and must not be a part of a longer one)
  const faceKeyHex = hexOf(env.FACE_TEMPLATE_ENCRYPTION_KEY);
  for (const name of ["OWNER_PRIVATE_KEY", "AUTHORITY_PRIVATE_KEY", "RELAYER_PRIVATE_KEY", "NULLIFIER_SECRET", "JWT_ACCESS_SECRET", "ADMIN_TOTP_ENCRYPTION_KEY"]) {
    if (hexOf(env[name]).includes(faceKeyHex)) issues.push({ path: "FACE_TEMPLATE_ENCRYPTION_KEY", message: `must not reuse ${name}` });
  }
  for (const name of ["MONGODB_URI", "CHAIN_RPC_URL"]) {
    if (env[name].toLowerCase().includes(faceKeyHex)) issues.push({ path: "FACE_TEMPLATE_ENCRYPTION_KEY", message: `must not appear in ${name}` });
  }

  // ---- production-like environments refuse development material
  if (isProduction) {
    const dev = hardhatDevAccounts();
    const devAddresses = new Set(dev.map((a) => a.address));
    for (const [role, addr] of Object.entries(signerAddresses)) {
      if (devAddresses.has(addr)) {
        issues.push({ path: `${role.toUpperCase()}_PRIVATE_KEY`, message: "is a publicly known Hardhat development key and is not allowed in production" });
      }
    }
    // A public key used as the nullifier secret would let anyone recompute every voter's nullifier.
    if (dev.some((a) => secretHex.includes(a.key))) {
      issues.push({ path: "NULLIFIER_SECRET", message: "contains a publicly known Hardhat development key and is not allowed in production" });
    }
    if (dev.some((a) => a.key === faceKeyHex)) {
      issues.push({ path: "FACE_TEMPLATE_ENCRYPTION_KEY", message: "is a publicly known Hardhat development key and is not allowed in production" });
    }
    if (env.CHAIN_ID === 31337) issues.push({ path: "CHAIN_ID", message: "31337 is the local Hardhat chain and is not allowed in production" });
    for (const name of ["CHAIN_ID", "VOTING_CONTRACT_ADDRESS", "ELECTION_ID"]) {
      if (env[name] === undefined) issues.push({ path: name, message: "is required in production (deployment metadata files are never consulted)" });
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const config = {
    nodeEnv: env.NODE_ENV,
    isProduction,
    port: env.PORT,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info"),
    corsOrigins: Object.freeze(corsOrigins),
    chain: Object.freeze({
      chainId: env.CHAIN_ID,
      contractAddress: env.VOTING_CONTRACT_ADDRESS,
      electionId: env.ELECTION_ID,
      deploymentMetadataPath: env.DEPLOYMENT_METADATA_PATH,
      confirmations: env.CHAIN_CONFIRMATIONS ?? 1, // blocks (the receipt block included) before a ballot is called final
    }),
    signerAddresses: Object.freeze(signerAddresses),
  };

  Object.defineProperty(config, "secrets", {
    enumerable: false,
    value: Object.freeze({
      ownerPrivateKey: env.OWNER_PRIVATE_KEY,
      authorityPrivateKey: env.AUTHORITY_PRIVATE_KEY,
      relayerPrivateKey: env.RELAYER_PRIVATE_KEY,
      nullifierSecret: Buffer.from(secretHex, "hex"),
      jwtAccessSecret: Buffer.from(env.JWT_ACCESS_SECRET.replace(/^0x/, ""), "hex"),
      adminTotpKey: Buffer.from(env.ADMIN_TOTP_ENCRYPTION_KEY.replace(/^0x/, ""), "hex"),
      faceTemplateKey: Buffer.from(faceKeyHex, "hex"),
      mongodbUri: env.MONGODB_URI,
      chainRpcUrl: env.CHAIN_RPC_URL,
    }),
  });

  return Object.freeze(config);
}

/**
 * Every secret VALUE the logger must scrub from any string it ever writes. Besides the raw values this
 * lists the pieces a library might print on its own: the (decoded) password of the MongoDB URI and the
 * path/query of the RPC URL, where providers such as Infura or Alchemy put their API key.
 */
export function secretValuesOf(config) {
  const s = config.secrets;
  const values = [
    s.ownerPrivateKey,
    s.authorityPrivateKey,
    s.relayerPrivateKey,
    s.ownerPrivateKey.slice(2),
    s.authorityPrivateKey.slice(2),
    s.relayerPrivateKey.slice(2),
    s.nullifierSecret.toString("hex"),
    "0x" + s.nullifierSecret.toString("hex"),
    s.jwtAccessSecret.toString("hex"),
    s.adminTotpKey.toString("hex"),
    s.faceTemplateKey.toString("hex"),
    s.mongodbUri,
    s.chainRpcUrl,
  ];

  const decoded = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text; // not valid percent-encoding: the text as written is all there is
    }
  };

  const userinfo = /^mongodb(?:\+srv)?:\/\/([^/?#@]*)@/.exec(s.mongodbUri)?.[1];
  const password = userinfo?.includes(":") ? userinfo.slice(userinfo.indexOf(":") + 1) : undefined;
  if (password) values.push(password, decoded(password));

  try {
    const rpc = new URL(s.chainRpcUrl);
    values.push(rpc.href, decoded(rpc.password));
    if (rpc.pathname + rpc.search !== "/") values.push(rpc.pathname + rpc.search, ...rpc.pathname.split("/").filter((segment) => segment.length >= 16)); // API-key-like segments
  } catch {
    // validated at load time; nothing more to derive
  }
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

/** Safe-to-log description of the configuration (public addresses and hosts only). */
export function describeConfig(config) {
  const rpcHost = (value) => {
    try {
      return new URL(value).host;
    } catch {
      return "(invalid)";
    }
  };
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    corsOrigins: config.corsOrigins,
    mongoHost: mongoHostsOf(config.secrets.mongodbUri)?.join(",") ?? "(invalid)",
    rpcHost: rpcHost(config.secrets.chainRpcUrl),
    signerAddresses: config.signerAddresses,
  };
}
