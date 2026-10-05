import { HDNodeWallet, Mnemonic, Wallet, getAddress } from "ethers";
import { z } from "zod";

/**
 * Environment validation of the RELAYER (the V2 approach: pure `loadEnv(rawEnv)`, every problem listed by NAME, secrets on a NON-enumerable property).
 *
 * This process holds exactly ONE chain key, the relayer's gas key, and NOTHING of the identity side. loadEnv REFUSES TO START when it finds an issuer key, an
 * owner or trustee key, any identity/voter/biometric/session/JWT setting, or the shared `MONGODB_URI` in its environment.
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
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x followed by 64 hex characters").transform((v) => v.toLowerCase());
const chainId = z.string().regex(/^[1-9][0-9]{0,15}$/, "must be a positive integer").transform(Number).refine(Number.isSafeInteger, "is too large to represent exactly");
const port = z.string().regex(/^[0-9]{1,5}$/, "must be a port number").transform(Number).refine((p) => p >= 1 && p <= 65535, "must be between 1 and 65535");
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
export const mongoDatabaseOf = (uri) => decodeURIComponent(/^mongodb(?:\+srv)?:\/\/[^/?#]*\/([^?#]*)/.exec(uri)?.[1] ?? "");
const mongoUri = z.string().refine((value) => mongoHostsOf(value) !== null, "must be a MongoDB connection string such as mongodb://127.0.0.1:27017/votechain_relay_v3");

const RAW = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: port.default(5200),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),

  RELAY_MONGODB_URI: mongoUri,

  CHAIN_RPC_URL: urlWithProtocols(["http:", "https:"], "http://127.0.0.1:8545"),
  CHAIN_ID: chainId,
  VOTECHAIN_V3_ADDRESS: address,
  ELECTION_ID: bytes32.optional(),
  CHAIN_CONFIRMATIONS: z.string().regex(/^[1-9][0-9]?$/, "must be an integer from 1 to 99").transform(Number).optional(),

  RELAYER_PRIVATE_KEY: privateKey,

  /** the whole-process request budget per minute (there is deliberately no per-client limit: this process does not know its callers) */
  RELAY_GLOBAL_LIMIT_PER_MINUTE: z.string().regex(/^[0-9]{1,6}$/, "must be a positive integer").transform(Number).refine((n) => n >= 1, "must be at least 1").optional(),
  CORS_ORIGINS: z.string().optional(),
});

/** Names that must NEVER reach this process: any identity-side or admin configuration, any other role's key, the shared Mongo variable name. */
const FOREIGN = /^(ISSUER_|OWNER_|AUTHORITY_|TRUSTEE_|ADMIN_|JWT_|NULLIFIER_|FACE_|IDENTITY_|VOTER_|SESSION_|COOKIE_|BATCH_|MONGODB_URI$)|(^|_)PRIVATE_KEY$/;
const ALLOWED_KEY = "RELAYER_PRIVATE_KEY";
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
  return valid ? { origins } : { error: "each entry must be an exact origin such as https://vote.votechain.example (no path, no trailing slash, no wildcard)" };
}

let hardhatAccountsCache;
function hardhatDevAccounts() {
  if (!hardhatAccountsCache) {
    const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_PUBLIC_MNEMONIC), "m/44'/60'/0'/0");
    hardhatAccountsCache = Array.from({ length: 20 }, (_, i) => root.deriveChild(i).address);
  }
  return hardhatAccountsCache;
}

export function loadEnv(rawEnv) {
  const input = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ""));
  const foreign = Object.keys(input).filter((name) => name !== ALLOWED_KEY && FOREIGN.test(name)).map((name) => ({ path: name, message: "must not be set for the relayer (it holds the relayer key only and knows nothing of the identity side)" }));
  const parsed = RAW.safeParse(input);
  if (!parsed.success) throw new ConfigError([...parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })), ...foreign]);
  const env = parsed.data;
  const issues = [...foreign];
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

  // Separate persistence: this store must be the relayer's own. The database name is the only thing visible here, so it is the rule.
  const database = mongoDatabaseOf(env.RELAY_MONGODB_URI);
  if (!/relay/i.test(database)) issues.push({ path: "RELAY_MONGODB_URI", message: "must name a database containing 'relay' (the relayer's own store, never the identity service's)" });

  const relayerAddress = new Wallet(env.RELAYER_PRIVATE_KEY).address;
  if (isProduction) {
    if (hardhatDevAccounts().includes(relayerAddress)) issues.push({ path: "RELAYER_PRIVATE_KEY", message: "is a publicly known Hardhat development key and is not allowed in production" });
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
    globalLimitPerMinute: env.RELAY_GLOBAL_LIMIT_PER_MINUTE ?? 600,
    relayerAddress,
  };
  Object.defineProperty(config, "secrets", { enumerable: false, value: Object.freeze({ relayerPrivateKey: env.RELAYER_PRIVATE_KEY, mongodbUri: env.RELAY_MONGODB_URI, chainRpcUrl: env.CHAIN_RPC_URL }) });
  return Object.freeze(config);
}

export function secretValuesOf(config) {
  const s = config.secrets;
  const values = [s.relayerPrivateKey, s.relayerPrivateKey.slice(2), s.mongodbUri, s.chainRpcUrl];
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

export function describeConfig(config) {
  const host = (value) => {
    try {
      return new URL(value).host;
    } catch {
      return "(invalid)";
    }
  };
  return { nodeEnv: config.nodeEnv, port: config.port, corsOrigins: config.corsOrigins, mongoHost: mongoHostsOf(config.secrets.mongodbUri)?.join(",") ?? "(invalid)", rpcHost: host(config.secrets.chainRpcUrl), relayerAddress: config.relayerAddress };
}
