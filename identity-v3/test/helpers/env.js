import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { loadEnv } from "../../src/config/env.js";
import { testUri } from "./db.js";
import { VECTOR_ADDRESS } from "./world.js";

/** raw environment for the identity service pointing at a test world (the issuer key is the world's issuer account) */
export const rawEnv = (world, over = {}) => ({
  NODE_ENV: "test",
  IDENTITY_MONGODB_URI: testUri ?? "mongodb://127.0.0.1:27017/votechain_identity_v3_test",
  CHAIN_RPC_URL: world?.url ?? "http://127.0.0.1:8545",
  CHAIN_ID: "31337",
  VOTECHAIN_V3_ADDRESS: getAddress(VECTOR_ADDRESS),
  ISSUER_PRIVATE_KEY: world?.issuer.privateKey ?? "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  FACE_TEMPLATE_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  ...over,
});
export const configFor = (world, over = {}) => loadEnv(rawEnv(world, over));
