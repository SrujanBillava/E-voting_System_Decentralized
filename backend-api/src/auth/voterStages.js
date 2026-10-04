/** The voting journey as a linear stage machine. Everything compares stages through this module. */
export const STAGES = Object.freeze({
  AUTHENTICATED: "AUTHENTICATED",
  FACE_VERIFIED: "FACE_VERIFIED",
  ELIGIBLE: "ELIGIBLE",
  AUTH_ISSUED: "AUTH_ISSUED",
  SUBMITTED: "SUBMITTED",
  COMPLETED: "COMPLETED",
});
export const STAGE_ORDER = Object.freeze(Object.values(STAGES));
export const isStage = (value) => STAGE_ORDER.includes(value);

/** Only the next stage is reachable; nothing ever moves backwards. */
export const canTransition = (from, to) => isStage(from) && isStage(to) && STAGE_ORDER.indexOf(to) === STAGE_ORDER.indexOf(from) + 1;

// Lifetimes in one place (milliseconds).
export const SESSION_ABSOLUTE_MS = 15 * 60 * 1000;
export const SESSION_IDLE_MS = 120 * 1000;
/** How long an issued authorization / the AUTH_ISSUED stage lives. */
export const AUTHORIZATION_TTL_MS = 180 * 1000;
/** The receipt screen is short-lived on purpose: a kiosk session must not stay authenticated after the vote. */
export const COMPLETED_TTL_MS = 60 * 1000;
export const STAGE_TTL_MS = Object.freeze({ [STAGES.AUTHENTICATED]: 5 * 60 * 1000, [STAGES.ELIGIBLE]: 3 * 60 * 1000, [STAGES.AUTH_ISSUED]: AUTHORIZATION_TTL_MS, [STAGES.SUBMITTED]: 10 * 60 * 1000, [STAGES.COMPLETED]: COMPLETED_TTL_MS, [STAGES.FACE_VERIFIED]: 3 * 60 * 1000 /* = FACE_VERIFIED_TTL_MS in biometrics/constants.js (a unit test keeps them equal) */ });
/** Receipt / recovery actions may continue in a Closed election, but only for sessions that already reached the chain. */
export const CLOSED_OK_STAGES = Object.freeze([STAGES.AUTH_ISSUED, STAGES.SUBMITTED, STAGES.COMPLETED]);
