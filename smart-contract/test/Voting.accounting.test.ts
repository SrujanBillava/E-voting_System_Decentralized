import { expect } from "chai";
import {
  castBallot,
  makeBallot,
  openFixture,
  vote,
  type World,
} from "./helpers/fixtures.js";
import { BLR, DEL, MUM, ethers, networkHelpers, nullifierOf } from "./helpers/setup.js";

const CONSTITUENCY_OF: Record<string, string> = { "1": BLR, "2": BLR, "3": BLR, "4": DEL, "5": DEL, "6": MUM };
const CANDIDATE_IDS = [1n, 2n, 3n, 4n, 5n, 6n];
const CONSTITUENCIES = [BLR, DEL, MUM];

/** Everything an invariant could depend on, read from the chain. */
async function snapshotAccounting(world: World) {
  const { voting } = world;
  return {
    total: await voting.totalBallots(),
    votes: await Promise.all(CANDIDATE_IDS.map((id) => voting.votesOf(id))),
    totals: await Promise.all(CONSTITUENCIES.map((c) => voting.constituencyTotal(c))),
    phase: await voting.phase(),
  };
}

/** Everything that must never change after Open. */
async function snapshotConfiguration(world: World) {
  const { voting } = world;
  const ids = await voting.getConstituencyIds(0, 100);
  const constituencies = [];
  for (const id of ids) {
    constituencies.push({
      id,
      meta: [...(await voting.getConstituency(id))],
      candidates: [...(await voting.getCandidateIdsByConstituency(id, 0, 100))],
    });
  }
  const candidates = [];
  const count = await voting.candidateCount();
  for (let i = 1n; i <= count; i++) candidates.push([...(await voting.getCandidate(i))]);
  return { constituencies, candidates, count };
}

