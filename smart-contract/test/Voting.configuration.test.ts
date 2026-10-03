import { expect } from "chai";
import {
  CANDIDATES,
  closedFixture,
  configuredFixture,
  deployFixture,
  makeBallot,
  openFixture,
  vote,
} from "./helpers/fixtures.js";
import { BLR, CONSTITUENCIES, DEL, MUM, Phase, cid, ethers, networkHelpers, nullifierOf } from "./helpers/setup.js";

describe("Voting V2: constituencies", () => {
  it("derives the canonical id as keccak256(bytes(code)) and returns it", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    const { code, name } = CONSTITUENCIES.BLR;

    expect(await voting.addConstituency.staticCall(code, name)).to.equal(cid(code));
    await expect(voting.addConstituency(code, name))
      .to.emit(voting, "ConstituencyAdded")
      .withArgs(cid(code), code, name);

    const [storedCode, storedName] = await voting.getConstituency(cid(code));
    expect(storedCode).to.equal(code);
    expect(storedName).to.equal(name);
    expect(await voting.constituencyCount()).to.equal(1n);
  });

  it("ConstituencyAdded is filterable by its indexed constituency id", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);
    const events = await voting.queryFilter(voting.filters.ConstituencyAdded(DEL));
    expect(events).to.have.length(1);
    expect(events[0].args.code).to.equal(CONSTITUENCIES.DEL.code);
    expect(events[0].args.name).to.equal(CONSTITUENCIES.DEL.name);
  });

  it("rejects a duplicate code", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("KA-BLR-S", "Bengaluru South");

    await expect(voting.addConstituency("KA-BLR-S", "Another Name"))
      .to.be.revertedWithCustomError(voting, "ConstituencyExists")
      .withArgs(cid("KA-BLR-S"));
    expect(await voting.constituencyCount()).to.equal(1n);
  });

  it("ids are case-sensitive: canonicalising codes is the caller's job (documented behaviour)", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("ka-blr-s", "lower");
    await voting.addConstituency("KA-BLR-S", "upper");
    expect(cid("ka-blr-s")).to.not.equal(cid("KA-BLR-S"));
    expect(await voting.constituencyCount()).to.equal(2n);
  });

  it("rejects an empty code and an empty name", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await expect(voting.addConstituency("", "Name")).to.be.revertedWithCustomError(voting, "BadCode");
    await expect(voting.addConstituency("CODE", "")).to.be.revertedWithCustomError(voting, "BadName");
    await expect(voting.addConstituency("", "")).to.be.revertedWithCustomError(voting, "BadCode");
    expect(await voting.constituencyCount()).to.equal(0n);
  });

  it("has no hard cap on the number of constituencies (25 created)", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    for (let i = 0; i < 25; i++) await voting.addConstituency(`C-${i}`, `Constituency ${i}`);
    expect(await voting.constituencyCount()).to.equal(25n);
  });

  it("enumerates constituency ids in creation order with pagination", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);

    expect(await voting.getConstituencyIds(0, 10)).to.deep.equal([BLR, DEL, MUM]);
    expect(await voting.getConstituencyIds(0, 2)).to.deep.equal([BLR, DEL]);
    expect(await voting.getConstituencyIds(2, 2)).to.deep.equal([MUM]);
    expect(await voting.getConstituencyIds(1, 1)).to.deep.equal([DEL]);
    expect(await voting.getConstituencyIds(3, 5)).to.deep.equal([]); // offset == length
    expect(await voting.getConstituencyIds(99, 5)).to.deep.equal([]); // offset beyond
    expect(await voting.getConstituencyIds(0, 0)).to.deep.equal([]); // limit 0
    expect(await voting.getConstituencyIds(1, ethers.MaxUint256)).to.deep.equal([DEL, MUM]); // no overflow
  });

  it("getConstituency reverts for an unknown id", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await expect(voting.getConstituency(cid("NOPE")))
      .to.be.revertedWithCustomError(voting, "UnknownConstituency")
      .withArgs(cid("NOPE"));
  });
});

