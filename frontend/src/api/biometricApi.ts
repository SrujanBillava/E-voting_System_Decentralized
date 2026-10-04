import { request } from "./http";

/** The face endpoints (backend: docs/BIOMETRICS.md). The browser sends numbers only: never an image. */
export interface FaceStatus {
  enrolled: boolean;
  verified: boolean;
  attemptsLeft: number;
  locked: boolean;
}
export interface FaceChallenge {
  challenge: string;
  action: "BLINK" | "TURN_LEFT" | "TURN_RIGHT";
  expiresAt: string;
  attemptsLeft: number;
}
export interface FaceVerified {
  stage: "FACE_VERIFIED";
  stageExpiresAt: string;
}
export interface Liveness {
  passed: boolean;
  real?: number;
  live?: number;
}
export interface AdminFaceInfo {
  voterId: string;
  enrolled: boolean;
  sampleCount: number;
  enrolledAt: string | null;
  algorithm: string | null;
  needsReenrolment: boolean;
}

export const voterFaceApi = {
  status: (signal?: AbortSignal) => request<FaceStatus>("GET", "/voter/face/status", { signal }),
  challenge: () => request<FaceChallenge>("POST", "/voter/face/challenge", { body: {} }),
  /** The SERVER decides. A match moves the session to FACE_VERIFIED; the caller then re-reads GET /voter/status. */
  verify: (challenge: string, descriptor: number[], liveness: Liveness) => request<FaceVerified>("POST", "/voter/face/verify", { body: { challenge, descriptor, liveness }, timeoutMs: 20_000 }),
};
