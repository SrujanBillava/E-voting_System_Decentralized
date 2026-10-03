import type { PublicCandidate } from "../../../api/types";
import { usePageTitle } from "../../../components/useRouteFocus";
import { KioskFrame } from "../KioskFrame";
import { useKeepAlive } from "../useKeepAlive";
import { useKiosk } from "../useKioskSession";

/** The explicit confirmation step. Nothing has been sent to the server about this choice yet. */
export default function ReviewScreen({ until, candidate, constituencyName, onChange, onConfirm }: { until: string; candidate: PublicCandidate; constituencyName?: string; onChange: () => void; onConfirm: () => void }) {
  usePageTitle("Review your selection");
  const { refresh } = useKiosk();
  useKeepAlive();
  return (
    <KioskFrame
      step={4}
      title="Review your selection"
      intro="Check your choice. After you confirm, it is locked and cannot be changed."
      until={until}
      onExpire={() => void refresh()}
      secondary={
        <button type="button" className="btn btn-secondary btn-lg" onClick={onChange}>
          Change selection
        </button>
      }
      primary={
        <button type="button" className="btn btn-primary btn-lg" onClick={onConfirm}>
          Confirm and cast vote
        </button>
      }
    >
      <section className="stack" aria-labelledby="chosen">
        <h2 className="eyebrow" id="chosen">
          You selected
        </h2>
        <p className="selection-name">{candidate.name}</p>
        {constituencyName && <p className="muted">Constituency: {constituencyName}</p>}
      </section>
    </KioskFrame>
  );
}