describe("Voting V2: candidates", () => {
  it("candidate ids are global, sequential, and start at 1", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("A", "A");
    await voting.addConstituency("B", "B");

    expect(await voting.addCandidate.staticCall(cid("A"), "x")).to.equal(1n);
    await voting.addCandidate(cid("A"), "x");
    await voting.addCandidate(cid("B"), "y");
    await voting.addCandidate(cid("A"), "z");

    expect(await voting.candidateCount()).to.equal(3n);
    const [n1, c1] = await voting.getCandidate(1);
    const [n2, c2] = await voting.getCandidate(2);
    const [n3, c3] = await voting.getCandidate(3);
    expect([n1, c1]).to.deep.equal(["x", cid("A")]);
    expect([n2, c2]).to.deep.equal(["y", cid("B")]);
    expect([n3, c3]).to.deep.equal(["z", cid("A")]);
  });

  it("emits CandidateAdded with id, constituency and name", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("A", "A");
    await expect(voting.addCandidate(cid("A"), "Asha"))
      .to.emit(voting, "CandidateAdded")
      .withArgs(1n, cid("A"), "Asha");
  });

  it("CandidateAdded is filterable by candidate id and by constituency id", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);

    const byId = await voting.queryFilter(voting.filters.CandidateAdded(5n));
    expect(byId).to.have.length(1);
    expect(byId[0].args.name).to.equal("Pooja Verma");
    expect(byId[0].args.constituencyId).to.equal(DEL);

    const byConstituency = await voting.queryFilter(voting.filters.CandidateAdded(undefined, BLR));
    expect(byConstituency.map((e) => e.args.candidateId)).to.deep.equal([...CANDIDATES.BLR]);
  });

  it("candidate id 0 is invalid everywhere", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);
    await expect(voting.getCandidate(0)).to.be.revertedWithCustomError(voting, "InvalidCandidate").withArgs(0n);
    await expect(voting.votesOf(0)).to.be.revertedWithCustomError(voting, "InvalidCandidate").withArgs(0n);
  });

  it("an id above candidateCount is invalid", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);
    await expect(voting.getCandidate(7)).to.be.revertedWithCustomError(voting, "InvalidCandidate").withArgs(7n);
    await expect(voting.votesOf(7)).to.be.revertedWithCustomError(voting, "InvalidCandidate");
  });

  it("rejects an unknown constituency and an empty name", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("A", "A");

    await expect(voting.addCandidate(cid("NOPE"), "x"))
      .to.be.revertedWithCustomError(voting, "UnknownConstituency")
      .withArgs(cid("NOPE"));
    await expect(voting.addCandidate(ethers.ZeroHash, "x")).to.be.revertedWithCustomError(voting, "UnknownConstituency");
    await expect(voting.addCandidate(cid("A"), "")).to.be.revertedWithCustomError(voting, "BadName");
    expect(await voting.candidateCount()).to.equal(0n);
  });

  it("allows identical candidate names: identity is the id, not the name", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("A", "A");
    await voting.addConstituency("B", "B");

    await voting.addCandidate(cid("A"), "Rahul Sharma");
    await voting.addCandidate(cid("A"), "Rahul Sharma"); // same constituency, same name
    await voting.addCandidate(cid("B"), "Rahul Sharma"); // other constituency

    expect(await voting.candidateCount()).to.equal(3n);
    expect(await voting.candidateCountOf(cid("A"))).to.equal(2n);
  });

  it("enumerates a constituency's candidate ids with pagination, in creation order", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);

    expect(await voting.candidateCountOf(BLR)).to.equal(3n);
    expect(await voting.candidateCountOf(DEL)).to.equal(2n);
    expect(await voting.candidateCountOf(MUM)).to.equal(1n);

    expect(await voting.getCandidateIdsByConstituency(BLR, 0, 10)).to.deep.equal([...CANDIDATES.BLR]);
    expect(await voting.getCandidateIdsByConstituency(DEL, 0, 10)).to.deep.equal([...CANDIDATES.DEL]);
    expect(await voting.getCandidateIdsByConstituency(MUM, 0, 10)).to.deep.equal([...CANDIDATES.MUM]);

    expect(await voting.getCandidateIdsByConstituency(BLR, 1, 1)).to.deep.equal([2n]);
    expect(await voting.getCandidateIdsByConstituency(BLR, 2, 5)).to.deep.equal([3n]);
    expect(await voting.getCandidateIdsByConstituency(BLR, 3, 5)).to.deep.equal([]);
    expect(await voting.getCandidateIdsByConstituency(BLR, 0, 0)).to.deep.equal([]);
    expect(await voting.getCandidateIdsByConstituency(BLR, 1, ethers.MaxUint256)).to.deep.equal([2n, 3n]);
  });

  it("candidate enumeration interleaves correctly when added out of constituency order", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("A", "A");
    await voting.addConstituency("B", "B");
    await voting.addCandidate(cid("A"), "a1"); // 1
    await voting.addCandidate(cid("B"), "b1"); // 2
    await voting.addCandidate(cid("A"), "a2"); // 3
    await voting.addCandidate(cid("B"), "b2"); // 4

    expect(await voting.getCandidateIdsByConstituency(cid("A"), 0, 10)).to.deep.equal([1n, 3n]);
    expect(await voting.getCandidateIdsByConstituency(cid("B"), 0, 10)).to.deep.equal([2n, 4n]);
  });

  it("per-constituency reads revert for an unknown constituency", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await expect(voting.candidateCountOf(cid("NOPE"))).to.be.revertedWithCustomError(voting, "UnknownConstituency");
    await expect(voting.getCandidateIdsByConstituency(cid("NOPE"), 0, 1)).to.be.revertedWithCustomError(
      voting,
      "UnknownConstituency",
    );
    await expect(voting.constituencyTotal(cid("NOPE"))).to.be.revertedWithCustomError(voting, "UnknownConstituency");
  });

  it("has no edit or delete functions at all", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    const names = voting.interface.fragments.filter((f) => f.type === "function").map((f) => (f as unknown as { name: string }).name);
    for (const forbidden of [
      "removeCandidate",
      "deleteCandidate",
      "updateCandidate",
      "editCandidate",
      "renameCandidate",
      "removeConstituency",
      "deleteConstituency",
      "updateConstituency",
      "editConstituency",
      "renameConstituency",
      "reopenElection",
      "setPhase",
    ]) {
      expect(names, forbidden).to.not.include(forbidden);
    }
  });
});

