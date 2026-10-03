import { Contract } from "ethers";
import { PHASES, votingInterface } from "./abi.js";
import { constituencyIdOf } from "./ids.js";

const PAGE_SIZE = 100n;

/** Read-only Voting instance. Writes need a signer (a later step); none is attached here. */
export function createVotingContract({ provider, address }) {
  return new Contract(address, votingInterface, provider);
}

const toSafeNumber = (value, what) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} does not fit a JavaScript integer`);
  return n;
};

/** Scalar election state; every field comes from the contract. */
export async function readElectionState(contract) {
  const [electionId, phase, owner, pendingOwner, authoritySigner, relayer, constituencyCount, candidateCount, totalBallots] =
    await Promise.all([
      contract.ELECTION_ID(),
      contract.phase(),
      contract.owner(),
      contract.pendingOwner(),
      contract.authoritySigner(),
      contract.relayer(),
      contract.constituencyCount(),
      contract.candidateCount(),
      contract.totalBallots(),
    ]);
  const phaseIndex = toSafeNumber(phase, "phase");
  return {
    electionId,
    phase: PHASES[phaseIndex] ?? `Unknown(${phaseIndex})`,
    phaseIndex,
    owner,
    pendingOwner,
    authoritySigner,
    relayer,
    constituencyCount: toSafeNumber(constituencyCount, "constituencyCount"),
    candidateCount: toSafeNumber(candidateCount, "candidateCount"),
    totalBallots: toSafeNumber(totalBallots, "totalBallots"),
  };
}

/** All constituencies with their candidate ids, read in pages of `pageSize`. */
export async function readConstituencies(contract, { pageSize = PAGE_SIZE } = {}) {
  const total = await contract.constituencyCount();
  const result = [];
  for (let offset = 0n; offset < total; offset += pageSize) {
    const ids = await contract.getConstituencyIds(offset, pageSize);
    for (const id of ids) {
      const [code, name] = await contract.getConstituency(id);
      const count = await contract.candidateCountOf(id);
      const candidateIds = [];
      for (let o = 0n; o < count; o += pageSize) {
        candidateIds.push(...(await contract.getCandidateIdsByConstituency(id, o, pageSize)).map((c) => toSafeNumber(c, "candidateId")));
      }
      result.push({ id, code, name, candidateIds, idMatchesCode: id === constituencyIdOf(code) });
    }
  }
  return result;
}

/** All candidates in id order (ids are global and sequential from 1). */
export async function readCandidates(contract, constituencies) {
  const byId = new Map(constituencies.map((c) => [c.id, c]));
  const count = toSafeNumber(await contract.candidateCount(), "candidateCount");
  const candidates = [];
  for (let candidateId = 1; candidateId <= count; candidateId++) {
    const [name, constituencyId] = await contract.getCandidate(candidateId);
    candidates.push({ id: candidateId, name, constituencyId, constituencyCode: byId.get(constituencyId)?.code ?? null });
  }
  return candidates;
}

/** All candidate ids of one constituency, ascending, read in pages. No tallies are touched. */
export async function readCandidateIds(contract, constituencyId) {
  const count = await contract.candidateCountOf(constituencyId);
  const ids = [];
  for (let offset = 0n; offset < count; offset += PAGE_SIZE) {
    ids.push(...(await contract.getCandidateIdsByConstituency(constituencyId, offset, PAGE_SIZE)).map((c) => toSafeNumber(c, "candidateId")));
  }
  return ids.sort((a, b) => a - b);
}
