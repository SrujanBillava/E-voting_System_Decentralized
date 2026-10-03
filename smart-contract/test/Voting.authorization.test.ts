import { expect } from "chai";
import { network } from "hardhat";
import { castBallot, makeBallot, openFixture, vote, type Ballot, type World } from "./helpers/fixtures.js";
import {
  BLR,
  CONSTITUENCIES,
  DEL,
  ELECTION_ID,
  MUM,
  TYPES,
  cid,
  ethers,
  futureDeadline,
  networkHelpers,
  nullifierOf,
} from "./helpers/setup.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Nothing about this nullifier changed: no ballot recorded for it, no accounting moved. */
async function expectNoBallot(world: World, nullifier: string, totalBefore = 0n) {
  expect(await world.voting.nullifierUsed(nullifier), "nullifier consumed").to.equal(false);
  expect(await world.voting.ballotIndexOf(nullifier)).to.equal(0n);
  expect(await world.voting.totalBallots()).to.equal(totalBefore);
}

describe("Voting V2: castVote happy path", () => {
  it("a valid authority-signed authorization submitted by the relayer is counted", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const { voting, relayer } = world;
    const n = nullifierOf(1);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: n, candidateId: 2n });

    await expect(castBallot(world, ballot)).to.emit(voting, "BallotCast").withArgs(n, BLR, 2n, 1n);

    expect(await voting.votesOf(2)).to.equal(1n);
    expect(await voting.votesOf(1)).to.equal(0n);
    expect(await voting.votesOf(3)).to.equal(0n);
    expect(await voting.constituencyTotal(BLR)).to.equal(1n);
    expect(await voting.constituencyTotal(DEL)).to.equal(0n);
    expect(await voting.totalBallots()).to.equal(1n);
    expect(await voting.nullifierUsed(n)).to.equal(true);
    expect(await voting.ballotIndexOf(n)).to.equal(1n);
    void relayer;
  });

  it("ballot indexes are 1-based and increase by one per ballot", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    for (let i = 1; i <= 5; i++) {
      await expect(vote(world, { constituencyId: BLR, nullifier: nullifierOf(i), candidateId: 1n }))
        .to.emit(world.voting, "BallotCast")
        .withArgs(nullifierOf(i), BLR, 1n, BigInt(i));
      expect(await world.voting.ballotIndexOf(nullifierOf(i))).to.equal(BigInt(i));
    }
    expect(await world.voting.totalBallots()).to.equal(5n);
  });

  it("BallotCast is filterable by each of its three indexed topics (receipt / audit / recovery)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const { voting } = world;
    await vote(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await vote(world, { constituencyId: DEL, nullifier: nullifierOf(2), candidateId: 4n });
    await vote(world, { constituencyId: BLR, nullifier: nullifierOf(3), candidateId: 2n });

    const byNullifier = await voting.queryFilter(voting.filters.BallotCast(nullifierOf(2)));
    expect(byNullifier).to.have.length(1);
    expect(byNullifier[0].args.candidateId).to.equal(4n);
    expect(byNullifier[0].args.ballotIndex).to.equal(2n);

    const byConstituency = await voting.queryFilter(voting.filters.BallotCast(undefined, BLR));
    expect(byConstituency.map((e) => e.args.nullifier)).to.deep.equal([nullifierOf(1), nullifierOf(3)]);

    const byCandidate = await voting.queryFilter(voting.filters.BallotCast(undefined, undefined, 2n));
    expect(byCandidate.map((e) => e.args.nullifier)).to.deep.equal([nullifierOf(3)]);
  });

  it("the on-chain digest equals the ethers EIP-712 digest for the same message", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const deadline = await futureDeadline();
    const message = {
      electionId: ELECTION_ID,
      constituencyId: BLR,
      nullifier: nullifierOf(1),
      candidateId: 3n,
      relayer: world.relayer.address,
      deadline,
    };
    const expected = ethers.TypedDataEncoder.hash(world.domain, TYPES, message);
    expect(await world.voting.hashAuthorization(BLR, nullifierOf(1), 3n, world.relayer.address, deadline)).to.equal(expected);
  });

  it("hashAuthorization hashes the relayer it is given, not the configured one, and every argument matters", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const deadline = await futureDeadline();
    const base = { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 3n, relayer: world.relayer2.address, deadline };
    const onChain = (m: typeof base) =>
      world.voting.hashAuthorization(m.constituencyId, m.nullifier, m.candidateId, m.relayer, m.deadline);

    const message = { electionId: ELECTION_ID, ...base };
    expect(await onChain(base)).to.equal(ethers.TypedDataEncoder.hash(world.domain, TYPES, message));
    // relayer2 is NOT the configured relayer, so a mutant that substitutes it would differ
    expect(await onChain(base)).to.not.equal(await onChain({ ...base, relayer: world.relayer.address }));

    const variants = [
      { ...base, constituencyId: DEL },
      { ...base, nullifier: nullifierOf(2) },
      { ...base, candidateId: 4n },
      { ...base, deadline: deadline + 1n },
    ];
    const seen = new Set<string>([await onChain(base)]);
    for (const v of variants) seen.add(await onChain(v));
    expect(seen.size, "every argument changes the digest").to.equal(variants.length + 1);
  });

  it("accepts a deadline exactly equal to the block timestamp, rejects one second later", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const t = BigInt(await networkHelpers.time.latest()) + 100n;

    const onTime = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n, deadline: t });
    await networkHelpers.time.setNextBlockTimestamp(t);
    await expect(castBallot(world, onTime)).to.emit(world.voting, "BallotCast");

    const late = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(2), candidateId: 1n, deadline: t });
    await networkHelpers.time.setNextBlockTimestamp(t + 1n);
    await expect(castBallot(world, late))
      .to.be.revertedWithCustomError(world.voting, "AuthorizationExpired")
      .withArgs(t, t + 1n);
    await expectNoBallot(world, nullifierOf(2), 1n);
  });
});

