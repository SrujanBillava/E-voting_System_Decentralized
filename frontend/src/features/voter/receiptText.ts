import type { PortableReceipt } from "../../api/types";
import { formatDateTime } from "../../lib/format";

/**
 * The text of a copied or printed receipt. It is built from the PORTABLE receipt only: it cannot contain the recorded
 * candidate, because that value is never passed in. (VoteChain is not receipt-free: the candidate is public on the ledger.)
 */
export function receiptText(r: PortableReceipt, origin: string): string {
  return [
    "VoteChain ballot receipt",
    `Election: ${r.electionId}`,
    `Ballot number: ${r.ballotIndex}`,
    `Recorded: ${formatDateTime(r.confirmedAt)}`,
    `Block: ${r.blockNumber}`,
    `Transaction: ${r.txHash}`,
    `Verify: ${origin}/verify/${r.txHash}`,
  ].join("\n");
}
