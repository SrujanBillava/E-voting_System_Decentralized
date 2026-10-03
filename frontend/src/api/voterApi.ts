import { request, requestRaw } from "./http";
import type { AuthorizationResult, Ballot, CastResult, EligibilityResult, ReceiptConfirmed, ReceiptPending, VoterLoginResult, VoterStatus } from "./types";

/** The voter session is an opaque HttpOnly cookie held by the browser; the stage always comes from the server. */
export const voterApi = {
  login: (identifier: string, password: string) => request<VoterLoginResult>("POST", "/voter/auth/login", { body: { identifier, password } }),
  logout: () => request<void>("POST", "/voter/auth/logout"),
  status: (signal?: AbortSignal) => request<VoterStatus>("GET", "/voter/status", { signal }),
  eligibility: () => request<EligibilityResult>("POST", "/voter/eligibility/check", { body: {} }),
  ballot: (signal?: AbortSignal) => request<Ballot>("GET", "/voter/ballot", { signal }),
  authorize: (candidateId: string) => request<AuthorizationResult>("POST", "/voter/authorization", { body: { candidateId } }),
  /** 200 = recorded, 202 = broadcast and being confirmed. The Idempotency-Key makes a retry safe. */
  cast: async (idempotencyKey: string) => {
    const r = await requestRaw<CastResult>("POST", "/voter/cast", { body: {}, headers: { "Idempotency-Key": idempotencyKey }, timeoutMs: 60_000 });
    return { status: r.status, body: r.data };
  },
  /** 200 = confirmed receipt, 202 = still pending. */
  receipt: async (signal?: AbortSignal): Promise<{ status: 200; body: ReceiptConfirmed } | { status: 202; body: ReceiptPending }> => {
    const r = await requestRaw<ReceiptConfirmed | ReceiptPending>("GET", "/voter/receipt", { signal, timeoutMs: 20_000 });
    return r.status === 200 ? { status: 200, body: r.data as ReceiptConfirmed } : { status: 202, body: r.data as ReceiptPending };
  },
};
