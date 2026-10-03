import { useId, useRef, useState, type FormEvent } from "react";
import { adminApi } from "../../api/adminApi";
import type { AdminConstituency, AdminVoter } from "../../api/types";
import { Alert } from "../../components/Alert";
import { Dialog } from "../../components/Dialog";
import { messageFor } from "../../lib/errors";
import { SelectField, TextField } from "./parts";
import { isLockedError, toApiError } from "./useAdminElection";

export const MIN_PASSWORD = 12;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything after 72 bytes; the backend caps the length

const passwordProblem = (value: string): string | null => {
  if (value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters (now ${value.length}).`;
  if (new TextEncoder().encode(value).length > MAX_PASSWORD_BYTES) return `Use at most ${MAX_PASSWORD_BYTES} bytes. Shorten the password.`;
  return null;
};

const PASSWORD_HINT = `At least ${MIN_PASSWORD} characters. Give it to the voter in person; it is not shown again.`;

interface Common {
  open: boolean;
  onClose: () => void;
  /** The election left Setup while the form was open. The caller re-reads the election and explains. */
  onLocked: () => void;
}

type Problems = Partial<Record<"name" | "email" | "password" | "constituencyCode", string>>;

/** Add (mode "add") or edit (mode "edit") a voter. State resets every time the dialog opens. */
export function VoterFormDialog({ mode, voter, constituencies, open, onClose, onLocked, onSaved }: Common & { mode: "add" | "edit"; voter?: AdminVoter | null; constituencies: AdminConstituency[]; onSaved: (voter: AdminVoter) => void }) {
  const formId = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [constituencyCode, setConstituencyCode] = useState("");
  const [status, setStatus] = useState<"ACTIVE" | "SUSPENDED">("ACTIVE");
  const [problems, setProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const constituencyRef = useRef<HTMLSelectElement>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setName(voter?.name ?? "");
      setEmail(voter?.email ?? "");
      setPassword("");
      setShowPassword(false);
      setConstituencyCode(voter?.constituencyCode ?? "");
      setStatus(voter?.status ?? "ACTIVE");
      setProblems({});
      setFailure(null);
      setBusy(false);
    }
  }

  const focusField = (key: keyof Problems) =>
    requestAnimationFrame(() => {
      const target = { name: nameRef, email: emailRef, password: passwordRef, constituencyCode: constituencyRef }[key];
      target.current?.focus();
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next: Problems = {};
    if (!name.trim()) next.name = "Enter the voter's full name.";
    else if (name.trim().length > 100) next.name = "Use at most 100 characters.";
    if (!email.trim()) next.email = "Enter an email address.";
    else if (!/^\S+@\S+\.\S+$/.test(email.trim()) || email.trim().length > 254) next.email = "Enter a valid email address, such as name@example.org.";
    if (mode === "add") {
      const p = passwordProblem(password);
      if (p) next.password = p;
    }
    if (!constituencyCode) next.constituencyCode = "Choose the constituency this voter belongs to.";
    setProblems(next);
    setFailure(null);
    const first = (["name", "email", "password", "constituencyCode"] as const).find((k) => next[k]);
    if (first) {
      focusField(first);
      return;
    }

    setBusy(true);
    try {
      if (mode === "add") {
        const { voter: created } = await adminApi.createVoter({ name: name.trim(), email: email.trim(), password, constituencyCode });
        onSaved(created);
      } else if (voter) {
        const changes: Parameters<typeof adminApi.updateVoter>[1] = {};
        if (name.trim() !== voter.name) changes.name = name.trim();
        if (email.trim().toLowerCase() !== voter.email) changes.email = email.trim();
        if (constituencyCode !== voter.constituencyCode) changes.constituencyCode = constituencyCode;
        if (status !== voter.status) changes.status = status;
        if (Object.keys(changes).length === 0) {
          setFailure("Nothing was changed. Edit a field, or cancel.");
          setBusy(false);
          return;
        }
        const { voter: updated } = await adminApi.updateVoter(voter.id, changes);
        onSaved(updated);
      }
    } catch (err) {
      const e = toApiError(err);
      setBusy(false);
      if (isLockedError(e)) {
        onLocked();
        return;
      }
      if (e.code === "EMAIL_TAKEN") {
        setProblems({ email: "Another voter already uses this email address." });
        focusField("email");
      } else if (e.code === "UNKNOWN_CONSTITUENCY") {
        setProblems({ constituencyCode: "That constituency does not exist on the election contract." });
        focusField("constituencyCode");
      } else {
        setFailure(messageFor(e));
      }
    }
  };

  const title = mode === "add" ? "Add a voter" : `Edit ${voter?.name ?? "voter"}`;
  const label = mode === "add" ? "Add voter" : "Save changes";
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn-primary" aria-busy={busy || undefined}>
            {busy ? "Saving…" : label}
          </button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {mode === "edit" && voter && (
          <p className="muted">
            Voter ID{" "}
            <span className="mono" translate="no">
              {voter.voterId}
            </span>{" "}
            cannot be changed.
          </p>
        )}
        {failure && (
          <Alert tone="danger" role="alert" title="Not saved">
            {failure}
          </Alert>
        )}
        <TextField id={`${formId}-name`} label="Full name" name="name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} error={problems.name} inputRef={nameRef} required />
        <TextField id={`${formId}-email`} label="Email" name="email" type="email" autoComplete="off" spellCheck={false} autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} error={problems.email} inputRef={emailRef} required />
        {mode === "add" && (
          <div className="stack-sm">
            <TextField
              id={`${formId}-password`}
              label="Initial password"
              name="new-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              spellCheck={false}
              hint={PASSWORD_HINT}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={problems.password}
              inputRef={passwordRef}
              required
            />
            <label className="check">
              <input type="checkbox" className="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
              Show password
            </label>
          </div>
        )}
        <SelectField id={`${formId}-const`} label="Constituency" name="constituencyCode" value={constituencyCode} onChange={(e) => setConstituencyCode(e.target.value)} error={problems.constituencyCode} selectRef={constituencyRef} required>
          <option value="">Choose a constituency</option>
          {constituencies.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} · {c.name}
            </option>
          ))}
        </SelectField>
        {mode === "edit" && (
          <SelectField id={`${formId}-status`} label="Status" name="status" value={status} onChange={(e) => setStatus(e.target.value as "ACTIVE" | "SUSPENDED")} hint="A suspended voter cannot sign in to vote.">
            <option value="ACTIVE">Active</option>
            <option value="SUSPENDED">Suspended</option>
          </SelectField>
        )}
        {busy && (
          <p className="muted" role="status">
            Saving…
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** Reset a voter's password. */
export function ResetPasswordDialog({ voter, open, onClose, onLocked, onDone }: Common & { voter: AdminVoter | null; onDone: (voter: AdminVoter) => void }) {
  const formId = useId();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setPassword("");
      setShow(false);
      setProblem(null);
      setFailure(null);
      setBusy(false);
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !voter) return;
    const p = passwordProblem(password);
    setProblem(p);
    setFailure(null);
    if (p) {
      ref.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await adminApi.resetVoterPassword(voter.id, password);
      onDone(voter);
    } catch (err) {
      const e = toApiError(err);
      setBusy(false);
      if (isLockedError(e)) onLocked();
      else setFailure(messageFor(e));
    }
  };

  return (
    <Dialog
      open={open}
      title={`Reset password for ${voter?.name ?? "voter"}?`}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={formId} className="btn btn-primary" aria-busy={busy || undefined}>
            {busy ? "Resetting…" : "Reset password"}
          </button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        <p>
          The current password of{" "}
          <strong>{voter?.name}</strong> (
          <span className="mono" translate="no">
            {voter?.voterId}
          </span>
          ) stops working immediately.
        </p>
        {failure && (
          <Alert tone="danger" role="alert" title="Password not reset">
            {failure}
          </Alert>
        )}
        <div className="stack-sm">
          <TextField id={`${formId}-pw`} label="New password" name="new-password" type={show ? "text" : "password"} autoComplete="new-password" spellCheck={false} hint={PASSWORD_HINT} value={password} onChange={(e) => setPassword(e.target.value)} error={problem} inputRef={ref} required />
          <label className="check">
            <input type="checkbox" className="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            Show password
          </label>
        </div>
      </form>
    </Dialog>
  );
}

/** Delete a voter. The dialog names the voter and the consequence. */
export function DeleteVoterDialog({ voter, open, onClose, onLocked, onDone }: Common & { voter: AdminVoter | null; onDone: (voter: AdminVoter) => void }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setFailure(null);
      setBusy(false);
    }
  }

  const remove = async () => {
    if (busy || !voter) return;
    setBusy(true);
    setFailure(null);
    try {
      await adminApi.deleteVoter(voter.id);
      onDone(voter);
    } catch (err) {
      const e = toApiError(err);
      setBusy(false);
      if (isLockedError(e)) onLocked();
      else setFailure(messageFor(e));
    }
  };

  return (
    <Dialog
      open={open}
      title={`Delete ${voter?.name ?? "voter"}?`}
      onClose={onClose}
      busy={busy}
      actions={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Keep voter
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void remove()} aria-busy={busy || undefined}>
            {busy ? "Deleting…" : "Delete voter"}
          </button>
        </>
      }
    >
      <div className="stack">
        <p>
          This permanently removes <strong>{voter?.name}</strong> ({voter?.email},{" "}
          <span className="mono" translate="no">
            {voter?.voterId}
          </span>
          ) from the electoral roll. They will not be able to vote. This cannot be undone.
        </p>
        {failure && (
          <Alert tone="danger" role="alert" title="Voter not deleted">
            {failure}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}
