import { useState } from "react";
import type { PublicCandidate } from "../../api/types";
import { LoadingState } from "../../components/States";
import BallotScreen from "./screens/BallotScreen";
import CastingScreen from "./screens/CastingScreen";
import EligibilityScreen from "./screens/EligibilityScreen";
import FaceScreen from "./screens/FaceScreen";
import LoginScreen from "./screens/LoginScreen";
import NoticeScreen from "./screens/NoticeScreen";
import ReceiptScreen from "./screens/ReceiptScreen";
import ReviewScreen from "./screens/ReviewScreen";
import WelcomeScreen from "./screens/WelcomeScreen";
import { useKiosk } from "./useKioskSession";

/**
 * Renders the kiosk from the SERVER's stage (GET /voter/status). The only things held here are UI choices the server has not
 * been told about yet: the highlighted candidate and whether the voter pressed "Confirm". Nothing is persisted in the browser.
 */
export default function Kiosk() {
  const { state } = useKiosk();
  // The inner tree is keyed by the SESSION. When a session ends (Done, End session, timeout, closed) or a new one begins, every piece
  // of UI state (begun, highlighted candidate, review, confirm) is discarded, so nothing can carry over from one voter to the next.
  const key = state.kind === "session" ? `session:${state.status.voter.voterId}:${state.status.sessionExpiresAt}` : state.kind;
  return <KioskScreens key={key} />;
}

function KioskScreens() {
  const { state, refresh, finish } = useKiosk();
  const [constituencyName, setConstituencyName] = useState<string | undefined>(undefined);
  const [begun, setBegun] = useState(false);
  const [selected, setSelected] = useState<PublicCandidate | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  if (state.kind === "loading") {
    return (
      <main id="main" className="shell-main" tabIndex={-1}>
        <div className="container">
          <LoadingState label="Starting the terminal…" />
        </div>
      </main>
    );
  }

  if (state.kind === "unavailable") {
    return <NoticeScreen title="This terminal cannot reach the voting service" text="Please ask a polling official. Do not leave a ballot unfinished." action={{ label: "Try again", onClick: () => void refresh() }} />;
  }

  if (state.kind === "ended") {
    return <NoticeScreen title="Voting is closed" text="This election is no longer accepting ballots. If you voted earlier, your ballot was recorded." action={{ label: "Return to the start", onClick: () => void finish() }} />;
  }

  if (state.kind === "anonymous") {
    if (!begun) {
      return <WelcomeScreen phase={state.electionPhase} notice={state.notice} onBegin={() => setBegun(true)} />;
    }
    return <LoginScreen onCancel={() => setBegun(false)} />;
  }

  const { status } = state;
  const until = status.stageExpiresAt;
  switch (status.stage) {
    case "AUTHENTICATED":
      return <FaceScreen voter={{ name: status.voter.name, voterId: status.voter.voterId }} until={until} />;
    case "FACE_VERIFIED":
      return <EligibilityScreen until={until} />;
    case "ELIGIBLE":
      if (confirmed && selected) return <CastingScreen candidate={selected} />;
      if (reviewing && selected) {
        return <ReviewScreen until={until} candidate={selected} constituencyName={constituencyName} onChange={() => setReviewing(false)} onConfirm={() => setConfirmed(true)} />;
      }
      return <BallotScreen until={until} selected={selected} onSelect={setSelected} onReview={() => setReviewing(true)} onLoaded={setConstituencyName} />;
    case "AUTH_ISSUED":
      return <CastingScreen candidate={null} />;
    case "SUBMITTED":
    case "COMPLETED":
      return <ReceiptScreen until={until} />;
  }
}
