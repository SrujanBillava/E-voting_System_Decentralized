// VoteChainV3: lifecycle, Setup configuration, commitment issuance, and the Semaphore group-admin guarantees. No ZK proofs are generated here.
import { expect } from "chai";
import fs from "node:fs";
import path from "node:path";
import { generateTestKeyPair } from "../../privacy-v3/src/elgamal.js";
import { validatePublicKey } from "../../privacy-v3/src/elgamal.js";
import { FIELD_PRIME as P } from "../../privacy-v3/src/params.js";
import { torsionOrder, torsionSubgroup } from "../../privacy-v3/test/curve.mjs";
import { CLOSE_GRACE, ELECTION_ID, EPOCH, PROJECT, Phase, cid, configure, newWorld, register, votersOf } from "./helpers/world.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const dummyArgs = (code = "KA-BLR") => ({
  constituencyId: cid(code),
  membership: { merkleTreeDepth: 20n, merkleTreeRoot: 1n, nullifier: 1n, points: Array(8).fill(0n) },
  coords: [],
  validity: { a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n] },
});
/** move to the first second of a fresh 30 s epoch so that the next few transactions share it */
async function alignToEpoch(w) {
  const now = await w.networkHelpers.time.latest();
  await w.networkHelpers.time.increaseTo((Math.floor(now / EPOCH) + 2) * EPOCH);
}

describe("VoteChainV3: deployment", () => {
  let w;
  before(async () => {
    w = await newWorld();
  });

  it("starts in Setup with the configured owner, election id, Semaphore, verifier and grace period, and the frozen constants", async () => {
    expect(await w.vc.owner()).to.equal(w.owner.address);
    expect(await w.vc.ELECTION_ID()).to.equal(ELECTION_ID);
    expect(await w.vc.semaphore()).to.equal(await w.semaphore.getAddress());
    expect(await w.vc.validityVerifier()).to.equal(await w.validityVerifier.getAddress());
    expect(await w.vc.CLOSE_GRACE()).to.equal(BigInt(CLOSE_GRACE));
    expect(await w.vc.phase()).to.equal(Phase.Setup);
    expect(await w.vc.issuanceOpen()).to.equal(false);
    expect(await w.vc.totalBallots()).to.equal(0n);
    expect(await w.vc.constituencyCount()).to.equal(0n);
    expect(await w.vc.K_MAX()).to.equal(16n);
    expect(await w.vc.COORD_COUNT()).to.equal(64n);
    expect(await w.vc.SEMAPHORE_DEPTH()).to.equal(20n);
    expect(await w.vc.MAX_REGISTERED_VOTERS()).to.equal(1n << 20n);
    expect(await w.vc.EPOCH_SECONDS()).to.equal(30n);
    expect(await w.vc.ROOT_WINDOW()).to.equal(3600n);
  });

  it("rejects a zero election id, zero addresses and dependencies that are not contracts", async () => {
    const sem = await w.semaphore.getAddress();
    const ver = await w.validityVerifier.getAddress();
    const F = await w.ethers.getContractFactory("VoteChainV3");
    await expect(F.deploy(w.owner.address, w.ethers.ZeroHash, sem, ver, 0n)).to.be.revertedWithCustomError(F, "ZeroId");
    await expect(F.deploy(w.owner.address, ELECTION_ID, ZERO, ver, 0n)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(w.owner.address, ELECTION_ID, sem, ZERO, 0n)).to.be.revertedWithCustomError(F, "ZeroAddress");
    await expect(F.deploy(w.owner.address, ELECTION_ID, w.attacker.address, ver, 0n)).to.be.revertedWithCustomError(F, "NotAContract");
    await expect(F.deploy(w.owner.address, ELECTION_ID, sem, w.attacker.address, 0n)).to.be.revertedWithCustomError(F, "NotAContract");
  });

  it("ownership is two-step and cannot be renounced (the election must stay closable)", async () => {
    await expect(w.vc.renounceOwnership()).to.be.revertedWithCustomError(w.vc, "RenounceDisabled");
    await w.vc.transferOwnership(w.newOwner.address);
    expect(await w.vc.owner()).to.equal(w.owner.address);
    await expect(w.vc.connect(w.attacker).acceptOwnership()).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await w.vc.connect(w.newOwner).acceptOwnership();
    expect(await w.vc.owner()).to.equal(w.newOwner.address);
  });
});

