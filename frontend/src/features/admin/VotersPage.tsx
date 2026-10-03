import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { adminApi } from "../../api/adminApi";
import type { AdminVoter } from "../../api/types";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { useAsync } from "../../lib/useAsync";
import { LockedNotice, PageHead, Pager } from "./parts";
import { useAdminElection } from "./useAdminElection";
import { useNotice } from "./useNotice";
import { DeleteVoterDialog, ResetPasswordDialog, VoterFormDialog } from "./VoterDialogs";

const PAGE_SIZE = 20;
const intParam = (v: string | null, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

type Dialogs = { kind: "add" } | { kind: "edit" | "reset" | "delete"; voter: AdminVoter } | null;

export default function VotersPage() {
  usePageTitle("Voters", "VoteChain Administration");
  const election = useAdminElection();
  const [params, setParams] = useSearchParams();
  const page = intParam(params.get("page"), 1, 1, 100000);
  const limit = intParam(params.get("limit"), PAGE_SIZE, 1, 100);
  const search = params.get("search") ?? "";
  const constituencyCode = params.get("constituency") ?? "";
  const status = params.get("status") === "ACTIVE" ? "ACTIVE" : params.get("status") === "SUSPENDED" ? "SUSPENDED" : "";

  const voters = useAsync(() => adminApi.voters({ page, limit, search, constituencyCode, status }), [page, limit, search, constituencyCode, status]);
  const constituencies = useAsync(() => adminApi.constituencies());
  const notice = useNotice();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [open, setOpen] = useState(false);

  const phase = election.election?.phase;
  const editable = phase === "Setup";
  const nameOf = (code: string) => constituencies.data?.constituencies.find((c) => c.code === code)?.name;

  const update = (changes: Record<string, string | null>, resetPage = true) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (resetPage) next.delete("page");
    setParams(next);
  };
  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    update({ search: String(new FormData(event.currentTarget).get("search") ?? "").trim() });
  };
  const filtered = Boolean(search || constituencyCode || status);

  const openDialog = (next: NonNullable<Dialogs>) => {
    setDialog(next);
    setOpen(true);
  };
  const close = () => setOpen(false);
  const saved = (title: string, text: React.ReactNode, focus = false) => {
    setOpen(false);
    notice.show({ tone: "ok", title, text }, focus);
    voters.reload();
    void election.refresh();
  };
  const locked = () => {
    setOpen(false);
    notice.show({ tone: "warn", title: "Not saved: the election is no longer in Setup", text: "Voters can no longer be changed. The page has been updated to show the current state." }, true);
    void election.refresh();
  };

  const data = voters.data;
  return (
    <>
      <PageHead eyebrow="Voters" title="Voters">
        {election.election ? (editable ? "Add, edit and remove voters while the election is in Setup." : "The voter roll is frozen. This list is read-only.") : "Loading the election phase…"}
      </PageHead>

      {notice.node}

      {election.election && !editable && phase && <LockedNotice phase={phase} what="Voters" />}
      {!election.election && !election.loading && election.error && <ErrorState error={election.error} title="The election phase could not be loaded" onRetry={() => void election.refresh()} />}

      <section className="section" aria-labelledby="voters-h">
        <h2 className="h2" id="voters-h">
          Electoral roll
        </h2>
        <div className="toolbar items-end">
          <form role="search" className="contents" key={search} onSubmit={onSearch}>
            <div className="field">
              <label className="label" htmlFor="voter-search">
                Search
              </label>
              <input id="voter-search" name="search" type="search" className="input flex-none w-64" maxLength={100} defaultValue={search} placeholder="Name, email or voter ID" autoComplete="off" spellCheck={false} />
            </div>
            <button type="submit" className="btn btn-secondary">
              Search
            </button>
          </form>
          <div className="field">
            <label className="label" htmlFor="voter-const">
              Constituency
            </label>
            <select id="voter-const" className="select flex-none" value={constituencyCode} onChange={(e) => update({ constituency: e.target.value })}>
              <option value="">All constituencies</option>
              {constituencies.data?.constituencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="voter-status">
              Status
            </label>
            <select id="voter-status" className="select flex-none" value={status} onChange={(e) => update({ status: e.target.value })}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
          {filtered && (
            <button type="button" className="btn btn-quiet" onClick={() => setParams(new URLSearchParams())}>
              Clear filters
            </button>
          )}
          {editable && (
            <button type="button" className="btn btn-primary toolbar-end" onClick={() => openDialog({ kind: "add" })}>
              Add voter
            </button>
          )}
        </div>

        {voters.status === "loading" && !data && <LoadingState label="Loading voters…" />}
        {voters.status === "error" && !data && <ErrorState error={voters.error} title="Voters could not be loaded" onRetry={voters.reload} />}
        {voters.status === "error" && data && <ErrorState error={voters.error} title="The list could not be refreshed" onRetry={voters.reload} />}
        {data && data.voters.length === 0 && (
          <EmptyState
            title={data.total > 0 ? "No voters on this page" : filtered ? "No voters match" : "No voters yet"}
            action={
              data.total > 0 ? (
                <button type="button" className="btn btn-secondary" onClick={() => update({ page: null }, false)}>
                  Go to the first page
                </button>
              ) : filtered ? (
                <button type="button" className="btn btn-secondary" onClick={() => setParams(new URLSearchParams())}>
                  Clear filters
                </button>
              ) : editable ? (
                <button type="button" className="btn btn-primary" onClick={() => openDialog({ kind: "add" })}>
                  Add the first voter
                </button>
              ) : undefined
            }
          >
            {data.total > 0 ? "The page you asked for is beyond the end of the list." : filtered ? "Try a different search or filter." : editable ? "Voters must exist before the election can be opened. Each voter belongs to one constituency." : "No voters were added before the election left Setup."}
          </EmptyState>
        )}
        {data && data.voters.length > 0 && (
          <>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Voters">
              <table className="table table-dense">
                <caption className="visually-hidden">Voters. Page {data.page} of {Math.max(data.totalPages, 1)}.</caption>
                <thead>
                  <tr>
                    <th scope="col">Voter ID</th>
                    <th scope="col">Name and email</th>
                    <th scope="col">Constituency</th>
                    <th scope="col">Status</th>
                    <th scope="col">Face enrolled</th>
                    {editable && <th scope="col">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.voters.map((v) => (
                    <tr key={v.id}>
                      <th scope="row" className="mono whitespace-nowrap" translate="no">
                        {v.voterId}
                      </th>
                      <td>
                        <span className="font-semibold">{v.name}</span>
                        <br />
                        <span className="muted" style={{ overflowWrap: "anywhere" }}>
                          {v.email}
                        </span>
                      </td>
                      <td>
                        <span className="mono" translate="no">
                          {v.constituencyCode}
                        </span>
                        {nameOf(v.constituencyCode) && <span className="muted"> {nameOf(v.constituencyCode)}</span>}
                      </td>
                      <td>{v.status === "ACTIVE" ? <span className="status status-ok">Active</span> : <span className="status status-warn">Suspended</span>}</td>
                      <td>{v.faceEnrolled ? <span className="status status-ok">Yes</span> : <span className="status status-neutral">No</span>}</td>
                      {editable && (
                        <td className="whitespace-nowrap">
                          <div className="flex gap-2">
                            <button type="button" className="btn btn-secondary btn-sm" aria-label={`Edit ${v.name}`} onClick={() => openDialog({ kind: "edit", voter: v })}>
                              Edit
                            </button>
                            <button type="button" className="btn btn-secondary btn-sm" aria-label={`Reset password for ${v.name}`} onClick={() => openDialog({ kind: "reset", voter: v })}>
                              Reset password
                            </button>
                            <button type="button" className="btn btn-quiet btn-sm text-danger" aria-label={`Delete ${v.name}`} onClick={() => openDialog({ kind: "delete", voter: v })}>
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={data.page} totalPages={data.totalPages} total={data.total} noun="voter" onPage={(p) => update({ page: p > 1 ? String(p) : null }, false)} />
          </>
        )}
      </section>

      {editable && (
        <>
          <VoterFormDialog mode={dialog?.kind === "edit" ? "edit" : "add"} voter={dialog?.kind === "edit" ? dialog.voter : null} constituencies={constituencies.data?.constituencies ?? []} open={open && (dialog?.kind === "add" || dialog?.kind === "edit")} onClose={close} onLocked={locked} onSaved={(v) => saved(dialog?.kind === "edit" ? "Voter updated" : "Voter added", dialog?.kind === "edit" ? `${v.name} was updated.` : <>{v.name} was added with voter ID <span className="mono" translate="no">{v.voterId}</span>. Give the voter this ID and the password you set.</>)} />
          <ResetPasswordDialog voter={dialog?.kind === "reset" ? dialog.voter : null} open={open && dialog?.kind === "reset"} onClose={close} onLocked={locked} onDone={(v) => saved("Password reset", `The password for ${v.name} was changed.`)} />
          <DeleteVoterDialog voter={dialog?.kind === "delete" ? dialog.voter : null} open={open && dialog?.kind === "delete"} onClose={close} onLocked={locked} onDone={(v) => saved("Voter deleted", `${v.name} was removed from the electoral roll.`, true)} />
        </>
      )}
    </>
  );
}