describe("Voting V2: election lifecycle", () => {
  it("cannot open with no constituency", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await expect(voting.openElection()).to.be.revertedWithCustomError(voting, "NothingToOpen");
    expect(await voting.phase()).to.equal(Phase.Setup);
  });

  it("cannot open while a constituency has no candidate (reports how many)", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("A", "A");
    await expect(voting.openElection()).to.be.revertedWithCustomError(voting, "ConstituencyHasNoCandidate").withArgs(1n);

    await voting.addConstituency("B", "B");
    await expect(voting.openElection()).to.be.revertedWithCustomError(voting, "ConstituencyHasNoCandidate").withArgs(2n);

    await voting.addCandidate(cid("A"), "a");
    await expect(voting.openElection()).to.be.revertedWithCustomError(voting, "ConstituencyHasNoCandidate").withArgs(1n);

    await voting.addCandidate(cid("B"), "b");
    await voting.openElection();
    expect(await voting.phase()).to.equal(Phase.Open);
  });

  it("a second candidate in the same constituency does not hide an empty one", async () => {
    const { voting } = await networkHelpers.loadFixture(deployFixture);
    await voting.addConstituency("A", "A");
    await voting.addConstituency("B", "B");
    await voting.addCandidate(cid("A"), "a1");
    await voting.addCandidate(cid("A"), "a2");
    await expect(voting.openElection()).to.be.revertedWithCustomError(voting, "ConstituencyHasNoCandidate").withArgs(1n);
  });

  it("Setup -> Open emits ElectionOpened with the frozen counts", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);
    await expect(voting.openElection()).to.emit(voting, "ElectionOpened").withArgs(3n, 6n);
    expect(await voting.phase()).to.equal(Phase.Open);
  });

  it("Open -> Closed emits ElectionClosed with the final ballot count", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    await vote(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await expect(world.voting.closeElection()).to.emit(world.voting, "ElectionClosed").withArgs(1n);
    expect(await world.voting.phase()).to.equal(Phase.Closed);
  });

  it("cannot close from Setup", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);
    await expect(voting.closeElection()).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Setup);
  });

  it("cannot open twice", async () => {
    const { voting } = await networkHelpers.loadFixture(openFixture);
    await expect(voting.openElection()).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Open);
  });

  it("cannot close twice, and cannot reopen after Closed", async () => {
    const { voting } = await networkHelpers.loadFixture(closedFixture);
    await expect(voting.closeElection()).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Closed);
    await expect(voting.openElection()).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Closed);
    expect(await voting.phase()).to.equal(Phase.Closed);
  });

  it("phase never decreases across the full lifecycle", async () => {
    const { voting } = await networkHelpers.loadFixture(configuredFixture);
    const seen: bigint[] = [await voting.phase()];
    await voting.openElection();
    seen.push(await voting.phase());
    await voting.closeElection();
    seen.push(await voting.phase());
    expect(seen).to.deep.equal([Phase.Setup, Phase.Open, Phase.Closed]);
  });

  it("configuration is rejected after Open", async () => {
    const { voting } = await networkHelpers.loadFixture(openFixture);
    await expect(voting.addConstituency("NEW", "New")).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Open);
    await expect(voting.addCandidate(BLR, "Late Entry")).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Open);
    expect(await voting.constituencyCount()).to.equal(3n);
    expect(await voting.candidateCount()).to.equal(6n);
  });

  it("configuration is rejected after Closed", async () => {
    const { voting } = await networkHelpers.loadFixture(closedFixture);
    await expect(voting.addConstituency("NEW", "New")).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Closed);
    await expect(voting.addCandidate(BLR, "Late Entry")).to.be.revertedWithCustomError(voting, "WrongPhase").withArgs(Phase.Closed);
  });

  it("voting is impossible in Setup", async () => {
    const world = await networkHelpers.loadFixture(configuredFixture);
    // `makeBallot` only needs the world's keys and domain, not the Open phase.
    const ballot = await makeBallot(world as never, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await expect(
      world.voting.connect(world.relayer).castVote(ballot.constituencyId, ballot.nullifier, ballot.candidateId, ballot.deadline, ballot.signature),
    )
      .to.be.revertedWithCustomError(world.voting, "WrongPhase")
      .withArgs(Phase.Setup);
  });

  it("voting is impossible after Closed, even with a perfectly valid authorization", async () => {
    const open = await networkHelpers.loadFixture(openFixture);
    const ballot = await makeBallot(open, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await open.voting.closeElection();

    await expect(
      open.voting.connect(open.relayer).castVote(ballot.constituencyId, ballot.nullifier, ballot.candidateId, ballot.deadline, ballot.signature),
    )
      .to.be.revertedWithCustomError(open.voting, "WrongPhase")
      .withArgs(Phase.Closed);
    expect(await open.voting.totalBallots()).to.equal(0n);
    expect(await open.voting.nullifierUsed(nullifierOf(1))).to.equal(false);
  });
});