describe("VoteChainV3: Setup configuration", () => {
  let w;
  let id;
  before(async () => {
    w = await newWorld();
  });

  it("only the owner configures, and the issuer cannot be the zero address", async () => {
    await expect(w.vc.connect(w.attacker).setIssuer(w.issuer.address)).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.connect(w.attacker).setElectionKey(1n, 1n)).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.connect(w.attacker).addConstituency("X", "X", 1n)).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.connect(w.attacker).addCandidate(cid("X"), "c")).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.setIssuer(ZERO)).to.be.revertedWithCustomError(w.vc, "ZeroAddress");
    await expect(w.vc.setIssuer(w.issuer.address)).to.emit(w.vc, "IssuerSet").withArgs(ZERO, w.issuer.address);
    expect(await w.vc.issuer()).to.equal(w.issuer.address);
  });

  it("the election key: accepts a real key; refuses the identity, the order-2 point, off-curve and non-canonical values", async () => {
    const { publicKey } = generateTestKeyPair();
    await expect(w.vc.setElectionKey(0n, 1n)).to.be.revertedWithCustomError(w.vc, "ElectionKeyInvalid"); // identity
    await expect(w.vc.setElectionKey(0n, P - 1n)).to.be.revertedWithCustomError(w.vc, "ElectionKeyInvalid"); // order-2 point
    await expect(w.vc.setElectionKey(publicKey[0], publicKey[1] + 1n)).to.be.revertedWithCustomError(w.vc, "ElectionKeyInvalid"); // off the curve
    await expect(w.vc.setElectionKey(P + publicKey[0], publicKey[1])).to.be.revertedWithCustomError(w.vc, "ElectionKeyInvalid"); // not reduced
    await expect(w.vc.setElectionKey(publicKey[0], P + publicKey[1])).to.be.revertedWithCustomError(w.vc, "ElectionKeyInvalid");
    await expect(w.vc.setElectionKey(publicKey[0], publicKey[1])).to.emit(w.vc, "ElectionKeySet").withArgs(publicKey[0], publicKey[1]);
    expect(await w.vc.electionKeySet()).to.equal(true);
    expect(await w.vc.electionKeyX()).to.equal(publicKey[0]);
    expect(await w.vc.electionKeyY()).to.equal(publicKey[1]);
  });

  it("KNOWN, DOCUMENTED LIMIT: an on-curve torsion key (x != 0) is accepted on-chain, because subgroup membership needs a scalar multiplication; the ceremony must reject it off-chain", async () => {
    const torsion = torsionSubgroup().find((t) => t[0] !== 0n && torsionOrder(t) === 8);
    expect(torsion, "an order-8 point with x != 0").to.not.equal(undefined);
    expect(validatePublicKey(torsion)).to.equal(false); // the frozen core's validation (used by the key ceremony) refuses it
    await expect(w.vc.setElectionKey(torsion[0], torsion[1])).to.emit(w.vc, "ElectionKeySet"); // the contract cannot tell
    const { publicKey } = generateTestKeyPair(); // put a real key back
    await w.vc.setElectionKey(publicKey[0], publicKey[1]);
  });

  it("addConstituency creates the Semaphore group with VoteChainV3 as its ONLY admin, fixes the cap and emits the group id", async () => {
    id = cid("KA-BLR");
    await expect(w.vc.addConstituency("KA-BLR", "Bengaluru", 100n)).to.emit(w.vc, "ConstituencyAdded").withArgs(id, "KA-BLR", "Bengaluru", 0n, 100n);
    const c = await w.vc.getConstituency(id);
    expect(c.code).to.equal("KA-BLR");
    expect(c.name).to.equal("Bengaluru");
    expect(c.groupId).to.equal(0n);
    expect(c.registeredVoters).to.equal(100n);
    expect(c.issued).to.equal(0n);
    expect(c.ballots).to.equal(0n);
    expect(c.candidateCount).to.equal(0n);
    expect(await w.semaphore.getGroupAdmin(c.groupId)).to.equal(w.address);
    expect((await w.semaphore.groups(c.groupId)).toString()).to.equal("3600");
    expect(await w.semaphore.getMerkleTreeSize(c.groupId)).to.equal(0n);
    expect(await w.vc.constituencyCount()).to.equal(1n);
    expect(await w.vc.constituencyIdAt(0)).to.equal(id);
  });

  it("each constituency gets its OWN group; duplicates, empty strings and bad caps are refused (the cap cannot exceed what a depth-20 tree holds)", async () => {
    await w.vc.addConstituency("MH-MUM", "Mumbai", 1n << 20n); // exactly the depth-20 capacity is fine
    expect((await w.vc.getConstituency(cid("MH-MUM"))).groupId).to.equal(1n);
    expect(await w.semaphore.groupCounter()).to.equal(2n);
    await expect(w.vc.addConstituency("KA-BLR", "again", 5n)).to.be.revertedWithCustomError(w.vc, "ConstituencyExists").withArgs(id);
    await expect(w.vc.addConstituency("", "n", 5n)).to.be.revertedWithCustomError(w.vc, "EmptyString");
    await expect(w.vc.addConstituency("C", "", 5n)).to.be.revertedWithCustomError(w.vc, "EmptyString");
    await expect(w.vc.addConstituency("ZERO", "n", 0n)).to.be.revertedWithCustomError(w.vc, "BadRegisteredVoters").withArgs(0n);
    await expect(w.vc.addConstituency("HUGE", "n", (1n << 20n) + 1n)).to.be.revertedWithCustomError(w.vc, "BadRegisteredVoters");
    expect(await w.semaphore.groupCounter(), "refused calls created no group").to.equal(2n);
  });

  it("addCandidate assigns slots 0,1,2,... initialises BOTH aggregates to the identity (0,1) - not (0,0) - and stops at 16", async () => {
    await expect(w.vc.addCandidate(id, "Asha")).to.emit(w.vc, "CandidateAdded").withArgs(id, 0n, "Asha");
    expect(await w.vc.addCandidate.staticCall(id, "Bala")).to.equal(1n);
    await w.vc.addCandidate(id, "Bala");
    await w.vc.addCandidate(id, "Chitra");
    expect(await w.vc.candidateName(id, 2)).to.equal("Chitra");
    expect((await w.vc.getConstituency(id)).candidateCount).to.equal(3n);
    for (let slot = 0; slot < 3; slot++) {
      const a = await w.vc.aggregateOf(id, slot);
      expect([a.ax, a.ay, a.bx, a.by]).to.deep.equal([0n, 1n, 0n, 1n]);
    }
    await expect(w.vc.aggregateOf(id, 3)).to.be.revertedWithCustomError(w.vc, "TooManyCandidates");
    await expect(w.vc.addCandidate(cid("XX"), "c")).to.be.revertedWithCustomError(w.vc, "UnknownConstituency");
    await expect(w.vc.addCandidate(id, "")).to.be.revertedWithCustomError(w.vc, "EmptyString");
    for (let j = 3; j < 16; j++) await w.vc.addCandidate(id, `c${j}`);
    await expect(w.vc.addCandidate(id, "seventeenth")).to.be.revertedWithCustomError(w.vc, "TooManyCandidates");
    expect((await w.vc.getConstituency(id)).candidateCount).to.equal(16n);
  });
});

