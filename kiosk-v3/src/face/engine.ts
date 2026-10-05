import type { FaceEngine } from "./types.ts";

let engine: FaceEngine | null = null;
let pending: Promise<FaceEngine> | null = null;

/**
 * The single, lazily created face engine. The heavy libraries and models are imported dynamically, so nothing biometric loads on the
 * public site, the normal admin pages or the kiosk until a voter reaches the face step or an administrator opens enrolment.
 * (`import.meta.env.VITE_E2E_FACE` is a build-time constant: in a normal build the test engine branch is removed entirely.)
 */
export function getFaceEngine(): Promise<FaceEngine> {
  pending ??= (async () => {
    const created: FaceEngine =
      import.meta.env.VITE_E2E_FACE === "1" ? new (await import("./e2eEngine.ts")).E2EFaceEngine() : new (await import("./humanEngine.ts")).HumanGhostNetEngine();
    await created.load();
    engine = created;
    return created;
  })().catch((err: unknown) => {
    pending = null; // allow a retry after a failed load
    throw err;
  });
  return pending;
}

export const loadedFaceEngine = (): FaceEngine | null => engine;
