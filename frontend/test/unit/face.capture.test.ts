import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { boundedFrameSize, MAX_FRAME_SIDE, snapshotFrame } from "../../src/features/face/snapshot.ts";
import { alignmentFor, applySimilarity } from "../../src/features/face/align.ts";
import { ALIGN_TARGET, CAPTURE, LIVENESS } from "../../src/features/face/config.ts";
import { CaptureReadiness } from "../../src/features/face/capture.ts";
import { LivenessTracker } from "../../src/features/face/liveness.ts";
import { HumanGhostNetEngine } from "../../src/features/face/humanEngine.ts";
import { FaceEngineError, type FaceMeasurement, type FrameSource } from "../../src/features/face/types.ts";

function canvasFixture(t: TestContext) {
  const draws: unknown[][] = [];
  const canvases: { width: number; height: number; getContext: () => unknown }[] = [];
  class Video { videoWidth = 7680; videoHeight = 4320; }
  class Image { naturalWidth = 6000; naturalHeight = 8000; }
  const values = {
    HTMLVideoElement: Video, HTMLImageElement: Image,
    document: { createElement: () => {
      const canvas = { width: 0, height: 0, getContext: () => ({ imageSmoothingEnabled: false, drawImage: (...args: unknown[]) => draws.push(args) }) };
      canvases.push(canvas);
      return canvas;
    } },
  };
  for (const [key, value] of Object.entries(values)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (before) Object.defineProperty(globalThis, key, before); else Reflect.deleteProperty(globalThis, key); });
  }
  return { Video, Image, draws, canvases };
}

const measurement = (eyeOpenness = 0.3, yawRatio = 0): FaceMeasurement => ({
  faceCount: 1, frame: { width: 1280, height: 720 },
  face: { box: { x: 496, y: 180, width: 288, height: 360 }, eyeOpenness, yawRatio, landmarks5: [] },
});
function blink() {
  const tracker = new LivenessTracker("BLINK");
  for (let i = 0; i < LIVENESS.baselineSamples; i++) tracker.push({ t: i * 100, faceCount: 1, eyeOpenness: 0.3 });
  tracker.push({ t: 700, faceCount: 1, eyeOpenness: 0.1 });
  return tracker;
}
function completeBlink() {
  const tracker = blink();
  tracker.push({ t: 800, faceCount: 1, eyeOpenness: 0.3 });
  return tracker;
}

describe("bounded shared frame snapshot", () => {
  it("keeps ordinary camera frames unchanged and bounds 4K, 8K, portrait and extreme sizes", () => {
    assert.deepEqual(boundedFrameSize(1280, 720), { width: 1280, height: 720 });
    for (const [w, h] of [[3840, 2160], [3841, 2161], [7680, 4320], [6000, 8000], [100000, 100000], [Number.MAX_SAFE_INTEGER, 1]]) {
      const size = boundedFrameSize(w, h);
      assert.ok(size.width <= MAX_FRAME_SIDE && size.height <= MAX_FRAME_SIDE);
      assert.ok(size.width > 0 && size.height > 0);
      const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(w, h));
      assert.ok(Math.abs(size.width - w * scale) <= 1 && Math.abs(size.height - h * scale) <= 1, "uniform scale within pixel rounding");
    }
  });
  it("rejects unavailable or invalid dimensions before allocating a canvas", (t) => {
    const { canvases } = canvasFixture(t);
    for (const value of [0, -1, NaN, Infinity, 0.5]) {
      assert.throws(() => snapshotFrame({ width: value, height: 720 } as FrameSource), FaceEngineError);
      assert.throws(() => boundedFrameSize(1280, value), FaceEngineError);
    }
    assert.equal(canvases.length, 0);
  });
  it("draws video, image, canvas and bitmap sources straight into a bounded canvas", (t) => {
    const { Video, Image, draws, canvases } = canvasFixture(t);
    for (const source of [new Video(), new Image(), { width: 8000, height: 8000 }, { width: 9000, height: 6000 }]) {
      const frame = snapshotFrame(source as FrameSource);
      assert.ok(frame.width <= MAX_FRAME_SIDE && frame.height <= MAX_FRAME_SIDE);
      assert.deepEqual(draws.at(-1), [source, 0, 0, frame.width, frame.height]);
    }
    assert.equal(canvases.length, 4, "no full-resolution intermediate canvas");
  });
  it("keeps the five-point alignment consistent in the downscaled coordinate space", () => {
    const size = boundedFrameSize(7680, 4320);
    const scale = size.width / 7680;
    const original = ALIGN_TARGET.map(([x, y]) => ({ x: x * 20 + 1600, y: y * 20 + 300 }));
    const small = original.map(({ x, y }) => ({ x: x * scale, y: y * scale }));
    const fullTransform = alignmentFor(original);
    const smallTransform = alignmentFor(small);
    original.forEach((point, i) => {
      const full = applySimilarity(fullTransform, point);
      const bounded = applySimilarity(smallTransform, small[i]);
      assert.ok(Math.hypot(full.x - bounded.x, full.y - bounded.y) < 1e-9);
    });
  });
});