describe("VoteChainV3: opening the election", () => {
  let w;
  before(async () => {
    w = await newWorld();
  });

  it("refuses to open until the issuer, the key, a constituency and a candidate in EVERY constituency exist", async () => {
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "IssuerNotSet");
    await w.vc.setIssuer(w.issuer.address);
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "ElectionKeyNotSet");
    const { publicKey } = generateTestKeyPair();
    await w.vc.setElectionKey(publicKey[0], publicKey[1]);
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "NothingToOpen");
    await w.vc.addConstituency("A-ONE", "One", 10n);
    await w.vc.addConstituency("B-TWO", "Two", 10n);
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "ConstituencyHasNoCandidate").withArgs(2n);
    await w.vc.addCandidate(cid("A-ONE"), "a");
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "ConstituencyHasNoCandidate").withArgs(1n);
    await w.vc.addCandidate(cid("B-TWO"), "b");
    await expect(w.vc.connect(w.attacker).openElection()).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.openElection()).to.emit(w.vc, "ElectionOpened").withArgs(2n, publicKey[0], publicKey[1], w.issuer.address);
    expect(await w.vc.phase()).to.equal(Phase.Open);
    expect(await w.vc.issuanceOpen()).to.equal(true);
  });

  it("once Open, every Setup function is refused and the election cannot be opened again", async () => {
    const { publicKey } = generateTestKeyPair();
    await expect(w.vc.setIssuer(w.attacker.address)).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(Phase.Open);
    await expect(w.vc.setElectionKey(publicKey[0], publicKey[1])).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    await expect(w.vc.addConstituency("C-NEW", "n", 1n)).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    await expect(w.vc.addCandidate(cid("A-ONE"), "late")).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "WrongPhase");
  });
});

