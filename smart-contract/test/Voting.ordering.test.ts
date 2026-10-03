import { expect } from "chai";
import {
  castBallot,
  closedFixture,
  configuredFixture,
  makeBallot,
  openFixture,
  vote,
  type World,
} from "./helpers/fixtures.js";
import { BLR, DEL, Phase, ethers, networkHelpers, nullifierOf } from "./helpers/setup.js";

/**
 * castVote must evaluate its checks in exactly this order (frozen spec):
 *   phase Open -> msg.sender == relayer -> nullifier != 0 -> nullifier unused
 *   -> deadline -> candidate exists -> candidate in constituency -> signature.
 * Each test below makes EVERY later check fail too, so the reported error identifies the
 * first check that ran. Swapping any two adjacent checks makes at least one of them fail.
 */

const JUNK_SIG = "0x" + "11".repeat(65);
const LONG_AGO = 1n;

function call(
  world: World,
  who: { address: string },
  args: { constituencyId: string; nullifier: string; candidateId: bigint; deadline: bigint; signature: string },
) {
  return world.voting
    .connect(who as typeof world.relayer)
    .castVote(args.constituencyId, args.nullifier, args.candidateId, args.deadline, args.signature);
}

describe("Voting V2: castVote check order (error precedence)", () => {
  it("1. phase beats everything: Setup and Closed report WrongPhase for a non-relayer with garbage arguments", async () => {
    const garbage = { constituencyId: ethers.ZeroHash, nullifier: ethers.ZeroHash, candidateId: 0n, deadline: LONG_AGO, signature: "0x" };

    const setup = await networkHelpers.loadFixture(configuredFixture);
    await expect(call(setup as never, setup.attacker, garbage))
      .to.be.revertedWithCustomError(setup.voting, "WrongPhase")
      .withArgs(Phase.Setup);

    const closed = await networkHelpers.loadFixture(closedFixture);
    await expect(call(closed, closed.attacker, garbage))
      .to.be.revertedWithCustomError(closed.voting, "WrongPhase")
      .withArgs(Phase.Closed);
  });

  it("2. relayer beats nullifier, deadline, candidate and signature checks", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const garbage = { constituencyId: ethers.ZeroHash, nullifier: ethers.ZeroHash, candidateId: 0n, deadline: LONG_AGO, signature: "0x" };
    await expect(call(world, world.attacker, garbage))
      .to.be.revertedWithCustomError(world.voting, "NotRelayer")
      .withArgs(world.attacker.address);
  });

  it("3. zero nullifier beats deadline, candidate and signature checks", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    await expect(
      call(world, world.relayer, { constituencyId: ethers.ZeroHash, nullifier: ethers.ZeroHash, candidateId: 0n, deadline: LONG_AGO, signature: "0x" }),
    ).to.be.revertedWithCustomError(world.voting, "ZeroId");
  });

  it("4. used nullifier beats deadline, candidate and signature checks", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    await vote(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await expect(
      call(world, world.relayer, { constituencyId: ethers.ZeroHash, nullifier: nullifierOf(1), candidateId: 0n, deadline: LONG_AGO, signature: "0x" }),
    )
      .to.be.revertedWithCustomError(world.voting, "NullifierAlreadyUsed")
      .withArgs(nullifierOf(1));
  });

  it("5. an expired deadline beats an invalid candidate, a mismatched candidate and a bad signature", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const now = BigInt(await networkHelpers.time.latest());
    for (const [candidateId, constituencyId] of [
      [0n, BLR], // invalid candidate
      [999n, BLR], // invalid candidate
      [4n, BLR], // candidate of another constituency
    ] as const) {
      await expect(
        call(world, world.relayer, { constituencyId, nullifier: nullifierOf(1), candidateId, deadline: now - 5n, signature: JUNK_SIG }),
      ).to.be.revertedWithCustomError(world.voting, "AuthorizationExpired");
    }
  });

  it("6. an invalid candidate (0 or unknown) beats the constituency-mismatch and signature checks", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const deadline = await networkHelpers.time.latest().then((t) => BigInt(t) + 3600n);
    // candidate 0 with the zero constituency id: the zero-initialised storage slot would
    // "match" it, so only the exists flag keeps id 0 out.
    for (const [candidateId, constituencyId] of [
      [0n, ethers.ZeroHash],
      [0n, BLR],
      [999n, BLR],
    ] as const) {
      await expect(
        call(world, world.relayer, { constituencyId, nullifier: nullifierOf(1), candidateId, deadline, signature: JUNK_SIG }),
      )
        .to.be.revertedWithCustomError(world.voting, "InvalidCandidate")
        .withArgs(candidateId);
    }
  });

  it("7. a candidate/constituency mismatch beats the signature check", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const deadline = await networkHelpers.time.latest().then((t) => BigInt(t) + 3600n);
    await expect(
      call(world, world.relayer, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 4n, deadline, signature: JUNK_SIG }),
    )
      .to.be.revertedWithCustomError(world.voting, "CandidateConstituencyMismatch")
      .withArgs(4n, BLR);
  });

  it("8. the signature is the last check: everything else valid, junk signature -> InvalidAuthorizationSignature", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const deadline = await networkHelpers.time.latest().then((t) => BigInt(t) + 3600n);
    await expect(
      call(world, world.relayer, { constituencyId: DEL, nullifier: nullifierOf(1), candidateId: 5n, deadline, signature: JUNK_SIG }),
    ).to.be.revertedWithCustomError(world.voting, "InvalidAuthorizationSignature");
  });

  it("a ballot for the all-zero (constituency, candidate) pair can never be counted, even when signed", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const ballot = await makeBallot(world, { constituencyId: ethers.ZeroHash, nullifier: nullifierOf(1), candidateId: 0n });
    await expect(castBallot(world, ballot)).to.be.revertedWithCustomError(world.voting, "InvalidCandidate").withArgs(0n);
    expect(await world.voting.totalBallots()).to.equal(0n);
  });
});
