import { getAddress } from "ethers";
import { AppError } from "../utils/errors.js";

const unavailable = () => new AppError(503, "CHAIN_UNAVAILABLE", "The blockchain is not reachable");

export const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const normalizeTxHash = (value) => (typeof value === "string" && TX_HASH_PATTERN.test(value) ? value.toLowerCase() : null);

/**
 * The ONE place that decides whether a transaction hash is a recorded VoteChain ballot. The voter receipt and the public
 * verification both build on it, so they can never disagree about what counts.
 *
 * Checked, in order: the transaction exists and targets the configured Voting contract; its receipt succeeded; exactly one
 * BallotCast was emitted BY that contract; the receipt's block is on the node's canonical chain; enough blocks have been
 * mined on top of it; and the contract itself says that nullifier is consumed with that very ballot index.
 *
 * Result: { status, evidence? } where status is
 *   NOT_FOUND   the node knows nothing about this hash
 *   PENDING     known but not mined
 *   REJECTED    exists, but is not a recorded ballot of THIS contract (wrong target, reverted, no/other event, not canonical, state mismatch)
 *   CONFIRMING  a valid ballot, but not yet final (fewer than the configured confirmations)
 *   CONFIRMED   a valid, final ballot; `evidence` carries the event data (including the SENSITIVE nullifier and candidate: callers filter)
 * Provider failures throw CHAIN_UNAVAILABLE; raw RPC errors never escape.
 */
export async function readBallotEvidence(chain, txHash) {
  const hash = normalizeTxHash(txHash);
  if (!hash) return { status: "NOT_FOUND" };
  const { provider, contract, deployment } = chain;
  const contractAddress = deployment.contractAddress;
  const required = chain.confirmations ?? 1;

  let tx;
  let receipt;
  try {
    [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
  } catch {
    throw unavailable();
  }
  if (!tx && !receipt) return { status: "NOT_FOUND" };

  const targets = [tx?.to, receipt?.to].filter(Boolean);
  if (targets.length === 0 || targets.some((to) => getAddress(to) !== contractAddress)) return { status: "REJECTED", reason: "wrong_contract" };
  if (!receipt) return { status: "PENDING" };
  if (receipt.status !== 1) return { status: "REJECTED", reason: "reverted" };

  const events = receipt.logs
    .filter((log) => log.address.toLowerCase() === contractAddress.toLowerCase())
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed?.name === "BallotCast");
  if (events.length !== 1) return { status: "REJECTED", reason: "no_ballot_event" };
  const { nullifier, constituencyId, candidateId, ballotIndex } = events[0].args;

  let block;
  let head;
  let used;
  let indexOnChain;
  try {
    [block, head] = await Promise.all([provider.getBlock(receipt.blockNumber), provider.getBlockNumber()]);
    if (!block) throw unavailable(); // a lagging node, not a verdict
    if (block.hash !== receipt.blockHash) return { status: "REJECTED", reason: "not_canonical" }; // reorged away since the receipt was read
    if (head - receipt.blockNumber + 1 < required) return { status: "CONFIRMING", confirmations: Math.max(0, head - receipt.blockNumber + 1), required };
    [used, indexOnChain] = await Promise.all([contract.nullifierUsed(nullifier), contract.ballotIndexOf(nullifier)]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unavailable();
  }
  if (!used || indexOnChain !== ballotIndex) return { status: "REJECTED", reason: "state_mismatch" };

  return {
    status: "CONFIRMED",
    evidence: {
      txHash: hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      blockTimestamp: block.timestamp,
      ballotIndex: ballotIndex.toString(),
      contractAddress,
      chainId: deployment.chainId,
      electionId: deployment.electionId,
      confirmations: head - receipt.blockNumber + 1,
      // sensitive: never copied into a response without a deliberate decision
      nullifier,
      constituencyId,
      candidateId,
    },
  };
}
