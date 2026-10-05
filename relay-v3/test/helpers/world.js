// TEST SUPPORT. A real VoteChainV3 election on a local Hardhat node: the official Semaphore stack, the generated validity verifier and the contract,
// deployed from the compiled artifacts of ../smart-contract-v3, then configured and opened. Services talk to it over JSON-RPC like in production.
import fs from "node:fs";
import { ContractFactory, HDNodeWallet, JsonRpcProvider, Mnemonic, Network, Wallet, keccak256, toUtf8Bytes } from "ethers";
import { add as pvAdd, generateTestKeyPair, mul as pvMul, randomScalar } from "../../../privacy-v3/src/elgamal.js";
import { G, TEST_CONTEXT } from "../../../privacy-v3/src/params.js";
import { artifactPath, contractsCompiled, startNode } from "./node.js";

export { contractsCompiled };
export const Phase = { Setup: 0, Open: 1, Closed: 2 };
export const EPOCH = 30;
export const CLOSE_GRACE = 20 * 60;
export const ELECTION_ID = "0x" + TEST_CONTEXT.electionId.toString(16).padStart(64, "0");
export const VECTOR_ADDRESS = "0x" + TEST_CONTEXT.contractAddress.toString(16).padStart(40, "0");

/** code -> { kc candidates, cap } : the standard constituencies of the test election */
export const CONSTITUENCIES = {
  "KA-BLR": { kc: 3, cap: 50 },
  "MH-MUM": { kc: 4, cap: 50 },
  "TN-CHE": { kc: 3, cap: 50 },
};

const artifact = (file) => JSON.parse(fs.readFileSync(artifactPath(...file), "utf8"));
const ARTIFACTS = {
  poseidon: ["poseidon-solidity", "PoseidonT3.sol", "PoseidonT3.json"],
  semaphoreVerifier: ["@semaphore-protocol", "contracts", "base", "SemaphoreVerifier.sol", "SemaphoreVerifier.json"],
  semaphore: ["@semaphore-protocol", "contracts", "Semaphore.sol", "Semaphore.json"],
  validity: ["contracts", "verifiers", "BallotValidityVerifier.sol", "Groth16Verifier.json"],
  voteChain: ["contracts", "VoteChainV3.sol", "VoteChainV3.json"],
};

/** replaces the library placeholders of a Hardhat artifact's bytecode with real addresses */
function linked(art, libraries) {
  let code = art.bytecode.slice(2);
  for (const libs of Object.values(art.linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(libs)) {
      const address = libraries[name].slice(2).toLowerCase();
      for (const { start, length } of refs) code = code.slice(0, start * 2) + address + code.slice(start * 2 + length * 2);
    }
  }
  return "0x" + code;
}

const MNEMONIC = "test test test test test test test test test test test junk";
export const devWallets = (provider) => {
  const root = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(MNEMONIC), "m/44'/60'/0'/0");
  return Array.from({ length: 20 }, (_, i) => new Wallet(root.deriveChild(i).privateKey, provider));
};

/** a trustee configuration whose verification keys are consistent with H (what openElection requires); not a real ceremony */
function fakeTrusteeConfig(addresses, H) {
  const C = pvMul(G, randomScalar());
  const keys = [1n, 2n, 3n].map((j) => pvAdd(H, pvMul(C, j)));
  return { transcriptHash: "0x" + "ab".repeat(32), addresses, keys: keys.map(([x, y]) => [x, y]) };
}

/**
 * Starts a node, deploys everything, configures and OPENS the election. Returns the pieces the tests need. `stop()` ends the node.
 * Roles (distinct accounts): owner #0, dependency deployer #1, issuer #2, relayer #4, trustees #7-#9, everyone else a plain account.
 */
