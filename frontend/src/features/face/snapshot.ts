import { FaceEngineError, type FrameSource } from "./types.ts";

// Bound both canvas memory and Human's input before detection. Normal booth frames are unchanged.
export const MAX_FRAME_SIDE = 1920;

export function boundedFrameSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new FaceEngineError("no-face", "The camera frame is not ready.");
  }
  const scale = Math.min(1, MAX_FRAME_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** One bounded, unmirrored copy: detection, landmarks and alignment all use these same pixels. */
export function snapshotFrame(source: FrameSource): HTMLCanvasElement {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const size = boundedFrameSize(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new FaceEngineError("inference", "The camera frame could not be read.");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, size.width, size.height);
  return canvas;
}
