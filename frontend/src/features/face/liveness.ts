import { LIVENESS, type LivenessAction } from "./config.ts";

export interface LivenessSample {
  /** milliseconds, any monotonic clock */
  t: number;
  faceCount: number;
  eyeOpenness?: number;
  yawRatio?: number;
}

/**
 * Recognises the requested action in a stream of measurements. ADVISORY: it guides the voter and decides when to capture; the server
 * cannot verify it and a modified browser can fake it, so nothing here is a proof of liveness.
 */
export class LivenessTracker {
  readonly action: LivenessAction;
  private opens: number[] = [];
  private baseline: number | null = null;
  private closedSince: number | null = null;
  private sawClosed = false;
  private closedTooLong = false;
  private neutral: number | null = null;
  private neutralSamples: number[] = [];
  private turnedFrames = 0;
  private done = false;

  constructor(action: LivenessAction) {
    this.action = action;
  }

  get observed(): boolean {
    return this.done;
  }

  /** Feed one measurement. Returns true once the requested action has been seen (and stays true). */
  push(s: LivenessSample): boolean {
    if (this.done) return true;
    if (s.faceCount !== 1) return false; // the action only counts with exactly one face in view
    if (this.action === "BLINK") this.pushBlink(s);
    else this.pushTurn(s);
    return this.done;
  }

  private pushBlink(s: LivenessSample) {
    if (s.eyeOpenness === undefined) return;
    const e = s.eyeOpenness;
    if (this.baseline === null) {
      // Establish what "open" looks like for THIS person before any blink can count.
      this.opens.push(e);
      if (this.opens.length >= LIVENESS.baselineSamples) {
        const sorted = [...this.opens].sort((a, b) => a - b);
        this.baseline = sorted[Math.floor(sorted.length * 0.75)];
      }
      return;
    }
    if (e < this.baseline * LIVENESS.blinkClosedRatio) {
      this.closedSince ??= s.t;
      this.sawClosed = true;
      // Eyes shut for a long time is not a blink: it must not count even after the eyes open again.
      if (s.t - this.closedSince > LIVENESS.blinkMaxClosedMs) this.closedTooLong = true;
    } else if (e > this.baseline * LIVENESS.blinkReopenRatio) {
      if (this.sawClosed && !this.closedTooLong) this.done = true;
      this.sawClosed = false;
      this.closedTooLong = false;
      this.closedSince = null;
    }
  }

  private pushTurn(s: LivenessSample) {
    if (s.yawRatio === undefined) return;
    if (this.neutral === null) {
      this.neutralSamples.push(s.yawRatio);
      if (this.neutralSamples.length >= LIVENESS.baselineSamples) {
        const sorted = [...this.neutralSamples].sort((a, b) => a - b);
        this.neutral = sorted[Math.floor(sorted.length / 2)];
      }
      return;
    }
    // Positive yaw ratio = the nose moved toward the image's right = the voter turned toward THEIR left.
    const direction = this.action === "TURN_LEFT" ? 1 : -1;
    const turned = (s.yawRatio - this.neutral) * direction >= LIVENESS.turnThreshold;
    this.turnedFrames = turned ? this.turnedFrames + 1 : 0;
    if (this.turnedFrames >= LIVENESS.turnFramesNeeded) this.done = true;
  }

  /** The neutral (frontal) yaw ratio learned while waiting, used to judge "looking straight" afterwards. */
  get neutralYaw(): number | null {
    return this.neutral;
  }
}

export const isFrontal = (yaw: number, neutral: number | null): boolean => Math.abs(yaw - (neutral ?? 0)) <= LIVENESS.frontalThreshold;
