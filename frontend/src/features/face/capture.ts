import { CAPTURE } from "./config.ts";
import { positionGuidance } from "./guidance.ts";
import { isFrontal, LivenessTracker } from "./liveness.ts";
import type { FaceMeasurement } from "./types.ts";

/** Consecutive usable frames after the action; BLINK must remain open through identity capture. */
export class CaptureReadiness {
  private stable = 0;
  private tracker: LivenessTracker;

  constructor(tracker: LivenessTracker) {
    this.tracker = tracker;
  }

  accepts = (m: FaceMeasurement): boolean =>
    this.tracker.observed && positionGuidance(m).ok && m.face !== undefined &&
    isFrontal(m.face.yawRatio, this.tracker.neutralYaw) &&
    (this.tracker.action !== "BLINK" || this.tracker.eyesOpen(m.face.eyeOpenness));

  push(m: FaceMeasurement): boolean {
    this.stable = this.accepts(m) ? this.stable + 1 : 0;
    return this.stable >= CAPTURE.settleFramesNeeded;
  }
}