describe("blink to open-eye identity capture", () => {
  it("does not settle before a complete blink (open, closed, reopened)", () => {
    const tracker = blink();
    const capture = new CaptureReadiness(tracker);
    for (let i = 0; i < 10; i++) assert.equal(capture.push(measurement(0.1)), false);
    assert.equal(capture.accepts(measurement()), false, "open measurement alone cannot complete the challenge");
    tracker.push({ t: 900, faceCount: 1, eyeOpenness: 0.3 });
    for (let i = 1; i <= CAPTURE.settleFramesNeeded; i++) assert.equal(capture.push(measurement()), i === CAPTURE.settleFramesNeeded);
  });
  it("requires consecutive open frames and resets if eyes close or only partly reopen", () => {
    const capture = new CaptureReadiness(completeBlink());
    assert.equal(capture.push(measurement()), false);
    assert.equal(capture.push(measurement()), false);
    for (const ear of [0.1, 0.24, NaN, Infinity]) assert.equal(capture.push(measurement(ear)), false);
    for (let i = 1; i <= CAPTURE.settleFramesNeeded; i++) assert.equal(capture.push(measurement()), i === CAPTURE.settleFramesNeeded);
    assert.equal(capture.accepts(measurement(0.1)), false, "a second blink at capture time is rejected");
  });
  it("resets settling when the face disappears, another face enters, or the head turns", () => {
    const capture = new CaptureReadiness(completeBlink());
    const invalid = [measurement(0.3, 0.4), { ...measurement(), faceCount: 0 }, { ...measurement(), faceCount: 2 }, { ...measurement(), face: undefined }];
    for (const m of invalid) {
      capture.push(measurement()); capture.push(measurement());
      assert.equal(capture.push(m), false);
      assert.equal(capture.push(measurement()), false);
    }
  });
  it("steady open eyes cannot bypass the actual blink requirement", () => {
    const tracker = new LivenessTracker("BLINK");
    const capture = new CaptureReadiness(tracker);
    for (let i = 0; i < 50; i++) {
      tracker.push({ t: i * 100, faceCount: 1, eyeOpenness: 0.3 });
      assert.equal(capture.push(measurement()), false);
    }
  });
  it("retains the requested turn and neutral-facing requirements", () => {
    for (const action of ["TURN_LEFT", "TURN_RIGHT"] as const) {
      const tracker = new LivenessTracker(action);
      const capture = new CaptureReadiness(tracker);
      for (let i = 0; i < LIVENESS.baselineSamples; i++) tracker.push({ t: i * 100, faceCount: 1, yawRatio: 0 });
      assert.equal(capture.accepts(measurement()), false);
      for (let i = 0; i < LIVENESS.turnFramesNeeded; i++) tracker.push({ t: 800 + i * 100, faceCount: 1, yawRatio: action === "TURN_LEFT" ? 0.3 : -0.3 });
      assert.equal(capture.accepts(measurement(0.3, 0.3)), false);
      for (let i = 1; i <= CAPTURE.settleFramesNeeded; i++) assert.equal(capture.push(measurement()), i === CAPTURE.settleFramesNeeded);
    }
  });
  it("production engine measures the bounded frame and refuses closed eyes before GhostNet inference", async (t) => {
    const { Video, canvases } = canvasFixture(t);
    const engine = new HumanGhostNetEngine();
    let inferences = 0;
    // Synthetic Human landmarks; the tested snapshot, analysis, EAR and pre-inference gate are production code.
    const mesh = Array.from({ length: 478 }, () => [900, 500, 0]);
    for (const [i, x, y] of [[33, 850, 450], [133, 890, 450], [362, 1030, 450], [263, 1070, 450], [159, 870, 448], [145, 870, 452], [386, 1050, 448], [374, 1050, 452], [1, 960, 520], [61, 900, 620], [291, 1020, 620]]) mesh[i] = [x, y, 0];
    Object.assign(engine, {
      human: { detect: async (frame: { width: number; height: number }) => {
        assert.deepEqual({ width: frame.width, height: frame.height }, { width: 1920, height: 1080 });
        return { face: [{ box: [744, 270, 432, 540], mesh }] };
      } },
      runModel: async () => { inferences++; return []; },
    });
    const capture = new CaptureReadiness(completeBlink());
    for (let i = 0; i < CAPTURE.settleFramesNeeded; i++) capture.push(measurement());
    await assert.rejects(engine.describe(new Video() as unknown as FrameSource, capture.accepts), (e) => e instanceof FaceEngineError && e.kind === "no-face");
    assert.equal(inferences, 0);
    assert.equal(canvases.length, 1, "rejected before even allocating the aligned crop");
  });
});
