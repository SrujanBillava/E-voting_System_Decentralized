import type { ReactNode } from "react";
import { PhaseStatus } from "../../components/PhaseStatus";
import { Countdown } from "../../components/Countdown";
import { useKiosk } from "./useKioskSession";

const KIOSK_STEPS = ["Sign in", "Face", "Eligibility", "Choose", "Review", "Cast", "Receipt"] as const;

interface FrameProps {
  /** Index into KIOSK_STEPS; omit on screens outside the voting journey (welcome, closed). */
  step?: number;
  title: string;
  /** What this screen is for, in one sentence. */
  intro?: ReactNode;
  children?: ReactNode;
  /** Pinned action bar: one primary action per screen, secondary on the left. */
  primary?: ReactNode;
  secondary?: ReactNode;
  /** Visible countdown (the server stage expiry). */
  until?: string;
  countdownLabel?: string;
  onExpire?: () => void;
}

/** The kiosk screen frame: a thin identity strip, a stepper, one task, a pinned action bar. No navigation of any kind. */
export function KioskFrame({ step, title, intro, children, primary, secondary, until, countdownLabel = "Time left", onExpire }: FrameProps) {
  const { state } = useKiosk();
  const session = state.kind === "session" ? state.status : null;
  return (
    <>
      <header className="shell-header">
        <div className="shell-bar">
          <span className="shell-brand">
            <span className="brand-mark" aria-hidden="true" />
            VoteChain Polling Terminal
          </span>
          <div className="shell-meta cluster">
            {session && (
              <span className="muted kiosk-where">
                Constituency <span className="mono">{session.voter.constituencyCode}</span>
              </span>
            )}
            <PhaseStatus phase={session?.electionPhase ?? (state.kind === "anonymous" ? state.electionPhase : null)} />
            {until && <Countdown until={until} label={countdownLabel} onExpire={onExpire} />}
          </div>
        </div>
      </header>

      <main id="main" className="shell-main" tabIndex={-1}>
        <div className="container stack">
          {step !== undefined && (
            <ol className="stepper" aria-label="Voting progress">
              {KIOSK_STEPS.map((label, i) => (
                <li key={label} className={`step${i < step ? " is-done" : ""}${i === step ? " is-current" : ""}`} aria-current={i === step ? "step" : undefined}>
                  <span className="step-num" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="step-label">
                    {label}
                    {i < step && <span className="visually-hidden"> (completed)</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {step !== undefined && (
            <p className="step-count">
              Step {step + 1} of {KIOSK_STEPS.length}: {KIOSK_STEPS[step]}
            </p>
          )}
          <div className="page-head">
            <h1 className="h1">{title}</h1>
            {intro && <p className="lede">{intro}</p>}
          </div>
          {children}
        </div>
      </main>

      {(primary || secondary) && (
        <footer className="shell-footer">
          <div className="container actions actions-between">
            <div>{secondary}</div>
            <div>{primary}</div>
          </div>
        </footer>
      )}
    </>
  );
}