describe("Voting V2: caller and basic validation", () => {
  it("only the configured relayer may call castVote", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });

    for (const caller of [world.attacker, world.owner, world.authority, world.other]) {
      await expect(castBallot(world, ballot, caller))
        .to.be.revertedWithCustomError(world.voting, "NotRelayer")
        .withArgs(caller.address);
    }
    await expectNoBallot(world, nullifierOf(1));
  });

  it("a non-relayer cannot cast even if the authority signed an authorization FOR that account", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const ballot = await makeBallot(world, {
      constituencyId: BLR,
      nullifier: nullifierOf(1),
      candidateId: 1n,
      signedRelayer: world.attacker.address,
    });
    await expect(castBallot(world, ballot, world.attacker))
      .to.be.revertedWithCustomError(world.voting, "NotRelayer")
      .withArgs(world.attacker.address);
  });

  it("rejects a zero nullifier even with a valid signature", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: ethers.ZeroHash, candidateId: 1n });
    await expect(castBallot(world, ballot)).to.be.revertedWithCustomError(world.voting, "ZeroId");
    expect(await world.voting.totalBallots()).to.equal(0n);
    expect(await world.voting.nullifierUsed(ethers.ZeroHash)).to.equal(false);
  });

  it("rejects candidate ids 0 and above candidateCount even when the authority signed them", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    for (const bad of [0n, 7n, 1000n, ethers.MaxUint256]) {
      const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: bad });
      await expect(castBallot(world, ballot))
        .to.be.revertedWithCustomError(world.voting, "InvalidCandidate")
        .withArgs(bad);
    }
    await expectNoBallot(world, nullifierOf(1));
  });

  it("rejects a candidate that belongs to another constituency even when the authority signed it", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    // candidate 4 is a Delhi candidate; the authorization claims Bengaluru
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 4n });
    await expect(castBallot(world, ballot))
      .to.be.revertedWithCustomError(world.voting, "CandidateConstituencyMismatch")
      .withArgs(4n, BLR);
    await expectNoBallot(world, nullifierOf(1));
  });

  it("rejects an unknown constituency id (no candidate can belong to it)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    for (const bogus of [cid("NOPE"), ethers.ZeroHash]) {
      const ballot = await makeBallot(world, { constituencyId: bogus, nullifier: nullifierOf(1), candidateId: 1n });
      await expect(castBallot(world, ballot)).to.be.revertedWithCustomError(world.voting, "CandidateConstituencyMismatch");
    }
    await expectNoBallot(world, nullifierOf(1));
  });
});

