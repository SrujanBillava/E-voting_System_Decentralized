/**
 * Application-level audit trail. record() never throws (an audit failure must not break the request,
 * and is logged), and only whitelisted, primitive metadata is stored: never passwords, codes,
 * tokens, secrets or keys.
 */
const META_KEYS = new Set(["reason", "phase", "failedChecks", "email", "voterDbId", "voterId", "changedFields", "constituencyCode", "candidateId", "name", "attempt", "score", "sampleCount", "liveness"]);

export function createAuditService({ AuditLog, logger, now = Date.now }) {
  const safeMeta = (meta = {}) => {
    const out = {};
    for (const [k, v] of Object.entries(meta)) {
      if (!META_KEYS.has(k)) continue;
      if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string").slice(0, 30).map((x) => x.slice(0, 80));
      else if (["string", "number", "boolean"].includes(typeof v)) out[k] = typeof v === "string" ? v.slice(0, 200) : v;
    }
    return out;
  };

  return {
    async record({ action, result, adminId = null, requestId = null, ip = null, txHash = null, meta }) {
      try {
        await AuditLog.create({ at: new Date(now()), action, result, adminId, requestId, ip, txHash, meta: safeMeta(meta) });
      } catch (err) {
        logger.error({ action, err }, "audit write failed");
      }
    },
  };
}
