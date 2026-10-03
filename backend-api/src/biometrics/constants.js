/**
 * Face verification settings, all in one place.
 *
 * HONEST LIMITATION. The browser computes the face descriptor and the server only sees numbers. A modified
 * client can therefore submit any descriptor it likes, and the liveness prompt in the browser is advisory:
 * the server cannot check it. This feature is SUPERVISED FACE MATCHING, not cryptographic proof that a live
 * person is present. The real control is a polling booth with an officer watching the screen.
 */

/** The embedding model the browser runs. A template enrolled with another model must be enrolled again. */
export const FACE_MODEL = "insightface-ghostnet-strides1";

/** Numbers in one face descriptor. THE central constant for the dimension: nothing else hard-codes it. */
export const DESCRIPTOR_LENGTH = 512;

/** Largest absolute value one component may have. Raw model output stays within about +-10. */
export const DESCRIPTOR_MAX_ABS = 100;

/** A descriptor shorter than this (L2 norm) is treated as empty. */
export const DESCRIPTOR_MIN_NORM = 1e-6;

/** Samples stored per voter at enrolment. */
export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 5;

/**
 * PROVISIONAL. Cosine similarity (best of the enrolled samples) needed to accept a face.
 * Chosen on a small public photo set, where the highest score between two different people was 0.33
 * and the lowest best-of-three score for the same person was 0.42. Tune it on real booth captures.
 */
export const MATCH_THRESHOLD = 0.45;

/** At enrolment every pair of samples must be at least this similar, so one template never mixes two people. */
export const ENROLMENT_CONSISTENCY_THRESHOLD = MATCH_THRESHOLD;

/** A challenge is bound to one session, works once, and expires quickly. */
export const CHALLENGE_TTL_MS = 30 * 1000;

/** After this many failed comparisons the face step is locked for the session. */
export const MAX_FAILED_ATTEMPTS = 3;

/** Challenges one session may request (failed, expired and abandoned ones included). */
export const MAX_CHALLENGES_PER_SESSION = 10;

/** How long a session stays FACE_VERIFIED before the voter must have moved on. */
export const FACE_VERIFIED_TTL_MS = 3 * 60 * 1000;

/** Written to VoterSession.faceMethod on success. */
export const FACE_METHOD = "FACE_MATCH";

/** What the browser asks the voter to do before it captures the face. Advisory only (see above). */
export const LIVENESS_ACTIONS = Object.freeze(["BLINK", "TURN_LEFT", "TURN_RIGHT"]);

/** Version of the stored template format. */
export const TEMPLATE_VERSION = 1;
