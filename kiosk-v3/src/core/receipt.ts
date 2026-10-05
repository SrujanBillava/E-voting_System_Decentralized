import type { BallotRecord, ElectionParams, Receipt, RecordedEvidence } from "./types.ts";

export const RECEIPT_STATEMENT = "This receipt proves that an encrypted ballot was recorded. It does not prove which candidate was selected.";

/**
 * The voter-facing receipt: only PUBLIC recording data. Deliberately absent: the voter's identity, voter id, uid, biometrics, the Semaphore commitment, the NULLIFIER, any Merkle
 * root, the private identity, the candidate, the one-hot vector, the encryption randomness. (The ballot hash and the transaction are public chain data that identify the
 * ENCRYPTED ballot, not the voter and not the vote.)
 */
export function buildReceipt(input: { params: Pick<ElectionParams, "electionId" | "constituency"> & { ctx: ElectionParams["ctx"] }; evidence: RecordedEvidence }): Receipt {
  const { params, evidence } = input;
  return {
    v: 1,
    electionId: params.electionId,
    chainId: Number(params.ctx.chainId),
    contract: "0x" + params.ctx.contractAddress.toString(16).padStart(40, "0"),
    constituency: params.constituency,
    ballotIndex: evidence.ballotIndex,
    ballotHash: "0x" + BigInt(evidence.ballotHash).toString(16).padStart(64, "0"),
    txHash: evidence.txHash,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    blockTimestamp: evidence.blockTimestamp,
    statement: RECEIPT_STATEMENT,
  };
}

/** Throws if a receipt contains something it must not: any of the given secrets (in any common spelling) or an unexpected field. */
export function assertReceiptSafe(receipt: Receipt, secrets: { nullifier?: string; commitment?: string; root?: string; candidate?: string }): void {
  const allowed = ["v", "electionId", "chainId", "contract", "constituency", "ballotIndex", "ballotHash", "txHash", "blockNumber", "blockHash", "blockTimestamp", "statement"];
  const extra = Object.keys(receipt).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`the receipt has unexpected fields: ${extra.join(", ")}`);
  const text = JSON.stringify(receipt).toLowerCase();
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    const forms = /^[0-9]+$/.test(value) ? [value, BigInt(value).toString(16), "0x" + BigInt(value).toString(16)] : [value];
    if (forms.some((f) => f.length >= 8 && text.includes(f.toLowerCase()))) throw new Error(`the receipt contains the ${name}`);
  }
}

export const receiptFor = (params: ElectionParams, record: BallotRecord, evidence: RecordedEvidence): Receipt => {
  const receipt = buildReceipt({ params, evidence });
  assertReceiptSafe(receipt, { nullifier: record.nullifier, root: record.membership.merkleTreeRoot });
  return receipt;
};
