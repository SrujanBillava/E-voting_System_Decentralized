import { useRef, useState, type FormEvent } from "react";
import { adminApi } from "../../api/adminApi";
import { EmptyState, ErrorState, LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { messageFor } from "../../lib/errors";
import { formatCount, shortHash } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { Alert } from "../../components/Alert";
import { LockedNotice, PageHead, TextField } from "./parts";
import { isLockedError, toApiError, useAdminElection } from "./useAdminElection";
import { useNotice } from "./useNotice";

/** Mirrors backend-api/src/chain/ids.js canonicalConstituencyCode: trimmed, UPPERCASE, A-Z0-9 groups joined by single hyphens, max 40. */
const CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const normaliseCode = (input: string): string => input.trim().toUpperCase();

export default function ConstituenciesPage() {
  usePageTitle("Constituencies", "VoteChain Administration");
  const election = useAdminElection();
  const list = useAsync(() => adminApi.constituencies());
  const notice = useNotice();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [problems, setProblems] = useState<{ code?: string; name?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const phase = election.election?.phase;
  const editable = phase === "Setup";
  const normalised = normaliseCode(code);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next: { code?: string; name?: string } = {};
    if (!normalised) next.code = "Enter a constituency code, such as KA-BLR.";
    else if (normalised.length > 40) next.code = "Use at most 40 characters.";
    else if (!CODE_PATTERN.test(normalised)) next.code = "Use letters and digits only, with single hyphens between groups (for example KA-BLR-NORTH).";
    if (!name.trim()) next.name = "Enter the constituency name.";
    else if (name.trim().length > 100) next.name = "Use at most 100 characters.";
    setProblems(next);
    setFailure(null);
    if (next.code || next.name) {
      (next.code ? codeRef : nameRef).current?.focus();
      return;
    }
    setBusy(true);
    try {
      const { constituency, txHash } = await adminApi.addConstituency(normalised, name.trim());
      notice.show({
        tone: "ok",
        title: "Constituency added",
        text: (
          <>
            <span className="mono" translate="no">
              {constituency.code}
            </span>{" "}
            · {constituency.name} was written to the election contract (transaction{" "}
            <span className="mono" translate="no">
              {shortHash(txHash)}
            </span>
            ).
          </>
        ),
      });
      setCode("");
      setName("");
      list.reload();
      void election.refresh();
      requestAnimationFrame(() => codeRef.current?.focus());
    } catch (err) {
      const e = toApiError(err);
      if (e.code === "CONSTITUENCY_EXISTS") {
        setProblems({ code: `${normalised} already exists. Choose a different code.` });
        requestAnimationFrame(() => codeRef.current?.focus());
      } else {
        setFailure(messageFor(e));
        if (isLockedError(e)) void election.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const items = list.data?.constituencies;
  return (
    <>
      <PageHead eyebrow="Constituencies" title="Constituencies">
        {election.election ? (editable ? "Each voter and candidate belongs to one constituency. Constituencies are written to the election contract and cannot be edited or removed." : "The constituency list is frozen. This list is read-only.") : "Loading the election phase…"}
      </PageHead>

      {notice.node}

      {election.election && !editable && phase && <LockedNotice phase={phase} what="Constituencies" />}
      {!election.election && !election.loading && election.error && <ErrorState error={election.error} title="The election phase could not be loaded" onRetry={() => void election.refresh()} />}

      {editable && (
        <section className="section" aria-labelledby="add-h">
          <h2 className="h2" id="add-h">
            Add a constituency
          </h2>
          <form className="stack mt-3" onSubmit={submit} noValidate>
            {failure && (
              <Alert tone="danger" role="alert" title="Constituency not added">
                {failure}
              </Alert>
            )}
            <div className="grid-auto">
              <TextField
                id="const-code"
                label="Code"
                name="code"
                className="mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                error={problems.code}
                inputRef={codeRef}
                hint={
                  <>
                    Letters and digits with single hyphens, saved in capitals (for example KA-BLR).
                    {normalised && normalised !== code && CODE_PATTERN.test(normalised) && (
                      <>
                        {" "}
                        Will be saved as{" "}
                        <span className="mono" translate="no">
                          {normalised}
                        </span>
                        .
                      </>
                    )}
                  </>
                }
                required
              />
              <TextField id="const-name" label="Name" name="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" error={problems.name} inputRef={nameRef} hint="Shown to voters on their ballot." required />
            </div>
            <div className="actions">
              <button type="submit" className="btn btn-primary" aria-busy={busy || undefined}>
                {busy ? "Saving to the election contract…" : "Add constituency"}
              </button>
              {busy && (
                <span className="muted" role="status">
                  Waiting for the blockchain to confirm the transaction. This can take a few seconds.
                </span>
              )}
            </div>
          </form>
        </section>
      )}

      <section className="section" aria-labelledby="list-h">
        <h2 className="h2" id="list-h">
          Constituencies on the contract
        </h2>
        {list.status === "loading" && !items && <LoadingState label="Loading constituencies…" />}
        {list.status === "error" && <ErrorState error={list.error} title="Constituencies could not be loaded" onRetry={list.reload} />}
        {items && items.length === 0 && (
          <EmptyState title="No constituencies yet">{editable ? "Add the first constituency above. Voters and candidates are assigned to a constituency." : "No constituencies were added before the election left Setup."}</EmptyState>
        )}
        {items && items.length > 0 && (
          <div className="mt-3">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Constituencies">
              <table className="table table-dense">
                <caption className="visually-hidden">Constituencies and their candidate counts</caption>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col" className="num">
                      Candidates
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c) => (
                    <tr key={c.code}>
                      <th scope="row" className="mono" translate="no">
                        {c.code}
                      </th>
                      <td>{c.name}</td>
                      <td className="num">{formatCount(c.candidateCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pager-info mt-3" role="status">
              {items.length} constituenc{items.length === 1 ? "y" : "ies"}
            </p>
          </div>
        )}
      </section>
    </>
  );
}
