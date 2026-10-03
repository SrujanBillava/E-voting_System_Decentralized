import { useRef, useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { adminSession } from "../../api/adminSession";
import { Alert } from "../../components/Alert";
import { ErrorState, LoadingState } from "../../components/States";
import { usePageTitle } from "../../components/useRouteFocus";
import { ApiError } from "../../api/http";
import { messageFor } from "../../lib/errors";
import { TextField } from "./parts";
import { toApiError } from "./useAdminElection";
import { useAdminBootstrap } from "./useAdminBootstrap";

const UNREACHABLE = new ApiError(0, "NETWORK", "The server could not be reached.");

/** Only ever return to an admin page; never follow an arbitrary path or origin from navigation state. */
function destination(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from === "string" && /^\/admin(\/|$|\?)/.test(from) && !from.startsWith("/admin/login") && !from.startsWith("//")) return from;
  return "/admin/election";
}

const SERVER_TEXT: Record<string, string> = {
  INVALID_CREDENTIALS: "The email, password or authenticator code is not correct. Check all three. If the last code was already used, wait for the next one.",
};

type Field = "email" | "password" | "totp";
type Problems = Partial<Record<Field, string>>;

export default function LoginPage() {
  usePageTitle("Administrator sign in", "VoteChain Administration");
  const session = useAdminBootstrap();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const totpRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  if (session.status === "authenticated") return <Navigate to={destination(location.state)} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next: Problems = {};
    if (!email.trim()) next.email = "Enter your email address.";
    else if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = "Enter a valid email address, such as name@example.org.";
    if (!password) next.password = "Enter your password.";
    if (!/^[0-9]{6}$/.test(totp)) next.totp = "Enter the 6-digit code from your authenticator app.";
    setProblems(next);
    setFailure(null);
    const first = (["email", "password", "totp"] as const).find((f) => next[f]);
    if (first) {
      ({ email: emailRef, password: passwordRef, totp: totpRef })[first].current?.focus();
      return;
    }
    setBusy(true);
    try {
      await adminSession.login(email.trim(), password, totp);
      // success: the session store flips to "authenticated" and this component redirects
    } catch (err) {
      const error = toApiError(err);
      setFailure(error);
      setTotp(""); // a code works once; the next attempt needs a new one
      setBusy(false);
      // Focus the first field that may need correcting; for throttling or a network problem keep focus on the action.
      requestAnimationFrame(() => (error.code === "INVALID_CREDENTIALS" ? emailRef.current : submitRef.current)?.focus());
    }
  };

  return (
    <div className="shell-admin" style={{ display: "block" }}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="shell-header">
        <div className="shell-bar">
          <span className="shell-brand">
            <span className="brand-mark" aria-hidden="true" />
            VoteChain
            <span className="muted" style={{ fontWeight: "var(--fw-regular)" }}>
              Administration
            </span>
          </span>
        </div>
      </header>
      <main id="main" className="shell-main" tabIndex={-1}>
        <div className="container" style={{ maxWidth: "34rem", marginInline: 0 }}>
          {session.status === "unknown" ? (
            session.unreachable ? (
              <ErrorState error={UNREACHABLE} title="The administration service could not be reached" onRetry={session.retry} />
            ) : (
              <LoadingState label="Checking for an existing session…" />
            )
          ) : (
            <>
              <div className="page-head">
                <p className="eyebrow">Administration</p>
                <h1 className="h1">Administrator sign in</h1>
                <p className="lede">Sign in with your email, password and the 6-digit code from your authenticator app.</p>
              </div>
              <form className="stack" onSubmit={onSubmit} noValidate>
                {failure && (
                  <Alert tone="danger" role="alert" title="Could not sign in">
                    {SERVER_TEXT[failure.code] ?? messageFor(failure)}
                  </Alert>
                )}
                <TextField id="admin-email" name="email" type="email" label="Email" autoComplete="username" inputMode="email" spellCheck={false} autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={problems.email} inputRef={emailRef} required />
                <TextField id="admin-password" name="password" type="password" label="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={problems.password} inputRef={passwordRef} required />
                <TextField
                  id="admin-totp"
                  name="totp"
                  label="Authenticator code"
                  hint="6 digits. Each code can be used once."
                  className="mono"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  spellCheck={false}
                  value={totp}
                  onChange={(e) => setTotp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  error={problems.totp}
                  inputRef={totpRef}
                  required
                />
                <div className="actions">
                  <button ref={submitRef} type="submit" className="btn btn-primary" aria-busy={busy || undefined}>
                    {busy ? "Signing in…" : "Sign in"}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
