import { performance } from "node:perf_hooks";

const TIMED_OUT = Symbol("timed out");

/** Resolves with the promise's value, or with TIMED_OUT if it has not settled after `ms`. */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Two views over the same preflight:
 *
 *  - getPublicHealth(): what the unauthenticated /health endpoint may say. Cheap, cached for a few
 *    seconds (so the endpoint cannot be used to hammer the RPC node or MongoDB), and reduced to
 *    "ok" | "degraded". Never any detail. A probe that does not finish within `probeTimeoutMs` counts
 *    as "degraded"; while such a probe is still hanging no second one is started.
 *  - getSystemPreflight(): the full structured report, always fresh. INTERNAL for now; a later
 *    step will expose it behind admin authentication. Bounded by `systemTimeoutMs`.
 *
 * The cache age uses a monotonic clock, so a wall-clock step (NTP) cannot freeze a stale answer.
 *
 * @param {{ runPreflight: (options: { deep: boolean }) => Promise<object>, ttlMs?: number, probeTimeoutMs?: number, systemTimeoutMs?: number, now?: () => number }} deps
 */
export function createHealthService({ runPreflight, ttlMs = 5000, probeTimeoutMs = 10_000, systemTimeoutMs = 300_000, now = () => performance.now() }) {
  let cached; // { at, status }
  let inFlight;
  let hung = false; // a probe that timed out and has not settled yet

  const probe = async () => {
    if (hung) return "degraded";
    const work = Promise.resolve().then(() => runPreflight({ deep: false }));
    try {
      const report = await withDeadline(work, probeTimeoutMs);
      if (report === TIMED_OUT) {
        hung = true;
        const release = () => {
          hung = false;
        };
        work.then(release, release);
        return "degraded";
      }
      return report.ok ? "ok" : "degraded";
    } catch {
      return "degraded";
    }
  };

  return {
    async getPublicHealth() {
      if (cached) {
        const age = now() - cached.at;
        if (age >= 0 && age < ttlMs) return { status: cached.status };
      }
      inFlight ??= probe()
        .then((status) => {
          cached = { at: now(), status };
          return status;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return { status: await inFlight };
    },

    async getSystemPreflight() {
      const report = await withDeadline(Promise.resolve().then(() => runPreflight({ deep: true })), systemTimeoutMs);
      if (report !== TIMED_OUT) return report;
      return {
        ok: false,
        status: "fail",
        checkedAt: new Date().toISOString(),
        checks: [{ name: "preflight", status: "fail", message: `preflight did not finish within ${systemTimeoutMs} ms` }],
      };
    },
  };
}
