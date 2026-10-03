import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { adminApi } from "../../api/adminApi";
import type { AdminElection } from "../../api/types";
import { Alert } from "../../components/Alert";
import { Dialog } from "../../components/Dialog";
import { formatCount, formatDateTime } from "../../lib/format";
import { messageFor } from "../../lib/errors";
import { TextField } from "./parts";
import { openBlockers, type LifecycleKind } from "./lifecycle";
import { checkLabel } from "./preflightLabels";
import { toApiError } from "./useAdminElection";

const COPY = {
  open: {
    title: "Open the election?",
    phrase: "OPEN ELECTION",
    confirm: "Open election",
    busy: "Opening election…",
  },
  close: {
    title: "Close the election?",
    phrase: "CLOSE ELECTION",
    confirm: "Close election",
    busy: "Closing election…",
  },
} as const;

/** The backend names failing checks in the error message ("Preflight failed: contract.owner, relayer.balance"). */
function preflightDetail(message: string): string | null {
  const m = /^Preflight failed:\s*(.+)$/.exec(message);
  return m ? m[1].split(",").map((n) => checkLabel(n.trim())).join("; ") : null;
}

/**
 * Step-up confirmation for the two irreversible lifecycle actions. The confirm button stays disabled until the exact phrase
 * AND a 6-digit code are entered. Focus starts on the heading (Dialog), never on the confirm button. On success the caller
 * re-reads the election: this dialog never decides what the new phase is.
 */
export default function ConfirmElectionDialog({
  kind,
  election,
  open,
  onClose,
  onDone,
  onRefresh,
}: {
  kind: LifecycleKind;
  election: AdminElection;
  open: boolean;
  onClose: () => void;
  /** Called after the backend accepted the action. The caller re-queries the election and closes the dialog. */
  onDone: (result: { phase: string; txHash: string }) => Promise<void>;
  /** Called after a failure that might have changed the election state, so the page behind shows the truth. */
  onRefresh: () => void;
}) {
  const copy = COPY[kind];
  const formId = useId();
  const [phrase, setPhrase] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string; detail: string | null } | null>(null);
  const totpRef = useRef<HTMLInputElement>(null);
  const phraseRef = useRef<HTMLInputElement>(null);

  // A dialog that is reopened always starts empty.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setPhrase("");
      setTotp("");
      setError(null);
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!error) return;
    // After a rejected step-up code the field needs a new value; after a wrong phrase retype that.
    const field = error.code === "INVALID_CONFIRMATION" ? phraseRef.current : totpRef.current;
    field?.focus();
  }, [error]);

  const blockers = kind === "open" ? openBlockers(election) : null;
  const phraseOk = phrase === copy.phrase;
  const totpOk = /^[0-9]{6}$/.test(totp);
  const ready = phraseOk && totpOk && !busy && !(blockers?.blocked ?? false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = kind === "open" ? await adminApi.openElection(phrase, totp) : await adminApi.closeElection(phrase, totp);
      await onDone({ phase: result.phase, txHash: result.txHash });
    } catch (err) {
      const e = toApiError(err);
      const detail = e.code === "PREFLIGHT_FAILED" ? preflightDetail(e.message) : null;
      setError({ code: e.code, message: messageFor(e), detail });
      setTotp(""); // a code is single-use whatever the outcome
      if (e.code !== "INVALID_STEP_UP" && e.code !== "INVALID_CONFIRMATION" && e.code !== "VALIDATION_FAILED" && e.code !== "RATE_LIMITED") onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={copy.title}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={formId} className={`btn ${kind === "open" ? "btn-primary" : "btn-danger"}`} disabled={!ready && !busy} aria-busy={busy || undefined}>
            {busy ? copy.busy : copy.confirm}
          </button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {kind === "open" ? (
          <p>
            Opening the election <strong>starts voting</strong> and <strong>freezes the election configuration</strong>. Voters, constituencies and candidates can no longer be added, changed or removed. This cannot be undone.
          </p>
        ) : (
          <p>
            Closing the election <strong>stops voting immediately</strong> and makes the official results available to the public. <strong>The election cannot be reopened.</strong>
          </p>
        )}
        <dl className="dl">
          <div className="dl-row">
            <dt>Election ID</dt>
            <dd className="mono" translate="no">
              {election.electionId}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Registered voters</dt>
            <dd>{election.voters ? formatCount(election.voters.registered) : "Not available"}</dd>
          </div>
          <div className="dl-row">
            <dt>Constituencies</dt>
            <dd>{formatCount(election.constituencyCount)}</dd>
          </div>
          <div className="dl-row">
            <dt>Candidates</dt>
            <dd>{formatCount(election.candidateCount)}</dd>
          </div>
          {kind === "close" && (
            <div className="dl-row">
              <dt>Ballots recorded</dt>
              <dd>{formatCount(election.totalBallots)}</dd>
            </div>
          )}
        </dl>

        {blockers?.blocked ? (
          <Alert tone="danger" title="The election cannot be opened yet">
            <p>The latest system check ({formatDateTime(election.preflight.checkedAt)}) did not pass.</p>
            <ul className="list-disc pl-5 mt-2">
              {blockers.failed.map((n) => (
                <li key={n}>{checkLabel(n)}: failed</li>
              ))}
              {blockers.failed.length === 0 && blockers.configNotReady && <li>{checkLabel("election.config")}: not ready. Add constituencies and give each one at least one candidate.</li>}
            </ul>
            <p className="mt-2">Fix these, refresh the checks on the Election page, then open the election.</p>
          </Alert>
        ) : (
          blockers && (
            <Alert tone={blockers.warned.length > 0 ? "warn" : "info"} title={blockers.warned.length > 0 ? "System checks passed with warnings" : "System checks passed"}>
              {blockers.warned.length > 0 ? `Warnings: ${blockers.warned.map(checkLabel).join("; ")}. ` : ""}Checked {formatDateTime(election.preflight.checkedAt)}.
            </Alert>
          )
        )}

        {error && (
          <Alert tone="danger" role="alert" title="The election was not changed">
            {error.message}
            {error.detail && <> Failing: {error.detail}.</>}
          </Alert>
        )}

        <TextField
          id={`${formId}-phrase`}
          label={`Type ${copy.phrase} to confirm`}
          inputRef={phraseRef}
          className="mono"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          hint="Type it exactly as shown, in capital letters."
        />
        <TextField
          id={`${formId}-totp`}
          label="Fresh authenticator code"
          inputRef={totpRef}
          className="mono"
          value={totp}
          onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          spellCheck={false}
          hint="6 digits from your authenticator app. A code you already used to sign in is refused; wait for the next one."
        />
        {busy && (
          <p className="muted" role="status">
            Sending the transaction and waiting for the blockchain to confirm it. Do not close this page.
          </p>
        )}
      </form>
    </Dialog>
  );
}