export async function newWorld({ constituencies = CONSTITUENCIES, open = true } = {}) {
  const node = await startNode();
  const network = Network.from(31337);
  const provider = new JsonRpcProvider(node.url, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
  const wallets = devWallets(provider);
  const [owner, depDeployer, issuer, attacker, relayer, newOwner, stranger, trustee1, trustee2, trustee3] = wallets;
  const deploy = async (art, signer, args = [], libraries = {}) => {
    const factory = new ContractFactory(art.abi, linked(art, libraries), signer);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };

  const poseidon = await deploy(artifact(ARTIFACTS.poseidon), depDeployer);
  const semaphoreVerifier = await deploy(artifact(ARTIFACTS.semaphoreVerifier), depDeployer);
  const semaphore = await deploy(artifact(ARTIFACTS.semaphore), depDeployer, [await semaphoreVerifier.getAddress()], { PoseidonT3: await poseidon.getAddress() });
  const validity = await deploy(artifact(ARTIFACTS.validity), depDeployer);
  // account 0's FIRST transaction: the contract lands at the address the frozen privacy-v3 vectors (and real proofs) are bound to
  const voteChain = await deploy(artifact(ARTIFACTS.voteChain), owner, [owner.address, ELECTION_ID, await semaphore.getAddress(), await validity.getAddress(), CLOSE_GRACE]);
  const address = await voteChain.getAddress();
  if (address.toLowerCase() !== VECTOR_ADDRESS.toLowerCase()) throw new Error(`VoteChainV3 must land at the vector address, got ${address}`);

  const { publicKey: H } = generateTestKeyPair();
  await (await voteChain.setIssuer(issuer.address)).wait();
  await (await voteChain.setElectionKey(H[0], H[1])).wait();
  const trustees = fakeTrusteeConfig([trustee1.address, trustee2.address, trustee3.address], H);
  await (await voteChain.configureTrustees(trustees.transcriptHash, trustees.addresses, trustees.keys, H[0], H[1])).wait();
  const ids = {};
  for (const [code, { kc, cap }] of Object.entries(constituencies)) {
    await (await voteChain.addConstituency(code, `${code} constituency`, cap)).wait();
    ids[code] = keccak256(toUtf8Bytes(code));
    for (let j = 0; j < kc; j++) await (await voteChain.addCandidate(ids[code], `${code} candidate ${j}`)).wait();
  }
  if (open) await (await voteChain.openElection()).wait();

  const send = (method, params = []) => provider.send(method, params);
  const world = {
    node,
    provider,
    url: node.url,
    address,
    voteChain,
    semaphore,
    owner,
    issuer,
    relayer,
    attacker,
    stranger,
    trustees: [trustee1, trustee2, trustee3],
    wallets,
    H,
    ids,
    constituencies,
    electionId: ELECTION_ID,
    /** the chain's own clock: the latest block's timestamp (deterministic: it only moves when a block is mined) */
    clock: { nowSeconds: async () => (await provider.getBlock("latest")).timestamp },
    snapshot: () => send("evm_snapshot"),
    revert: (id) => send("evm_revert", [id]),
    /** mine one block carrying exactly this timestamp (and move the node's clock there) */
    mineAt: (timestamp) => send("evm_mine", [timestamp]),
    /** the start (in seconds) of the epoch that follows the one the chain is in `n` epochs from now, plus a safe offset inside it */
    async epochStart(n = 1, offset = 5) {
      const now = (await provider.getBlock("latest")).timestamp;
      return (Math.floor(now / EPOCH) + n) * EPOCH + offset;
    },
    /** moves the chain into the epoch `n` epochs ahead (default: the next one) */
    async nextEpoch(n = 1) {
      const t = await world.epochStart(n);
      await world.mineAt(t);
      return t;
    },
    async groupLeaves(code) {
      const { groupId } = await voteChain.getConstituency(ids[code]);
      const logs = await semaphore.queryFilter(semaphore.filters.MembersAdded(groupId));
      return logs.flatMap((l) => [...l.args.identityCommitments].map(BigInt));
    },
    /** the issuer (a test stand-in for the identity service) registers commitments as ONE batch */
    async register(code, commitments) {
      await (await voteChain.connect(issuer).registerCommitmentBatch(ids[code], commitments)).wait();
    },
    /** revert to the base snapshot and take a fresh one (a snapshot is consumed by reverting) */
    async reset() {
      await send("evm_revert", [world.base]);
      world.base = await send("evm_snapshot");
    },
    stop: () => node.stop(),
  };
  return world;
}

export { Phase as PHASES };
