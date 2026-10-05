import { HDNodeWallet, Mnemonic, Wallet, getAddress } from "ethers";
import { z } from "zod";

/**
 * Environment validation of the IDENTITY service (the V2 approach: pure `loadEnv(rawEnv)`, every problem listed by NAME, secrets on a NON-enumerable
 * `secrets` property so JSON.stringify(config) / logging a config can never leak one).
 *
 * This process holds exactly ONE chain key: the commitment-issuer key. It must never be given the anonymous relayer's key, the owner key, a trustee key
 * or any other service's configuration: loadEnv REFUSES TO START when it finds one in its environment.
 */

const HARDHAT_PUBLIC_MNEMONIC = "test test test test test test test test test test test junk";

export class ConfigError extends Error {
  constructor(rawIssues) {
    const issues = rawIssues.filter((issue, i) => rawIssues.findIndex((o) => o.path === issue.path) === i);
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i.path || "(config)"}: ${i.message}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

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
      return getAddress(a);
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
  .refine(Number.isSafeInteger, "is too large to represent exactly");

const port = z
  .string()
  .regex(/^[0-9]{1,5}$/, "must be a port number")
  .transform(Number)
  .refine((p) => p >= 1 && p <= 65535, "must be between 1 and 65535");

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

/** The host list of a mongodb:// or mongodb+srv:// URI, or null when it is not a plausible one. */
export function mongoHostsOf(value) {
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

/** The database name of a MongoDB URI ("" when there is none). */
export const mongoDatabaseOf = (uri) => decodeURIComponent(/^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^?#]*)/.exec(uri)?.[1] ?? "");

const mongoUri = z.string().refine((value) => mongoHostsOf(value) !== null, "must be a MongoDB connection string such as mongodb://127.0.0.1:27017/votechain_identity_v3");

function isLowEntropyHex(value) {
  const hex = value.toLowerCase();
  if (new Set(hex).size < 8) return true;
  for (let period = 1; period <= hex.length / 2; period++) {
    if (hex.length % period === 0 && hex.slice(0, period).repeat(hex.length / period) === hex) return true;
  }
  return false;
}

const aes256Key = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/, "must be exactly 32 bytes of random hex (generate with: openssl rand -hex 32)")
  .refine((v) => !isLowEntropyHex(v.replace(/^0x/, "")), "has too little entropy (repeating or near-constant)");

const RAW = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: port.default(5100),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),

  IDENTITY_MONGODB_URI: mongoUri,

  CHAIN_RPC_URL: urlWithProtocols(["http:", "https:"], "http://127.0.0.1:8545"),
  CHAIN_ID: chainId,
  VOTECHAIN_V3_ADDRESS: address,
  ELECTION_ID: bytes32.optional(),
  CHAIN_CONFIRMATIONS: z.string().regex(/^[1-9][0-9]?$/, "must be an integer from 1 to 99").transform(Number).optional(),

  ISSUER_PRIVATE_KEY: privateKey,
  FACE_TEMPLATE_ENCRYPTION_KEY: aes256Key,

  /** at most MAX_BATCH (128, frozen in the contract); lower only if a target chain needs it */
  BATCH_MAX_SIZE: z.string().regex(/^[0-9]{1,3}$/, "must be an integer from 1 to 128").transform(Number).refine((n) => n >= 1 && n <= 128, "must be from 1 to 128").optional(),
  BATCH_INTERVAL_MS: z.string().regex(/^[0-9]{3,6}$/, "must be a number of milliseconds from 100 to 600000").transform(Number).refine((n) => n >= 100 && n <= 600_000, "must be from 100 to 600000").optional(),

  CORS_ORIGINS: z.string().optional(),
});

/** Names that must NEVER reach this process: another service's secrets or another role's key. */
const FOREIGN = /^(RELAYER_|RELAY_|OWNER_|AUTHORITY_|TRUSTEE_|ADMIN_|JWT_|NULLIFIER_)|(^|_)PRIVATE_KEY$/;
const ALLOWED_KEY = "ISSUER_PRIVATE_KEY";

const DEV_CORS_DEFAULT = ["http://localhost:5173", "http://127.0.0.1:5173"];

function parseCorsOrigins(value) {
  const origins = value.split(",").map((o) => o.trim()).filter(Boolean);
  const valid = origins.every((origin) => {
    try {
      const url = new URL(origin);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
    } catch {
      return false;
    }
  });
  return valid ? { origins } : { error: "each entry must be an exact origin such as https://id.votechain.example (no path, no trailing slash, no wildcard)" };
}

let hardhatAccountsCache;
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

