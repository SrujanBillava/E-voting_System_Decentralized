import type { ReactNode } from "react";
import { PROTOTYPE_NOTICE } from "./messages.ts";

export function Alert({ tone, title, children, role }: { tone: "info" | "ok" | "warn" | "danger"; title?: string; children?: ReactNode; role?: "alert" | "status" }) {
  return (
    <div className={`alert alert-${tone}`} role={role ?? (tone === "danger" ? "alert" : "status")}>
      {title && <p className="alert-title">{title}</p>}
      {children}
    </div>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <p className="busy" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </p>
  );
}

export type StepState = "todo" | "doing" | "done";
export function Steps({ steps }: { steps: { label: string; state: StepState }[] }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s) => (
        <li key={s.label} className={`step step-${s.state}`} aria-current={s.state === "doing" ? "step" : undefined}>
          <span className="step-mark" aria-hidden="true">
            {s.state === "done" ? "✓" : s.state === "doing" ? "…" : "·"}
          </span>
          <span>
            {s.label}
            <span className="visually-hidden">{s.state === "done" ? " (done)" : s.state === "doing" ? " (in progress)" : " (waiting)"}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Shell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the main content
      </a>
      <header className="masthead">
        <div className="container">
          <p className="brand">VoteChain</p>
        </div>
      </header>
      <main id="main" className="container" tabIndex={-1}>
        {children}
      </main>
      <footer className="container footer">
        {footer}
        <details className="devnote">
          <summary>{PROTOTYPE_NOTICE.summary}</summary>
          <p>{PROTOTYPE_NOTICE.body}</p>
          <p>
            <strong>{PROTOTYPE_NOTICE.heading}</strong>
          </p>
          <ol>
            {PROTOTYPE_NOTICE.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>
      </footer>
    </>
  );
}
