import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isApiError } from "../../api/http";
import { publicApi } from "../../api/publicApi";
import type { ElectionPhase, VoterStatus } from "../../api/types";
import { voterApi } from "../../api/voterApi";

/**
 * What the kiosk knows. The authoritative voter stage lives on the SERVER; this only mirrors the last GET /voter/status
 * in memory. Nothing is written to localStorage / sessionStorage, so a refresh simply asks the server again.
 */
export type KioskState =
  | { kind: "loading" }
  | { kind: "anonymous"; electionPhase: ElectionPhase | null; notice?: string }
  | { kind: "session"; status: VoterStatus }
  | { kind: "ended"; reason: "expired" | "closed" }
  | { kind: "unavailable" };

interface KioskApi {
  state: KioskState;
  /** Re-read the server stage (also used after every step). */
  refresh: () => Promise<void>;
  /** End the session on the server and return to the welcome screen. */
  finish: () => Promise<void>;
  /** The server told us the session is gone. */
  sessionLost: (reason?: "expired" | "closed") => void;
}

const Ctx = createContext<KioskApi | null>(null);

export function KioskSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<KioskState>({ kind: "loading" });
  const seq = useRef(0);

  /** Show the welcome screen at once (never leave the previous voter's screen up), then learn the election phase. */
  const toAnonymous = useCallback(async (notice?: string) => {
    setState({ kind: "anonymous", electionPhase: null, notice });
    try {
      const { phase } = await publicApi.election();
      setState((s) => (s.kind === "anonymous" ? { ...s, electionPhase: phase } : s));
    } catch {
      // the welcome screen copes with an unknown phase
    }
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const status = await voterApi.status();
      if (mine === seq.current) setState({ kind: "session", status });
    } catch (err) {
      if (mine !== seq.current) return;
      if (isApiError(err) && (err.status === 401 || err.code === "UNAUTHENTICATED" || err.code === "SESSION_EXPIRED")) {
        await toAnonymous(err.code === "SESSION_EXPIRED" ? "Your session timed out. If you have not voted, please start again." : undefined);
      } else if (isApiError(err) && (err.code === "ELECTION_CLOSED" || err.code === "ELECTION_NOT_OPEN")) {
        setState({ kind: "ended", reason: "closed" });
      } else {
        setState({ kind: "unavailable" });
      }
    }
  }, [toAnonymous]);

  const finish = useCallback(async () => {
    seq.current++;
    try {
      await voterApi.logout();
    } catch {
      // the cookie is cleared by the server when it can; either way we go back to the start
    }
    await toAnonymous();
  }, [toAnonymous]);

  const sessionLost = useCallback(
    (reason: "expired" | "closed" = "expired") => {
      seq.current++;
      if (reason === "closed") setState({ kind: "ended", reason });
      else void toAnonymous("Your session timed out. If you have not voted, please start again.");
    },
    [toAnonymous],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ state, refresh, finish, sessionLost }), [state, refresh, finish, sessionLost]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useKiosk(): KioskApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useKiosk must be used inside KioskSessionProvider");
  return v;
}