/** Tiny deterministic PRNG so the "random" sequence is reproducible. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

describe("Voting V2: results and accounting", () => {
  it("keeps tallies separated across constituencies", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const plan: Array<[string, bigint, number]> = [
      [BLR, 1n, 3],
      [BLR, 2n, 2],
      [BLR, 3n, 0],
      [DEL, 4n, 1],
      [DEL, 5n, 4],
      [MUM, 6n, 2],
    ];
    let n = 0;
    for (const [constituency, candidate, count] of plan) {
      for (let i = 0; i < count; i++) {
        await vote(world, { constituencyId: constituency, nullifier: nullifierOf(++n), candidateId: candidate });
      }
    }

    const { voting } = world;
    expect(await Promise.all(CANDIDATE_IDS.map((id) => voting.votesOf(id)))).to.deep.equal([3n, 2n, 0n, 1n, 4n, 2n]);
    expect(await voting.constituencyTotal(BLR)).to.equal(5n);
    expect(await voting.constituencyTotal(DEL)).to.equal(5n);
    expect(await voting.constituencyTotal(MUM)).to.equal(2n);
    expect(await voting.totalBallots()).to.equal(12n);
  });

  it("tallies stay readable and unchanged after Closed", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    await vote(world, { constituencyId: DEL, nullifier: nullifierOf(1), candidateId: 5n });
    const before = await snapshotAccounting(world);
    await world.voting.closeElection();
    const after = await snapshotAccounting(world);

    expect({ ...after, phase: 0n }).to.deep.equal({ ...before, phase: 0n });
    expect(after.votes[4]).to.equal(1n);
  });

  it("the tally is readable while Open (the contract does not hide results)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    await vote(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 2n });
    // anyone, not only the owner or relayer, can read the running total
    expect(await world.voting.connect(world.attacker).votesOf(2)).to.equal(1n);
    expect(await world.voting.connect(world.attacker).constituencyTotal(BLR)).to.equal(1n);
  });
});

describe("Voting V2: invariants over a mixed sequence of valid and failing calls", () => {
  it("holds all accounting invariants after 60 pseudo-random ballots interleaved with attacks", async function () {
    this.timeout(120_000);
    const world = await networkHelpers.loadFixture(openFixture);
    const { voting, attacker, relayer2 } = world;
    const rand = lcg(20260101);
    const configBefore = await snapshotConfiguration(world);

    const accepted: Array<{ nullifier: string; constituency: string; candidate: bigint }> = [];

    for (let i = 1; i <= 60; i++) {
      const candidate = CANDIDATE_IDS[rand() % CANDIDATE_IDS.length];
      const constituency = CONSTITUENCY_OF[candidate.toString()];
      const nullifier = nullifierOf(i);
      const good = await makeBallot(world, { constituencyId: constituency, nullifier, candidateId: candidate });

      // --- failing attempts first: each must change nothing at all ---
      const attempts: Array<() => Promise<unknown>> = [
        () => castBallot(world, { ...good, candidateId: candidate === 1n ? 2n : 1n }, world.relayer), // swapped candidate
        () => castBallot(world, good, attacker), // wrong caller
        () => castBallot(world, good, relayer2), // wrong caller
        () => castBallot(world, { ...good, nullifier: nullifierOf(1000 + i) }), // swapped nullifier
        () => castBallot(world, { ...good, signature: ethers.hexlify(ethers.randomBytes(65)) }), // junk signature
        () => castBallot(world, { ...good, constituencyId: CONSTITUENCIES[(CONSTITUENCIES.indexOf(constituency) + 1) % 3] }),
      ];
      const failing = attempts[rand() % attempts.length];
      const before = await snapshotAccounting(world);
      await expect(failing()).to.be.revert(ethers);
      expect(await snapshotAccounting(world), `failed call #${i} changed accounting`).to.deep.equal(before);
      expect(await voting.nullifierUsed(nullifier)).to.equal(false);

      // --- the genuine ballot ---
      await expect(castBallot(world, good)).to.emit(voting, "BallotCast");
      accepted.push({ nullifier, constituency, candidate });

      // --- replay attempts after acceptance: must change nothing ---
      if (rand() % 3 === 0) {
        const afterAccept = await snapshotAccounting(world);
        await expect(castBallot(world, good)).to.be.revertedWithCustomError(voting, "NullifierAlreadyUsed");
        expect(await snapshotAccounting(world)).to.deep.equal(afterAccept);
      }
    }

    // ------------------------------- invariants -------------------------------
    const total = await voting.totalBallots();
    expect(total).to.equal(60n);

    // 8. totalBallots == sum of candidate tallies
    const votes = await Promise.all(CANDIDATE_IDS.map((id) => voting.votesOf(id)));
    expect(votes.reduce((a, b) => a + b, 0n)).to.equal(total);

    // 9. totalBallots == sum of constituency tallies
    const totals = await Promise.all(CONSTITUENCIES.map((c) => voting.constituencyTotal(c)));
    expect(totals.reduce((a, b) => a + b, 0n)).to.equal(total);

    // each constituency total == sum of its candidates' tallies
    for (const c of CONSTITUENCIES) {
      const ids = await voting.getCandidateIdsByConstituency(c, 0, 100);
      const sum = (await Promise.all(ids.map((id: bigint) => voting.votesOf(id)))).reduce((a, b) => a + b, 0n);
      expect(await voting.constituencyTotal(c)).to.equal(sum);
    }

    // events: exactly one BallotCast per accepted ballot, each consistent with state
    const events = await voting.queryFilter(voting.filters.BallotCast());
    expect(events).to.have.length(60);

    const seenNullifiers = new Set<string>();
    const seenIndexes = new Set<bigint>();
    const perCandidate = new Map<bigint, bigint>();
    for (const e of events) {
      const { nullifier, constituencyId, candidateId, ballotIndex } = e.args;

      // 1. a nullifier contributes at most one ballot
      expect(seenNullifiers.has(nullifier), "nullifier counted twice").to.equal(false);
      seenNullifiers.add(nullifier);

      // ballot indexes are unique and equal the stored index
      expect(seenIndexes.has(ballotIndex)).to.equal(false);
      seenIndexes.add(ballotIndex);
      expect(await voting.ballotIndexOf(nullifier)).to.equal(ballotIndex);

      // 2. every counted ballot points to an existing candidate
      const [, candidateConstituency] = await voting.getCandidate(candidateId);

      // 3. every counted candidate belongs to the signed constituency
      expect(candidateConstituency).to.equal(constituencyId);

      perCandidate.set(candidateId, (perCandidate.get(candidateId) ?? 0n) + 1n);
    }
    expect([...seenIndexes].sort((a, b) => Number(a - b))).to.deep.equal(Array.from({ length: 60 }, (_, i) => BigInt(i + 1)));
    for (const id of CANDIDATE_IDS) {
      expect(await voting.votesOf(id)).to.equal(perCandidate.get(id) ?? 0n);
    }
    expect(new Set(accepted.map((a) => a.nullifier)).size).to.equal(60);

    // 6. configuration is untouched by voting, by attacks, and by closing
    expect(await snapshotConfiguration(world)).to.deep.equal(configBefore);
    await voting.closeElection();
    expect(await snapshotConfiguration(world)).to.deep.equal(configBefore);
    expect(await voting.totalBallots()).to.equal(60n);
  });

  it("configuration cannot be changed by any caller once Open (owner, relayer, authority, outsiders)", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const before = await snapshotConfiguration(world);

    for (const who of [world.owner, world.relayer, world.authority, world.attacker]) {
      await expect(world.voting.connect(who).addConstituency("EVIL", "Evil")).to.be.revert(ethers);
      await expect(world.voting.connect(who).addCandidate(BLR, "Evil")).to.be.revert(ethers);
    }
    expect(await snapshotConfiguration(world)).to.deep.equal(before);
  });
});

async function freshVotingFixture() {
  const [owner, authority, relayer] = await ethers.getSigners();
  const v = await ethers.deployContract("Voting", [owner.address, ethers.id("GAS"), authority.address, relayer.address]);
  return { v };
}

describe("Voting V2: gas (informational, with loose sanity ceilings)", () => {
  it("measures the main operations", async () => {
    const world = await networkHelpers.loadFixture(openFixture);
    const gas = async (txPromise: Promise<{ wait(): Promise<{ gasUsed: bigint } | null> }>) => {
      const tx = await txPromise;
      const receipt = await tx.wait();
      return receipt!.gasUsed;
    };

    const first = await gas(castBallot(world, await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(1), candidateId: 1n })));
    const second = await gas(castBallot(world, await makeBallot(world, { constituencyId: BLR, nullifier: nullifierOf(2), candidateId: 1n })));
    const otherCandidate = await gas(castBallot(world, await makeBallot(world, { constituencyId: DEL, nullifier: nullifierOf(3), candidateId: 4n })));

    const fresh = await networkHelpers.loadFixture(freshVotingFixture);
    const addC = await gas(fresh.v.addConstituency("GAS-1", "Gas One"));
    const addCand = await gas(fresh.v.addCandidate(ethers.id("GAS-1"), "Gas Candidate"));
    const open = await gas(fresh.v.openElection());

    console.log(`      castVote  first ballot (cold tallies) : ${first}`);
    console.log(`      castVote  repeat candidate            : ${second}`);
    console.log(`      castVote  other candidate/constituency: ${otherCandidate}`);
    console.log(`      addConstituency                       : ${addC}`);
    console.log(`      addCandidate                          : ${addCand}`);
    console.log(`      openElection                          : ${open}`);

    expect(first).to.be.lessThan(200_000n);
    expect(second).to.be.lessThan(first);
    expect(open).to.be.lessThan(80_000n); // O(1): does not loop over constituencies
  });

  it("openElection gas does not grow with the number of constituencies", async () => {
    async function openGas(n: number) {
      const [owner, authority, relayer] = await ethers.getSigners();
      const v = await ethers.deployContract("Voting", [owner.address, ethers.id(`OPEN-${n}`), authority.address, relayer.address]);
      for (let i = 0; i < n; i++) {
        await v.addConstituency(`C-${i}`, `C ${i}`);
        await v.addCandidate(ethers.id(`C-${i}`), `cand ${i}`);
      }
      const receipt = await (await v.openElection()).wait();
      return receipt!.gasUsed;
    }
    const small = await openGas(1);
    const large = await openGas(20);
    expect(large).to.equal(small);
  });
});
