import { expect } from "chai";
import { makeBallot, openFixture, type World } from "./helpers/fixtures.js";
import { BLR, ethers, networkHelpers, nullifierOf } from "./helpers/setup.js";

/**
 * Minimal call forwarder, hand-assembled so the suite needs no extra Solidity file.
 * Input calldata: 20-byte target address ++ payload. It CALLs target with the payload and
 * bubbles up success (returndata) or failure (revert data). msg.sender seen by the target is
 * the forwarder; tx.origin is whoever sent the outer transaction.
 */
const FORWARDER_RUNTIME =
  "0x" +
  [
    "6014", "36", "03", "80", "6014", "5f", "37", // len = cds-20; calldatacopy(0, 20, len)
    "5f", "5f", "82", "5f", "5f", // retSize, retOffset, argsSize=len, argsOffset, value
    "5f", "35", "6060", "1c", // target = calldataload(0) >> 96
    "5a", "f1", // gas, call
    "3d", "5f", "5f", "3e", // returndatacopy(0, 0, rds)
    "601f", "57", // jumpi(success)
    "3d", "5f", "fd", // revert(0, rds)
    "5b", "3d", "5f", "f3", // return(0, rds)
  ].join("");
const FORWARDER_INITCODE = "0x" + "6023" + "80" + "6009" + "5f" + "39" + "5f" + "f3" + FORWARDER_RUNTIME.slice(2);

async function deployForwarder(world: World): Promise<string> {
  const tx = await world.owner.sendTransaction({ data: FORWARDER_INITCODE });
  const receipt = await tx.wait();
  return receipt!.contractAddress!;
}

async function viaForwarder(world: World, forwarder: string, from: { sendTransaction: (t: never) => Promise<unknown> }, calldata: string) {
  const data = ethers.concat([await world.voting.getAddress(), calldata]);
  return from.sendTransaction({ to: forwarder, data } as never);
}

describe("Voting V2: the relayer is msg.sender (not tx.origin)", () => {
  it("the forwarder helper really forwards (sanity: a view call through it returns data)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const forwarder = await deployForwarder(world);
    const data = ethers.concat([await world.voting.getAddress(), world.voting.interface.encodeFunctionData("totalBallots")]);
    const out = await ethers.provider.call({ to: forwarder, data });
    expect(BigInt(out)).to.equal(0n);
  });

  it("a malicious contract called by the relayer EOA cannot cast on its behalf (tx.origin == relayer is not enough)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const forwarder = await deployForwarder(world);

    // The authority legitimately authorized this ballot for the relayer EOA.
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    const calldata = world.voting.interface.encodeFunctionData("castVote", [
      ballot.constituencyId,
      ballot.nullifier,
      ballot.candidateId,
      ballot.deadline,
      ballot.signature,
    ]);

    // relayer EOA (tx.origin) -> forwarder (msg.sender seen by Voting) -> Voting
    await expect(viaForwarder(world, forwarder, world.relayer as never, calldata)).to.be.revert(ethers);
    expect(await world.voting.totalBallots()).to.equal(0n);
    expect(await world.voting.nullifierUsed(nullifierOf(1))).to.equal(false);

    // control: the same ballot sent directly by the relayer is counted
    await expect(
      world.voting.connect(world.relayer).castVote(ballot.constituencyId, ballot.nullifier, ballot.candidateId, ballot.deadline, ballot.signature),
    ).to.emit(world.voting, "BallotCast");
  });

  it("the revert reason through the forwarder is NotRelayer(forwarder)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const forwarder = await deployForwarder(world);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    const calldata = world.voting.interface.encodeFunctionData("castVote", [
      ballot.constituencyId, ballot.nullifier, ballot.candidateId, ballot.deadline, ballot.signature,
    ]);
    const data = ethers.concat([await world.voting.getAddress(), calldata]);
    await expect(ethers.provider.call({ from: world.relayer.address, to: forwarder, data })).to.be.revert(ethers);
    try {
      await ethers.provider.call({ from: world.relayer.address, to: forwarder, data });
      expect.fail("should have reverted");
    } catch (e) {
      const raw = (e as { data?: string }).data ?? "";
      expect(world.voting.interface.parseError(raw)?.name).to.equal("NotRelayer");
      expect(world.voting.interface.parseError(raw)?.args[0]).to.equal(ethers.getAddress(forwarder));
    }
  });

  it("a contract can be the relayer: the authorization names the contract, and it works through msg.sender", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const forwarder = await deployForwarder(world);
    await world.voting.setRelayer(forwarder);

    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n, signedRelayer: forwarder });
    const calldata = world.voting.interface.encodeFunctionData("castVote", [
      ballot.constituencyId, ballot.nullifier, ballot.candidateId, ballot.deadline, ballot.signature,
    ]);
    await viaForwarder(world, forwarder, world.attacker as never, calldata); // any EOA may trigger the contract-relayer
    expect(await world.voting.totalBallots()).to.equal(1n);
    expect(await world.voting.votesOf(1)).to.equal(1n);

    // an authorization signed for the EOA that sent the outer tx (tx.origin) does not count
    const forOrigin = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(2), candidateId: 1n, signedRelayer: world.attacker.address });
    const calldata2 = world.voting.interface.encodeFunctionData("castVote", [
      forOrigin.constituencyId, forOrigin.nullifier, forOrigin.candidateId, forOrigin.deadline, forOrigin.signature,
    ]);
    await expect(viaForwarder(world, forwarder, world.attacker as never, calldata2)).to.be.revert(ethers);
    expect(await world.voting.totalBallots()).to.equal(1n);
  });
});
