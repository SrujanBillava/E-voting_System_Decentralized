import type { ReactNode } from "react";
import type { ApiError } from "../api/http";
import { messageFor } from "../lib/errors";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state state-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, title = "This could not be loaded", onRetry }: { error: ApiError | Error | null; title?: string; onRetry?: () => void }) {
  const reference = error && "requestId" in error ? error.requestId : undefined;
  return (
    <div className="state state-error" role="alert">
      <p className="state-title">{title}</p>
      <p className="state-body">{messageFor(error)}</p>
      {reference && (
        <p className="state-body muted">
          Reference <span className="mono">{reference}</span>
        </p>
      )}
      {onRetry && (
        <div className="state-actions">
          <button type="button" className="btn btn-secondary" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <p className="state-title">{title}</p>
      {children && <div className="state-body">{children}</div>}
      {action && <div className="state-actions">{action}</div>}
    </div>
  );
}
