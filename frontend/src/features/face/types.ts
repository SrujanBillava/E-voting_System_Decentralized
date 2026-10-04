export interface Point {
  x: number;
  y: number;
}

/** Anything a frame can be read from. */
export type FrameSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | ImageBitmap;

/**
 * What the engine learned from one frame. All coordinates are in pixels of the frame exactly as the camera delivered it (not mirrored).
 * Ratios are unit-free so they do not depend on the camera resolution.
 */
export interface FaceMeasurement {
  faceCount: number;
  frame: { width: number; height: number };
  /** Present when exactly one face was found. */
  face?: {
    box: { x: number; y: number; width: number; height: number };
    /** Mean eye aspect ratio of both eyes (measured: open 0.27-0.51, closed 0.13-0.17). */
    eyeOpenness: number;
    /** (nose - eye midpoint) / eye distance along the image x axis. Positive = nose toward the RIGHT of the image = the voter turned to THEIR left. */
    yawRatio: number;
    /** [left eye, right eye, nose, mouth left, mouth right] in frame pixels. */
    landmarks5: Point[];
  };
}

export interface FaceEngine {
  /** "human-ghostnet" is the production engine; "e2e-fake" exists only in test builds. */
  readonly kind: "human-ghostnet" | "e2e-fake";
  load(): Promise<void>;
  measure(source: FrameSource): Promise<FaceMeasurement>;
  /** Detect, align, run GhostNet: a validated 512-number descriptor of the single face in the frame. */
  describe(source: FrameSource): Promise<{ descriptor: number[]; measurement: FaceMeasurement }>;
  dispose(): void;
}

export class FaceEngineError extends Error {
  readonly kind: "load" | "no-face" | "many-faces" | "invalid-descriptor" | "inference";
  constructor(kind: FaceEngineError["kind"], message: string) {
    super(message);
    this.name = "FaceEngineError";
    this.kind = kind;
  }
}
