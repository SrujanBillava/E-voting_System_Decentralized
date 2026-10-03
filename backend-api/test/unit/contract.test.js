import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readCandidates, readConstituencies, readElectionState } from "../../src/chain/contract.js";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { fakeWorld } from "../helpers/fake-chain.js";

// Offline: the paging and conversion logic of the read helpers, against the fake deployment.
const many = Array.from({ length: 7 }, (_, i) => ({
  code: `C-${i}`,
  name: `Constituency ${i}`,
  candidates: Array.from({ length: [3, 0, 1, 5, 2, 0, 4][i] }, (_, j) => `cand ${i}.${j}`),
}));

describe("contract reads: paging", () => {
  const expected = () => {
    let next = 1;
    return many.map((c) => ({ code: c.code, name: c.name, candidateIds: c.candidates.map(() => next++), idMatchesCode: true, id: constituencyIdOf(c.code) }));
  };

  for (const pageSize of [1n, 2n, 3n, 7n, 8n, 100n]) {
    it(`page size ${pageSize}: every constituency and every candidate id is returned exactly once, in order`, async () => {
      const world = fakeWorld({ constituencies: many });
      assert.deepEqual(await readConstituencies(world.contract, { pageSize }), expected());
    });
  }

  it("the default page size gives the same answer", async () => {
    const world = fakeWorld({ constituencies: many });
    assert.deepEqual(await readConstituencies(world.contract), expected());
  });

  it("paging requests the right windows (no skipped or repeated offsets)", async () => {
    const world = fakeWorld({ constituencies: many });
    const windows = [];
    const contract = new Proxy(world.contract, {
      get: (target, property) => (property === "getConstituencyIds" ? (offset, limit) => (windows.push([Number(offset), Number(limit)]), target.getConstituencyIds(offset, limit)) : target[property]),
    });
    await readConstituencies(contract, { pageSize: 3n });
    assert.deepEqual(windows, [[0, 3], [3, 3], [6, 3]]);
  });

  it("readCandidates returns ids 1..N in order and resolves each constituency code", async () => {
    const world = fakeWorld({ constituencies: many });
    const constituencies = await readConstituencies(world.contract, { pageSize: 2n });
    const candidates = await readCandidates(world.contract, constituencies);
    assert.deepEqual(candidates.map((c) => c.id), Array.from({ length: 15 }, (_, i) => i + 1));
    assert.deepEqual(candidates.slice(0, 4).map((c) => [c.name, c.constituencyCode]), [["cand 0.0", "C-0"], ["cand 0.1", "C-0"], ["cand 0.2", "C-0"], ["cand 2.0", "C-2"]]);
    assert.ok(candidates.every((c) => c.constituencyId === constituencyIdOf(c.constituencyCode)));
  });

  it("a candidate pointing at a constituency nobody lists has constituencyCode null", async () => {
    const world = fakeWorld({ candidateConstituencyOverrides: { 1: constituencyIdOf("GHOST") } });
    const candidates = await readCandidates(world.contract, await readConstituencies(world.contract));
    assert.equal(candidates[0].constituencyCode, null);
    assert.equal(candidates[1].constituencyCode, "KA-BLR");
  });

  it("flags a constituency whose id is not keccak256(code)", async () => {
    const world = fakeWorld({ constituencyIdOverrides: { "KA-BLR": constituencyIdOf("ka-blr") } });
    const constituencies = await readConstituencies(world.contract);
    assert.deepEqual(constituencies.map((c) => c.idMatchesCode), [false, true]);
  });
});

describe("contract reads: scalar state", () => {
  it("maps every field from the right accessor", async () => {
    const world = fakeWorld({ phase: 1n, totalBallots: 41n });
    const state = await readElectionState(world.contract);
    assert.equal(state.electionId, world.state.electionId);
    assert.equal(state.phase, "Open");
    assert.equal(state.phaseIndex, 1);
    assert.equal(state.owner, world.state.owner);
    assert.equal(state.pendingOwner, world.state.pendingOwner);
    assert.equal(state.authoritySigner, world.state.authoritySigner);
    assert.equal(state.relayer, world.state.relayer);
    assert.notEqual(state.authoritySigner, state.relayer);
    assert.equal(state.constituencyCount, 2);
    assert.equal(state.candidateCount, 5);
    assert.equal(state.totalBallots, 41);
  });

  it("names the three known phases and never invents one for an unknown index", async () => {
    assert.equal((await readElectionState(fakeWorld({ phase: 0n }).contract)).phase, "Setup");
    assert.equal((await readElectionState(fakeWorld({ phase: 2n }).contract)).phase, "Closed");
    assert.equal((await readElectionState(fakeWorld({ phase: 7n }).contract)).phase, "Unknown(7)");
  });

  it("refuses counts that do not fit an exactly-representable JavaScript integer", async () => {
    await assert.rejects(readElectionState(fakeWorld({ totalBallots: 2n ** 60n }).contract), RangeError);
    await assert.rejects(readElectionState(fakeWorld({ candidateCountOverride: 2n ** 53n }).contract), RangeError);
    await assert.rejects(readElectionState(fakeWorld({ constituencyCountOverride: 2n ** 53n }).contract), RangeError);
    await assert.rejects(readElectionState(fakeWorld({ phase: 2n ** 60n }).contract), RangeError);
    await assert.rejects(readCandidates(fakeWorld({ candidateCountOverride: 2n ** 60n }).contract, []), RangeError);
  });
});
