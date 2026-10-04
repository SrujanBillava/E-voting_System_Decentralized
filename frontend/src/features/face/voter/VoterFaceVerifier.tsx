import { useEffect, useRef, useState } from "react";
import { isApiError } from "../../../api/http";
import { voterFaceApi } from "../../../api/biometricApi";
import { Alert } from "../../../components/Alert";
import { LoadingState } from "../../../components/States";
import { messageFor, messageForCode } from "../../../lib/errors";
import type { FaceAdapterProps } from "../../voter/face/registry";
import { CameraError } from "../camera.ts";
import { CAPTURE, POSITION } from "../config.ts";
import { ACTION_TEXT, positionGuidance } from "../guidance.ts";
import { LivenessTracker } from "../liveness.ts";
import { CaptureReadiness } from "../capture.ts";
import { FaceEngineError, type FaceEngine, type FaceMeasurement } from "../types.ts";
import { FaceCameraView } from "../FaceCameraView";
import { useFaceCamera } from "../useFaceCamera.ts";

type Blocked = "not-enrolled" | "locked" | "reenrolment" | "limit" | "camera" | "engine" | "service" | "rate" | "stage";
type Ui =
  | { kind: "preparing" }
  | { kind: "blocked"; reason: Blocked; message: string; retry: boolean }
  | { kind: "guide"; text: string; note?: string }
  | { kind: "action"; action: keyof typeof ACTION_TEXT; secondsLeft: number; seeing: string }
  | { kind: "settle"; text: string }
  | { kind: "capturing" }
  | { kind: "verifying" }
  | { kind: "mismatch"; attemptsLeft: number }
  | { kind: "success" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHALLENGE_MS = 30_000; // backend CHALLENGE_TTL_MS; measured from when the challenge arrives, so a wrong browser clock cannot matter

function blockedFrom(err: unknown): Extract<Ui, { kind: "blocked" }> {
  if (err instanceof FaceEngineError) {
    // the on-device step failed (not the server): say so, instead of a generic "something went wrong"
    const message = err.kind === "load" ? "The face recognition files could not be loaded. Please try again, or ask a polling official." : "Your face could not be read on this terminal. Please try again, or ask a polling official.";
    return { kind: "blocked", reason: err.kind === "load" ? "engine" : "service", message, retry: true };
  }
  const code = isApiError(err) ? err.code : "";
  const msg = messageFor(err);
  if (code === "FACE_NOT_ENROLLED") return { kind: "blocked", reason: "not-enrolled", message: msg, retry: false };
  if (code === "FACE_LOCKED") return { kind: "blocked", reason: "locked", message: msg, retry: false };
  if (code === "FACE_REENROLMENT_REQUIRED") return { kind: "blocked", reason: "reenrolment", message: msg, retry: false };
  if (code === "FACE_CHALLENGE_LIMIT") return { kind: "blocked", reason: "limit", message: msg, retry: false };
  if (code === "RATE_LIMITED") return { kind: "blocked", reason: "rate", message: msg, retry: true };
  if (code === "STAGE_REQUIRED") return { kind: "blocked", reason: "stage", message: msg, retry: false };
  return { kind: "blocked", reason: "service", message: msg, retry: true };
}

function blockedFromStartup(error: CameraError | FaceEngineError): Extract<Ui, { kind: "blocked" }> {
  if (error instanceof CameraError) {
    const message =
      error.kind === "denied" ? "Camera access was refused. Please allow the camera for this terminal, or ask a polling official."
      : error.kind === "no-device" ? "No camera was found on this terminal. Please ask a polling official."
      : error.kind === "in-use" ? "The camera is busy or cannot be read. Please ask a polling official."
      : error.kind === "insecure" ? "The camera needs a secure page. Please ask a polling official."
      : "The camera could not be started. Please ask a polling official.";
    return { kind: "blocked", reason: "camera", message, retry: error.kind !== "insecure" && error.kind !== "unsupported" };
  }
  return { kind: "blocked", reason: "engine", message: "The face recognition files could not be loaded. Please ask a polling official.", retry: true };
}

/**
 * The real face check. The browser measures and describes the face; THE SERVER decides. Success is only ever reported by
 * `onServerStageMayHaveChanged()`, after which the kiosk re-reads GET /voter/status. Nothing here can set FACE_VERIFIED.
 *
 * Order of events: status -> camera + models (together) -> well positioned -> challenge (30 s clock starts only now) -> requested
 * movement observed -> look straight -> descriptor -> verify. The camera is stopped the moment verification succeeds, and on unmount.
 */
export default function VoterFaceVerifier(props: FaceAdapterProps) {
  // Ask the SERVER first. The camera is switched on only for a voter who is enrolled, not locked and not already verified.
  const [gate, setGate] = useState<{ kind: "checking" } | { kind: "go"; attemptsLeft: number } | { kind: "blocked"; ui: Extract<Ui, { kind: "blocked" }> }>({ kind: "checking" });
  const [round, setRound] = useState(0);
  const callbacks = useRef(props);
  useEffect(() => {
    callbacks.current = props;
  });

  useEffect(() => {
    let live = true;
    voterFaceApi
      .status()
      .then((status) => {
        if (!live) return;
        if (status.verified) return callbacks.current.onServerStageMayHaveChanged();
        if (!status.enrolled) return setGate({ kind: "blocked", ui: { kind: "blocked", reason: "not-enrolled", message: messageForCode("FACE_NOT_ENROLLED"), retry: false } });
        if (status.locked) return setGate({ kind: "blocked", ui: { kind: "blocked", reason: "locked", message: messageForCode("FACE_LOCKED"), retry: false } });
        setGate({ kind: "go", attemptsLeft: status.attemptsLeft });
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isApiError(err) && (err.status === 401 || ["SESSION_EXPIRED", "UNAUTHENTICATED", "ELECTION_CLOSED", "ELECTION_NOT_OPEN", "STAGE_REQUIRED"].includes(err.code))) return callbacks.current.onServerStageMayHaveChanged(); // the server decides
        setGate({ kind: "blocked", ui: blockedFrom(err) });
      });
    return () => {
      live = false;
    };
  }, [round]);

  useEffect(() => {
    if (gate.kind === "blocked" && !gate.ui.retry) callbacks.current.onNeedsOfficial();
  }, [gate]);

  if (gate.kind === "checking") return <LoadingState label="Preparing the face check…" />;
  if (gate.kind === "blocked") {
    return (
      <div className="stack">
        <Status ui={gate.ui} state="blocked" attemptsLeft={null} />
        {gate.ui.retry && (
          <div className="actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={() => { setGate({ kind: "checking" }); setRound((n) => n + 1); }} autoFocus>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }
  return <FaceCheck {...props} startAttemptsLeft={gate.attemptsLeft} />;
}

function FaceCheck({ onServerStageMayHaveChanged, onNeedsOfficial, startAttemptsLeft }: FaceAdapterProps & { startAttemptsLeft: number }) {
  const { videoRef, engineRef, state, stop, retry } = useFaceCamera();
  const [ui, setUi] = useState<Ui>({ kind: "preparing" });
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(startAttemptsLeft);
  const [announce, setAnnounce] = useState("");
  const [run, setRun] = useState(0);
  const resume = useRef<(() => void) | null>(null);
  const callbacks = useRef({ onServerStageMayHaveChanged, onNeedsOfficial });
  useEffect(() => {
    callbacks.current = { onServerStageMayHaveChanged, onNeedsOfficial };
  });

  // Camera / model problems become a blocked state (with a retry). Derived from the hook state, never set from an effect.
  const errored = state.kind === "error" ? blockedFromStartup(state.error) : null;
  useEffect(() => {
    if (errored) callbacks.current.onNeedsOfficial();
  }, [errored]);

  // The verification flow runs only once the camera AND the models are ready.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const ctl = { cancelled: false };
    const alive = () => !ctl.cancelled;
    const video = videoRef.current!;
    const engine = engineRef.current as FaceEngine;
    let last: FaceMeasurement | null = null;

    async function look(): Promise<FaceMeasurement> {
      for (;;) {
        if (!alive()) throw new Error("cancelled");
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            last = await engine.measure(video);
            return last;
          } catch {
            // a single bad frame is not an error: look again
          }
        }
        await sleep(POSITION.frameIntervalMs);
      }
    }
    const say = (text: string) => setAnnounce((prev) => (prev === text ? prev : text));

    async function waitUntilPositioned(note?: string) {
      let stable = 0;
      for (;;) {
        const g = positionGuidance(await look());
        stable = g.ok ? stable + 1 : 0;
        setUi({ kind: "guide", text: g.ok ? "Hold still." : g.text, note });
        say(g.text);
        if (stable >= POSITION.stableFramesNeeded) return;
        await sleep(POSITION.frameIntervalMs);
      }
    }

    async function flow() {
      try {
        let note: string | undefined;
        for (;;) {
          await waitUntilPositioned(note);
          note = undefined;

          // ---- the challenge (the 30 second clock starts here)
          const issued = await voterFaceApi.challenge();
          if (!alive()) return;
          setAttemptsLeft(issued.attemptsLeft);
          const deadline = performance.now() + CHALLENGE_MS;
          const tracker = new LivenessTracker(issued.action);
          const text = ACTION_TEXT[issued.action];
          say(`${text.instruction}. ${text.detail}`);

          // ---- the requested movement
          let observed = false;
          while (alive() && performance.now() < deadline && !observed) {
            const m = await look();
            observed = tracker.push({ t: performance.now(), faceCount: m.faceCount, eyeOpenness: m.face?.eyeOpenness, yawRatio: m.face?.yawRatio });
            setUi({ kind: "action", action: issued.action, secondsLeft: Math.max(0, Math.ceil((deadline - performance.now()) / 1000)), seeing: positionGuidance(m).ok ? "" : positionGuidance(m).text });
            await sleep(POSITION.frameIntervalMs / 2);
          }
          if (!alive()) return;
          if (!observed) {
            note = "That check timed out. Let's start again.";
            continue; // a NEW challenge; the old one is never reused
          }

          // ---- look straight, hold still, then capture
          const capture = new CaptureReadiness(tracker);
          let settled = false;
          const settleBy = performance.now() + CAPTURE.settleTimeoutMs;
          setUi({ kind: "settle", text: "Look straight at the camera with your eyes open. Hold still." });
          say("Look straight at the camera with your eyes open and hold still.");
          while (alive() && !settled && performance.now() < settleBy && deadline - performance.now() > CAPTURE.minRemainingChallengeMs) {
            const m = await look();
            settled = capture.push(m);
            await sleep(POSITION.frameIntervalMs);
          }
          if (!alive()) return;
          if (!settled) {
            note = "That check timed out. Let's start again.";
            continue;
          }

          setUi({ kind: "capturing" });
          let descriptor: number[];
          try {
            descriptor = (await engine.describe(video, capture.accepts)).descriptor;
          } catch (err) {
            if (err instanceof FaceEngineError && (err.kind === "no-face" || err.kind === "many-faces")) {
              note = err.kind === "many-faces" ? "More than one face was visible. Let's start again." : "Your face was not clear. Let's start again.";
              continue;
            }
            throw err;
          }
          if (!alive()) return;

          // ---- the server decides
          setUi({ kind: "verifying" });
          say("Verifying.");
          try {
            await voterFaceApi.verify(issued.challenge, descriptor, { passed: true }); // reached only after the movement was observed
            if (!alive()) return;
            stop(); // the camera light goes out as soon as the decision is in
            setUi({ kind: "success" });
            say("Face verification complete.");
            callbacks.current.onServerStageMayHaveChanged();
            return;
          } catch (err) {
            if (!alive()) return;
            const code = isApiError(err) ? err.code : "";
            if (isApiError(err) && code === "FACE_MISMATCH") {
              const left = typeof err.details?.attemptsLeft === "number" ? err.details.attemptsLeft : 0;
              const locked = err.details?.locked === true || left <= 0;
              setAttemptsLeft(left);
              if (locked) {
                stop();
                setUi({ kind: "blocked", reason: "locked", message: messageForCode("FACE_LOCKED"), retry: false });
                callbacks.current.onNeedsOfficial();
                return;
              }
              setUi({ kind: "mismatch", attemptsLeft: left });
              say(`Face could not be verified. ${left} ${left === 1 ? "attempt" : "attempts"} remaining.`);
              await new Promise<void>((r) => (resume.current = r)); // wait for the voter to choose to try again
              resume.current = null;
              continue;
            }
            if (code === "FACE_CHALLENGE_INVALID" || code === "FACE_LIVENESS_FAILED") {
              note = messageFor(err);
              continue; // costs no attempt; a new challenge follows
            }
            throw err;
          }
        }
      } catch (err) {
        if (!alive() || (err instanceof Error && err.message === "cancelled")) return;
        stop();
        if (isApiError(err) && (err.status === 401 || ["SESSION_EXPIRED", "UNAUTHENTICATED", "ELECTION_CLOSED", "ELECTION_NOT_OPEN", "STAGE_REQUIRED"].includes(err.code))) {
          callbacks.current.onServerStageMayHaveChanged(); // the session ended, the election closed or the stage moved: the server decides what is next
          return;
        }
        const b = blockedFrom(err);
        setUi(b);
        if (!b.retry) callbacks.current.onNeedsOfficial();
      }
    }

    void flow();

    return () => {
      ctl.cancelled = true;
      resume.current?.();
      resume.current = null;
    };
  }, [state, run, videoRef, engineRef, stop]);

  const shown: Ui = errored ?? ui;
  const tryAgain = () => {
    if (shown.kind === "mismatch") {
      setUi({ kind: "guide", text: "Getting ready…" });
      resume.current?.();
    } else {
      setUi({ kind: "preparing" });
      setRun((n) => n + 1);
      retry();
    }
  };

  const busy = shown.kind === "preparing" || shown.kind === "capturing" || shown.kind === "verifying";
  return (
    <div className="grid gap-x-12 gap-y-6 md:grid-cols-2 md:items-start">
      <FaceCameraView videoRef={videoRef} live={state.kind === "ready" && shown.kind !== "blocked" && shown.kind !== "success"} />
      <div className="stack" aria-busy={busy || undefined}>
        <Status ui={shown} state={state.kind} attemptsLeft={attemptsLeft} />
        {(shown.kind === "mismatch" || (shown.kind === "blocked" && shown.retry)) && (
          <div className="actions">
            <button type="button" className="btn btn-primary btn-lg" onClick={tryAgain} autoFocus>
              Try again
            </button>
          </div>
        )}
        <p className="visually-hidden" role="status" aria-live="polite">
          {announce}
        </p>
      </div>
    </div>
  );
}

