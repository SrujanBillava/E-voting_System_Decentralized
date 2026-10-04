// The FROZEN encodings, proven in Solidity against privacy-v3/spec/vectors.json: the very library VoteChainV3 uses, and the deployed contract itself.
import { expect } from "chai";
import { network } from "hardhat";
import { electionScope } from "../../privacy-v3/src/params.js";
import { CONSTITUENCIES, ELECTION_ID, cid, configure, ctx, newWorld, vectors } from "./helpers/world.js";

const ctxOf = (v) => ({ chainId: BigInt(v.chainId), contractAddress: v.contractAddress, electionId: v.electionId });

describe("Frozen encodings: Solidity == privacy-v3/spec/vectors.json", () => {
  let harness;
  let world;
  before(async () => {
    world = await newWorld();
    harness = await world.ethers.deployContract("EncodingsHarness");
    await configure(world, { only: ["KA-BLR"] });
  });

  it("the tags are keccak256 of their labels, exactly as in the vector file", async () => {
    expect(await harness.scopeTag()).to.equal(vectors.tags.SCOPE_TAG.bytes32);
    expect(await harness.ballotTag()).to.equal(vectors.tags.BALLOT_TAG.bytes32);
    expect(world.ethers.id(vectors.tags.SCOPE_TAG.label)).to.equal(vectors.tags.SCOPE_TAG.bytes32);
    expect(world.ethers.id(vectors.tags.BALLOT_TAG.label)).to.equal(vectors.tags.BALLOT_TAG.bytes32);
  });

  it("every scope vector (6): keccak256(abi.encode(SCOPE_TAG, chainId, contract, electionId)) matches, including election ids that differ only in their lowest 8 bits", async () => {
    expect(vectors.scope.vectors.length).to.be.gte(6);
    for (const v of vectors.scope.vectors) {
      const c = ctxOf(v);
      expect(await harness.scopeOf(c.chainId, c.contractAddress, c.electionId), v.name).to.equal(BigInt(v.scope));
      // the 128-byte abi.encode preimage in the vector file is what Solidity hashes
      const preimage = world.ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256", "address", "bytes32"], [vectors.tags.SCOPE_TAG.bytes32, c.chainId, c.contractAddress, c.electionId]);
      expect(preimage, v.name).to.equal(v.abiEncoded);
      expect(world.ethers.keccak256(preimage), v.name).to.equal(v.scope);
    }
    const low = vectors.scope.vectors.filter((v) => v.name.includes("lowest"));
    expect(new Set(low.map((v) => v.scope)).size).to.equal(low.length);
  });

  it("every ballot-hash vector (6, static uint256[64], 69-word preimage): Solidity == the frozen vector", async () => {
    expect(vectors.ballotHash.vectors.length).to.be.gte(6);
    for (const v of vectors.ballotHash.vectors) {
      const c = ctxOf(v);
      expect(v.coords).to.have.length(64);
      expect(await harness.ballotHashOf(c.chainId, c.contractAddress, c.electionId, v.constituencyId, v.coords.map(BigInt)), v.name).to.equal(BigInt(v.ballotHash));
      const preimage = world.ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256[64]"],
        [vectors.tags.BALLOT_TAG.bytes32, c.chainId, c.contractAddress, c.electionId, v.constituencyId, v.coords.map(BigInt)],
      );
      expect((preimage.length - 2) / 2, "69 words: no offset word, no length word").to.equal(69 * 32);
    }
  });

  it("the DEPLOYED contract (at the vector address, with the vector election id) computes scope() == the first scope vector", async () => {
    expect(world.address.toLowerCase()).to.equal(vectors.scope.vectors[0].contractAddress);
    expect(await world.vc.ELECTION_ID()).to.equal(vectors.scope.vectors[0].electionId);
    expect(await world.vc.scope()).to.equal(BigInt(vectors.scope.vectors[0].scope));
    expect(await world.vc.scope()).to.equal(electionScope(ctx));
  });

  it("the deployed contract's ballotHashOf(constituency, active coordinates) pads with identity ciphertexts and equals the 'real ElGamal ciphertexts' vector", async () => {
    const v = vectors.ballotHash.vectors.find((x) => x.name.startsWith("real ElGamal"));
    expect(v.constituencyCode).to.equal("KA-BLR");
    const kc = CONSTITUENCIES["KA-BLR"].kc;
    const active = v.coords.slice(0, kc * 4).map(BigInt);
    expect(v.coords.slice(kc * 4)).to.deep.equal(Array.from({ length: 16 - kc }, () => ["0", "1", "0", "1"]).flat(), "the vector's padded slots are the identity ciphertext");
    expect(await world.vc.ballotHashOf(cid("KA-BLR"), active)).to.equal(BigInt(v.ballotHash));
  });

  it("ballotHashOf refuses a wrong coordinate count and an unknown constituency", async () => {
    await expect(world.vc.ballotHashOf(cid("KA-BLR"), Array(8).fill(1n))).to.be.revertedWithCustomError(world.vc, "WrongCoordinateCount").withArgs(12n, 8n);
    await expect(world.vc.ballotHashOf(cid("KA-BLR"), Array(16).fill(1n))).to.be.revertedWithCustomError(world.vc, "WrongCoordinateCount");
    await expect(world.vc.ballotHashOf(cid("XX-NONE"), [])).to.be.revertedWithCustomError(world.vc, "UnknownConstituency");
  });

  it("another deployment (other address) has a different scope, equal to the JS rule for that address; the chain id is part of it", async () => {
    const other = await world.ethers.deployContract("VoteChainV3", [world.owner.address, ELECTION_ID, await world.semaphore.getAddress(), await world.validityVerifier.getAddress(), 0n], world.stranger);
    const addr = await other.getAddress();
    expect(addr).to.not.equal(world.address);
    expect(await other.scope()).to.not.equal(await world.vc.scope());
    expect(await other.scope()).to.equal(electionScope({ ...ctx, contractAddress: BigInt(addr) }));
    expect((await world.ethers.provider.getNetwork()).chainId).to.equal(31337n);
    expect(await other.scope()).to.equal(await harness.scopeOf(31337n, addr, ELECTION_ID));
  });
});
