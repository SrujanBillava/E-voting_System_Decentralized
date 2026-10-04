import { Suspense, lazy, useState } from "react";
import { adminApi } from "../../../api/adminApi";
import type { AdminFaceInfo } from "../../../api/biometricApi";
import { Alert } from "../../../components/Alert";
import { ErrorState, LoadingState } from "../../../components/States";
import { formatDateTime } from "../../../lib/format";
import { messageFor } from "../../../lib/errors";
import { useAsync } from "../../../lib/useAsync";
import type { EnrolmentPanelProps } from "../../admin/biometrics/adapter";

// The camera step (and with it Human / TensorFlow.js / the models) loads only when an administrator starts capturing.
const CaptureStep = lazy(() => import("./CaptureStep").then((m) => ({ default: m.CaptureStep })));

type Mode = "view" | "capture" | "saving" | "confirm-replace" | "confirm-remove";

/**
 * Admin face enrolment for one voter: view status, enrol, re-enrol (replaces), remove. Setup phase only; the server refuses changes in
 * every other phase and this panel is read-only then. No raw photo ever leaves the browser and no descriptor is displayed.
 */
export default function EnrolmentPanel({ voter, onEnrolmentChanged, canModify, onBusyChange }: EnrolmentPanelProps) {
  const info = useAsync<AdminFaceInfo>(() => adminApi.faceInfo(voter.id), [voter.id]);
  const [mode, setMode] = useState<Mode>("view");
  const [result, setResult] = useState<{ tone: "ok" | "danger"; title: string; text: string } | null>(null);
  const enrolled = info.data?.enrolled ?? voter.faceEnrolled;

  const busy = (value: boolean) => onBusyChange(value);
  const finish = (r: NonNullable<typeof result>) => {
    setResult(r);
    setMode("view");
    busy(false);
    info.reload();
    onEnrolmentChanged();
  };

  const save = async (descriptors: number[][]) => {
    setMode("saving");
    busy(true);
    try {
      const out = await adminApi.enrolFace(voter.id, descriptors);
      finish({ tone: "ok", title: "Face enrolled", text: `${out.face.sampleCount} samples were saved, encrypted, for ${voter.name}.` });
    } catch (err) {
      finish({ tone: "danger", title: "Enrolment was not saved", text: messageFor(err) });
    }
  };

  const remove = async () => {
    setMode("saving");
    busy(true);
    try {
      await adminApi.removeFace(voter.id);
      finish({ tone: "ok", title: "Face enrolment removed", text: `${voter.name} can no longer pass the face check until a face is enrolled again.` });
    } catch (err) {
      finish({ tone: "danger", title: "Enrolment was not removed", text: messageFor(err) });
    }
  };

  if (mode === "capture") {
    return (
      <Suspense fallback={<LoadingState label="Preparing the camera…" />}>
        <CaptureStep onSave={(d) => void save(d)} onCancel={() => setMode("view")} />
      </Suspense>
    );
  }

  return (
    <div className="stack">
      {result && <Alert tone={result.tone} title={result.title} role={result.tone === "danger" ? "alert" : "status"}>{result.text}</Alert>}

      {info.status === "loading" && !info.data && <LoadingState label="Loading face enrolment…" />}
      {info.status === "error" && <ErrorState error={info.error} title="Face enrolment could not be loaded" onRetry={info.reload} />}
      {info.data && (
        <dl className="dl">
          <div className="dl-row">
            <dt>Face enrolled</dt>
            <dd>{info.data.enrolled ? "Yes" : "No"}</dd>
          </div>
          {info.data.enrolled && (
            <>
              <div className="dl-row">
                <dt>Samples</dt>
                <dd className="tabular">{info.data.sampleCount}</dd>
              </div>
              {info.data.enrolledAt && (
                <div className="dl-row">
                  <dt>Enrolled</dt>
                  <dd>{formatDateTime(info.data.enrolledAt)}</dd>
                </div>
              )}
            </>
          )}
        </dl>
      )}
      {info.data?.needsReenrolment && (
        <Alert tone="warn" title="This enrolment needs to be redone">
          It was made with a different face model, so it can no longer be used. Enrol the voter again.
        </Alert>
      )}

      {!canModify && (
        <Alert tone="info" title="Enrolment is locked">
          Face enrolment can only be changed while the election is in Setup.
        </Alert>
      )}

      {mode === "confirm-replace" && (
        <Alert tone="warn" title="Replace the existing face template?">
          <p>This replaces the enrolled face of {voter.name} with new samples. The old template is discarded.</p>
          <div className="actions mt-3">
            <button type="button" className="btn btn-primary" onClick={() => setMode("capture")}>
              Continue to capture
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </Alert>
      )}
      {mode === "confirm-remove" && (
        <Alert tone="danger" title="Remove this face enrolment?">
          <p>{voter.name} will not be able to pass the face check until a face is enrolled again.</p>
          <div className="actions mt-3">
            <button type="button" className="btn btn-danger" onClick={() => void remove()}>
              Remove enrolment
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </Alert>
      )}
      {mode === "saving" && <LoadingState label="Saving…" />}

      {canModify && mode === "view" && (
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setMode(enrolled ? "confirm-replace" : "capture")}>
            {enrolled ? "Re-enrol face" : "Enrol face"}
          </button>
          {enrolled && (
            <button type="button" className="btn btn-quiet text-danger" onClick={() => setMode("confirm-remove")}>
              Remove enrolment
            </button>
          )}
        </div>
      )}
      <p className="hint">The camera is used only while capturing. Only numbers describing the face are saved (encrypted). No photo is stored or uploaded.</p>
    </div>
  );
}
