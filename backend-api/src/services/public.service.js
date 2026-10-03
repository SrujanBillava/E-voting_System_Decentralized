import { readBallotEvidence } from "../chain/ballotEvidence.js";
import { readCandidateIds, readConstituencies } from "../chain/contract.js";
import { AppError } from "../utils/errors.js";
import { readPhaseName } from "./chainConfig.js";

const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");

/** What a confirmed public receipt proves, and what it does not. Shown to users, so it is worded with care. */
export const VERIFICATION_STATEMENT =
  "A ballot represented by this transaction was recorded by this VoteChain contract for this election and constituency and remains on the canonical chain. " +
  "This does not identify the voter, does not show that the recorded choice matches the voter's intent, and does not provide ballot secrecy, receipt-freeness or coercion resistance.";

/** Honest scope of the closed-only results rule. */
export const RESULTS_NOTICE =
  "The official VoteChain application publishes results only after the election closes. Because the blockchain is public and ballots are plaintext in this version, an external observer can derive interim counts while the election is open.";

/**
 * Public, unauthenticated reads: election information, receipt verification and closed-only results. Everything comes from the
 * Voting contract; Mongo is never an authority for a tally. Nothing here can change state.
 */
export function createPublicService({ chain, audit, now = Date.now, structureCacheMs = 5000, inconsistencyAuditEveryMs = 60_000, inconsistencyCacheMs = 15_000 }) {
  const wrap = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw unavailable();
    }
  };
  const candidatesOf = (constituency) => Promise.all(constituency.candidateIds.map(async (id) => ({ candidateId: String(id), name: (await chain.contract.getCandidate(id))[0] })));

  let structure = null; // { at, value }; configuration is immutable once the election has left Setup
  let results = null; // the assembled Closed results (the election can never reopen)
  let building = null; // single-flight: concurrent first requests share one build (and one audit row)
  let structureBuilding = null; // single-flight for the (RPC-heavy) structure read
  let inconsistent = null; // { until }: a bad tally is not re-assembled on every request
  let lastInconsistencyAuditAt = -Infinity;

  /** Configuration is frozen from Open on, so it is cached for good then; in Setup it may still change, so only briefly. Concurrent readers share one build. */
  async function readStructure(phase) {
    if (structure && (phase !== "Setup" || now() - structure.at < structureCacheMs)) return structure.value;
    structureBuilding ??= (async () => {
      const constituencies = await readConstituencies(chain.contract);
      const value = await Promise.all(constituencies.map(async (c) => ({ code: c.code, name: c.name, candidates: await candidatesOf(c) })));
      structure = { at: now(), value, phase };
      return value;
    })().finally(() => { structureBuilding = null; });
    return structureBuilding;
  }

  return {
    async getElection() {
      return wrap(async () => {
        const phase = await readPhaseName(chain);
        // No tallies and no ballot counts here, in any phase.
        return { electionId: chain.deployment.electionId, phase, contractAddress: chain.deployment.contractAddress, chainId: chain.deployment.chainId, constituencies: await readStructure(phase) };
      });
    },

    async getResults() {
      return wrap(async () => {
        const phase = await readPhaseName(chain);
        if (phase !== "Closed") throw new AppError(403, "RESULTS_NOT_AVAILABLE", "Results are published after the election closes");
        if (results) return results;
        if (inconsistent && now() < inconsistent.until) throw new AppError(500, "RESULT_INCONSISTENCY", "The results could not be verified and are not being published");
        building ??= (async () => {
        const { contract } = chain;
        const [constituencies, totalBallots, candidateCount] = await Promise.all([readConstituencies(contract), contract.totalBallots(), contract.candidateCount()]);
        const built = await Promise.all(
          constituencies.map(async (c) => {
            const [constituencyTotal, candidates] = await Promise.all([
              contract.constituencyTotal(c.id),
              Promise.all(c.candidateIds.map(async (id) => { const [name, owner] = await contract.getCandidate(id); return { id, name, owner, votes: await contract.votesOf(id) }; })),
            ]);
            return { code: c.code, name: c.name, constituencyTotal, candidates };
          }),
        );

        // Never serve numbers that do not add up: candidates -> constituency -> election.
        const sum = (values) => values.reduce((a, b) => a + b, 0n);
        const listed = built.reduce((n, c) => n + c.candidates.length, 0);
        const consistent = BigInt(listed) === candidateCount && built.every((c, i) => c.candidates.every((x) => x.owner === constituencies[i].id)) && built.every((c) => sum(c.candidates.map((x) => x.votes)) === c.constituencyTotal) && sum(built.map((c) => c.constituencyTotal)) === totalBallots;
        if (!consistent) {
          if (now() - lastInconsistencyAuditAt >= inconsistencyAuditEveryMs) {
            lastInconsistencyAuditAt = now();
            await audit.record({ action: "RESULT_INCONSISTENCY", result: "failure", meta: { reason: "tally_sum_mismatch", phase } });
          }
          inconsistent = { until: now() + inconsistencyCacheMs };
          throw new AppError(500, "RESULT_INCONSISTENCY", "The results could not be verified and are not being published");
        }

        results = {
          electionId: chain.deployment.electionId,
          phase,
          totalBallots: totalBallots.toString(),
          constituencies: built.map((c) => ({
            code: c.code,
            name: c.name,
            totalVotes: c.constituencyTotal.toString(),
            candidates: c.candidates.map((x) => ({ candidateId: String(x.id), name: x.name, votes: x.votes.toString() })), // grouped by constituency: never one global leaderboard
          })),
          notice: RESULTS_NOTICE,
        };
        await audit.record({ action: "RESULTS_PUBLISHED", result: "success", meta: { phase } });
        return results;
        })().finally(() => { building = null; });
        return building;
      });
    },

    /** @returns {{ http: number, body: object }} */
    async verifyReceipt(txHash) {
      return wrap(async () => {
        const found = await readBallotEvidence(chain, txHash);
        switch (found.status) {
          case "NOT_FOUND":
            throw new AppError(404, "RECEIPT_NOT_FOUND", "No such transaction was found");
          case "REJECTED":
            throw new AppError(422, "RECEIPT_INVALID", "This transaction is not a recorded ballot of this election");
          case "PENDING":
            return { http: 202, body: { found: true, status: "PENDING", txHash: String(txHash).toLowerCase() } };
          case "CONFIRMING":
            return { http: 202, body: { found: true, status: "CONFIRMING", txHash: String(txHash).toLowerCase(), confirmations: found.confirmations } };
        }
        const ev = found.evidence;
        let constituency;
        try {
          const [code, name] = await chain.contract.getConstituency(ev.constituencyId);
          constituency = { code, name };
        } catch (err) {
          if (err?.revert?.name === "UnknownConstituency") throw new AppError(422, "RECEIPT_INVALID", "This transaction is not a recorded ballot of this election");
          throw unavailable();
        }
        const body = {
          found: true,
          status: "CONFIRMED",
          txHash: ev.txHash,
          blockNumber: ev.blockNumber,
          blockHash: ev.blockHash,
          ballotIndex: ev.ballotIndex,
          electionId: ev.electionId,
          contractAddress: ev.contractAddress,
          chainId: ev.chainId,
          confirmedAt: new Date(ev.blockTimestamp * 1000).toISOString(),
          constituency,
          statement: VERIFICATION_STATEMENT,
        };
        // The recorded candidate is on the public chain, but this application does not hand it out before the election closes.
        // The recorded candidate is on the public chain, but this API NEVER returns it (before or after close): it does not make proving a choice easier than necessary. That is not receipt-freeness.
        return { http: 200, body };
      });
    },
  };
}
