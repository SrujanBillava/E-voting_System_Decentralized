import { useEffect, useRef, useState, type FormEvent } from "react";
import { voterApi } from "../../../api/voterApi";
import { Alert } from "../../../components/Alert";
import { usePageTitle } from "../../../components/useRouteFocus";
import { messageFor } from "../../../lib/errors";
import { KioskFrame } from "../KioskFrame";
import { useKiosk } from "../useKioskSession";

export default function LoginScreen({ onCancel }: { onCancel: () => void }) {
  usePageTitle("Sign in");
  const { refresh } = useKiosk();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<HTMLInputElement>(null);

  // Nobody is signed in yet, so nothing server-side can time this screen out: walk away and the terminal resets to the welcome screen,
  // clearing the typed identifier and password for the next person.
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resetTimer = () => {
    clearTimeout(idle.current);
    idle.current = setTimeout(onCancel, 90_000);
  };
  useEffect(() => {
    resetTimer();
    return () => clearTimeout(idle.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pwRef = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (identifier.trim().length < 3) {
      setError("Enter your voter ID or the email address registered to you.");
      idRef.current?.focus();
      return;
    }
    if (password.length === 0) {
      setError("Enter your password.");
      pwRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await voterApi.login(identifier.trim(), password);
      setPassword("");
      await refresh();
    } catch (err) {
      setError(messageFor(err));
      setPassword("");
      pwRef.current?.focus();
      setBusy(false);
    }
  };

  return (
    <KioskFrame
      step={0}
      title="Sign in"
      intro="Enter your voter ID or the email address registered to you, and your password."
      secondary={
        <button type="button" className="btn btn-secondary btn-lg" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      }
      primary={
        <button type="submit" form="login-form" className="btn btn-primary btn-lg" aria-busy={busy || undefined} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      }
    >
      <form id="login-form" className="stack container-narrow" onSubmit={submit} onChange={resetTimer} onFocus={resetTimer} noValidate>
        {error && <Alert tone="danger" title="We could not sign you in">{error}</Alert>}
        <div className="field">
          <label className="label" htmlFor="identifier">
            Voter ID or email
          </label>
          <input id="identifier" name="identifier" ref={idRef} className="input" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} aria-describedby="identifier-hint" autoFocus />
          <p className="hint" id="identifier-hint">
            Your voter ID looks like VC-ABCDEFGHJK.
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="password">
            Password
          </label>
          <input id="password" name="password" ref={pwRef} className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </div>
      </form>
    </KioskFrame>
  );
}
