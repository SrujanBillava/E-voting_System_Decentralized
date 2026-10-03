import { useState } from "react";
import { Alert } from "../../components/Alert";
import { CopyButton } from "../../components/CopyButton";
import { ErrorState, LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { formatDateTime } from "../../lib/format";
import { PageHead } from "./parts";
import { CheckResult, PreflightTable } from "./PreflightTable";
import { CHECK_GROUPS, overallLabel } from "./preflightLabels";
import { useAdminElection } from "./useAdminElection";

/** Only what GET /admin/election really returns: the connection identifiers and the preflight check results. */
export default function SystemPage() {
  usePageTitle("System", "VoteChain Administration");
  const { election, error, loading, refreshing, refresh } = useAdminElection();
  const [note, setNote] = useState("");

  if (!election) {
    return (
      <>
        <PageHead eyebrow="System" title="System status" />
        {loading ? <LoadingState label="Loading system status…" /> : <ErrorState error={error} title="System status could not be loaded" onRetry={() => void refresh()} />}
      </>
    );
  }

  const { preflight } = election;
  const known = new Set(CHECK_GROUPS.flatMap((g) => g.names));
  const groups = [
    ...CHECK_GROUPS.map((g) => ({ title: g.title, checks: preflight.checks.filter((c) => g.names.includes(c.name)) })),
    { title: "Other checks", checks: preflight.checks.filter((c) => !known.has(c.name)) },
  ].filter((g) => g.checks.length > 0);

  const check = async () => {
    setNote("");
    const fresh = await refresh();
    setNote(fresh ? `Checks refreshed at ${formatDateTime(fresh.preflight.checkedAt)}: ${overallLabel(fresh.preflight).toLowerCase()}.` : "The checks could not be refreshed.");
  };

  return (
    <>
      <PageHead eyebrow="System" title="System status">
        What the server can reach and verify right now. The checks only read; they never change anything.
      </PageHead>

      <section className="section" aria-labelledby="overall-h">
        <div className="cluster cluster-between">
          <h2 className="h2" id="overall-h">
            Overall
          </h2>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void check()} aria-busy={refreshing || undefined}>
            {refreshing ? "Checking…" : "Refresh checks"}
          </button>
        </div>
        <p className="mt-2">
          <CheckResult status={preflight.status} /> <span className="font-semibold">{overallLabel(preflight)}.</span> <span className="muted">Last checked {formatDateTime(preflight.checkedAt)}.</span>
        </p>
        <p className="visually-hidden" role="status">
          {note}
        </p>
        {error && (
          <div className="mt-3">
            <Alert tone="warn" role="status" title="Refresh failed">
              The results below are from the last successful check.
            </Alert>
          </div>
        )}
      </section>

      {groups.map((g, i) => (
        <section className="section" key={g.title} aria-labelledby={`grp-${i}`}>
          <h2 className="h2 mb-3" id={`grp-${i}`}>
            {g.title}
          </h2>
          <PreflightTable checks={g.checks} label={g.title} />
        </section>
      ))}

      <section className="section" aria-labelledby="conn-h">
        <h2 className="h2" id="conn-h">
          Connection details
        </h2>
        <dl className="dl mt-3">
          <div className="dl-row">
            <dt>Chain ID</dt>
            <dd className="mono" translate="no">
              {election.chainId}
            </dd>
          </div>
          <div className="dl-row">
            <dt>Contract address</dt>
            <dd className="cluster">
              <span className="mono" translate="no">
                {election.contractAddress}
              </span>
              <CopyButton text={election.contractAddress} label="Copy address" className="btn btn-quiet btn-sm" />
            </dd>
          </div>
          <div className="dl-row">
            <dt>Election ID</dt>
            <dd className="cluster">
              <span className="mono" translate="no">
                {election.electionId}
              </span>
              <CopyButton text={election.electionId} label="Copy ID" className="btn btn-quiet btn-sm" />
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
