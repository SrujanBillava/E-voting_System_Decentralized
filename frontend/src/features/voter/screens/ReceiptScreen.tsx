import { useEffect, useRef, useState } from "react";
import { isApiError } from "../../../api/http";
import type { ReceiptConfirmed } from "../../../api/types";
import { voterApi } from "../../../api/voterApi";
import { Alert } from "../../../components/Alert";
import { CopyButton } from "../../../components/CopyButton";
import { LoadingState } from "../../../components/States";
import { usePageTitle } from "../../../components/useRouteFocus";
import { formatDateTime, shortHash } from "../../../lib/format";
import { messageFor } from "../../../lib/errors";
import { KioskFrame } from "../KioskFrame";
import { receiptText } from "../receiptText";
import { useKiosk } from "../useKioskSession";

type View = { kind: "waiting"; late: boolean } | { kind: "ready"; data: ReceiptConfirmed } | { kind: "problem"; code: string; message: string };

/**
 * SUBMITTED / COMPLETED. Polls GET /voter/receipt until the ballot is confirmed (202 = still pending, 200 = receipt).
 * The recorded selection is a transient confirmation for THIS voter; the portable receipt below it is built from the
 * receipt object alone, so neither Copy nor Print can contain the candidate.
 */
export default function ReceiptScreen({ until }: { until: string }) {
  usePageTitle("Your receipt");
  const { finish, sessionLost, refresh } = useKiosk();
  const [view, setView] = useState<View>({ kind: "waiting", late: false });
  const polls = useRef(0);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await voterApi.receipt();
        if (!live) return;
        if (r.status === 200) return setView({ kind: "ready", data: r.body });
        polls.current += 1;
        setView({ kind: "waiting", late: polls.current > 10 });
        timer = setTimeout(() => void poll(), 1500);
      } catch (err) {
        if (!live) return;
        if (isApiError(err) && (err.status === 401 || err.code === "SESSION_EXPIRED")) return sessionLost("expired");
        if (isApiError(err) && err.code === "NETWORK") {
          timer = setTimeout(() => void poll(), 3000); // transient: keep trying quietly
          return;
        }
        setView({ kind: "problem", code: isApiError(err) ? err.code : "UNKNOWN", message: messageFor(err) });
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [round, sessionLost]);

  const end = (
    <button type="button" className="btn btn-secondary btn-lg" onClick={() => void finish()}>
      Done
    </button>
  );

  if (view.kind === "ready") {
    const { receipt, recordedSelection } = view.data;
    const text = receiptText(receipt, window.location.origin);
    return (
      <KioskFrame
        title="Your vote has been recorded"
        until={view.data.stageExpiresAt}
        countdownLabel="Screen closes in"
        onExpire={() => void finish()}
        secondary={
          <div className="cluster">
            <CopyButton text={text} label="Copy receipt" copiedLabel="Receipt copied" className="btn btn-secondary btn-lg" />
            <button type="button" className="btn btn-secondary btn-lg" onClick={() => window.print()}>
              Print receipt
            </button>
          </div>
        }
        primary={
          <button type="button" className="btn btn-primary btn-lg" onClick={() => void finish()}>
            Done
          </button>
        }
      >
        <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[2fr_3fr]">
        <section className="stack recorded-selection" aria-labelledby="sel">
          <h2 className="eyebrow" id="sel">
            Your recorded selection
          </h2>
          <p className="selection-name">{recordedSelection.name}</p>
          <p className="muted">Shown on this screen only. It is not part of your receipt.</p>
        </section>

        <section className="stack" aria-labelledby="rcpt">
          <h2 className="eyebrow" id="rcpt">
            Receipt
          </h2>
          <div className="receipt">
            <dl className="dl">
              <div className="dl-row">
                <dt>Ballot number</dt>
                <dd className="tabular">{receipt.ballotIndex}</dd>
              </div>
              <div className="dl-row">
                <dt>Transaction</dt>
                <dd className="mono" translate="no">
                  {receipt.txHash}
                </dd>
              </div>
              <div className="dl-row">
                <dt>Recorded</dt>
                <dd>{formatDateTime(receipt.confirmedAt)}</dd>
              </div>
              <div className="dl-row">
                <dt>Block</dt>
                <dd className="mono tabular" translate="no">
                  {receipt.blockNumber}
                </dd>
              </div>
              <div className="dl-row">
                <dt>Election</dt>
                <dd className="mono" translate="no" title={receipt.electionId}>
                  {shortHash(receipt.electionId, 12, 10)}
                </dd>
              </div>
            </dl>
          </div>
          <p className="muted no-print">
            The receipt does not contain your selection. Anyone can use it to check that a ballot was recorded, and VoteChain does not make that check secret from the public ledger: the recorded choice is visible there. Share it only if you choose to.
          </p>
        </section>
        </div>
      </KioskFrame>
    );
  }

  if (view.kind === "problem") {
    const notRecorded = view.code === "VOTE_NOT_RECORDED";
    return (
      <KioskFrame step={6} title={notRecorded ? "Your ballot was not recorded" : "We could not show your receipt"} secondary={end} primary={!notRecorded ? <button type="button" className="btn btn-primary btn-lg" onClick={() => { setView({ kind: "waiting", late: false }); polls.current = 0; setRound((n) => n + 1); void refresh(); }}>Try again</button> : undefined}>
        <Alert tone="danger" title="Please ask a polling official">
          <p>{view.message}</p>
          <p>Stay at the terminal. Do not try to vote again on your own.</p>
        </Alert>
      </KioskFrame>
    );
  }

  return (
    <KioskFrame step={6} title="Confirming your ballot" intro="Your ballot was submitted and is being confirmed. Please wait; do not leave the terminal." until={until} onExpire={() => void refresh()}>
      <LoadingState label={view.late ? "Still confirming. This is taking longer than usual…" : "Waiting for confirmation…"} />
      {view.late && (
        <Alert tone="warn" title="This is taking longer than usual" role="status">
          <p>Your ballot has not been lost. If this continues, please ask a polling official.</p>
        </Alert>
      )}
    </KioskFrame>
  );
}
