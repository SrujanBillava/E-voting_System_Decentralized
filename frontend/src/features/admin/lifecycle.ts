import type { AdminElection } from "../../api/types";

export type LifecycleKind = "open" | "close";

/** What an open attempt is blocked by, mirroring the backend: any failed check, or an election.config check that is not a clean pass. */
export function openBlockers(election: AdminElection): { failed: string[]; warned: string[]; configNotReady: boolean; blocked: boolean } {
  const checks = election.preflight.checks;
  const config = checks.find((c) => c.name === "election.config");
  const failed = checks.filter((c) => c.status === "fail").map((c) => c.name);
  const warned = checks.filter((c) => c.status === "warn").map((c) => c.name);
  const configNotReady = config?.status !== "pass";
  return { failed, warned, configNotReady, blocked: !election.preflight.ok || failed.length > 0 || configNotReady };
}
