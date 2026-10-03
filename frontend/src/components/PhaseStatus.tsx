import type { ElectionPhase } from "../api/types";

const LABEL: Record<ElectionPhase, string> = { Setup: "Setup", Open: "Open", Closed: "Closed" };
const CLASS: Record<ElectionPhase, string> = { Setup: "phase-setup", Open: "phase-open", Closed: "phase-closed" };

/** The election phase as a WORD with its own glyph and fill: never colour alone. */
export function PhaseStatus({ phase, large = false }: { phase: ElectionPhase | null | undefined; large?: boolean }) {
  if (!phase) return <span className="status status-neutral">Phase unknown</span>;
  return <span className={`status ${CLASS[phase]}${large ? " status-lg" : ""}`}>{LABEL[phase]}</span>;
}

export function PhaseBanner({ phase, children }: { phase: ElectionPhase; children: React.ReactNode }) {
  return (
    <div className={`phase-banner ${CLASS[phase]}`} role="status">
      <span>
        <strong>{LABEL[phase]}.</strong> {children}
      </span>
    </div>
  );
}
