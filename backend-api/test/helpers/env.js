import { HDNodeWallet, Mnemonic } from "ethers";

/**
 * TEST FIXTURES ONLY.
 * The Hardhat development mnemonic is public (printed by every `hardhat node`). Deriving the keys
 * from it keeps literal private keys out of the repository. These identities are the same ones
 * smart-contract's `deploy:local` configures: #0 owner, #1 authority, #2 relayer.
 */
const HARDHAT_MNEMONIC = "test test test test test test test test test test test junk";
const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(HARDHAT_MNEMONIC), "m/44'/60'/0'/0");

export const hardhatAccount = (index) => root.deriveChild(index);

export const KEYS = {
  owner: hardhatAccount(0).privateKey,
  authority: hardhatAccount(1).privateKey,
  relayer: hardhatAccount(2).privateKey,
};

// 32 random-looking bytes, fixed so test output is stable. Not used anywhere outside tests.
export const TEST_NULLIFIER_SECRET = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

export const TEST_JWT_SECRET = "3c9a1f5e7b2d48a6c0e1f39b5d7a2c4e8f6b1d3a5c7e9f0b2d4a6c8e1f3b5d70";
export const TEST_TOTP_KEY = "b7e4a1c9d2f6385e0a4c7b1d9e3f5a2c8d6b0e4f1a3c5d7e9b2f4a6c8d0e1f35";

/** A complete, valid raw environment (what process.env would hold). Override or delete keys per test. */
export function validEnv(overrides = {}) {
  const env = {
    NODE_ENV: "test",
    PORT: "5050",
    MONGODB_URI: "mongodb://127.0.0.1:27017/evoting-test",
    CHAIN_RPC_URL: "http://127.0.0.1:8545",
    CHAIN_ID: "31337",
    VOTING_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    ELECTION_ID: "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40",
    OWNER_PRIVATE_KEY: KEYS.owner,
    AUTHORITY_PRIVATE_KEY: KEYS.authority,
    RELAYER_PRIVATE_KEY: KEYS.relayer,
    NULLIFIER_SECRET: TEST_NULLIFIER_SECRET,
    JWT_ACCESS_SECRET: TEST_JWT_SECRET,
    ADMIN_TOTP_ENCRYPTION_KEY: TEST_TOTP_KEY,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}
