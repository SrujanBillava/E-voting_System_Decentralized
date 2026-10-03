import { useSyncExternalStore } from "react";
import { ApiError, request } from "./http";
import type { AdminProfile } from "./types";

/**
 * Admin session store, deliberately OUTSIDE React so it is safe under StrictMode double effects and concurrent requests.
 * The access token lives only in this module's memory (never localStorage / sessionStorage); the rotating refresh token is
 * an HttpOnly cookie that JavaScript cannot read. There is exactly ONE refresh in flight at any time.
 */
export type AdminAuthStatus = "unknown" | "authenticated" | "anonymous";
interface Snapshot {
  status: AdminAuthStatus;
  admin: AdminProfile | null;
}

let accessToken: string | null = null;
let snapshot: Snapshot = { status: "unknown", admin: null };
let refreshing: Promise<boolean> | null = null;
/** Incremented by login/logout: a refresh that was already in flight when the session changed must not undo that change. */
let epoch = 0;
let bootstrapping: Promise<void> | null = null;
const listeners = new Set<() => void>();

const publish = (next: Snapshot) => {
  snapshot = next;
  listeners.forEach((l) => l());
};
const setSession = (token: string, admin: AdminProfile) => {
  accessToken = token;
  publish({ status: "authenticated", admin });
};
const clearSession = () => {
  accessToken = null;
  publish({ status: "anonymous", admin: null });
};

interface SessionPayload {
  accessToken: string;
  admin: AdminProfile;
}

export const adminSession = {
  getToken: () => accessToken,
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** Restores the session after a page load, using the refresh cookie. Safe to call many times. */
  bootstrap(): Promise<void> {
    if (snapshot.status !== "unknown") return Promise.resolve();
    bootstrapping ??= adminSession.refresh().then(() => undefined);
    return bootstrapping;
  },

  async login(email: string, password: string, totp: string): Promise<void> {
    const data = await request<SessionPayload>("POST", "/admin/auth/login", { body: { email, password, totp } });
    epoch++;
    setSession(data.accessToken, data.admin);
  },

  /** Single-flight. Resolves true when a new access token is held, false (and the session is cleared) when refresh failed. */
  refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      const started = epoch;
      try {
        const data = await request<SessionPayload>("POST", "/admin/auth/refresh");
        if (epoch !== started) return false; // signed out / signed in again meanwhile: this result is stale
        setSession(data.accessToken, data.admin);
        return true;
      } catch (err) {
        if (epoch !== started) return false;
        // Only a definite "not authenticated" ends the session. A network failure, a 5xx, a rate limit or a proxy error is transient:
        // keep what we have and let the caller decide.
        if (err instanceof ApiError && (err.code === "NETWORK" || err.status >= 500 || err.status === 429)) return false;
        clearSession();
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  },

  async logout(): Promise<void> {
    epoch++;
    try {
      await request<void>("POST", "/admin/auth/logout");
    } catch {
      // the local session is cleared regardless
    }
    clearSession();
  },
};

export function useAdminSession(): Snapshot {
  return useSyncExternalStore(adminSession.subscribe, adminSession.getSnapshot, adminSession.getSnapshot);
}
