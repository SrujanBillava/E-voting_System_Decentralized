import { Outlet } from "react-router-dom";
import { useRouteFocus } from "../components/useRouteFocus";
import { KioskSessionProvider } from "../features/voter/useKioskSession";

/**
 * VOTER KIOSK context: a full-screen terminal. No public navigation, no results or verification links, no admin chrome,
 * nothing about the ledger. The kiosk screens render their own identity strip (so it can show the stage and a countdown).
 */
export default function VoterKioskLayout() {
  useRouteFocus("VoteChain Polling Terminal");
  return (
    <KioskSessionProvider>
      <div className="shell-kiosk">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <Outlet />
      </div>
    </KioskSessionProvider>
  );
}
