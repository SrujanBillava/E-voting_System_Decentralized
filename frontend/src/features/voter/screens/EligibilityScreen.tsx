import { useEffect, useRef, useState } from "react";
import { isApiError } from "../../../api/http";
import type { EligibilityResult } from "../../../api/types";
import { voterApi } from "../../../api/voterApi";
import { Alert } from "../../../components/Alert";
import { LoadingState } from "../../../components/States";
import { usePageTitle } from "../../../components/useRouteFocus";
import { messageFor } from "../../../lib/errors";
import { KioskFrame } from "../KioskFrame";
import { useKiosk } from "../useKioskSession";

type View = { kind: "checking" } | { kind: "eligible"; result: EligibilityResult } | { kind: "inflight" } | { kind: "voted"; receiptAvailable: boolean } | { kind: "error"; message: string; code: string };

/** FACE_VERIFIED -> ELIGIBLE. The client sends nothing: the server derives identity, constituency and status. */
export default function EligibilityScreen({ until }: { until: string }) {
  usePageTitle("Eligibility");
  const { refresh, finish, sessionLost } = useKiosk();
  const [view, setView] = useState<View>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const job = useRef<{ attempt: number; promise: Promise<EligibilityResult> } | null>(null);

  useEffect(() => {
    // One request per attempt even when React StrictMode runs this effect twice in development: both runs await the same promise,
    // and only the run that is still mounted acts on the result.
    if (job.current?.attempt !== attempt) job.current = { attempt, promise: voterApi.eligibility() };
    let live = true;
    job.current.promise
      .then((result) => live && setView({ kind: "eligible", result }))
      .catch((err: unknown) => {
        if (!live) return;
        if (isApiError(err) && err.code === "ALREADY_VOTED") return setView({ kind: "voted", receiptAvailable: err.details?.receiptAvailable === true });
        if (isApiError(err) && err.code === "VOTE_IN_FLIGHT") return setView({ kind: "inflight" });
        if (isApiError(err) && (err.status === 401 || err.code === "SESSION_EXPIRED")) return sessionLost("expired");
        if (isApiError(err) && (err.code === "ELECTION_CLOSED" || err.code === "STAGE_REQUIRED")) return void refresh(); // the server decides what screen this session is on
        setView({ kind: "error", message: messageFor(err), code: isApiError(err) ? err.code : "UNKNOWN" });
      });
    return () => {
      live = false;
    };
  }, [attempt, sessionLost, refresh]);

  // A ballot that is still being confirmed: look again every few seconds; the server answers ALREADY_VOTED once it is final.
  useEffect(() => {
    if (view.kind !== "inflight") return;
    const id = setTimeout(() => setAttempt((n) => n + 1), 3000);
    return () => clearTimeout(id);
  }, [view]);

  const end = (
    <button type="button" className="btn btn-secondary btn-lg" onClick={() => void finish()}>
      End session
    </button>
  );

  if (view.kind === "eligible") {
    return (
      <KioskFrame
        step={2}
        title="You are eligible to vote"
        intro={`Your ballot is for ${view.result.constituency.name}.`}
        until={view.result.stageExpiresAt}
        onExpire={() => void refresh()}
        secondary={end}
        primary={
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void refresh()}>
            View my ballot
          </button>
        }
      >
        <dl className="dl">
          <div className="dl-row">
            <dt>Constituency</dt>
            <dd>
              {view.result.constituency.name} <span className="mono muted">{view.result.constituency.code}</span>
            </dd>
          </div>
        </dl>
      </KioskFrame>
    );
  }

  if (view.kind === "voted") {
    return (
      <KioskFrame
        step={2}
        title="A ballot has already been accepted"
        until={until}
        onExpire={() => void refresh()}
        secondary={end}
        primary={
          view.receiptAvailable ? (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => void refresh()}>
              View my receipt
            </button>
          ) : undefined
        }
      >
        {view.receiptAvailable ? (
          <Alert tone="info" title="You have already voted" role="status">
            <p>Your ballot for this election was recorded. You can view your receipt. You cannot vote again.</p>
          </Alert>
        ) : (
          <Alert tone="warn" title="You cannot vote again" role="status">
            <p>This election already contains an accepted ballot for your voter authorization. A receipt cannot be recovered from this terminal.</p>
            <p>If you think this is a mistake, please ask a polling official.</p>
          </Alert>
        )}
      </KioskFrame>
    );
  }

  if (view.kind === "inflight") {
    return (
      <KioskFrame step={2} title="Your ballot is still being confirmed" until={until} onExpire={() => void refresh()} secondary={end}>
        <LoadingState label="Your ballot is still being confirmed. This usually takes a few seconds. Please wait…" />
        <p className="muted">You do not need to vote again.</p>
      </KioskFrame>
    );
  }

  if (view.kind === "error") {
    return (
      <KioskFrame
        step={2}
        title="We could not check your eligibility"
        secondary={end}
        primary={
          view.code === "NETWORK" || view.code === "CHAIN_UNAVAILABLE" ? (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => { setView({ kind: "checking" }); setAttempt((n) => n + 1); }}>
              Try again
            </button>
          ) : undefined
        }
      >
        <Alert tone="danger" title="Something went wrong">
          <p>{view.message}</p>
          <p>Please ask a polling official if this continues.</p>
        </Alert>
      </KioskFrame>
    );
  }

  return (
    <KioskFrame step={2} title="Checking your eligibility" until={until} onExpire={() => void refresh()}>
      <LoadingState label="Checking your eligibility…" />
    </KioskFrame>
  );
}
