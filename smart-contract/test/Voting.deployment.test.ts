import { expect } from "chai";
import { deployFixture, openFixture, closedFixture, configuredFixture } from "./helpers/fixtures.js";
import { ELECTION_ID, Phase, TYPES, TYPE_STRING, ethers, networkHelpers } from "./helpers/setup.js";

describe("Voting V2: deployment", () => {
  it("sets owner, election id, authority, relayer and starts in Setup", async () => {
    const { voting, owner, authority, relayer } = await networkHelpers.loadFixture(deployFixture);

    expect(await voting.owner()).to.equal(owner.address);
    expect(await voting.pendingOwner()).to.equal(ethers.ZeroAddress);
    expect(await voting.ELECTION_ID()).to.equal(ELECTION_ID);
    expect(await voting.authoritySigner()).to.equal(authority.address);
    expect(await voting.relayer()).to.equal(relayer.address);
    expect(await voting.phase()).to.equal(Phase.Setup);

    expect(await voting.candidateCount()).to.equal(0n);
    expect(await voting.totalBallots()).to.equal(0n);
    expect(await voting.constituencyCount()).to.equal(0n);
  });

  it("emits ElectionDeployed with the public configuration", async () => {
    const [owner, authority, relayer] = await ethers.getSigners();
    const voting = await ethers.deployContract("Voting", [
      owner.address,
      ELECTION_ID,
      authority.address,
      relayer.address,
    ]);
    await expect(voting.deploymentTransaction())
      .to.emit(voting, "ElectionDeployed")
      .withArgs(ELECTION_ID, owner.address, authority.address, relayer.address);
  });

  it("rejects a zero election id", async () => {
    const [owner, authority, relayer] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("Voting");
    await expect(
      factory.deploy(owner.address, ethers.ZeroHash, authority.address, relayer.address),
    ).to.be.revertedWithCustomError(factory, "ZeroId");
  });

  it("rejects a zero authority", async () => {
    const [owner, , relayer] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("Voting");
    await expect(
      factory.deploy(owner.address, ELECTION_ID, ethers.ZeroAddress, relayer.address),
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("rejects a zero relayer", async () => {
    const [owner, authority] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("Voting");
    await expect(
      factory.deploy(owner.address, ELECTION_ID, authority.address, ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("rejects a zero owner (OpenZeppelin Ownable)", async () => {
    const [, authority, relayer] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("Voting");
    await expect(
      factory.deploy(ethers.ZeroAddress, ELECTION_ID, authority.address, relayer.address),
    ).to.be.revertedWithCustomError(factory, "OwnableInvalidOwner");
  });
});

describe("Voting V2: EIP-712 domain and type hash", () => {
  it("exposes the exact domain: VoteChain / 2 / chainId / this contract", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    const d = await voting.eip712Domain();
    const net = await ethers.provider.getNetwork();

    expect(d.name).to.equal("VoteChain");
    expect(d.version).to.equal("2");
    expect(d.chainId).to.equal(net.chainId);
    expect(d.verifyingContract).to.equal(await voting.getAddress());
    expect(d.salt).to.equal(ethers.ZeroHash);
    expect(d.extensions.length).to.equal(0);
    // fields bitmap: name, version, chainId, verifyingContract (0b01111)
    expect(d.fields).to.equal("0x0f");
  });

  it("BALLOT_AUTHORIZATION_TYPEHASH is the hash of the one canonical type string", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    expect(await voting.BALLOT_AUTHORIZATION_TYPEHASH()).to.equal(ethers.id(TYPE_STRING));
  });

  it("the type string matches the ethers typed-data encoder (backend will use this)", async () => {
    const encoder = ethers.TypedDataEncoder.from(TYPES);
    expect(encoder.encodeType("BallotAuthorization")).to.equal(TYPE_STRING);
    expect(ethers.id(encoder.encodeType("BallotAuthorization"))).to.equal(ethers.id(TYPE_STRING));
  });

  it("signs candidateId and does not sign the relayer as a call parameter", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    expect(TYPE_STRING).to.contain("uint256 candidateId");
    const castVote = voting.interface.getFunction("castVote")!;
    expect(castVote.inputs.map((i) => `${i.type} ${i.name}`)).to.deep.equal([
      "bytes32 constituencyId",
      "bytes32 nullifier",
      "uint256 candidateId",
      "uint256 deadline",
      "bytes signature",
    ]);
  });
});

describe("Voting V2: ownership (Ownable2Step)", () => {
  it("only the owner can configure, rotate keys and change phase", async () => {
    const { voting, attacker, other } = await networkHelpers.loadFixture(configuredFixture);
    const asAttacker = voting.connect(attacker);
    const ownerOnly = "OwnableUnauthorizedAccount";

    await expect(asAttacker.addConstituency("X-1", "X")).to.be.revertedWithCustomError(voting, ownerOnly).withArgs(attacker.address);
    await expect(asAttacker.addCandidate(ethers.id("KA-BLR-S"), "X")).to.be.revertedWithCustomError(voting, ownerOnly);
    await expect(asAttacker.setAuthoritySigner(other.address)).to.be.revertedWithCustomError(voting, ownerOnly);
    await expect(asAttacker.setRelayer(other.address)).to.be.revertedWithCustomError(voting, ownerOnly);
    await expect(asAttacker.openElection()).to.be.revertedWithCustomError(voting, ownerOnly);

    await voting.openElection();
    await expect(asAttacker.closeElection()).to.be.revertedWithCustomError(voting, ownerOnly);
  });

  it("transfer is two-step: pending owner has no power until accepting", async () => {
    const { voting, owner, newOwner } = await networkHelpers.loadFixture(deployFixture);

    await expect(voting.transferOwnership(newOwner.address))
      .to.emit(voting, "OwnershipTransferStarted")
      .withArgs(owner.address, newOwner.address);

    expect(await voting.owner()).to.equal(owner.address);
    expect(await voting.pendingOwner()).to.equal(newOwner.address);

    // pending owner cannot act yet
    await expect(voting.connect(newOwner).addConstituency("X-1", "X")).to.be.revertedWithCustomError(
      voting,
      "OwnableUnauthorizedAccount",
    );

    await expect(voting.connect(newOwner).acceptOwnership())
      .to.emit(voting, "OwnershipTransferred")
      .withArgs(owner.address, newOwner.address);

    expect(await voting.owner()).to.equal(newOwner.address);
    expect(await voting.pendingOwner()).to.equal(ethers.ZeroAddress);

    // old owner lost power; new owner has it
    await expect(voting.addConstituency("X-1", "X")).to.be.revertedWithCustomError(voting, "OwnableUnauthorizedAccount");
    await voting.connect(newOwner).addConstituency("X-1", "X");
  });

  it("a random account cannot accept a pending transfer", async () => {
    const { voting, owner, newOwner, attacker } = await networkHelpers.loadFixture(deployFixture);
    await voting.transferOwnership(newOwner.address);

    await expect(voting.connect(attacker).acceptOwnership())
      .to.be.revertedWithCustomError(voting, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);
    expect(await voting.owner()).to.equal(owner.address);
  });

  it("the owner can change a pending transfer before it is accepted", async () => {
    const { voting, newOwner, attacker } = await networkHelpers.loadFixture(deployFixture);
    await voting.transferOwnership(attacker.address);
    await voting.transferOwnership(newOwner.address);

    await expect(voting.connect(attacker).acceptOwnership()).to.be.revertedWithCustomError(
      voting,
      "OwnableUnauthorizedAccount",
    );
    await voting.connect(newOwner).acceptOwnership();
    expect(await voting.owner()).to.equal(newOwner.address);
  });

  it("renounceOwnership always reverts, in every phase, for everyone", async () => {
    const setup = await networkHelpers.loadFixture(deployFixture);
    await expect(setup.voting.renounceOwnership()).to.be.revertedWithCustomError(setup.voting, "RenounceDisabled");
    await expect(setup.voting.connect(setup.attacker).renounceOwnership()).to.be.revertedWithCustomError(
      setup.voting,
      "RenounceDisabled",
    );

    const open = await networkHelpers.loadFixture(openFixture);
    await expect(open.voting.renounceOwnership()).to.be.revertedWithCustomError(open.voting, "RenounceDisabled");
    expect(await open.voting.owner()).to.equal(open.owner.address);

    const closed = await networkHelpers.loadFixture(closedFixture);
    await expect(closed.voting.renounceOwnership()).to.be.revertedWithCustomError(closed.voting, "RenounceDisabled");
    expect(await closed.voting.owner()).to.equal(closed.owner.address);
  });

  it("ownership can still be transferred after Closed (so a lost key can be handed over before)", async () => {
    const { voting, newOwner } = await networkHelpers.loadFixture(closedFixture);
    await voting.transferOwnership(newOwner.address);
    await voting.connect(newOwner).acceptOwnership();
    expect(await voting.owner()).to.equal(newOwner.address);
  });
});
