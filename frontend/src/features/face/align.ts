import { ALIGN_TARGET, MESH } from "./config.ts";
import type { Point } from "./types.ts";

/** A similarity transform (rotation, uniform scale, translation): x' = a*x - b*y + tx, y' = b*x + a*y + ty. */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

/**
 * Least-squares similarity transform that moves `from` onto `to` (Umeyama, 2-D, solved with complex numbers).
 * With p_i, q_i centred on their means, z -> m*z + t where m = sum(conj(p_i) q_i) / sum(|p_i|^2).
 */
export function fitSimilarity(from: readonly Point[], to: readonly (readonly [number, number])[]): Similarity {
  if (from.length !== to.length || from.length < 2) throw new Error("fitSimilarity needs two matching point lists of at least 2 points");
  const n = from.length;
  const mp = { x: from.reduce((s, p) => s + p.x, 0) / n, y: from.reduce((s, p) => s + p.y, 0) / n };
  const mq = { x: to.reduce((s, q) => s + q[0], 0) / n, y: to.reduce((s, q) => s + q[1], 0) / n };
  let re = 0;
  let im = 0;
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const px = from[i].x - mp.x;
    const py = from[i].y - mp.y;
    const qx = to[i][0] - mq.x;
    const qy = to[i][1] - mq.y;
    re += px * qx + py * qy; // Re(conj(p) * q)
    im += px * qy - py * qx; // Im(conj(p) * q)
    norm += px * px + py * py;
  }
  if (norm < 1e-9) throw new Error("degenerate landmarks");
  const a = re / norm;
  const b = im / norm;
  return { a, b, tx: mq.x - (a * mp.x - b * mp.y), ty: mq.y - (b * mp.x + a * mp.y) };
}

export const applySimilarity = (t: Similarity, p: Point): Point => ({ x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty });

/** Canvas 2D setTransform arguments (a, b, c, d, e, f) for the same transform. */
export const canvasMatrix = (t: Similarity): [number, number, number, number, number, number] => [t.a, t.b, -t.b, t.a, t.tx, t.ty];

type Mesh = readonly (readonly number[])[];
const at = (mesh: Mesh, i: number): Point => ({ x: mesh[i][0], y: mesh[i][1] });
const mid = (p: Point, q: Point): Point => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
const dist = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

/** The five alignment points (docs/BIOMETRICS.md): eye centres, nose tip, mouth corners, from the 468-point mesh, in frame pixels. */
export function landmarks5(mesh: Mesh): Point[] {
  const [l1, l2] = MESH.eyeLeftCorners;
  const [r1, r2] = MESH.eyeRightCorners;
  return [mid(at(mesh, l1), at(mesh, l2)), mid(at(mesh, r1), at(mesh, r2)), at(mesh, MESH.noseTip), at(mesh, MESH.mouthLeft), at(mesh, MESH.mouthRight)];
}

/** Eye aspect ratio (lid opening / eye width), averaged over both eyes. */
export function eyeOpenness(mesh: Mesh): number {
  const ear = (e: { outer: number; inner: number; upper: number; lower: number }) => dist(at(mesh, e.upper), at(mesh, e.lower)) / Math.max(1e-6, dist(at(mesh, e.outer), at(mesh, e.inner)));
  return (ear(MESH.earLeft) + ear(MESH.earRight)) / 2;
}

/** Nose offset from the eye midpoint, in units of the eye distance (see FaceMeasurement.yawRatio for the sign). */
export function yawRatio(points5: readonly Point[]): number {
  const [eyeL, eyeR, nose] = points5;
  const eyeDistance = Math.max(1e-6, eyeR.x - eyeL.x);
  return (nose.x - (eyeL.x + eyeR.x) / 2) / eyeDistance;
}

/** The transform from the camera frame into the 112x112 crop the descriptor model expects. */
export const alignmentFor = (points5: readonly Point[]): Similarity => fitSimilarity(points5, ALIGN_TARGET);
