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
export const STAGE_TTL_MS = Object.freeze({ [STAGES.AUTHENTICATED]: 5 * 60 * 1000 });
