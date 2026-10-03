import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { adminApi } from "../../api/adminApi";
import { ApiError, isApiError } from "../../api/http";
import type { AdminElection } from "../../api/types";

/**
 * The ONE election query of the admin console. AdminLayout owns it and hands it to every page through the router outlet
 * context, so the header's phase indicator and the page content can never disagree. Pages call `refresh()` after any
 * mutation; the phase is only ever what the backend last reported (never flipped optimistically).
 */
export interface AdminElectionContext {
  /** The last successful response, kept while a refresh is running or has failed. */
  election: AdminElection | null;
  /** The error of the most recent request, or null when it succeeded. */
  error: ApiError | null;
  /** True until the first request has finished (successfully or not). */
  loading: boolean;
  /** True while an explicit refresh() is running. */
  refreshing: boolean;
  /** Re-reads GET /admin/election. Resolves with the fresh election, or null when the request failed. */
  refresh: () => Promise<AdminElection | null>;
}

export const toApiError = (err: unknown): ApiError => (isApiError(err) ? err : new ApiError(0, "UNKNOWN", "Something went wrong."));

/** Used once, by AdminLayout. */
export function useElectionQuery(): AdminElectionContext {
  const [state, setState] = useState<{ election: AdminElection | null; error: ApiError | null; settled: boolean }>({ election: null, error: null, settled: false });
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  const fetchOnce = useCallback(async (): Promise<AdminElection | null> => {
    const mine = ++latest.current;
    try {
      const election = await adminApi.election();
      if (mine === latest.current) setState({ election, error: null, settled: true });
      return election;
    } catch (err) {
      if (mine === latest.current) setState((s) => ({ election: s.election, error: toApiError(err), settled: true }));
      return null;
    }
  }, []);

  useEffect(() => {
    void fetchOnce();
  }, [fetchOnce]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      return await fetchOnce();
    } finally {
      setRefreshing(false);
    }
  }, [fetchOnce]);

  return useMemo(() => ({ election: state.election, error: state.error, loading: !state.settled, refreshing, refresh }), [state, refreshing, refresh]);
}

/** For pages rendered inside AdminLayout. */
export function useAdminElection(): AdminElectionContext {
  return useOutletContext<AdminElectionContext>();
}

/** Backend code for "the election left Setup while you were editing". */
export const isLockedError = (err: unknown): boolean => isApiError(err) && err.code === "ELECTION_LOCKED";