/** @returns a frozen config object. Throws ConfigError listing every problem (names only). */
export function loadEnv(rawEnv) {
  const input = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ""));

  const foreign = Object.keys(input).filter((name) => name !== ALLOWED_KEY && FOREIGN.test(name));
  const parsed = RAW.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError([...parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), ...foreign.map((name) => ({ path: name, message: "must not be set for the identity service (it holds the issuer key only)" }))]);
  }
  const env = parsed.data;
  const issues = foreign.map((name) => ({ path: name, message: "must not be set for the identity service (it holds the issuer key only)" }));
  const isProduction = env.NODE_ENV === "production";

  let corsOrigins = [];
  if (env.CORS_ORIGINS !== undefined) {
    const result = parseCorsOrigins(env.CORS_ORIGINS);
    if (result.error) issues.push({ path: "CORS_ORIGINS", message: result.error });
    else corsOrigins = result.origins;
  } else if (!isProduction) {
    corsOrigins = DEV_CORS_DEFAULT;
  }
  if (isProduction && corsOrigins.length === 0 && issues.length === 0) issues.push({ path: "CORS_ORIGINS", message: "is required in production (explicit comma-separated list of exact origins)" });

  // Separate persistence: the identity store must not be the relayer's. The database name is the only thing visible here, so it is the rule.
  const database = mongoDatabaseOf(env.IDENTITY_MONGODB_URI);
  if (database === "") issues.push({ path: "IDENTITY_MONGODB_URI", message: "must name a database (there is deliberately no default)" });
  else if (/relay/i.test(database)) issues.push({ path: "IDENTITY_MONGODB_URI", message: "must not point at the relayer's database (the two stores are separate)" });

  const hexOf = (v) => v.replace(/^0x/, "").toLowerCase();
  const faceKeyHex = hexOf(env.FACE_TEMPLATE_ENCRYPTION_KEY);
  if (hexOf(env.ISSUER_PRIVATE_KEY).includes(faceKeyHex)) issues.push({ path: "FACE_TEMPLATE_ENCRYPTION_KEY", message: "must not reuse ISSUER_PRIVATE_KEY" });
  for (const name of ["IDENTITY_MONGODB_URI", "CHAIN_RPC_URL"]) {
    if (env[name].toLowerCase().includes(faceKeyHex)) issues.push({ path: "FACE_TEMPLATE_ENCRYPTION_KEY", message: `must not appear in ${name}` });
  }

  if (isProduction) {
    const dev = hardhatDevAccounts();
    const issuerAddress = new Wallet(env.ISSUER_PRIVATE_KEY).address;
    if (dev.some((a) => a.address === issuerAddress)) issues.push({ path: "ISSUER_PRIVATE_KEY", message: "is a publicly known Hardhat development key and is not allowed in production" });
    if (dev.some((a) => a.key === faceKeyHex)) issues.push({ path: "FACE_TEMPLATE_ENCRYPTION_KEY", message: "is a publicly known Hardhat development key and is not allowed in production" });
    if (env.CHAIN_ID === 31337) issues.push({ path: "CHAIN_ID", message: "31337 is the local Hardhat chain and is not allowed in production" });
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const config = {
    nodeEnv: env.NODE_ENV,
    isProduction,
    port: env.PORT,
    logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === "test" ? "silent" : "info"),
    corsOrigins: Object.freeze(corsOrigins),
    chain: Object.freeze({ chainId: env.CHAIN_ID, contractAddress: env.VOTECHAIN_V3_ADDRESS, electionId: env.ELECTION_ID, confirmations: env.CHAIN_CONFIRMATIONS ?? 1 }),
    batch: Object.freeze({ maxSize: env.BATCH_MAX_SIZE ?? 128, intervalMs: env.BATCH_INTERVAL_MS ?? 2000 }),
    issuerAddress: new Wallet(env.ISSUER_PRIVATE_KEY).address,
  };

  Object.defineProperty(config, "secrets", {
    enumerable: false,
    value: Object.freeze({
      issuerPrivateKey: env.ISSUER_PRIVATE_KEY,
      faceTemplateKey: Buffer.from(faceKeyHex, "hex"),
      mongodbUri: env.IDENTITY_MONGODB_URI,
      chainRpcUrl: env.CHAIN_RPC_URL,
    }),
  });
  return Object.freeze(config);
}

/** Every secret VALUE the logger must scrub from any string it ever writes (including the pieces a library might print: URL passwords, RPC API keys). */
export function secretValuesOf(config) {
  const s = config.secrets;
  const values = [s.issuerPrivateKey, s.issuerPrivateKey.slice(2), s.faceTemplateKey.toString("hex"), s.mongodbUri, s.chainRpcUrl];
  const decoded = (text) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  const userinfo = /^mongodb(?:\+srv)?:\/\/([^/?#@]*)@/.exec(s.mongodbUri)?.[1];
  const password = userinfo?.includes(":") ? userinfo.slice(userinfo.indexOf(":") + 1) : undefined;
  if (password) values.push(password, decoded(password));
  try {
    const rpc = new URL(s.chainRpcUrl);
    values.push(rpc.href, decoded(rpc.password));
    if (rpc.pathname + rpc.search !== "/") values.push(rpc.pathname + rpc.search, ...rpc.pathname.split("/").filter((segment) => segment.length >= 16));
  } catch {
    // validated at load time
  }
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

/** Safe-to-log description of the configuration (public addresses and hosts only). */
export function describeConfig(config) {
  const host = (value) => {
    try {
      return new URL(value).host;
    } catch {
      return "(invalid)";
    }
  };
  return { nodeEnv: config.nodeEnv, port: config.port, corsOrigins: config.corsOrigins, mongoHost: mongoHostsOf(config.secrets.mongodbUri)?.join(",") ?? "(invalid)", rpcHost: host(config.secrets.chainRpcUrl), issuerAddress: config.issuerAddress, batch: config.batch };
}
