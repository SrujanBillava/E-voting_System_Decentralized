/**
 * The V3 identity journey as a linear stage machine. Everything compares stages through this module.
 *
 *   AUTHENTICATED -> FACE_VERIFIED -> ELIGIBLE -> COMMITMENT_PENDING -> CREDENTIAL_ISSUED
 *
 * CREDENTIAL_ISSUED is TERMINAL: the identity session ends there. There is deliberately no SUBMITTED and no COMPLETED stage (those are V2 stages):
 * this service has no knowledge of ballot submission at all.
 */
export const STAGES = Object.freeze({
  AUTHENTICATED: "AUTHENTICATED",
  FACE_VERIFIED: "FACE_VERIFIED",
  ELIGIBLE: "ELIGIBLE",
  COMMITMENT_PENDING: "COMMITMENT_PENDING",
  CREDENTIAL_ISSUED: "CREDENTIAL_ISSUED",
});
export const STAGE_ORDER = Object.freeze(Object.values(STAGES));
export const isStage = (value) => STAGE_ORDER.includes(value);

/** Only the next stage is reachable; nothing ever moves backwards. */
export const canTransition = (from, to) => isStage(from) && isStage(to) && STAGE_ORDER.indexOf(to) === STAGE_ORDER.indexOf(from) + 1;

// Lifetimes in one place (milliseconds).
export const SESSION_ABSOLUTE_MS = 15 * 60 * 1000;
export const SESSION_IDLE_MS = 120 * 1000;
/** The terminal stage lives only long enough to deliver the issuance result once. The session is deleted on delivery, or purged when this passes. */
export const ISSUED_TTL_MS = 60 * 1000;
export const STAGE_TTL_MS = Object.freeze({
  [STAGES.AUTHENTICATED]: 5 * 60 * 1000,
  [STAGES.FACE_VERIFIED]: 3 * 60 * 1000 /* = FACE_VERIFIED_TTL_MS of the V2 biometrics constants (a unit test keeps them equal) */,
  [STAGES.ELIGIBLE]: 3 * 60 * 1000,
  [STAGES.COMMITMENT_PENDING]: 5 * 60 * 1000,
  [STAGES.CREDENTIAL_ISSUED]: ISSUED_TTL_MS,
});
