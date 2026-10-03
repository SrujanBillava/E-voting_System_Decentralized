import { ApiError, request } from "./http";
import { adminSession } from "./adminSession";
import type { AdminCandidate, AdminConstituency, AdminElection, AdminVoter, VoterPage } from "./types";

/** Authenticated call: attach the in-memory token; on 401 refresh ONCE (shared with every other caller) and retry once. */
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await request<T>(method, path, { body, token: adminSession.getToken() });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401 || err.code === "INVALID_STEP_UP") throw err;
    if (!(await adminSession.refresh())) throw err;
    return request<T>(method, path, { body, token: adminSession.getToken() });
  }
}

const qs = (params: Record<string, string | number | undefined>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
};

export interface VoterListQuery {
  page?: number;
  limit?: number;
  search?: string;
  constituencyCode?: string;
  status?: "ACTIVE" | "SUSPENDED" | "";
}

export const adminApi = {
  election: () => call<AdminElection>("GET", "/admin/election"),
  openElection: (confirmation: string, totp: string) => call<{ txHash: string; phase: string }>("POST", "/admin/election/open", { confirmation, totp }),
  closeElection: (confirmation: string, totp: string) => call<{ txHash: string; phase: string; totalBallots: number }>("POST", "/admin/election/close", { confirmation, totp }),

  voters: (q: VoterListQuery) => call<VoterPage>("GET", `/admin/voters${qs({ ...q })}`),
  createVoter: (v: { name: string; email: string; password: string; constituencyCode: string }) => call<{ voter: AdminVoter }>("POST", "/admin/voters", v),
  updateVoter: (id: string, changes: Partial<Pick<AdminVoter, "name" | "email" | "constituencyCode" | "status">>) => call<{ voter: AdminVoter }>("PATCH", `/admin/voters/${id}`, changes),
  deleteVoter: (id: string) => call<void>("DELETE", `/admin/voters/${id}`),
  resetVoterPassword: (id: string, newPassword: string) => call<void>("POST", `/admin/voters/${id}/password-reset`, { newPassword }),

  constituencies: () => call<{ constituencies: AdminConstituency[] }>("GET", "/admin/constituencies"),
  addConstituency: (code: string, name: string) => call<{ txHash: string; constituency: AdminConstituency }>("POST", "/admin/constituencies", { code, name }),

  candidates: (constituencyCode?: string) => call<{ candidates: AdminCandidate[] }>("GET", `/admin/candidates${qs({ constituencyCode })}`),
  addCandidate: (name: string, constituencyCode: string) => call<{ txHash: string; candidate: AdminCandidate }>("POST", "/admin/candidates", { name, constituencyCode }),
};
