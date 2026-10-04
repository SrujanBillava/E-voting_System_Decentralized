import { DESCRIPTOR_LENGTH } from "./config.ts";
import { FaceEngineError, type FaceEngine, type FaceMeasurement, type FrameSource } from "./types.ts";

/**
 * TEST-ONLY engine. It is imported exclusively behind `import.meta.env.VITE_E2E_FACE === "1"` (see engine.ts), a build-time constant,
 * so a normal build contains neither this file nor any trace of it. The browser tests drive it through `window.__E2E_FACE__`.
 *
 * It plays the part of a person standing at the booth: the "face" blinks, turns left and turns right in a repeating 6 second cycle,
 * and returns whatever descriptor the test supplies. It exercises every line of the camera / challenge / verify flow, but NOT the neural
 * networks and NOT real landmark or pose detection: those are covered by the static-photo pipeline test and the manual webcam checklist.
 */
export interface E2EFaceScript {
  /** How many faces are in view (default 1). */
  faces?: number;
  /** What describe() returns. */
  descriptor?: number[];
  /** Make load() fail. */
  failLoad?: boolean;
  /** Make describe() fail with this kind. */
  describeError?: "no-face" | "many-faces" | "inference";
  /** The "person" never blinks or turns (to test challenge expiry). */
  noMovement?: boolean;
  /** Milliseconds load() takes (default 300). */
  loadMs?: number;
}
declare global {
  interface Window {
    __E2E_FACE__?: E2EFaceScript;
  }
}

const CYCLE_MS = 6000;
const script = (): E2EFaceScript => window.__E2E_FACE__ ?? {};

function pose(t: number): { ear: number; yaw: number } {
  const p = t % CYCLE_MS;
  if (p >= 1500 && p < 1800) return { ear: 0.1, yaw: 0 }; // blink
  if (p >= 2800 && p < 3600) return { ear: 0.3, yaw: 0.35 }; // turn to the voter's left (nose toward the image's right)
  if (p >= 4000 && p < 4800) return { ear: 0.3, yaw: -0.35 }; // turn to the voter's right
  return { ear: 0.3, yaw: 0 };
}

export class E2EFaceEngine implements FaceEngine {
  readonly kind = "e2e-fake" as const;
  private started = performance.now();

  async load(): Promise<void> {
    await new Promise((r) => setTimeout(r, script().loadMs ?? 300));
    if (script().failLoad) throw new FaceEngineError("load", "The face recognition files could not be loaded.");
  }

  private size(source: FrameSource): { width: number; height: number } {
    if (source instanceof HTMLVideoElement) return { width: source.videoWidth || 640, height: source.videoHeight || 480 };
    return { width: (source as HTMLCanvasElement).width || 640, height: (source as HTMLCanvasElement).height || 480 };
  }

  async measure(source: FrameSource): Promise<FaceMeasurement> {
    const frame = this.size(source);
    const faces = script().faces ?? 1;
    if (faces !== 1) return { faceCount: faces, frame };
    const { ear, yaw } = script().noMovement ? { ear: 0.3, yaw: 0 } : pose(performance.now() - this.started);
    const h = frame.height * 0.5;
    const w = h * 0.8;
    const cx = frame.width / 2;
    const cy = frame.height / 2;
    const eyeDistance = w * 0.45;
    const noseX = cx + yaw * eyeDistance;
    return {
      faceCount: 1,
      frame,
      face: {
        box: { x: cx - w / 2, y: cy - h / 2, width: w, height: h },
        eyeOpenness: ear,
        yawRatio: yaw,
        landmarks5: [
          { x: cx - eyeDistance / 2, y: cy - h * 0.1 },
          { x: cx + eyeDistance / 2, y: cy - h * 0.1 },
          { x: noseX, y: cy + h * 0.05 },
          { x: cx - eyeDistance * 0.3, y: cy + h * 0.25 },
          { x: cx + eyeDistance * 0.3, y: cy + h * 0.25 },
        ],
      },
    };
  }

  async describe(source: FrameSource, accept?: (measurement: FaceMeasurement) => boolean): Promise<{ descriptor: number[]; measurement: FaceMeasurement }> {
    const s = script();
    if (s.describeError) throw new FaceEngineError(s.describeError === "inference" ? "inference" : s.describeError, "Test-injected failure.");
    const measurement = await this.measure(source);
    if (measurement.faceCount === 0) throw new FaceEngineError("no-face", "No face was found.");
    if (measurement.faceCount > 1) throw new FaceEngineError("many-faces", "More than one face was found.");
    if (accept && !accept(measurement)) throw new FaceEngineError("no-face", "The capture frame was not usable.");
    if (!s.descriptor || s.descriptor.length !== DESCRIPTOR_LENGTH) throw new FaceEngineError("invalid-descriptor", "No test descriptor was provided.");
    return { descriptor: [...s.descriptor], measurement };
  }

  dispose(): void {}
}
