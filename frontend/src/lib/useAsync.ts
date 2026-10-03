import { useCallback, useEffect, useRef, useState } from "react";
import { isApiError, type ApiError } from "../api/http";

export type AsyncState<T> = { status: "loading"; data: T | null; error: null } | { status: "ready"; data: T; error: null } | { status: "error"; data: T | null; error: ApiError };

type Settled<T> = { key: string; status: "ready"; data: T } | { key: string; status: "error"; error: ApiError };

/**
 * Loads something on mount, when `deps` change, and on `reload`. A superseded request is aborted and a stale response never
 * overwrites a newer one. "Loading" is DERIVED (the settled result belongs to an older key), so no state is set synchronously
 * inside the effect. The previous data stays available while a reload is in flight.
 */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [last, setLast] = useState<T | null>(null);
  const loaderRef = useRef(loader);
  useEffect(() => {
    loaderRef.current = loader;
  });
  const key = `${tick}:${deps.map(String).join("|")}`;

  useEffect(() => {
    const controller = new AbortController();
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setLast(data);
        setSettled({ key, status: "ready", data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const error = isApiError(err) ? err : ({ name: "ApiError", message: "Something went wrong.", status: 0, code: "UNKNOWN" } as ApiError);
        setSettled({ key, status: "error", error });
      });
    return () => controller.abort();
  }, [key]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = settled && settled.key === key ? settled : null;
  if (!current) return { status: "loading", data: last, error: null, reload };
  return current.status === "ready" ? { status: "ready", data: current.data, error: null, reload } : { status: "error", data: last, error: current.error, reload };
}
