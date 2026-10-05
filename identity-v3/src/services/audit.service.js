/**
 * The identity service's audit trail: STRUCTURED LOG LINES, not database rows. A database row about a voter with a timestamp would be exactly the precise,
 * voter-linked issuance metadata this service must not keep. Lines name a session reference at most (a short hash that cannot be turned back into a voter once
 * the session is deleted), never a voter id, a commitment, a batch or a transaction of a voter.
 */
export function createAuditService({ logger }) {
  return {
    record({ action, result, requestId = null, sessionRef = null, meta = {} }) {
      logger.info({ audit: true, action, result, requestId, sessionRef, ...meta }, "audit");
    },
  };
}
