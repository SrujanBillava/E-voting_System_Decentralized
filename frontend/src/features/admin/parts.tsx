import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from "react";
import { Alert } from "../../components/Alert";
import type { ElectionPhase } from "../../api/types";

/** Page opener used by every admin page: eyebrow = section, the single h1, one line saying what state the page is in. */
export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="h1">{title}</h1>
      {children && <p className="lede">{children}</p>}
    </div>
  );
}

const describedBy = (id: string, hint: ReactNode, error?: string | null) => [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;

interface FieldBase {
  id: string;
  label: string;
  hint?: ReactNode;
  /** Field-level validation message; sets aria-invalid and is linked with aria-describedby. */
  error?: string | null;
}

export function TextField({ id, label, hint, error, inputRef, className = "", ...input }: FieldBase & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className"> & { inputRef?: Ref<HTMLInputElement>; className?: string }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input id={id} ref={inputRef} className={`input ${className}`.trim()} aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...input} />
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}

export function SelectField({ id, label, hint, error, selectRef, children, ...select }: FieldBase & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> & { selectRef?: Ref<HTMLSelectElement> }) {
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <select id={id} ref={selectRef} className="select" aria-invalid={error ? true : undefined} aria-describedby={describedBy(id, hint, error)} {...select}>
        {children}
      </select>
      {hint && (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-err`}>
          {error}
        </p>
      )}
    </div>
  );
}

const LOCK_WORDS: Record<ElectionPhase, string> = {
  Setup: "",
  Open: "The election is open.",
  Closed: "The election has closed.",
};

/** Shown instead of every edit control once the election has left Setup. Static notice, so no live-region role. */
export function LockedNotice({ phase, what }: { phase: ElectionPhase; what: string }) {
  return (
    <Alert tone="info" title="Configuration is frozen">
      {LOCK_WORDS[phase]} {what} can no longer be added, changed or removed, so this page is read-only. The configuration was fixed when the election left Setup and cannot be reopened.
    </Alert>
  );
}

/** Page/limit live in the URL; this only renders the controls. */
export function Pager({ page, totalPages, total, noun, onPage }: { page: number; totalPages: number; total: number; noun: string; onPage: (page: number) => void }) {
  return (
    <div className="pager">
      <p className="pager-info" role="status">
        {total === 0 ? `No ${noun}s` : `${total} ${noun}${total === 1 ? "" : "s"} · page ${page} of ${Math.max(totalPages, 1)}`}
      </p>
      <div className="pager-nav">
        <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous page
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next page
        </button>
      </div>
    </div>
  );
}