describe("Voting V2: signature binding (every signed field is load-bearing)", () => {
  let world: World;
  beforeEach(async () => {
    world = await networkHelpers.loadFixture(openFixture);
  });

  async function expectBadSignature(ballot: Ballot, caller?: { address: string }) {
    await expect(castBallot(world, ballot, caller)).to.be.revertedWithCustomError(world.voting, "InvalidAuthorizationSignature");
    await expectNoBallot(world, ballot.nullifier);
  }

  it("rejects a signature from the wrong authority", async () => {
    await expectBadSignature(
      await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n, signer: world.attacker as never }),
    );
  });

  it("rejects an authorization signed for a different relayer address", async () => {
    await expectBadSignature(
      await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n, signedRelayer: world.relayer2.address }),
    );
  });

  it("rejects when the candidate is swapped after signing (same constituency)", async () => {
    const signedForCandidate1 = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    // a compromised relayer substitutes candidate 2 in the same constituency
    await expectBadSignature({ ...signedForCandidate1, candidateId: 2n });
    // ...but the genuine call still works
    await expect(castBallot(world, signedForCandidate1)).to.emit(world.voting, "BallotCast");
    expect(await world.voting.votesOf(1)).to.equal(1n);
    expect(await world.voting.votesOf(2)).to.equal(0n);
  });

  it("rejects when the constituency is swapped after signing", async () => {
    // authority signed (BLR, candidate 4); relayer submits (DEL, candidate 4), which is
    // internally consistent but was never authorized
    const signed = await makeBallot(world, {
      constituencyId: DEL,
      nullifier: nullifierOf(1),
      candidateId: 4n,
      signedOverrides: { constituencyId: BLR },
    });
    await expectBadSignature(signed);
  });

  it("rejects when the nullifier is swapped after signing, and consumes neither", async () => {
    const signed = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await expectBadSignature({ ...signed, nullifier: nullifierOf(2) });
    await expectNoBallot(world, nullifierOf(1));
  });

  it("rejects when the deadline is extended after signing", async () => {
    const signed = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await expectBadSignature({ ...signed, deadline: signed.deadline + 100_000n });
  });

  it("rejects an authorization signed for a different election id", async () => {
    await expectBadSignature(
      await makeBallot(world, {
        constituencyId: BLR,
        nullifier: nullifierOf(1),
        candidateId: 1n,
        signedOverrides: { electionId: ethers.id("SOME-OTHER-ELECTION") },
      }),
    );
  });

  it("rejects a wrong EIP-712 domain: chain id, contract, name and version", async () => {
    const base = { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n };
    const variants = [
      { ...world.domain, chainId: BigInt(world.domain.chainId) + 1n },
      { ...world.domain, verifyingContract: world.attacker.address },
      { ...world.domain, name: "VoteChain-V1" },
      { ...world.domain, version: "1" },
    ];
    for (const domain of variants) {
      await expectBadSignature(await makeBallot(world, { ...base, domain }));
    }
  });

  it("rejects malformed signatures of every shape", async () => {
    const good = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    const sig = ethers.Signature.from(good.signature);

    // ethers refuses to serialise a non-canonical (high-s) signature, so build the bytes by hand:
    // (r, N - s, flipped v) is the classic malleable twin of a valid signature.
    const highS = ethers.concat([
      sig.r,
      ethers.toBeHex(SECP256K1_N - BigInt(sig.s), 32),
      sig.v === 27 ? "0x1c" : "0x1b",
    ]);

    const flippedV = good.signature.slice(0, -2) + (sig.v === 27 ? "1c" : "1b"); // other recovery id

    const shapes: Record<string, string> = {
      "empty bytes": "0x",
      "one byte": "0x01",
      "all-zero 65 bytes": "0x" + "00".repeat(65),
      "EIP-2098 64-byte compact form of the valid signature": sig.compactSerialized,
      "truncated by one byte": ethers.dataSlice(good.signature, 0, 64),
      "truncated to 32 bytes": ethers.dataSlice(good.signature, 0, 32),
      "66 bytes (valid + trailing byte)": good.signature + "00",
      "invalid v value": good.signature.slice(0, -2) + "00",
      "wrong recovery id": flippedV,
      "high-s malleated twin": highS,
      "random 65 bytes": ethers.hexlify(ethers.randomBytes(65)),
    };

    for (const [label, signature] of Object.entries(shapes)) {
      await expect(castBallot(world, { ...good, signature }), label).to.be.revertedWithCustomError(
        world.voting,
        "InvalidAuthorizationSignature",
      );
    }
    await expectNoBallot(world, nullifierOf(1));

    // the unmodified signature still works afterwards (nothing was consumed)
    await expect(castBallot(world, good)).to.emit(world.voting, "BallotCast");
  });

  it("rejects an expired authorization and reports the deadline and current time", async () => {
    const past = BigInt(await networkHelpers.time.latest()) - 10n;
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n, deadline: past });
    await expect(castBallot(world, ballot)).to.be.revertedWithCustomError(world.voting, "AuthorizationExpired");
    await expectNoBallot(world, nullifierOf(1));
  });
});

