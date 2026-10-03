import { useState } from "react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router-dom";
import { adminSession } from "../api/adminSession";
import { ApiError } from "../api/http";
import type { AdminProfile } from "../api/types";
import { Alert } from "../components/Alert";
import { PhaseStatus } from "../components/PhaseStatus";
import { ErrorState, LoadingState } from "../components/States";
import { useRouteFocus } from "../components/useRouteFocus";
import { messageFor } from "../lib/errors";
import { useAdminBootstrap } from "../features/admin/useAdminBootstrap";
import { useElectionQuery } from "../features/admin/useAdminElection";

const UNREACHABLE = new ApiError(0, "NETWORK", "The server could not be reached.");

const NAV = [
  { to: "/admin/election", label: "Election" },
  { to: "/admin/voters", label: "Voters" },
  { to: "/admin/constituencies", label: "Constituencies" },
  { to: "/admin/candidates", label: "Candidates" },
  { to: "/admin/biometrics", label: "Biometrics" },
  { to: "/admin/system", label: "System" },
];

/**
 * ADMIN context: guard + header (persistent election phase) + left rail + work area.
 * The guard is a UX convenience; the backend authorises every request. An anonymous session (never signed in, signed out,
 * or a refresh that failed permanently) always lands on /admin/login.
 */
export default function AdminLayout() {
  const session = useAdminBootstrap();
  const location = useLocation();
  useRouteFocus("VoteChain Administration");

  if (session.status === "unknown") {
    return (
      <div className="shell-admin" style={{ display: "block" }}>
        <main id="main" className="shell-main" tabIndex={-1}>
          {session.unreachable ? (
            <ErrorState error={UNREACHABLE} title="The administration service could not be reached" onRetry={session.retry} />
          ) : (
            <LoadingState label="Checking your session…" />
          )}
        </main>
      </div>
    );
  }
  if (session.status === "anonymous" || !session.admin) {
    return <Navigate to="/admin/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <AdminFrame admin={session.admin} />;
}

function AdminFrame({ admin }: { admin: AdminProfile }) {
  const query = useElectionQuery();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    await adminSession.logout(); // the session turns anonymous and AdminLayout redirects to /admin/login
  };

  return (
    <div className="shell-admin">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="shell-header">
        <div className="shell-bar">
          <NavLink className="shell-brand" to="/admin/election">
            <span className="brand-mark" aria-hidden="true" />
            VoteChain
            <span className="muted" style={{ fontWeight: "var(--fw-regular)" }}>
              Administration
            </span>
          </NavLink>
          <div className="shell-meta">
            <div className="cluster" role="status">
              <span className="muted">Election phase</span>
              {query.election ? <PhaseStatus phase={query.election.phase} large /> : query.loading ? <span className="muted">Loading…</span> : <PhaseStatus phase={null} />}
            </div>
            <span>
              <span className="visually-hidden">Signed in as </span>
              {admin.name}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={signOut} aria-busy={signingOut || undefined} disabled={signingOut}>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </div>
      </header>
      <nav className="shell-rail" aria-label="Administration">
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
      <main id="main" className="shell-main" tabIndex={-1}>
        <div className="container">
          {query.election && query.error && (
            <div className="section" style={{ paddingBlock: 0, marginBottom: "var(--s-4)" }}>
              <Alert tone="warn" role="status" title="Election details may be out of date">
                The latest refresh failed: {messageFor(query.error)}{" "}
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void query.refresh()} aria-busy={query.refreshing || undefined}>
                  {query.refreshing ? "Refreshing…" : "Refresh now"}
                </button>
              </Alert>
            </div>
          )}
          <Outlet context={query} />
        </div>
      </main>
      <footer className="shell-footer">
        <p>Signed in as {admin.email}. The election phase and counts shown here are read from the election contract; configuration changes are written to it.</p>
      </footer>
    </div>
  );
}
