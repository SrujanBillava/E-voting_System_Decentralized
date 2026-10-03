import { useEffect } from "react";
import { voterApi } from "../../api/voterApi";

/**
 * The voter session has a short IDLE limit; thinking on the ballot or review screen must not end it. Every 50 s this repeats the
 * idempotent eligibility check (a meaningful call that changes nothing at stage ELIGIBLE and writes no audit row). The stage's own
 * deadline still applies, and errors are ignored: the next real action will report a lost session.
 */
export function useKeepAlive(): void {
  useEffect(() => {
    const id = setInterval(() => void voterApi.eligibility().catch(() => undefined), 50_000);
    return () => clearInterval(id);
  }, []);
}