function Status({ ui, state, attemptsLeft }: { ui: Ui; state: string; attemptsLeft: number | null }) {
  if (ui.kind === "blocked") {
    const official = !ui.retry;
    return (
      <Alert tone={official ? "warn" : "danger"} title={official ? "Please ask a polling official" : "The face check could not be completed"} role={official ? "status" : "alert"}>
        <p>{ui.message}</p>
        {ui.reason === "locked" && <p>The terminal cannot unlock this for you.</p>}
      </Alert>
    );
  }
  if (ui.kind === "mismatch") {
    return (
      <Alert tone="warn" title="Face could not be verified." role="status">
        <p>
          Attempts remaining: <strong>{ui.attemptsLeft}</strong>
        </p>
        <p>Look straight at the camera, remove anything covering your face, and try again.</p>
      </Alert>
    );
  }
  if (ui.kind === "success") return <Alert tone="ok" title="Face verification complete" role="status" />;
  const headline =
    ui.kind === "preparing" ? (state === "starting" ? "Starting the camera and loading face recognition…" : "Getting ready…")
    : ui.kind === "guide" ? ui.text
    : ui.kind === "action" ? ACTION_TEXT[ui.action].instruction
    : ui.kind === "settle" ? ui.text
    : ui.kind === "capturing" ? "Capturing…"
    : "Verifying…";
  return (
    <div className="stack stack-sm">
      <p className="camera-status" role="status">
        <strong>{headline}</strong>
      </p>
      {ui.kind === "guide" && ui.note && <p className="muted">{ui.note}</p>}
      {ui.kind === "action" && (
        <>
          <p>{ACTION_TEXT[ui.action].detail}</p>
          <p className="muted tabular">Time for this check: {ui.secondsLeft} s</p>
          {ui.seeing && <p className="muted">{ui.seeing}</p>}
        </>
      )}
      {attemptsLeft !== null && attemptsLeft < 3 && (ui.kind === "guide" || ui.kind === "action") && <p className="muted">Attempts remaining: {attemptsLeft}</p>}
      <div className="prose">
        <ul>
          <li>Look at the camera and keep your face inside the guide.</li>
          <li>Remove sunglasses or a hat if you can.</li>
          <li>Only one person should be in view.</li>
        </ul>
      </div>
    </div>
  );
}
