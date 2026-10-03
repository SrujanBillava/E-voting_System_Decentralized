import { useEffect } from "react";
import { voterApi } from "../../../api/voterApi";
import type { PublicCandidate } from "../../../api/types";
import { ErrorState, LoadingState } from "../../../components/States";
import { usePageTitle } from "../../../components/useRouteFocus";
import { useAsync } from "../../../lib/useAsync";
import { KioskFrame } from "../KioskFrame";
import { useKeepAlive } from "../useKeepAlive";
import { useKiosk } from "../useKioskSession";

/**
 * The voter's own constituency ballot, from the server. Nothing is preselected and no counts exist on this screen.
 * Native fieldset + legend + radios. Re-reading the ballot once a minute also keeps the (idle-limited) session alive
 * while the voter thinks; the stage's own deadline still applies.
 */
export default function BallotScreen({ until, selected, onSelect, onReview, onLoaded }: { until: string; selected: PublicCandidate | null; onSelect: (c: PublicCandidate) => void; onReview: () => void; onLoaded?: (constituencyName: string) => void }) {
  usePageTitle("Your ballot");
  const { finish, sessionLost, refresh } = useKiosk();
  useKeepAlive();
  const ballot = useAsync((signal) => voterApi.ballot(signal));

  useEffect(() => {
    if (ballot.status !== "error") return;
    const { status, code } = ballot.error;
    if (status === 401 || code === "SESSION_EXPIRED") sessionLost("expired");
    else if (code === "ELECTION_CLOSED" || code === "STAGE_REQUIRED") void refresh(); // the server decides what screen this session is on
  }, [ballot.status, ballot.error, sessionLost, refresh]);

  const data = ballot.data;
  const constituencyName = data?.constituency.name;
  useEffect(() => {
    if (constituencyName) onLoaded?.(constituencyName);
  }, [constituencyName, onLoaded]);
  return (
    <KioskFrame
      step={3}
      title="Your ballot"
      until={until}
      onExpire={() => void refresh()}
      secondary={
        <button type="button" className="btn btn-secondary btn-lg" onClick={() => void finish()}>
          End session
        </button>
      }
      primary={
        <button type="button" className="btn btn-primary btn-lg" disabled={!selected} onClick={onReview}>
          Review my selection
        </button>
      }
    >
      {ballot.status === "loading" && !data && <LoadingState label="Loading your ballot…" />}
      {ballot.status === "error" && <ErrorState error={ballot.error} title="Your ballot could not be loaded" onRetry={ballot.reload} />}
      {data && (
        <div className="ballot">
          <div className="ballot-head">
            <span className="eyebrow">Official ballot</span> {data.constituency.name} <span className="mono">{data.constituency.code}</span> <span className="muted">· Select one candidate, then review your choice.</span>
          </div>
          <div className="ballot-body">
            <fieldset className="choice-list">
              <legend className="sr-only">Choose one candidate</legend>
              {data.candidates.map((c) => (
                <label key={c.candidateId} className="choice">
                  <input className="choice-input" type="radio" name="candidate" value={c.candidateId} checked={selected?.candidateId === c.candidateId} onChange={() => onSelect(c)} />
                  <span className="choice-body">
                    <span className="choice-name">{c.name}</span>
                  </span>
                  <span className="choice-state">Selected</span>
                </label>
              ))}
            </fieldset>
          </div>
        </div>
      )}
    </KioskFrame>
  );
}
