import { createContext, useContext } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { publicApi } from "../api/publicApi";
import type { PublicElection } from "../api/types";
import { PhaseStatus } from "../components/PhaseStatus";
import { useRouteFocus } from "../components/useRouteFocus";
import { useAsync, type AsyncState } from "../lib/useAsync";

type PublicElectionCtx = AsyncState<PublicElection> & { reload: () => void };
const Ctx = createContext<PublicElectionCtx | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function usePublicElection(): PublicElectionCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePublicElection must be used inside PublicLayout");
  return v;
}

const NAV = [
  { to: "/election", label: "Election" },
  { to: "/verify", label: "Verify a receipt" },
  { to: "/results", label: "Results" },
  { to: "/trust", label: "Guarantees and limits" },
  { to: "/accessibility", label: "Accessibility" },
];

/** PUBLIC context: masthead, top navigation and an honest footer. The voter kiosk and admin console never use this shell. */
export default function PublicLayout() {
  const election = useAsync((signal) => publicApi.election(signal));
  useRouteFocus("VoteChain");
  return (
    <Ctx.Provider value={election}>
      <div className="shell-public">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="shell-header">
          <div className="shell-bar">
            <NavLink className="shell-brand" to="/" end>
              <span className="brand-mark" aria-hidden="true" />
              VoteChain
            </NavLink>
            <nav aria-label="Public">
              <ul className="shell-nav">
                {NAV.map((n) => (
                  <li key={n.to}>
                    <NavLink className="shell-link" to={n.to}>
                      {n.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="shell-meta">
              <span className="muted">Election phase</span> <PhaseStatus phase={election.data?.phase} />
            </div>
          </div>
        </header>
        <main id="main" className="shell-main" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="shell-footer">
          <div className="container stack stack-sm">
            <p>
              <strong>What a receipt proves.</strong> A confirmed receipt shows that a ballot represented by that transaction was recorded by this VoteChain contract for this election and constituency. It does not show who voted, and VoteChain does not provide ballot secrecy, receipt-freeness or coercion resistance: the chosen candidate is readable on the public ledger.
            </p>
            <p className="muted">
              <NavLink to="/trust">Read the full list of guarantees and limits</NavLink>
            </p>
          </div>
        </footer>
      </div>
    </Ctx.Provider>
  );
}
