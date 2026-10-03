import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { publicApi } from "../../api/publicApi";
import type { PublicReceiptCheck } from "../../api/types";
import { Alert } from "../../components/Alert";
import { LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { formatDateTime, TX_HASH } from "../../lib/format";
import { messageFor } from "../../lib/errors";
import { useAsync } from "../../lib/useAsync";
import { TRUST } from "./content";

/** Public verification. It can only ever show what the public API returns, and that never includes the candidate. */
export default function VerifyPage() {
  usePageTitle("Verify a receipt");
  const { txHash } = useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(txHash ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [recheck, setRecheck] = useState(0);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = draft.trim();
    if (!TX_HASH.test(value)) {
      setFormError("Enter the transaction reference exactly as shown on the receipt: 0x followed by 64 characters (0–9, a–f).");
      document.getElementById("tx")?.focus();
      return;
    }
    setFormError(null);
    const target = `/verify/${value.toLowerCase()}`;
    if (window.location.pathname === target) setRecheck((n) => n + 1);
    else navigate(target);
  };

  const urlHashInvalid = txHash !== undefined && !TX_HASH.test(txHash);
  return (
    <div className="container stack stack-lg">
      <div className="page-head">
        <p className="eyebrow">Public verification</p>
        <h1 className="h1">Verify a receipt</h1>
        <p className="lede">Paste the transaction reference from a receipt to check that a ballot with that reference was recorded in this election.</p>
      </div>

      <form className="stack" onSubmit={onSubmit} noValidate>
        <div className="field">
          <label className="label" htmlFor="tx">
            Transaction reference
          </label>
          <input
            id="tx"
            name="txHash"
            className="input mono"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="text"
            placeholder="0x…"
            aria-describedby={formError || urlHashInvalid ? "tx-hint tx-err" : "tx-hint"}
            aria-invalid={formError || urlHashInvalid ? true : undefined}
          />
          <p className="hint" id="tx-hint">
            Starts with 0x and has 64 more characters.
          </p>
          {(formError || urlHashInvalid) && (
            <p className="field-error" id="tx-err" role="alert">
              {formError ?? "That link does not contain a valid transaction reference."}
            </p>
          )}
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary">
            Verify receipt
          </button>
        </div>
      </form>

      {txHash && !urlHashInvalid && <VerifyResult key={`${txHash}:${recheck}`} txHash={txHash} />}
    </div>
  );
}

function VerifyResult({ txHash }: { txHash: string }) {
  const check = useAsync((signal) => publicApi.verifyReceipt(txHash, signal), [txHash]);

  if (check.status === "loading" && !check.data) return <LoadingState label="Checking the public record…" />;
  if (check.status === "error") {
    const code = check.error.code;
    const tone = code === "RECEIPT_NOT_FOUND" || code === "RECEIPT_INVALID" ? "warn" : "danger";
    const title = code === "RECEIPT_NOT_FOUND" ? "No such transaction" : code === "RECEIPT_INVALID" ? "Not a recorded ballot of this election" : code === "CHAIN_UNAVAILABLE" || code === "NETWORK" ? "The record cannot be reached right now" : "The check could not be completed";
    return (
      <div className="stack">
        <Alert tone={tone} title={title} role="alert">
          <p>{messageFor(check.error)}</p>
          {code === "RECEIPT_NOT_FOUND" && <p>Check the reference for typing errors.</p>}
          {(code === "CHAIN_UNAVAILABLE" || code === "NETWORK" || code === "RATE_LIMITED") && <p>This is not a statement about the receipt. Try again shortly.</p>}
        </Alert>
        {(code === "CHAIN_UNAVAILABLE" || code === "NETWORK" || code === "RATE_LIMITED") && (
          <div className="actions">
            <button type="button" className="btn btn-secondary" onClick={check.reload}>
              Try again
            </button>
          </div>
        )}
      </div>
    );
  }
  const data = check.data;
  if (!data) return null;
  return data.status === "CONFIRMED" ? <Confirmed data={data} /> : <NotFinal data={data} onCheckAgain={check.reload} />;
}

function NotFinal({ data, onCheckAgain }: { data: PublicReceiptCheck; onCheckAgain: () => void }) {
  return (
    <div className="stack">
      <Alert tone="warn" title="Not final yet" role="status">
        <p>{data.status === "PENDING" ? "This transaction has been submitted but has not been recorded in a block yet." : "This transaction is recorded but has not yet been followed by enough later blocks to be treated as final."}</p>
        {typeof data.confirmations === "number" && <p>Confirmations so far: {data.confirmations}.</p>}
      </Alert>
      <div className="actions">
        <button type="button" className="btn btn-secondary" onClick={onCheckAgain}>
          Check again
        </button>
      </div>
    </div>
  );
}

function Confirmed({ data }: { data: PublicReceiptCheck }) {
  return (
    <div className="stack stack-lg" aria-live="polite">
      <Alert tone="ok" title="Ballot recorded" role="status">
        <p>A ballot represented by this transaction is recorded for this election and constituency.</p>
      </Alert>

      <dl className="dl">
        <div className="dl-row">
          <dt>Ballot number</dt>
          <dd className="tabular">{data.ballotIndex}</dd>
        </div>
        <div className="dl-row">
          <dt>Constituency</dt>
          <dd>
            {data.constituency?.name} <span className="mono muted">{data.constituency?.code}</span>
          </dd>
        </div>
        {data.confirmedAt && (
          <div className="dl-row">
            <dt>Recorded at</dt>
            <dd>{formatDateTime(data.confirmedAt)}</dd>
          </div>
        )}
        <div className="dl-row">
          <dt>Block</dt>
          <dd className="mono tabular" translate="no">
            {data.blockNumber}
          </dd>
        </div>
        <div className="dl-row">
          <dt>Election</dt>
          <dd className="mono" translate="no">
            {data.electionId}
          </dd>
        </div>
        <div className="dl-row">
          <dt>Transaction</dt>
          <dd className="mono" translate="no">
            {data.txHash}
          </dd>
        </div>
      </dl>

      <section className="section stack" aria-labelledby="proves">
        <h2 className="h2" id="proves">
          What this shows
        </h2>
        <p className="prose">{data.statement ?? TRUST.verifyStatement}</p>
        <ul className="prose stack stack-sm">
          <li>It shows a ballot was recorded by this election contract and remains part of the public record.</li>
          <li>It does not show who the voter was.</li>
          <li>It does not show that the recorded choice matches what the voter intended.</li>
          <li>It does not mean the vote was secret, and it does not protect against coercion.</li>
        </ul>
      </section>
    </div>
  );
}
