import { expect } from "chai";
import { castBallot, closedFixture, configuredFixture, makeBallot, openFixture } from "./helpers/fixtures.js";
import { BLR, Phase, ethers, networkHelpers, nullifierOf } from "./helpers/setup.js";

describe("Voting V2: authority signer rotation", () => {
  it("can rotate during Setup and Open, emitting an event each time", async () => {
    const setup = await networkHelpers.loadFixture(configuredFixture);
    await expect(setup.voting.setAuthoritySigner(setup.authority2.address))
      .to.emit(setup.voting, "AuthoritySignerChanged")
      .withArgs(setup.authority.address, setup.authority2.address);
    expect(await setup.voting.authoritySigner()).to.equal(setup.authority2.address);

    await setup.voting.openElection();
    await expect(setup.voting.setAuthoritySigner(setup.authority.address))
      .to.emit(setup.voting, "AuthoritySignerChanged")
      .withArgs(setup.authority2.address, setup.authority.address);
    expect(await setup.voting.authoritySigner()).to.equal(setup.authority.address);
  });

  it("an outstanding signature from the old authority stops working; the new authority's works", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const { voting, authority2 } = world;

    // signed by the current authority BEFORE rotation, never submitted
    const outstanding = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });

    await voting.setAuthoritySigner(authority2.address);

    await expect(castBallot(world, outstanding)).to.be.revertedWithCustomError(voting, "InvalidAuthorizationSignature");
    expect(await voting.nullifierUsed(nullifierOf(1))).to.equal(false);

    // the same voter is re-authorized by the new authority and succeeds
    const reissued = await makeBallot(world, {
      constituencyId: BLR,
      nullifier: nullifierOf(1),
      candidateId: 1n,
      signer: authority2 as never,
    });
    await expect(castBallot(world, reissued)).to.emit(voting, "BallotCast").withArgs(nullifierOf(1), BLR, 1n, 1n);
  });

  it("ballots already counted under the old authority stay counted after rotation", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    await castBallot(world, await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n }));
    await world.voting.setAuthoritySigner(world.authority2.address);
    expect(await world.voting.totalBallots()).to.equal(1n);
    expect(await world.voting.votesOf(1)).to.equal(1n);
    expect(await world.voting.nullifierUsed(nullifierOf(1))).to.equal(true);
  });

  it("rejects the zero address", async () => {
    const { voting } = await networkHelpers.loadFixture(openFixture);
    await expect(voting.setAuthoritySigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(voting, "ZeroAddress");
  });

  it("is owner-only", async () => {
    const { voting, attacker } = await networkHelpers.loadFixture(openFixture);
    await expect(voting.connect(attacker).setAuthoritySigner(attacker.address))
      .to.be.revertedWithCustomError(voting, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);
  });

  it("is rejected after Closed", async () => {
    const { voting, authority2 } = await networkHelpers.loadFixture(closedFixture);
    await expect(voting.setAuthoritySigner(authority2.address))
      .to.be.revertedWithCustomError(voting, "WrongPhase")
      .withArgs(Phase.Closed);
  });
});

describe("Voting V2: relayer rotation", () => {
  it("can rotate during Setup and Open, emitting an event each time", async () => {
    const setup = await networkHelpers.loadFixture(configuredFixture);
    await expect(setup.voting.setRelayer(setup.relayer2.address))
      .to.emit(setup.voting, "RelayerChanged")
      .withArgs(setup.relayer.address, setup.relayer2.address);
    expect(await setup.voting.relayer()).to.equal(setup.relayer2.address);

    await setup.voting.openElection();
    await expect(setup.voting.setRelayer(setup.relayer.address))
      .to.emit(setup.voting, "RelayerChanged")
      .withArgs(setup.relayer2.address, setup.relayer.address);
    expect(await setup.voting.relayer()).to.equal(setup.relayer.address);
  });

  it("the old relayer is rejected and the new relayer is accepted", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const { voting, relayer, relayer2 } = world;

    await voting.setRelayer(relayer2.address);

    // old relayer, authorization signed for the old relayer
    const forOld = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await expect(castBallot(world, forOld, relayer))
      .to.be.revertedWithCustomError(voting, "NotRelayer")
      .withArgs(relayer.address);

    // new relayer, authorization signed for the new relayer
    const forNew = await makeBallot(world, {
      constituencyId: BLR,
      nullifier: nullifierOf(1),
      candidateId: 1n,
      signedRelayer: relayer2.address,
    });
    await expect(castBallot(world, forNew, relayer2)).to.emit(voting, "BallotCast");
  });

  it("an authorization issued for the old relayer cannot be used by the new relayer", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const forOld = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await world.voting.setRelayer(world.relayer2.address);
    await expect(castBallot(world, forOld, world.relayer2)).to.be.revertedWithCustomError(world.voting, "InvalidAuthorizationSignature");
  });

  it("rejects the zero address", async () => {
    const { voting } = await networkHelpers.loadFixture(openFixture);
    await expect(voting.setRelayer(ethers.ZeroAddress)).to.be.revertedWithCustomError(voting, "ZeroAddress");
  });

  it("is owner-only, and the relayer itself cannot rotate", async () => {
    const { voting, attacker, relayer } = await networkHelpers.loadFixture(openFixture);
    await expect(voting.connect(attacker).setRelayer(attacker.address)).to.be.revertedWithCustomError(voting, "OwnableUnauthorizedAccount");
    await expect(voting.connect(relayer).setRelayer(attacker.address)).to.be.revertedWithCustomError(voting, "OwnableUnauthorizedAccount");
  });

  it("is rejected after Closed", async () => {
    const { voting, relayer2 } = await networkHelpers.loadFixture(closedFixture);
    await expect(voting.setRelayer(relayer2.address))
      .to.be.revertedWithCustomError(voting, "WrongPhase")
      .withArgs(Phase.Closed);
  });
});
