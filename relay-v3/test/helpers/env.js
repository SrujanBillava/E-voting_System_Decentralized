import { getAddress } from "ethers";
import { loadEnv } from "../../src/config/env.js";
import { testUri } from "./db.js";
import { VECTOR_ADDRESS } from "./world.js";

/** raw environment for the relayer pointing at a test world (the relayer key is the world's relayer account) */
export const rawEnv = (world, over = {}) => ({
  NODE_ENV: "test",
  RELAY_MONGODB_URI: testUri ?? "mongodb://127.0.0.1:27017/votechain_relay_v3_test",
  CHAIN_RPC_URL: world?.url ?? "http://127.0.0.1:8545",
  CHAIN_ID: "31337",
  VOTECHAIN_V3_ADDRESS: getAddress(VECTOR_ADDRESS),
  RELAYER_PRIVATE_KEY: world?.relayer.privateKey ?? "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  ...over,
});
export const configFor = (world, over = {}) => loadEnv(rawEnv(world, over));