describe("Voting V2: nullifier semantics", () => {
  it("the same nullifier can never count twice", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });

    await castBallot(world, ballot);
    await expect(castBallot(world, ballot)).to.be.revertedWithCustomError(world.voting, "NullifierAlreadyUsed").withArgs(n);

    expect(await world.voting.totalBallots()).to.equal(1n);
    expect(await world.voting.votesOf(1)).to.equal(1n);
  });

  it("the same nullifier cannot vote for a different candidate", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    await vote(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });

    await expect(vote(world, { constituencyId: BLR, nullifier: n, candidateId: 2n }))
      .to.be.revertedWithCustomError(world.voting, "NullifierAlreadyUsed")
      .withArgs(n);
    expect(await world.voting.votesOf(2)).to.equal(0n);
  });

  it("the same nullifier cannot vote in a different constituency", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    await vote(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });

    await expect(vote(world, { constituencyId: DEL, nullifier: n, candidateId: 4n }))
      .to.be.revertedWithCustomError(world.voting, "NullifierAlreadyUsed");
    expect(await world.voting.constituencyTotal(DEL)).to.equal(0n);
  });

  it("a fresh, valid, unexpired authorization for a used nullifier is still rejected", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    await vote(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });

    // brand-new signature, brand-new deadline, same nullifier
    await networkHelpers.time.increase(500);
    const fresh = await makeBallot(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });
    await expect(castBallot(world, fresh)).to.be.revertedWithCustomError(world.voting, "NullifierAlreadyUsed");
    expect(await world.voting.totalBallots()).to.equal(1n);
  });

  it("retry after the authorization expired reports NullifierAlreadyUsed, not AuthorizationExpired", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });
    await castBallot(world, ballot);

    await networkHelpers.time.increaseTo(ballot.deadline + 1000n);

    await expect(castBallot(world, ballot)).to.be.revertedWithCustomError(world.voting, "NullifierAlreadyUsed").withArgs(n);
  });

  it("an expired authorization for an UNUSED nullifier reports AuthorizationExpired (so the backend can tell them apart)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });
    await networkHelpers.time.increaseTo(ballot.deadline + 1000n);

    await expect(castBallot(world, ballot)).to.be.revertedWithCustomError(world.voting, "AuthorizationExpired");
    await expectNoBallot(world, nullifierOf(1));
  });

  it("nullifier reuse is reported before an invalid candidate or a bad signature", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    await vote(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });

    const junk = ethers.hexlify(ethers.randomBytes(65));
    await expect(
      world.voting.connect(world.relayer).castVote(BLR, n, 999n, 1n, junk), // bad candidate, expired, junk sig
    )
      .to.be.revertedWithCustomError(world.voting, "NullifierAlreadyUsed")
      .withArgs(n);
  });

  it("check order: phase, then relayer, then nullifier reuse", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    await vote(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });
    const reuse = await makeBallot(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });

    // wrong caller + used nullifier -> NotRelayer wins
    await expect(castBallot(world, reuse, world.attacker)).to.be.revertedWithCustomError(world.voting, "NotRelayer");

    // closed + used nullifier -> WrongPhase wins
    await world.voting.closeElection();
    await expect(castBallot(world, reuse)).to.be.revertedWithCustomError(world.voting, "WrongPhase");
  });

  it("a failed castVote never consumes the nullifier; the same nullifier still works afterwards", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const n = nullifierOf(1);
    const good = await makeBallot(world, { constituencyId: BLR, nullifier: n, candidateId: 1n });

    // several different failures on the same nullifier
    await expect(castBallot(world, { ...good, candidateId: 2n })).to.be.revert(ethers); // tampered candidate
    await expect(castBallot(world, { ...good, signature: ethers.hexlify(ethers.randomBytes(65)) })).to.be.revert(ethers);
    await expect(castBallot(world, good, world.attacker)).to.be.revert(ethers); // wrong caller
    await expect(castBallot(world, { ...good, candidateId: 4n })).to.be.revert(ethers); // wrong constituency
    await expectNoBallot(world, n);

    await expect(castBallot(world, good)).to.emit(world.voting, "BallotCast").withArgs(n, BLR, 1n, 1n);
  });
});

