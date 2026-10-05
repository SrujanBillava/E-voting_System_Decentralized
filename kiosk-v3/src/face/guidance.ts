import { POSITION } from "./config.ts";
import type { FaceMeasurement } from "./types.ts";

export type GuidanceCode = "waiting" | "no-face" | "many-faces" | "unclear" | "closer" | "back" | "centre" | "ok";
export interface Guidance {
  code: GuidanceCode;
  /** Short, plain instruction for the person at the terminal. */
  text: string;
  /** True when the face is positioned well enough to continue. */
  ok: boolean;
}

/** Practical positioning advice from one measurement. Forgiving by design: this is a voting booth, not a passport photo. */
export function positionGuidance(m: FaceMeasurement | null): Guidance {
  if (!m) return { code: "waiting", text: "Getting ready…", ok: false };
  if (m.faceCount === 0) return { code: "no-face", text: "No face detected. Look at the camera.", ok: false };
  if (m.faceCount > 1) return { code: "many-faces", text: "More than one face is visible. Only the voter should be in view.", ok: false };
  if (!m.face) return { code: "unclear", text: "Hold still. Your face is not clear yet.", ok: false };
  const { box } = m.face;
  const heightRatio = box.height / m.frame.height;
  if (heightRatio < POSITION.minFaceHeightRatio) return { code: "closer", text: "Move slightly closer.", ok: false };
  if (heightRatio > POSITION.maxFaceHeightRatio) return { code: "back", text: "Move slightly back.", ok: false };
  const dx = Math.abs(box.x + box.width / 2 - m.frame.width / 2) / m.frame.width;
  const dy = Math.abs(box.y + box.height / 2 - m.frame.height / 2) / m.frame.height;
  if (dx > POSITION.maxCentreOffset || dy > POSITION.maxCentreOffset) return { code: "centre", text: "Center your face in the guide.", ok: false };
  return { code: "ok", text: "Hold still.", ok: true };
}

export const ACTION_TEXT = {
  BLINK: { instruction: "Blink now", detail: "Blink once, naturally." },
  TURN_LEFT: { instruction: "Turn your head to your left", detail: "Turn slowly, then look straight at the camera again." },
  TURN_RIGHT: { instruction: "Turn your head to your right", detail: "Turn slowly, then look straight at the camera again." },
} as const;
