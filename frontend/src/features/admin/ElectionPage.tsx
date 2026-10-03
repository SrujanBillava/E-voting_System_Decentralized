import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "../../components/Alert";
import { CopyButton } from "../../components/CopyButton";
import { PhaseBanner, PhaseStatus } from "../../components/PhaseStatus";
import { ErrorState, LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { formatCount, formatDateTime } from "../../lib/format";
import ConfirmElectionDialog from "./ConfirmElectionDialog";
import { openBlockers, type LifecycleKind } from "./lifecycle";
import { PageHead } from "./parts";
import { CheckResult, PreflightTable } from "./PreflightTable";
import { checkLabel, overallLabel } from "./preflightLabels";
import { useAdminElection } from "./useAdminElection";
import { useNotice } from "./useNotice";

const LEDE = {
  Setup: "The election is in Setup. Configure voters, constituencies and candidates, then open it when the system checks pass.",
  Open: "Voting is open. Configuration is frozen. Close the election when voting is over.",
  Closed: "Voting has closed. The election cannot be reopened.",
} as const;

export default function ElectionPage() {
  usePageTitle("Election", "VoteChain Administration");
  const { election, error, loading, refreshing, refresh } = useAdminElection();
  const [kind, setKind] = useState<LifecycleKind>("open");
  const [dialogOpen, setDialogOpen] = useState(false);
  const notice = useNotice();
  const [checkNote, setCheckNote] = useState("");

  if (!election) {
    return (
      <>
        <PageHead eyebrow="Election" title="Election control" />
        {loading ? <LoadingState label="Loading the election…" /> : <ErrorState error={error} title="The election could not be loaded" onRetry={() => void refresh()} />}
      </>
    );
  }

  const { phase, preflight } = election;
  const blockers = openBlockers(election);

  const refreshChecks = async () => {
    setCheckNote("");
    const fresh = await refresh();
    setCheckNote(fresh ? `Checks refreshed at ${formatDateTime(fresh.preflight.checkedAt)}: ${overallLabel(fresh.preflight).toLowerCase()}.` : "The checks could not be refreshed.");
  };

  const done = async () => {
    // Never assume the new phase: ask the backend again and report what it says.
    const fresh = await refresh();
    setDialogOpen(false);
    notice.show(
      fresh
        ? { tone: "ok", title: kind === "open" ? "Election opened" : "Election closed", text: `The backend now reports the election as ${fresh.phase}.` }
        : { tone: "warn", title: "Request accepted", text: "The action was accepted, but the latest election state could not be loaded. Refresh to confirm the phase." },
      true,
    );
  };

  return (
    <>
      <PageHead eyebrow="Election" title="Election control">
        {LEDE[phase]}
      </PageHead>

      {notice.node}

      {phase === "Closed" && (
        <div className="mb-4">
          <PhaseBanner phase="Closed">Voting has closed. The election cannot be reopened.</PhaseBanner>
        </div>
      )}

      <dl className="summary">
        <div>
          <dt>Phase</dt>
          <dd>
            <PhaseStatus phase={phase} />
          </dd>
        </div>
        <div>
          <dt>Registered voters</dt>
          <dd>{election.voters ? formatCount(election.voters.registered) : "Not available"}</dd>
        </div>
        <div>
          <dt>Face enrolled</dt>
          <dd>{election.voters ? formatCount(election.voters.faceEnrolled) : "Not available"}</dd>
        </div>
        {phase === "Setup" ? (
          <div>
            <dt>Constituencies / candidates</dt>
            <dd>
              {formatCount(election.constituencyCount)} / {formatCount(election.candidateCount)}
            </dd>
          </div>
        ) : (
          <div>
            <dt>Ballots recorded</dt>
            <dd>{formatCount(election.totalBallots)}</dd>
          </div>
        )}
      </dl>

      <section className="section" aria-labelledby="lifecycle-h">
        <h2 className="h2" id="lifecycle-h">
          Election lifecycle
        </h2>
        {phase === "Setup" && (
          <div className="stack mt-3">
            <p className="prose">Opening the election starts voting and freezes the configuration: voters, constituencies and candidates can no longer be changed. You will be asked to type a confirmation phrase and enter a fresh authenticator code.</p>
            {blockers.blocked && (
              <Alert tone="warn" title="The election cannot be opened yet">
                {blockers.failed.length > 0 ? `These system checks are failing: ${blockers.failed.map(checkLabel).join("; ")}.` : "The constituency and candidate configuration is not ready: add at least one constituency and give each constituency at least one candidate."} See the system checks below.
              </Alert>
            )}
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => { setKind("open"); setDialogOpen(true); }}>
                Open election
              </button>
            </div>
          </div>
        )}
        {phase === "Open" && (
          <div className="stack mt-3">
            <p className="prose">Closing the election stops voting immediately and makes the official results available to the public. It cannot be reopened.</p>
            <div className="actions">
              <button type="button" className="btn btn-danger btn-sm" onClick={() => { setKind("close"); setDialogOpen(true); }}>
                Close election
              </button>
            </div>
          </div>
        )}
        {phase === "Closed" && (
          <div className="stack mt-3">
            <p className="prose">Voting stopped and the official results are published. No further lifecycle action is available.</p>
            <div className="actions">
              <Link to="/results" className="btn btn-secondary">
                View public results
              </Link>
            </div>
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="checks-h">
        <div className="cluster cluster-between">
          <h2 className="h2" id="checks-h">
            System checks
          </h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refreshChecks()} aria-busy={refreshing || undefined}>
            {refreshing ? "Checking…" : "Refresh checks"}
          </button>
        </div>
        <p className="mt-2 mb-3">
          <span className={preflight.ok ? "" : "font-semibold"}>
            <CheckResult status={preflight.status} /> {overallLabel(preflight)}.
          </span>{" "}
          <span className="muted">Last checked {formatDateTime(preflight.checkedAt)}.</span>
        </p>
        <p className="visually-hidden" role="status">
          {checkNote}
        </p>
        {error && (
          <div className="mb-3">
            <Alert tone="warn" role="status" title="Refresh failed">
              The checks shown are from the last successful read.
            </Alert>
          </div>
        )}
        <PreflightTable checks={preflight.checks} label="System checks" />
      </section>

      <section className="section" aria-labelledby="record-h">
        <h2 className="h2" id="record-h">
          Election record
        </h2>
        <dl className="dl mt-3">
          <div className="dl-row">
            <dt>Election ID</dt>
            <dd className="cluster">
              <span className="mono" translate="no">
                {election.electionId}
              </span>
              <CopyButton text={election.electionId} label="Copy ID" copiedLabel="Copied" className="btn btn-quiet btn-sm" />
            </dd>
          </div>
          <div className="dl-row">
            <dt>Contract address</dt>
            <dd className="cluster">
              <span className="mono" translate="no">
                {election.contractAddress}
              </span>
              <CopyButton text={election.contractAddress} label="Copy address" copiedLabel="Copied" className="btn btn-quiet btn-sm" />
            </dd>
          </div>
          <div className="dl-row">
            <dt>Chain ID</dt>
            <dd className="mono" translate="no">
              {election.chainId}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Constituencies</dt>
            <dd>{formatCount(election.constituencyCount)}</dd>
          </div>
          <div className="dl-row">
            <dt>Candidates</dt>
            <dd>{formatCount(election.candidateCount)}</dd>
          </div>
        </dl>
      </section>

      <ConfirmElectionDialog kind={kind} election={election} open={dialogOpen} onClose={() => setDialogOpen(false)} onDone={done} onRefresh={() => void refresh()} />
    </>
  );
}
