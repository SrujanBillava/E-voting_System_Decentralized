import { useCallback, useEffect, useRef, useState } from "react";
import { CameraError, CameraSession } from "./camera.ts";
import { getFaceEngine } from "./engine.ts";
import { FaceEngineError, type FaceEngine } from "./types.ts";

export type FaceCameraState =
  | { kind: "starting"; camera: boolean; engine: boolean }
  | { kind: "ready" }
  | { kind: "error"; error: CameraError | FaceEngineError };

/**
 * Owns the camera and the face engine for ONE screen. The camera starts when the screen mounts, together with the (lazy) engine load, and
 * is stopped when the screen unmounts, on page hide, and when `stop()` is called: no path leaves the camera running.
 * `retry()` starts again after an error.
 */
export function useFaceCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<CameraSession | null>(null);
  const engineRef = useRef<FaceEngine | null>(null);
  const [state, setState] = useState<FaceCameraState>({ kind: "starting", camera: false, engine: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const session = new CameraSession();
    sessionRef.current = session;
    let live = true;
    const video = videoRef.current;
    const hide = () => session.stop();
    window.addEventListener("pagehide", hide);

    const camera = video ? session.start(video) : Promise.reject(new CameraError("unknown", "No video element."));
    const engine = getFaceEngine();
    void camera.then(() => live && setState((s) => (s.kind === "starting" ? { ...s, camera: true } : s))).catch(() => undefined);
    void engine.then(() => live && setState((s) => (s.kind === "starting" ? { ...s, engine: true } : s))).catch(() => undefined);
    Promise.all([camera, engine])
      .then(([, e]) => {
        if (!live) return;
        engineRef.current = e;
        setState({ kind: "ready" });
      })
      .catch((error: unknown) => {
        if (!live) return;
        session.stop(); // a failed start must not leave the other half running
        setState({ kind: "error", error: error instanceof CameraError || error instanceof FaceEngineError ? error : new FaceEngineError("load", "The face recognition files could not be loaded.") });
      });

    return () => {
      live = false;
      window.removeEventListener("pagehide", hide);
      session.stop();
      if (video) video.srcObject = null;
      engineRef.current = null;
    };
  }, [attempt]);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);
  const retry = useCallback(() => {
    setState({ kind: "starting", camera: false, engine: false });
    setAttempt((n) => n + 1);
  }, []);

  return { videoRef, engineRef, state, stop, retry };
}