describe("Voting V2: replay protection", () => {
  it("a signature cannot be replayed on another Voting deployment (same keys, same election id)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);

    // identical configuration; the ONLY difference is the contract address
    const twin = await ethers.deployContract("Voting", [world.owner.address, ELECTION_ID, world.authority.address, world.relayer.address]);
    await twin.addConstituency(CONSTITUENCIES.BLR.code, CONSTITUENCIES.BLR.name);
    await twin.addCandidate(BLR, "Twin Candidate");
    await twin.openElection();
    expect(await twin.getAddress()).to.not.equal(await world.voting.getAddress());

    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });

    await expect(
      twin.connect(world.relayer).castVote(ballot.constituencyId, ballot.nullifier, ballot.candidateId, ballot.deadline, ballot.signature),
    ).to.be.revertedWithCustomError(twin, "InvalidAuthorizationSignature");
    expect(await twin.totalBallots()).to.equal(0n);

    // control: the original contract accepts it
    await expect(castBallot(world, ballot)).to.emit(world.voting, "BallotCast");
  });

  it("a signature cannot be replayed under a different relayer", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const ballot = await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n });

    // The owner rotates to a new relayer. The old relayer's authorization must not work for it.
    await world.voting.setRelayer(world.relayer2.address);
    await expect(castBallot(world, ballot, world.relayer2)).to.be.revertedWithCustomError(world.voting, "InvalidAuthorizationSignature");
    await expect(castBallot(world, ballot, world.relayer)).to.be.revertedWithCustomError(world.voting, "NotRelayer");
    await expectNoBallot(world, nullifierOf(1));
  });

  it("a signature cannot be replayed on a different CHAIN, even at the same contract address", async () => {
    // Two independent in-process chains. Same deployer, same nonce, same bytecode ->
    // the same contract address. Only chainId differs.
    async function chain(chainId: number) {
      const conn = await network.create({ network: "hardhatMainnet", override: { chainId } });
      const [owner, authority, relayer] = await conn.ethers.getSigners();
      const c = await conn.ethers.deployContract("Voting", [owner.address, ELECTION_ID, authority.address, relayer.address]);
      await c.addConstituency(CONSTITUENCIES.BLR.code, CONSTITUENCIES.BLR.name);
      await c.addCandidate(BLR, "Chain Candidate");
      await c.openElection();
      const net = await conn.ethers.provider.getNetwork();
      return { conn, c, authority, relayer, chainId: net.chainId, address: await c.getAddress() };
    }

    const a = await chain(31337);
    const b = await chain(1337);

    expect(a.chainId).to.equal(31337n);
    expect(b.chainId).to.equal(1337n);
    expect(a.address, "same contract address on both chains").to.equal(b.address);

    const deadline = BigInt(await a.conn.networkHelpers.time.latest()) + 3600n;
    const message = {
      electionId: ELECTION_ID,
      constituencyId: BLR,
      nullifier: nullifierOf(1),
      candidateId: 1n,
      relayer: a.relayer.address,
      deadline,
    };
    const sigForA = await a.authority.signTypedData(
      { name: "VoteChain", version: "2", chainId: a.chainId, verifyingContract: a.address },
      TYPES,
      message,
    );

    // replay on chain B: rejected
    await expect(
      b.c.connect(b.relayer).castVote(BLR, nullifierOf(1), 1n, deadline, sigForA),
    ).to.be.revertedWithCustomError(b.c, "InvalidAuthorizationSignature");
    expect(await b.c.totalBallots()).to.equal(0n);

    // control: the same signature is valid on its own chain
    await expect(a.c.connect(a.relayer).castVote(BLR, nullifierOf(1), 1n, deadline, sigForA)).to.emit(a.c, "BallotCast");
    expect(await a.c.totalBallots()).to.equal(1n);

    // and chain B needs its own signature
    const sigForB = await b.authority.signTypedData(
      { name: "VoteChain", version: "2", chainId: b.chainId, verifyingContract: b.address },
      TYPES,
      message,
    );
    await expect(b.c.connect(b.relayer).castVote(BLR, nullifierOf(1), 1n, deadline, sigForB)).to.emit(b.c, "BallotCast");
  });

  it("MUM single-candidate constituency works end to end (smallest legal ballot)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    await expect(vote(world, { constituencyId: MUM, nullifier: nullifierOf(1), candidateId: 6n }))
      .to.emit(world.voting, "BallotCast")
      .withArgs(nullifierOf(1), MUM, 6n, 1n);
  });
});
