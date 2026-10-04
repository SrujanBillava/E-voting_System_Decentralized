import { useState } from "react";
import { Alert } from "../../../components/Alert";
import { usePageTitle } from "../../../components/useRouteFocus";
import { KioskFrame } from "../KioskFrame";
import { FaceVerifierSlot } from "../face/FaceVerifierSlot";
import { hasFaceVerifier } from "../face/registry";
import { useKiosk } from "../useKioskSession";

/**
 * The face check screen. It hosts the registered face client (features/face/voter/VoterFaceVerifier, registered in features/face/register.ts)
 * and never decides anything itself: the client talks to the face endpoints, THE SERVER moves the session to FACE_VERIFIED, and this
 * screen only re-reads the stage (GET /voter/status). There is no skip, no "verify anyway" and no way to report success from the browser.
 * If no client is registered (a build without biometrics) it says the check is unavailable and offers a re-check of the server stage only.
 */
export default function FaceScreen({ voter, until }: { voter: { name: string; voterId: string }; until: string }) {
  usePageTitle("Face check");
  const { refresh, finish } = useKiosk();
  const connected = hasFaceVerifier();
  const [checking, setChecking] = useState(false);

  const recheck = async () => {
    setChecking(true);
    await refresh();
    setChecking(false);
  };

  return (
    <KioskFrame
      step={1}
      title="Face check"
      intro="Look at the camera so we can confirm you are the registered voter."
      until={until}
      onExpire={() => void refresh()}
      secondary={
        <button type="button" className="btn btn-secondary btn-lg" onClick={() => void finish()}>
          End session
        </button>
      }
      primary={
        connected ? undefined : (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void recheck()} aria-busy={checking || undefined} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
        )
      }
    >
      {connected ? (
        <FaceVerifierSlot voter={voter} onServerStageMayHaveChanged={() => void refresh()} onNeedsOfficial={() => undefined} />
      ) : (
        <div className="grid gap-x-12 gap-y-6 md:grid-cols-2 md:items-start">
          <div className="camera-shell" role="img" aria-label="Camera area. The camera is not connected on this terminal.">
            <svg viewBox="0 0 120 150" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
              <ellipse cx="60" cy="72" rx="38" ry="52" strokeDasharray="8 6" />
            </svg>
          </div>
          <div className="stack">
            <p className="camera-status" role="status">
              <strong>Face verification is not available on this terminal.</strong>
            </p>
            <Alert tone="warn" title="Please ask a polling official">
              <p>The face check cannot be completed here. An official can help you, or end this session so the terminal can be reset.</p>
            </Alert>
          </div>
        </div>
      )}
    </KioskFrame>
  );
}
