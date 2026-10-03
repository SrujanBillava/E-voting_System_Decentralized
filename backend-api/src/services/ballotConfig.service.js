import { readCandidates, readConstituencies } from "../chain/contract.js";
import { canonicalConstituencyCode, constituencyIdOf } from "../chain/ids.js";
import { AppError } from "../utils/errors.js";
import { readConstituencyById, requireSetup } from "./chainConfig.js";

/**
 * Constituencies and candidates are authoritative ON-CHAIN. This service only relays admin intent to the
 * contract through the OWNER signer and reports what the contract says afterwards. Items are immutable
 * once created (the contract has no edit or delete), so there is nothing to edit here either.
 */
export function createBallotConfigService({ chain, audit, ownerQueue }) {
  const ownerContract = () => chain.contract.connect(chain.signers.owner);

  const codeOrThrow = (raw) => {
    const code = canonicalConstituencyCode(raw);
    if (!code) throw new AppError(400, "VALIDATION_FAILED", "Invalid request: constituencyCode");
    return code;
  };

  /** Sends one owner transaction, requires a successful receipt, and returns the receipt's matching event args. */
  async function sendAndParse(method, args, eventName, ctx, action) {
    let tx;
    let receipt;
    try {
      tx = await ownerContract()[method](...args);
      receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) throw new Error("reverted");
    } catch (err) {
      const reason = err?.revert?.name ?? "tx_failed";
      await audit.record({ action, result: "failure", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, txHash: tx?.hash ?? null, meta: { reason } });
      const mapped = { WrongPhase: [409, "ELECTION_LOCKED", "Configuration is locked"], ConstituencyExists: [409, "CONSTITUENCY_EXISTS", "That constituency already exists"], UnknownConstituency: [422, "UNKNOWN_CONSTITUENCY", "That constituency does not exist on-chain"], BadName: [400, "BAD_NAME", "Invalid name"], BadCode: [400, "BAD_CODE", "Invalid code"] }[reason];
      throw mapped ? new AppError(...mapped) : new AppError(502, "CHAIN_TX_FAILED", "The blockchain transaction failed");
    }
    const event = receipt.logs
      .filter((log) => log.address.toLowerCase() === chain.deployment.contractAddress.toLowerCase())
      .map((log) => chain.contract.interface.parseLog(log))
      .find((parsed) => parsed?.name === eventName);
    if (!event) throw new AppError(502, "CHAIN_STATE_UNEXPECTED", "The expected contract event was not emitted");
    return { txHash: tx.hash, args: event.args };
  }

  return {
    async listConstituencies() {
      const list = await readConstituencies(chain.contract);
      return list.map((c) => ({ code: c.code, name: c.name, constituencyId: c.id, candidateCount: c.candidateIds.length }));
    },

    async addConstituency({ code: rawCode, name }, ctx) {
      const code = codeOrThrow(rawCode);
      const expectedId = constituencyIdOf(code);
      return ownerQueue.run(async () => {
        await requireSetup(chain);
        if (await readConstituencyById(chain, expectedId)) throw new AppError(409, "CONSTITUENCY_EXISTS", "That constituency already exists");
        const { txHash, args } = await sendAndParse("addConstituency", [code, name], "ConstituencyAdded", ctx, "CONSTITUENCY_ADD_FAILED");
        if (args.constituencyId !== expectedId) throw new AppError(502, "CHAIN_STATE_UNEXPECTED", "The contract created an unexpected constituency id");
        const stored = await readConstituencyById(chain, expectedId);
        if (!stored || stored.code !== code || stored.name !== name) throw new AppError(502, "CHAIN_STATE_UNEXPECTED", "The contract state does not match the request");
        await audit.record({ action: "CONSTITUENCY_ADDED", result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, txHash, meta: { constituencyCode: code } });
        return { txHash, constituency: { code, name, constituencyId: expectedId, candidateCount: 0 } };
      });
    },

    async listCandidates({ constituencyCode } = {}) {
      const constituencies = await readConstituencies(chain.contract);
      const all = await readCandidates(chain.contract, constituencies);
      const wanted = constituencyCode ? codeOrThrow(constituencyCode) : null;
      return all
        .filter((c) => !wanted || c.constituencyCode === wanted)
        .map((c) => ({ candidateId: c.id, name: c.name, constituencyCode: c.constituencyCode, constituencyId: c.constituencyId }));
    },

    async getCandidate(candidateId) {
      const all = await this.listCandidates();
      const found = all.find((c) => c.candidateId === candidateId);
      if (!found) throw new AppError(404, "NOT_FOUND", "Candidate not found");
      return found;
    },

    async addCandidate({ name, constituencyCode }, ctx) {
      const code = codeOrThrow(constituencyCode);
      const constituencyId = constituencyIdOf(code);
      return ownerQueue.run(async () => {
        await requireSetup(chain);
        if (!(await readConstituencyById(chain, constituencyId))) throw new AppError(422, "UNKNOWN_CONSTITUENCY", "That constituency does not exist on-chain");
        const { txHash, args } = await sendAndParse("addCandidate", [constituencyId, name], "CandidateAdded", ctx, "CANDIDATE_ADD_FAILED");
        const candidateId = Number(args.candidateId);
        const [storedName, storedConstituency] = await chain.contract.getCandidate(candidateId);
        if (args.constituencyId !== constituencyId || storedConstituency !== constituencyId || storedName !== name) throw new AppError(502, "CHAIN_STATE_UNEXPECTED", "The contract state does not match the request");
        await audit.record({ action: "CANDIDATE_ADDED", result: "success", adminId: ctx.adminId, requestId: ctx.requestId, ip: ctx.ip, txHash, meta: { candidateId, constituencyCode: code } });
        return { txHash, candidate: { candidateId, name, constituencyCode: code, constituencyId } };
      });
    },
  };
}