describe("VoteChainV3: commitment issuance", () => {
  let w;
  let blr;
  let mum;
  before(async () => {
    w = await newWorld();
    await configure(w, { only: ["KA-BLR", "MH-MUM"] });
    await w.vc.addConstituency("CAP-5", "Cap five", 5n);
    await w.vc.addCandidate(cid("CAP-5"), "only");
    blr = votersOf("KA-BLR");
    mum = votersOf("MH-MUM");
  });

  it("is refused while the election is still in Setup", async () => {
    await expect(w.vc.connect(w.issuer).registerCommitmentBatch(cid("KA-BLR"), [1n])).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(Phase.Setup);
    await w.vc.openElection();
  });

  it("only the issuer may register commitments: neither the owner nor anybody else", async () => {
    for (const who of [w.owner, w.attacker, w.relayer]) {
      await expect(w.vc.connect(who).registerCommitmentBatch(cid("KA-BLR"), [1n])).to.be.revertedWithCustomError(w.vc, "NotIssuer").withArgs(who.address);
    }
  });

  it("registers a batch through the Semaphore group: counts, root, events; the JS group (frozen core) has the SAME root", async () => {
    await alignToEpoch(w);
    const tx = w.vc.connect(w.issuer).registerCommitmentBatch(cid("KA-BLR"), blr.voters.map((v) => v.commitment));
    const root = BigInt(blr.group.root);
    await expect(tx).to.emit(w.vc, "CommitmentBatchRegistered");
    const receipt = await (await tx).wait();
    const epoch = BigInt(Math.floor((await w.networkHelpers.time.latest()) / EPOCH));
    const ev = receipt.logs.map((l) => { try { return w.vc.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "CommitmentBatchRegistered");
    expect(ev.args.constituencyId).to.equal(cid("KA-BLR"));
    expect(ev.args.epoch).to.equal(epoch);
    expect(ev.args.firstIndex).to.equal(0n);
    expect(ev.args.count).to.equal(5n);
    expect(ev.args.issuedTotal).to.equal(5n);
    expect(ev.args.merkleTreeRoot).to.equal(root);
    const groupId = (await w.vc.getConstituency(cid("KA-BLR"))).groupId;
    expect(await w.semaphore.getMerkleTreeSize(groupId)).to.equal(5n);
    expect(await w.semaphore.getMerkleTreeRoot(groupId)).to.equal(root);
    expect(await w.semaphore.getMerkleTreeDepth(groupId)).to.equal(3n);
    for (const v of blr.voters) {
      expect(await w.vc.commitmentRegistered(v.commitment)).to.equal(true);
      expect(await w.semaphore.hasMember(groupId, v.commitment)).to.equal(true);
    }
    expect((await w.vc.getConstituency(cid("KA-BLR"))).issued).to.equal(5n);
    // Semaphore itself emitted MembersAdded (clients rebuild the tree from it)
    const sem = receipt.logs.map((l) => { try { return w.semaphore.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "MembersAdded");
    expect(sem.args.groupId).to.equal(groupId);
    expect(sem.args.merkleTreeRoot).to.equal(root);
    // ...and VoteChainV3's own event carries NO commitments
    expect(ev.fragment.inputs.map((i) => i.name)).to.not.include.members(["commitments", "commitment"]);
  });

  it("is election-wide unique: the same commitment twice in a batch, again later, or in ANOTHER constituency is refused", async () => {
    const [fresh1, fresh2] = votersOf("MH-MUM", 2).voters.map((v) => v.commitment);
    await expect(w.vc.connect(w.issuer).registerCommitmentBatch(cid("MH-MUM"), [fresh1, fresh2, fresh1])).to.be.revertedWithCustomError(w.vc, "DuplicateCommitment").withArgs(fresh1);
    await expect(w.vc.connect(w.issuer).registerCommitmentBatch(cid("MH-MUM"), [blr.voters[0].commitment])).to.be.revertedWithCustomError(w.vc, "DuplicateCommitment").withArgs(blr.voters[0].commitment); // registered in Bengaluru
    await w.networkHelpers.time.increase(EPOCH);
    await expect(w.vc.connect(w.issuer).registerCommitmentBatch(cid("KA-BLR"), [blr.voters[2].commitment])).to.be.revertedWithCustomError(w.vc, "DuplicateCommitment"); // again, same constituency
    expect(await w.vc.commitmentRegistered(fresh1), "a failed batch registers nothing").to.equal(false);
  });

  it("refuses an empty batch, an oversized batch, an unknown constituency and invalid commitments (0, p, above p)", async () => {
    await w.networkHelpers.time.increase(EPOCH);
    const I = w.vc.connect(w.issuer);
    await expect(I.registerCommitmentBatch(cid("MH-MUM"), [])).to.be.revertedWithCustomError(w.vc, "EmptyBatch");
    await expect(I.registerCommitmentBatch(cid("MH-MUM"), Array.from({ length: 129 }, (_, i) => BigInt(i + 1)))).to.be.revertedWithCustomError(w.vc, "BatchTooLarge").withArgs(129n);
    await expect(I.registerCommitmentBatch(cid("XX-NONE"), [1n])).to.be.revertedWithCustomError(w.vc, "UnknownConstituency");
    await expect(I.registerCommitmentBatch(cid("MH-MUM"), [5n, 0n])).to.be.revertedWithCustomError(w.vc, "InvalidCommitment").withArgs(1n);
    await expect(I.registerCommitmentBatch(cid("MH-MUM"), [P])).to.be.revertedWithCustomError(w.vc, "InvalidCommitment").withArgs(0n);
    await expect(I.registerCommitmentBatch(cid("MH-MUM"), [7n, P + 1n])).to.be.revertedWithCustomError(w.vc, "InvalidCommitment").withArgs(1n);
  });

  it("at most ONE batch per constituency per 30 s epoch; the next epoch is fine; other constituencies are independent", async () => {
    await alignToEpoch(w);
    const I = w.vc.connect(w.issuer);
    await I.registerCommitmentBatch(cid("MH-MUM"), [mum.voters[0].commitment]);
    await expect(I.registerCommitmentBatch(cid("MH-MUM"), [mum.voters[1].commitment])).to.be.revertedWithCustomError(w.vc, "BatchAlreadyThisEpoch");
    await expect(I.registerCommitmentBatch(cid("CAP-5"), [votersOf("CAP-5", 6).voters[0].commitment]), "another constituency in the same epoch").to.emit(w.vc, "CommitmentBatchRegistered");
    await w.networkHelpers.time.increase(EPOCH);
    await expect(I.registerCommitmentBatch(cid("MH-MUM"), mum.voters.slice(1).map((v) => v.commitment))).to.emit(w.vc, "CommitmentBatchRegistered");
    const mumGroup = (await w.vc.getConstituency(cid("MH-MUM"))).groupId;
    expect(await w.semaphore.getMerkleTreeSize(mumGroup)).to.equal(5n);
    expect(await w.semaphore.getMerkleTreeRoot(mumGroup), "two batches build the same tree as one").to.equal(BigInt(mum.group.root));
  });

  it("can never exceed the constituency's registered-voter cap", async () => {
    const capVoters = votersOf("CAP-5", 6).voters.map((v) => v.commitment); // [0] is already registered (previous test); the cap is 5
    await w.networkHelpers.time.increase(EPOCH);
    const I = w.vc.connect(w.issuer);
    await expect(I.registerCommitmentBatch(cid("CAP-5"), capVoters.slice(1, 6))).to.be.revertedWithCustomError(w.vc, "IssuedCapExceeded").withArgs(6n, 5n);
    expect((await w.vc.getConstituency(cid("CAP-5"))).issued, "the refused batch changed nothing").to.equal(1n);
    await I.registerCommitmentBatch(cid("CAP-5"), capVoters.slice(1, 5));
    expect((await w.vc.getConstituency(cid("CAP-5"))).issued).to.equal(5n);
    await w.networkHelpers.time.increase(EPOCH);
    await expect(I.registerCommitmentBatch(cid("CAP-5"), [capVoters[5]])).to.be.revertedWithCustomError(w.vc, "IssuedCapExceeded").withArgs(6n, 5n);
  });
});

describe("VoteChainV3: closing", () => {
  let w;
  before(async () => {
    w = await newWorld();
    await configure(w, { only: ["KA-BLR"] });
    await w.vc.openElection();
  });

  it("closeElection needs issuance closed first and then the grace period; only the owner may close", async () => {
    await expect(w.vc.closeElection()).to.be.revertedWithCustomError(w.vc, "IssuanceStillOpen");
    await expect(w.vc.connect(w.attacker).closeIssuance()).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.closeIssuance()).to.emit(w.vc, "IssuanceClosed");
    expect(await w.vc.issuanceOpen()).to.equal(false);
    expect(await w.vc.phase(), "ballots stay possible during the grace period").to.equal(Phase.Open);
    await expect(w.vc.closeIssuance()).to.be.revertedWithCustomError(w.vc, "IssuanceNotOpen");
    await expect(w.vc.closeElection()).to.be.revertedWithCustomError(w.vc, "GraceNotElapsed");
    await w.networkHelpers.time.increase(CLOSE_GRACE - 60);
    await expect(w.vc.closeElection()).to.be.revertedWithCustomError(w.vc, "GraceNotElapsed");
    await w.networkHelpers.time.increase(120);
    await expect(w.vc.connect(w.attacker).closeElection()).to.be.revertedWithCustomError(w.vc, "OwnableUnauthorizedAccount");
    await expect(w.vc.closeElection()).to.emit(w.vc, "ElectionClosed").withArgs(0n);
    expect(await w.vc.phase()).to.equal(Phase.Closed);
  });

  it("issuance is refused once closeIssuance has been called, and after Close", async () => {
    await expect(w.vc.connect(w.issuer).registerCommitmentBatch(cid("KA-BLR"), [1n])).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(Phase.Closed);
  });

  it("after Close nothing moves: no ballot, no reopen, no second close, no Setup change", async () => {
    const a = dummyArgs();
    await expect(w.vc.submitBallot(a.constituencyId, a.membership, a.coords, a.validity)).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(Phase.Closed);
    await expect(w.vc.openElection()).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    await expect(w.vc.closeElection()).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    await expect(w.vc.closeIssuance()).to.be.revertedWithCustomError(w.vc, "WrongPhase");
    await expect(w.vc.addConstituency("LATE", "late", 1n)).to.be.revertedWithCustomError(w.vc, "WrongPhase");
  });

  it("a ballot in Setup is refused with WrongPhase before anything else is looked at", async () => {
    const fresh = await newWorld();
    const a = dummyArgs();
    await expect(fresh.vc.submitBallot(a.constituencyId, a.membership, a.coords, a.validity)).to.be.revertedWithCustomError(fresh.vc, "WrongPhase").withArgs(Phase.Setup);
  });

  it("with no grace period configured the election can be closed straight after closeIssuance", async () => {
    const fast = await newWorld({ closeGrace: 0 });
    await configure(fast, { only: ["KA-BLR"] });
    await fast.vc.openElection();
    await fast.vc.closeIssuance();
    await expect(fast.vc.closeElection()).to.emit(fast.vc, "ElectionClosed");
  });
});

describe("VoteChainV3 + Semaphore: VoteChainV3 is the ONLY group admin", () => {
  let w;
  before(async () => {
    w = await newWorld();
    await configure(w, { only: ["KA-BLR", "MH-MUM"] });
    await w.vc.openElection();
    await register(w, "KA-BLR", votersOf("KA-BLR").voters);
  });

  it("every constituency group is administered by the contract, not by the owner, the issuer or the deployer of Semaphore", async () => {
    for (const code of ["KA-BLR", "MH-MUM"]) {
      const groupId = (await w.vc.getConstituency(cid(code))).groupId;
      expect(await w.semaphore.getGroupAdmin(groupId)).to.equal(w.address);
    }
  });

  it("nobody else can add, update or remove members, change the admin or change the root window (Semaphore reverts for every account, owner and issuer included)", async () => {
    const groupId = (await w.vc.getConstituency(cid("KA-BLR"))).groupId;
    const voters = votersOf("KA-BLR").voters;
    for (const who of [w.owner, w.issuer, w.attacker, w.depDeployer]) {
      const S = w.semaphore.connect(who);
      const denied = (p) => expect(p, who.address).to.be.revertedWithCustomError(w.semaphore, "Semaphore__CallerIsNotTheGroupAdmin");
      await denied(S.addMember(groupId, 123456789n));
      await denied(S.addMembers(groupId, [123456789n]));
      await denied(S.updateMember(groupId, voters[0].commitment, 987654321n, []));
      await denied(S.removeMember(groupId, voters[0].commitment, []));
      await denied(S.updateGroupAdmin(groupId, who.address));
      await denied(S.updateGroupMerkleTreeDuration(groupId, 1n));
    }
    expect(await w.semaphore.getMerkleTreeSize(groupId)).to.equal(5n);
  });

  it("VoteChainV3 exposes NO generic Semaphore administration: its ABI has none of updateGroupAdmin, removeMember, updateMember, addMember(s), acceptGroupAdmin, updateGroupMerkleTreeDuration, validateProof", () => {
    const names = new Set(w.vc.interface.fragments.filter((f) => f.type === "function").map((f) => f.name));
    for (const forbidden of ["updateGroupAdmin", "acceptGroupAdmin", "removeMember", "updateMember", "addMember", "addMembers", "updateGroupMerkleTreeDuration", "validateProof", "createGroup"]) {
      expect(names.has(forbidden), forbidden).to.equal(false);
    }
    expect(names.has("registerCommitmentBatch")).to.equal(true);
  });

  it("the contract source never calls validateProof (only the official verifyProof path) and never calls the admin functions", () => {
    const source = fs.readFileSync(path.join(PROJECT, "contracts", "VoteChainV3.sol"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source).to.not.match(/validateProof|updateGroupAdmin|removeMember|updateMember|acceptGroupAdmin|updateGroupMerkleTreeDuration|\.addMember\(/);
    expect(source).to.match(/semaphore\.verifyProof\(/);
    expect(source).to.match(/semaphore\.addMembers\(/);
    expect(source).to.match(/semaphore\.createGroup\(address\(this\), ROOT_WINDOW\)/);
  });
});

describe("VoteChainV3: what this phase does NOT contain", () => {
  const strip = (file) => fs.readFileSync(path.join(PROJECT, "contracts", file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("there is no decryption, tally-publication or final-result entry point in the ABI, and no state that could hold a result", async () => {
    const w = await newWorld();
    const names = w.vc.interface.fragments.filter((f) => f.type === "function" || f.type === "event").map((f) => f.name.toLowerCase());
    for (const name of names) expect(name, name).to.not.match(/decrypt|result|tally|finali[sz]|reveal|publish|winner|trustee|share/);
    // what an auditor can read: ciphertext aggregates and counts, nothing decrypted
    for (const read of ["aggregateOf", "totalBallots", "getConstituency", "nullifierUsed", "commitmentRegistered"]) expect(names).to.include(read.toLowerCase());
  });

  it("the encrypted aggregate is built by point ADDITION only: no BabyJubJub scalar multiplication exists on-chain, and the only precompile the contract layer calls is MODEXP", () => {
    for (const file of ["VoteChainV3.sol", "libraries/BabyJubJub.sol", "libraries/V3Encodings.sol"]) {
      const source = strip(file);
      expect(source, `${file}: no scalar multiplication`).to.not.match(/\bmul(Point|Scalar|Escalar)|scalarMul|\bec(Mul|Add|Pairing)\b/i);
      const precompiles = [...source.matchAll(/staticcall\(\s*gas\(\)\s*,\s*(0x[0-9a-fA-F]+|\d+)/g)].map((m) => Number(m[1]));
      for (const address of precompiles) expect(address, `${file}: only the MODEXP precompile (0x05)`).to.equal(5);
    }
    const library = strip("libraries/BabyJubJub.sol");
    expect(library).to.match(/function add\(/);
    expect(library.match(/function (\w+)\(/g).map((s) => s.slice(9, -1)).sort()).to.deep.equal(["_inverse", "add", "isIdentity", "isOnCurve"]);
  });
});
