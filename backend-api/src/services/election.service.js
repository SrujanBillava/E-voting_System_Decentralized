import { readElectionState } from "../chain/contract.js";
import { AppError } from "../utils/errors.js";

/**
 * Admin-only election lifecycle. The CONTRACT is the source of truth for the phase; nothing here
 * keeps its own "open" flag. Transactions are sent by the OWNER signer and the response is built only
 * from what the chain reports after the transaction is confirmed.
 */
export function createElectionService({ chain, healthService, auth, audit, ownerQueue, voterStats, faceReadiness }) {
  const ownerContract = () => chain.contract.connect(chain.signers.owner);

  const summarize = (report) => ({
    ok: report.ok,
    status: report.status,
    checkedAt: report.checkedAt,
    checks: report.checks.map((c) => ({ name: c.name, status: c.status })),
  });

  const exclusive = (fn) => ownerQueue.run(fn);

  async function sendAndConfirm(method, expectedPhaseIndex, ctx, action) {
    let txHash;
    try {
      const tx = await ownerContract()[method]();
      txHash = tx.hash;
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("transaction reverted");
    } catch (err) {
      await audit.record({ action, result: "failure", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, txHash: txHash ?? null, meta: { reason: "tx_failed" } });
      throw new AppError(502, "CHAIN_TX_FAILED", "The blockchain transaction failed");
    }
    const state = await readElectionState(chain.contract);
    if (state.phaseIndex !== expectedPhaseIndex) {
      await audit.record({ action, result: "failure", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, txHash, meta: { reason: "phase_not_confirmed" } });
      throw new AppError(502, "CHAIN_STATE_UNEXPECTED", "The chain did not report the expected phase");
    }
    return { txHash, state };
  }

  return {
    async getElection() {
      const report = await healthService.getSystemPreflight();
      const s = report.snapshot;
      if (!s) throw new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable or does not match the configuration");
      return {
        electionId: s.electionId,
        phase: s.phase,
        contractAddress: s.contractAddress,
        chainId: s.chainId,
        constituencyCount: s.constituencyCount,
        candidateCount: s.candidateCount,
        totalBallots: s.totalBallots,
        preflight: summarize(report),
        ...(voterStats ? { voters: await voterStats() } : {}),
      };
    },

    async open({ confirmation, totp }, ctx) {
      if (confirmation !== "OPEN ELECTION") throw new AppError(400, "INVALID_CONFIRMATION", 'Type "OPEN ELECTION" to confirm');
      return exclusive(async () => {
        await audit.record({ action: "ELECTION_OPEN_REQUESTED", result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip });

        const report = await healthService.getSystemPreflight();
        const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.name);
        const config = report.checks.find((c) => c.name === "election.config");
        if (report.snapshot && report.snapshot.phase !== "Setup") throw new AppError(409, "WRONG_PHASE", `The election is ${report.snapshot.phase}, not Setup`);
        if (!report.ok || config?.status !== "pass") {
          const blockers = [...new Set([...failed, ...(config?.status === "warn" ? ["election.config"] : [])])];
          await audit.record({ action: "ELECTION_OPEN_REJECTED", result: "failure", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, meta: { reason: "preflight_failed", failedChecks: blockers } });
          throw new AppError(409, "PREFLIGHT_FAILED", `Preflight failed: ${blockers.join(", ")}`);
        }

        // Biometrics: opening freezes enrolment, so every enrolled face must be readable NOW (a lost or mistyped template key would otherwise strand voters).
        const face = faceReadiness ? await faceReadiness() : { unreadable: 0 };
        if (face.unreadable > 0) {
          await audit.record({ action: "ELECTION_OPEN_REJECTED", result: "failure", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, meta: { reason: "preflight_failed", failedChecks: ["face.templates"] } });
          throw new AppError(409, "PREFLIGHT_FAILED", `Preflight failed: face.templates (${face.unreadable} enrolled face${face.unreadable === 1 ? "" : "s"} cannot be read with the configured key; enrol them again)`);
        }

        await auth.verifyStepUp({ adminId: ctx.adminId, totp, ip: ctx.ip, requestId: ctx.requestId });

        const { txHash, state } = await sendAndConfirm("openElection", 1, ctx, "ELECTION_OPENED");
        await audit.record({ action: "ELECTION_OPENED", result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, txHash });
        return { txHash, phase: state.phase };
      });
    },

    async close({ confirmation, totp }, ctx) {
      if (confirmation !== "CLOSE ELECTION") throw new AppError(400, "INVALID_CONFIRMATION", 'Type "CLOSE ELECTION" to confirm');
      return exclusive(async () => {
        await audit.record({ action: "ELECTION_CLOSE_REQUESTED", result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip });

        let state;
        try {
          state = await readElectionState(chain.contract);
        } catch {
          throw new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");
        }
        if (state.phase !== "Open") throw new AppError(409, "WRONG_PHASE", `The election is ${state.phase}, not Open`);
        if (state.owner !== chain.signers.addresses.owner) throw new AppError(409, "PREFLIGHT_FAILED", "Preflight failed: contract.owner");

        await auth.verifyStepUp({ adminId: ctx.adminId, totp, ip: ctx.ip, requestId: ctx.requestId });

        const { txHash, state: after } = await sendAndConfirm("closeElection", 2, ctx, "ELECTION_CLOSED");
        await audit.record({ action: "ELECTION_CLOSED", result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, txHash });
        return { txHash, phase: after.phase, totalBallots: after.totalBallots };
      });
    },
  };
}
