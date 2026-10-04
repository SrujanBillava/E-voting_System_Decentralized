import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

// VoteChain V3 contracts. Plain JavaScript config on purpose (no TypeScript loader needed).
// The optimizer is required: the V3 contract plus the official Semaphore contracts do not fit the default (unoptimised) profile comfortably.
export default {
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    // The OFFICIAL Semaphore V4 sources from the npm package (pinned 4.14.3), compiled unmodified so tests can deploy them.
    // On a real network VoteChainV3 would point at an official Semaphore deployment instead.
    npmFilesToBuild: [
      "@semaphore-protocol/contracts/Semaphore.sol",
      "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol",
      "poseidon-solidity/PoseidonT3.sol",
    ],
    profiles: {
      default: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  // Real Groth16 proofs are generated inside several tests, so give them room.
  test: { mocha: { timeout: 900000 } },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545" },
  },
};
