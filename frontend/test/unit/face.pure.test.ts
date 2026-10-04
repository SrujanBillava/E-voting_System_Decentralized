import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alignmentFor, applySimilarity, canvasMatrix, eyeOpenness, fitSimilarity, landmarks5, yawRatio } from "../../src/features/face/align.ts";
import { ALIGN_TARGET, DESCRIPTOR_LENGTH, LIVENESS } from "../../src/features/face/config.ts";
import { compactDescriptor, cosineSimilarity, DescriptorError, validateDescriptor } from "../../src/features/face/descriptor.ts";
import { isFrontal, LivenessTracker } from "../../src/features/face/liveness.ts";

const rotate = (p: { x: number; y: number }, deg: number) => {
  const r = (deg * Math.PI) / 180;
  return { x: p.x * Math.cos(r) - p.y * Math.sin(r), y: p.x * Math.sin(r) + p.y * Math.cos(r) };
};

describe("alignment (5-point similarity transform)", () => {
  it("maps the template onto itself with the identity transform", () => {
    const from = ALIGN_TARGET.map(([x, y]) => ({ x, y }));
    const t = fitSimilarity(from, ALIGN_TARGET);
    assert.ok(Math.abs(t.a - 1) < 1e-9 && Math.abs(t.b) < 1e-9 && Math.abs(t.tx) < 1e-9 && Math.abs(t.ty) < 1e-9);
  });

  it("recovers a rotated, scaled and shifted face exactly (noise free)", () => {
    const scale = 3.7;
    const from = ALIGN_TARGET.map(([x, y]) => {
      const r = rotate({ x: x * scale, y: y * scale }, 17);
      return { x: r.x + 220, y: r.y + 95 };
    });
    const t = alignmentFor(from);
    from.forEach((p, i) => {
      const q = applySimilarity(t, p);
      assert.ok(Math.abs(q.x - ALIGN_TARGET[i][0]) < 1e-6 && Math.abs(q.y - ALIGN_TARGET[i][1]) < 1e-6, `point ${i}`);
    });
  });

  it("is a least-squares fit when the landmarks are noisy (residual stays small)", () => {
    const from = ALIGN_TARGET.map(([x, y], i) => ({ x: x * 2 + 50 + (i % 2 ? 0.4 : -0.4), y: y * 2 + 30 + (i % 3 ? 0.3 : -0.3) }));
    const t = alignmentFor(from);
    const worst = Math.max(...from.map((p, i) => Math.hypot(applySimilarity(t, p).x - ALIGN_TARGET[i][0], applySimilarity(t, p).y - ALIGN_TARGET[i][1])));
    assert.ok(worst < 1, `worst residual ${worst}`);
  });

  it("canvasMatrix reproduces applySimilarity", () => {
    const t = { a: 0.8, b: 0.3, tx: 5, ty: -7 };
    const [a, b, c, d, e, f] = canvasMatrix(t);
    const p = { x: 12, y: 34 };
    assert.deepEqual({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }, applySimilarity(t, p));
  });

  it("rejects degenerate input", () => {
    assert.throws(() => fitSimilarity([{ x: 1, y: 1 }], [[1, 1]]));
    assert.throws(() => fitSimilarity(Array(5).fill({ x: 3, y: 3 }), ALIGN_TARGET));
  });
});

describe("mesh measurements", () => {
  // a synthetic mesh where only the indices we read are meaningful
  const mesh = Array.from({ length: 478 }, () => [0, 0, 0]);
  const set = (i: number, x: number, y: number) => (mesh[i] = [x, y, 0]);
  set(33, 100, 100); set(133, 140, 100); set(362, 200, 100); set(263, 240, 100);
  set(1, 170, 140); set(61, 130, 190); set(291, 210, 190);
  set(159, 120, 94); set(145, 120, 106); // left eye: opening 12 over width 40 = 0.3
  set(386, 220, 94); set(374, 220, 106);

  it("takes the five alignment points from the right mesh indices", () => {
    const p = landmarks5(mesh);
    assert.deepEqual(p.map((q) => [q.x, q.y]), [[120, 100], [220, 100], [170, 140], [130, 190], [210, 190]]);
  });
  it("computes eye openness and a centred yaw ratio of zero", () => {
    assert.ok(Math.abs(eyeOpenness(mesh) - 0.3) < 1e-9);
    assert.equal(yawRatio(landmarks5(mesh)), 0);
  });
  it("yaw ratio is positive when the nose moves toward the image's right", () => {
    const p = landmarks5(mesh);
    p[2] = { x: p[2].x + 20, y: p[2].y };
    assert.ok(Math.abs(yawRatio(p) - 0.2) < 1e-9);
  });
});

describe("descriptor validation", () => {
  const good = Array.from({ length: DESCRIPTOR_LENGTH }, (_, i) => Math.sin(i) / 4);
  it("accepts exactly 512 finite numbers", () => assert.equal(validateDescriptor(good).length, DESCRIPTOR_LENGTH));
  it("rejects wrong length, NaN, Infinity, non-numbers and all zeros without echoing values", () => {
    for (const bad of [good.slice(1), [...good, 1], good.map((v, i) => (i === 7 ? NaN : v)), good.map((v, i) => (i === 7 ? Infinity : v)), good.map((v, i) => (i === 7 ? ("1" as unknown as number) : v)), new Array(DESCRIPTOR_LENGTH).fill(0)]) {
      assert.throws(() => validateDescriptor(bad), (e) => e instanceof DescriptorError && !/\d\.\d/.test(e.message));
    }
  });
  it("compactDescriptor is lossless for float32 values and much shorter", () => {
    const f32 = Array.from(Float32Array.from(good));
    const compact = compactDescriptor(f32);
    assert.deepEqual(compact.map((v) => Math.fround(v)), f32);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(f32).length);
    assert.ok(JSON.stringify({ descriptors: Array(5).fill(compact) }).length < 60_000, "five samples stay far below the 100 kB request limit");
  });
  it("cosine similarity", () => {
    assert.ok(Math.abs(cosineSimilarity(good, good) - 1) < 1e-12);
    assert.ok(Math.abs(cosineSimilarity(good, good.map((v) => -v)) + 1) < 1e-12);
  });
});

