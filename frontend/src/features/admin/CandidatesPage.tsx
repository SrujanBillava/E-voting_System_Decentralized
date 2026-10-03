import { useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { adminApi } from "../../api/adminApi";
import { Alert } from "../../components/Alert";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { messageFor } from "../../lib/errors";
import { shortHash } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { LockedNotice, PageHead, SelectField, TextField } from "./parts";
import { isLockedError, toApiError, useAdminElection } from "./useAdminElection";
import { useNotice } from "./useNotice";

export default function CandidatesPage() {
  usePageTitle("Candidates", "VoteChain Administration");
  const election = useAdminElection();
  const [params, setParams] = useSearchParams();
  const filter = params.get("constituency") ?? "";
  const constituencies = useAsync(() => adminApi.constituencies());
  const list = useAsync(() => adminApi.candidates(filter || undefined), [filter]);
  const notice = useNotice();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [problems, setProblems] = useState<{ name?: string; code?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLSelectElement>(null);

  const phase = election.election?.phase;
  const editable = phase === "Setup";
  const options = constituencies.data?.constituencies ?? [];
  const nameOf = (c: string) => options.find((o) => o.code === c)?.name;

  const setFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("constituency", value);
    else next.delete("constituency");
    setParams(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next: { name?: string; code?: string } = {};
    if (!name.trim()) next.name = "Enter the candidate's name.";
    else if (name.trim().length > 100) next.name = "Use at most 100 characters.";
    if (!code) next.code = "Choose the constituency this candidate stands in.";
    setProblems(next);
    setFailure(null);
    if (next.name || next.code) {
      (next.name ? nameRef : codeRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      const { candidate, txHash } = await adminApi.addCandidate(name.trim(), code);
      notice.show({
        tone: "ok",
        title: "Candidate added",
        text: (
          <>
            {candidate.name} (candidate{" "}
            <span className="mono" translate="no">
              {candidate.candidateId}
            </span>
            ) in{" "}
            <span className="mono" translate="no">
              {candidate.constituencyCode}
            </span>{" "}
            was written to the election contract (transaction{" "}
            <span className="mono" translate="no">
              {shortHash(txHash)}
            </span>
            ).
          </>
        ),
      });
      setName(""); // the constituency stays selected: candidates are usually entered one constituency at a time
      list.reload();
      constituencies.reload();
      void election.refresh();
      requestAnimationFrame(() => nameRef.current?.focus());
    } catch (err) {
      const e = toApiError(err);
      if (e.code === "UNKNOWN_CONSTITUENCY") {
        setProblems({ code: "That constituency does not exist on the election contract." });
        requestAnimationFrame(() => codeRef.current?.focus());
      } else {
        setFailure(messageFor(e));
        if (isLockedError(e)) void election.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const items = list.data?.candidates;
  return (
    <>
      <PageHead eyebrow="Candidates" title="Candidates">
        {election.election ? (editable ? "Candidates are written to the election contract and cannot be edited or removed." : "The candidate list is frozen. This list is read-only.") : "Loading the election phase…"}
      </PageHead>

      {notice.node}

      {election.election && !editable && phase && <LockedNotice phase={phase} what="Candidates" />}
      {!election.election && !election.loading && election.error && <ErrorState error={election.error} title="The election phase could not be loaded" onRetry={() => void election.refresh()} />}

      {editable && (
        <section className="section" aria-labelledby="add-h">
          <h2 className="h2" id="add-h">
            Add a candidate
          </h2>
          {constituencies.status === "ready" && options.length === 0 ? (
            <div className="mt-3">
              <Alert tone="info" title="Add a constituency first">
                A candidate must stand in a constituency. <Link to="/admin/constituencies">Go to Constituencies</Link>.
              </Alert>
            </div>
          ) : (
            <form className="stack mt-3" onSubmit={submit} noValidate>
              {failure && (
                <Alert tone="danger" role="alert" title="Candidate not added">
                  {failure}
                </Alert>
              )}
              <div className="grid-auto">
                <TextField id="cand-name" label="Candidate name" name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" error={problems.name} inputRef={nameRef} hint="Shown to voters on their ballot." required />
                <SelectField id="cand-const" label="Constituency" name="constituencyCode" value={code} onChange={(e) => setCode(e.target.value)} error={problems.code} selectRef={codeRef} required>
                  <option value="">{constituencies.status === "loading" ? "Loading constituencies…" : "Choose a constituency"}</option>
                  {options.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.name}
                    </option>
                  ))}
                </SelectField>
              </div>
              <div className="actions">
                <button type="submit" className="btn btn-primary" aria-busy={busy || undefined}>
                  {busy ? "Saving to the election contract…" : "Add candidate"}
                </button>
                {busy && (
                  <span className="muted" role="status">
                    Waiting for the blockchain to confirm the transaction. This can take a few seconds.
                  </span>
                )}
              </div>
            </form>
          )}
        </section>
      )}

      <section className="section" aria-labelledby="list-h">
        <h2 className="h2" id="list-h">
          Candidates on the contract
        </h2>
        <div className="toolbar items-end">
          <div className="field">
            <label className="label" htmlFor="cand-filter">
              Constituency
            </label>
            <select id="cand-filter" className="select flex-none" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All constituencies</option>
              {options.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} · {c.name}
                </option>
              ))}
            </select>
          </div>
          {filter && (
            <button type="button" className="btn btn-quiet" onClick={() => setFilter("")}>
              Clear filter
            </button>
          )}
        </div>
        {list.status === "loading" && !items && <LoadingState label="Loading candidates…" />}
        {list.status === "error" && <ErrorState error={list.error} title="Candidates could not be loaded" onRetry={list.reload} />}
        {items && items.length === 0 && (
          <EmptyState title={filter ? "No candidates in this constituency" : "No candidates yet"}>
            {filter ? "Choose another constituency or clear the filter." : editable ? "Add the first candidate above." : "No candidates were added before the election left Setup."}
          </EmptyState>
        )}
        {items && items.length > 0 && (
          <>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Candidates">
              <table className="table table-dense">
                <caption className="visually-hidden">Candidates{filter ? ` in ${filter}` : ""}</caption>
                <thead>
                  <tr>
                    <th scope="col" className="num w-px whitespace-nowrap">
                      Candidate ID
                    </th>
                    <th scope="col">Name</th>
                    <th scope="col">Constituency</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.candidateId}>
                      <th scope="row" className="num mono w-px whitespace-nowrap">
                        {c.candidateId}
                      </th>
                      <td>{c.name}</td>
                      <td>
                        <span className="mono" translate="no">
                          {c.constituencyCode}
                        </span>
                        {nameOf(c.constituencyCode) && <span className="muted"> {nameOf(c.constituencyCode)}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pager-info mt-3" role="status">
              {items.length} candidate{items.length === 1 ? "" : "s"}
            </p>
          </>
        )}
      </section>
    </>
  );
}
