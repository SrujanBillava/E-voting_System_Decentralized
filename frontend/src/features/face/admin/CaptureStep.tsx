import { useEffect, useRef, useState } from "react";
import { Alert } from "../../../components/Alert";
import { CameraError } from "../camera.ts";
import { ENROL, MAX_SAMPLES, MIN_SAMPLES, POSITION } from "../config.ts";
import { compactDescriptor, cosineSimilarity } from "../descriptor.ts";
import { positionGuidance, type Guidance } from "../guidance.ts";
import { FaceCameraView } from "../FaceCameraView";
import { FaceEngineError, type FaceEngine } from "../types.ts";
import { useFaceCamera } from "../useFaceCamera.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Captures 3 to 5 face samples for ONE voter. It uses the same engine and the same describe() as the voter's verification, so enrolment
 * and verification cannot drift apart. Only descriptors (numbers) are kept, in memory, until saved or cancelled; no image is stored or
 * sent, and nothing is shown that could reconstruct a face. The camera belongs to this component and stops when it unmounts.
 */
export function CaptureStep({ onSave, onCancel }: { onSave: (descriptors: number[][]) => void; onCancel: () => void }) {
  const { videoRef, engineRef, state, stop, retry } = useFaceCamera();
  const [guidance, setGuidance] = useState<Guidance>(positionGuidance(null));
  const [count, setCount] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const samples = useRef<number[][]>([]);
  const lastAt = useRef(0);

  useEffect(() => {
    if (state.kind !== "ready") return;
    let live = true;
    const video = videoRef.current!;
    const engine = engineRef.current as FaceEngine;
    void (async () => {
      while (live) {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            const g = positionGuidance(await engine.measure(video));
            if (live) setGuidance((prev) => (prev.code === g.code ? prev : g));
          } catch {
            // one bad frame is fine
          }
        }
        await sleep(POSITION.frameIntervalMs * 2);
      }
    })();
    return () => {
      live = false;
    };
  }, [state, videoRef, engineRef]);

  const capture = async () => {
    const engine = engineRef.current;
    const video = videoRef.current;
    if (!engine || !video || busy) return;
    setBusy(true);
    setNote("");
    try {
      if (performance.now() - lastAt.current < ENROL.minGapMs) {
        setNote("Wait a moment, then capture again.");
        return;
      }
      const { descriptor } = await engine.describe(video);
      const previous = samples.current.at(-1);
      if (previous && cosineSimilarity(previous, descriptor) >= ENROL.duplicateSimilarity) {
        setNote("That sample is the same as the last one. Ask the voter to move their head very slightly or change their expression, then capture again.");
        return;
      }
      samples.current.push(descriptor);
      lastAt.current = performance.now();
      setCount(samples.current.length);
      setNote(samples.current.length < MIN_SAMPLES ? `Sample ${samples.current.length} captured. Ask the voter for a small natural change (head angle, expression) before the next one.` : `Sample ${samples.current.length} captured.`);
    } catch (err) {
      setNote(err instanceof FaceEngineError && err.kind === "many-faces" ? "More than one face is visible. Only the voter should be in view." : "The face was not clear. Position the voter in the guide and try again.");
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    stop(); // the camera light goes out before the request is made
    const out = samples.current.map(compactDescriptor);
    samples.current = [];
    onSave(out);
  };
  const cancel = () => {
    samples.current = [];
    stop();
    onCancel();
  };

  if (state.kind === "error") {
    const e = state.error;
    const message = e instanceof CameraError ? (e.kind === "denied" ? "Camera access was refused. Allow the camera for this site and try again." : e.kind === "no-device" ? "No camera was found on this computer." : "The camera could not be started.") : "The face recognition files could not be loaded. Run `npm run face:setup` in the frontend folder and reload.";
    return (
      <div className="stack">
        <Alert tone="danger" title="The camera could not start">
          <p>{message}</p>
        </Alert>
        <div className="actions">
          <button type="button" className="btn btn-secondary" onClick={retry}>
            Try again
          </button>
          <button type="button" className="btn btn-quiet" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const ready = state.kind === "ready";
  const next = Math.min(count + 1, MAX_SAMPLES);
  return (
    <div className="stack">
      <h3 className="h3">{count < MIN_SAMPLES ? `Sample ${next} of ${MIN_SAMPLES}` : `${count} samples captured (up to ${MAX_SAMPLES})`}</h3>
      <FaceCameraView videoRef={videoRef} live={ready} />
      <p className="camera-status" role="status">
        <strong>{ready ? guidance.text : "Starting the camera and loading face recognition…"}</strong>
      </p>
      {note && <p className="muted">{note}</p>}
      <p className="hint">Only numbers describing the face are kept. No photo is stored or uploaded.</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={() => void capture()} disabled={!ready || !guidance.ok || busy || count >= MAX_SAMPLES} aria-busy={busy || undefined}>
          {busy ? "Capturing…" : count === 0 ? "Capture sample" : "Capture another sample"}
        </button>
        {count >= MIN_SAMPLES && (
          <button type="button" className="btn btn-secondary" onClick={save}>
            Save enrolment ({count} samples)
          </button>
        )}
        <button type="button" className="btn btn-quiet" onClick={cancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
