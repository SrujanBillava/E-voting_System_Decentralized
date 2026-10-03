import type { ElectionPhase } from "../../../api/types";
import { PhaseBanner } from "../../../components/PhaseStatus";
import { usePageTitle } from "../../../components/useRouteFocus";
import { KioskFrame } from "../KioskFrame";

/** The idle screen. The Begin button is disabled only when the election is known not to be open. */
export default function WelcomeScreen({ phase, notice, onBegin }: { phase: ElectionPhase | null; notice?: string; onBegin: () => void }) {
  usePageTitle("Welcome");
  const closed = phase === "Closed";
  const notOpen = phase === "Setup";
  return (
    <KioskFrame
      title="VoteChain Secure Polling Terminal"
      intro={closed ? "Voting has closed. This terminal is no longer accepting ballots." : notOpen ? "Voting has not opened yet. Please ask a polling official." : "Touch Begin to sign in and cast your vote. A polling official is available if you need help."}
      primary={
        closed || notOpen ? undefined : (
          <button type="button" className="btn btn-primary btn-lg" onClick={onBegin}>
            Begin
          </button>
        )
      }
    >
      {(closed || notOpen) && phase && <PhaseBanner phase={phase}>{closed ? "Voting has ended. No more ballots are accepted at this terminal." : "Voting has not started. Please ask a polling official."}</PhaseBanner>}
      {!closed && !notOpen && (
        <section className="stack" aria-labelledby="next">
          <h2 className="h3" id="next">
            What happens next
          </h2>
          <ol className="prose stack stack-sm">
            <li>Sign in with your voter ID or email and your password.</li>
            <li>Look at the camera for a face check.</li>
            <li>Choose one candidate on your own constituency ballot and review your choice.</li>
            <li>Confirm. Your vote is recorded and you receive a receipt.</li>
          </ol>
        </section>
      )}
      {notice && (
        <div className="alert alert-info" role="status">
          <div>
            <p>{notice}</p>
          </div>
        </div>
      )}
    </KioskFrame>
  );
}