describe("liveness tracker (advisory)", () => {
  const stream = (tracker: LivenessTracker, values: { ear?: number; yaw?: number; faces?: number }[], stepMs = 100) => values.forEach((v, i) => tracker.push({ t: i * stepMs, faceCount: v.faces ?? 1, eyeOpenness: v.ear, yawRatio: v.yaw }));
  const open = (n: number) => Array.from({ length: n }, () => ({ ear: 0.3, yaw: 0 }));

  it("BLINK: needs a baseline, then closed, then open again", () => {
    const t = new LivenessTracker("BLINK");
    stream(t, [...open(8), { ear: 0.1 }, { ear: 0.1 }]);
    assert.equal(t.observed, false, "closed but not re-opened yet");
    stream(t, [{ ear: 0.3 }]);
    assert.equal(t.observed, true);
  });
  it("BLINK: steady open eyes, a squint, or too few frames never count", () => {
    const a = new LivenessTracker("BLINK");
    stream(a, open(40));
    assert.equal(a.observed, false);
    const b = new LivenessTracker("BLINK");
    stream(b, [...open(8), { ear: 0.25 }, { ear: 0.3 }]);
    assert.equal(b.observed, false, "a small dip is not a blink");
    const c = new LivenessTracker("BLINK");
    stream(c, [{ ear: 0.1 }, { ear: 0.3 }, { ear: 0.1 }, { ear: 0.3 }]);
    assert.equal(c.observed, false, "no baseline yet");
  });
  it("BLINK: eyes held shut for a long time is not a blink", () => {
    const t = new LivenessTracker("BLINK");
    stream(t, [...open(8), ...Array.from({ length: 20 }, () => ({ ear: 0.05 }))], 100);
    stream(t, [{ ear: 0.3 }]);
    assert.equal(t.observed, false);
  });
  it("only counts with exactly one face in view", () => {
    const t = new LivenessTracker("BLINK");
    stream(t, [...open(8), { ear: 0.1, faces: 2 }, { ear: 0.3, faces: 2 }]);
    assert.equal(t.observed, false);
  });
  it("TURN_LEFT: nose moving toward the image's right (the voter's left) for enough frames", () => {
    const t = new LivenessTracker("TURN_LEFT");
    stream(t, [...open(8), { yaw: 0.3 }]);
    assert.equal(t.observed, false, "one frame is not enough");
    stream(t, [{ yaw: 0.31 }]);
    assert.equal(t.observed, true);
    const wrong = new LivenessTracker("TURN_LEFT");
    stream(wrong, [...open(8), { yaw: -0.4 }, { yaw: -0.4 }, { yaw: -0.4 }]);
    assert.equal(wrong.observed, false, "the other direction does not count");
  });
  it("TURN_RIGHT is the mirror image, relative to the voter's own neutral pose", () => {
    const t = new LivenessTracker("TURN_RIGHT");
    stream(t, [...Array.from({ length: 8 }, () => ({ yaw: 0.05 })), { yaw: -0.2 }, { yaw: -0.2 }]);
    assert.equal(t.observed, true, "-0.25 relative to a +0.05 neutral");
    assert.ok(t.neutralYaw !== null && Math.abs(t.neutralYaw - 0.05) < 1e-9);
  });
  it("frontal check is relative to the neutral pose", () => {
    assert.equal(isFrontal(0.04, 0), true);
    assert.equal(isFrontal(0.3, 0), false);
    assert.equal(isFrontal(0.3, 0.25), true);
    assert.ok(LIVENESS.frontalThreshold < LIVENESS.turnThreshold);
  });
});

import { ACTION_TEXT, positionGuidance } from "../../src/features/face/guidance.ts";
import type { FaceMeasurement } from "../../src/features/face/types.ts";

describe("position guidance", () => {
  const frame = { width: 1280, height: 720 };
  const one = (box: { x: number; y: number; width: number; height: number }): FaceMeasurement => ({ faceCount: 1, frame, face: { box, eyeOpenness: 0.3, yawRatio: 0, landmarks5: [] } });
  const centred = (h: number) => one({ x: 640 - (h * 0.8) / 2, y: 360 - h / 2, width: h * 0.8, height: h });

  it("says what is wrong, in order of importance", () => {
    assert.equal(positionGuidance(null).code, "waiting");
    assert.equal(positionGuidance({ faceCount: 0, frame }).code, "no-face");
    assert.equal(positionGuidance({ faceCount: 2, frame }).code, "many-faces");
    assert.equal(positionGuidance({ faceCount: 1, frame }).code, "unclear");
    assert.equal(positionGuidance(centred(120)).code, "closer");
    assert.equal(positionGuidance(centred(700)).code, "back");
    assert.equal(positionGuidance(one({ x: 20, y: 200, width: 250, height: 320 })).code, "centre");
  });
  it("accepts a well placed face and never asks for perfection", () => {
    for (const h of [260, 340, 450, 560]) assert.equal(positionGuidance(centred(h)).ok, true, `height ${h}`);
  });
  it("has wording for all three challenge actions", () => {
    for (const a of ["BLINK", "TURN_LEFT", "TURN_RIGHT"] as const) assert.ok(ACTION_TEXT[a].instruction.length > 3);
  });
});
