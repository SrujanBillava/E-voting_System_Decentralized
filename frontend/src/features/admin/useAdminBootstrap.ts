import { useCallback, useEffect, useState } from "react";
import { adminSession, useAdminSession } from "../../api/adminSession";

/**
 * Restores the admin session (refresh cookie) once and exposes it. If the server cannot be reached the session stays
 * "unknown" (it is NOT treated as signed out), so `unreachable` lets the caller offer a retry instead of spinning forever.
 */
export function useAdminBootstrap() {
  const session = useAdminSession();
  const [failed, setFailed] = useState(false);

  const run = useCallback((again: boolean) => {
    const done = again ? adminSession.refresh().then(() => undefined) : adminSession.bootstrap();
    void done.then(() => {
      if (adminSession.getSnapshot().status === "unknown") setFailed(true);
    });
  }, []);

  useEffect(() => {
    run(false);
  }, [run]);

  const retry = useCallback(() => {
    setFailed(false);
    run(true);
  }, [run]);

  return { ...session, unreachable: failed && session.status === "unknown", retry };
}
