/**
 * Every tunable of the in-browser face pipeline in ONE place. The identity pipeline (alignment targets, model input, descriptor
 * size) must match docs/BIOMETRICS.md and backend-api/src/biometrics/constants.js exactly: change it only together with the backend.
 * The guidance and liveness numbers below are PROVISIONAL and need tuning on real booth-camera footage.
 */

/** Served by VoteChain itself (frontend/public/face, prepared by `npm run face:setup`). Nothing is fetched from a third party. */
export const ASSETS = {
  humanModels: "/face/human/",
  wasm: "/face/wasm/",
  ghostnet: "/face/ghostnet/insightface-ghostnet-strides1.json",
} as const;

/** Descriptor contract (backend: DESCRIPTOR_LENGTH). */
export const DESCRIPTOR_LENGTH = 512;
/** Enrolment sample counts (backend: MIN_SAMPLES / MAX_SAMPLES). */
export const MIN_SAMPLES = 3;
export const MAX_SAMPLES = 5;

/** ArcFace/InsightFace 112x112 five-point template: [left eye, right eye, nose tip, left mouth corner, right mouth corner] (image coordinates). */
export const ALIGN_TARGET: readonly (readonly [number, number])[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];
export const CROP_SIZE = 112;

/**
 * Human 468-point mesh indices. "Left"/"right" are positions in the IMAGE as the camera delivers it (never mirrored): the eye on
 * the left of the image, and so on. Eye centre = midpoint of the two corner points.
 */
export const MESH = {
  eyeLeftCorners: [33, 133],
  eyeRightCorners: [362, 263],
  noseTip: 1,
  mouthLeft: 61,
  mouthRight: 291,
  // eye-openness (eye aspect ratio): outer corner, inner corner, upper lid, lower lid
  earLeft: { outer: 33, inner: 133, upper: 159, lower: 145 },
  earRight: { outer: 263, inner: 362, upper: 386, lower: 374 },
} as const;

/** What counts as a usable position in front of the booth camera. Deliberately forgiving: this is a voting booth, not a passport photo. */
export const POSITION = {
  minFaceHeightRatio: 0.28, // face box height / frame height
  maxFaceHeightRatio: 0.85,
  maxCentreOffset: 0.22, // face centre vs frame centre, as a fraction of the frame width/height
  ignoreFacesBelowHeightRatio: 0.1, // a face smaller than this is background, not a second person at the terminal
  stableFramesNeeded: 3, // consecutive acceptable frames before a challenge is requested or a sample captured
  frameIntervalMs: 90, // pause between analysed frames
} as const;

/** Liveness hints (ADVISORY ONLY; the server cannot verify them). */
export const LIVENESS = {
  // BLINK
  baselineSamples: 6, // open-eye frames needed before a blink can be recognised
  blinkClosedRatio: 0.62, // eye openness below baseline * ratio = closed
  blinkReopenRatio: 0.85, // back above baseline * ratio = open again
  blinkMaxClosedMs: 1200,
  // TURN
  turnThreshold: 0.2, // |yaw ratio - neutral| to count as turned (ratio is nose offset / eye distance)
  turnFramesNeeded: 2,
  frontalThreshold: 0.1, // |yaw ratio - neutral| below this = looking at the camera
} as const;

/** After the requested action is seen, the voter looks straight ahead and the descriptor is taken from a settled frame. */
export const CAPTURE = {
  settleFramesNeeded: 3,
  settleTimeoutMs: 6000,
  minRemainingChallengeMs: 3500, // below this the challenge is replaced rather than risking an expired verify
} as const;

/** Enrolment (admin): two consecutive samples this similar are treated as the same frame and refused. */
export const ENROL = {
  duplicateSimilarity: 0.9995,
  minGapMs: 700,
} as const;

export type LivenessAction = "BLINK" | "TURN_LEFT" | "TURN_RIGHT";
