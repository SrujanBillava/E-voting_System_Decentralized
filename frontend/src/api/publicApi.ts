import { request, requestRaw } from "./http";
import type { PublicElection, PublicReceiptCheck, PublicResults } from "./types";

/** Unauthenticated, read-only. */
export const publicApi = {
  election: (signal?: AbortSignal) => request<PublicElection>("GET", "/public/election", { signal }),
  results: (signal?: AbortSignal) => request<PublicResults>("GET", "/public/results", { signal }),
  /** 200 = confirmed, 202 = pending / still confirming. Anything else is an ApiError (404 RECEIPT_NOT_FOUND, 422 RECEIPT_INVALID, 503 CHAIN_UNAVAILABLE...). */
  verifyReceipt: async (txHash: string, signal?: AbortSignal) => (await requestRaw<PublicReceiptCheck>("GET", `/public/receipts/${encodeURIComponent(txHash)}`, { signal })).data,
};
