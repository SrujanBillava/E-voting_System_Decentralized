import { Suspense, createElement, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { adminApi } from "../../api/adminApi";
import type { AdminVoter } from "../../api/types";
import { Alert } from "../../components/Alert";
import { Dialog } from "../../components/Dialog";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { formatCount } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { getEnrolmentPanel } from "./biometrics/adapter";
import { PageHead, Pager } from "./parts";
import { useAdminElection } from "./useAdminElection";

type FaceFilter = "all" | "enrolled" | "not-enrolled";
const PAGE_SIZE = 25;

/**
 * STRUCTURE ONLY. The list, the filter and the per-voter action shell exist; enrolment itself is supplied by the biometric
 * integration through ./biometrics/adapter (registerEnrolmentPanel). Until then the actions are disabled and say why.
 */
export default function BiometricsPage() {
  usePageTitle("Biometrics", "VoteChain Administration");
  const { election, refresh: refreshElection } = useAdminElection();
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const face: FaceFilter = params.get("face") === "enrolled" ? "enrolled" : params.get("face") === "not-enrolled" ? "not-enrolled" : "all";
  const voters = useAsync(() => adminApi.voters({ page, limit: PAGE_SIZE }), [page]);
  const [target, setTarget] = useState<AdminVoter | null>(null);
  const [open, setOpen] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);

  const panel = getEnrolmentPanel();
  const locked = election !== null && election.phase !== "Setup"; // enrolment changes are Setup-only (the server enforces it too)
  const data = voters.data;
  const rows = data?.voters.filter((v) => (face === "enrolled" ? v.faceEnrolled : face === "not-enrolled" ? !v.faceEnrolled : true)) ?? [];

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
  };

  return (
    <>
      <PageHead eyebrow="Biometrics" title="Face enrolment">
        See which voters have an enrolled face, and enrol, re-enrol or remove a face. Changes are possible only while the election is in Setup.
      </PageHead>

      {!panel && (
        <div className="mb-4">
          <Alert tone="info" title="Face enrolment is not connected to this console yet">
            The enrol actions below are switched off. Voters already enrolled by another route are shown as enrolled.
          </Alert>
        </div>
      )}

      {locked && (
        <div className="mb-4">
          <Alert tone="info" title="Face enrolment is locked">
            The election is {election?.phase}. Enrolment can no longer be changed; you can still see who is enrolled.
          </Alert>
        </div>
      )}

      {election?.voters && (
        <dl className="summary">
          <div>
            <dt>Face enrolled</dt>
            <dd>
              {formatCount(election.voters.faceEnrolled)} of {formatCount(election.voters.registered)}
            </dd>
          </div>
          <div>
            <dt>Not yet enrolled</dt>
            <dd>{formatCount(Math.max(0, election.voters.registered - election.voters.faceEnrolled))}</dd>
          </div>
        </dl>
      )}

      <section className="section" aria-labelledby="bio-h">
        <h2 className="h2" id="bio-h">
          Voters
        </h2>
        <div className="toolbar items-end">
          <div className="field">
            <label className="label" htmlFor="face-filter">
              Face enrolment
            </label>
            <select id="face-filter" className="select flex-none" value={face} onChange={(e) => update({ face: e.target.value === "all" ? null : e.target.value })} aria-describedby="face-filter-hint">
              <option value="all">All voters</option>
              <option value="enrolled">Enrolled</option>
              <option value="not-enrolled">Not enrolled</option>
            </select>
          </div>
          <p className="hint" id="face-filter-hint">
            The filter applies to the voters on this page only.
          </p>
        </div>

        {voters.status === "loading" && !data && <LoadingState label="Loading voters…" />}
        {voters.status === "error" && <ErrorState error={voters.error} title="Voters could not be loaded" onRetry={voters.reload} />}
        {data && data.voters.length === 0 && <EmptyState title="No voters yet">Add voters on the Voters page, then enrol their faces here.</EmptyState>}
        {data && data.voters.length > 0 && rows.length === 0 && (
          <EmptyState title="No voters on this page match" action={<button type="button" className="btn btn-secondary" onClick={() => update({ face: null })}>Show all voters</button>}>
            Try another page, or change the filter.
          </EmptyState>
        )}
        {data && rows.length > 0 && (
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Voters and face enrolment">
            <table className="table table-dense">
              <caption className="visually-hidden">Voters and whether a face is enrolled</caption>
              <thead>
                <tr>
                  <th scope="col">Voter ID</th>
                  <th scope="col">Name</th>
                  <th scope="col">Constituency</th>
                  <th scope="col">Face enrolled</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id}>
                    <th scope="row" className="mono" translate="no">
                      {v.voterId}
                    </th>
                    <td>{v.name}</td>
                    <td className="mono" translate="no">
                      {v.constituencyCode}
                    </td>
                    <td>{v.faceEnrolled ? <span className="status status-ok">Yes</span> : <span className="status status-neutral">No</span>}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!panel}
                        aria-describedby={panel ? undefined : "enrol-note"}
                        aria-label={locked ? `View face enrolment for ${v.name}` : `${v.faceEnrolled ? "Re-enrol" : "Enrol"} face for ${v.name}`}
                        onClick={() => {
                          setTarget(v);
                          setOpen(true);
                        }}
                      >
                        {locked ? "View" : v.faceEnrolled ? "Re-enrol" : "Enrol"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!panel && (
          <p className="hint mt-3" id="enrol-note">
            Face enrolment is not connected to this console yet, so Enrol and Re-enrol are unavailable.
          </p>
        )}
        {data && data.voters.length > 0 && <Pager page={data.page} totalPages={data.totalPages} total={data.total} noun="voter" onPage={(p) => update({ page: p > 1 ? String(p) : null })} />}
      </section>

      {panel && target && (
        <Dialog
          open={open}
          title={locked ? `Face enrolment of ${target.name}` : `${target.faceEnrolled ? "Re-enrol" : "Enrol"} face for ${target.name}`}
          onClose={() => setOpen(false)}
          busy={panelBusy}
          actions={
            <button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>
              Close
            </button>
          }
        >
          <Suspense fallback={<LoadingState label="Loading face enrolment…" />}>
            {createElement(panel, { voter: { id: target.id, voterId: target.voterId, name: target.name, faceEnrolled: target.faceEnrolled }, onEnrolmentChanged: () => { voters.reload(); void refreshElection(); }, onClose: () => setOpen(false), canModify: election?.phase === "Setup", onBusyChange: setPanelBusy })}
          </Suspense>
        </Dialog>
      )}
    </>
  );
}
