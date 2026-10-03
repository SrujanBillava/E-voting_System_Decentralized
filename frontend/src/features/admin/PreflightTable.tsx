import { Check, Minus, TriangleAlert, X } from "lucide-react";
import type { PreflightSummary } from "../../api/types";
import { checkLabel, isKnownCheck } from "./preflightLabels";

type Check = PreflightSummary["checks"][number];

/** Result as text + glyph + shape. Only real statuses the backend returned are ever rendered. */
export function CheckResult({ status }: { status: string }) {
  switch (status) {
    case "pass":
      return (
        <span className="inline-flex items-center gap-2">
          <Check className="icon" aria-hidden="true" />
          Pass
        </span>
      );
    case "warn":
      return (
        <span className="status status-warn">
          <TriangleAlert className="icon" aria-hidden="true" />
          Warning
        </span>
      );
    case "fail":
      return (
        <span className="status status-danger">
          <X className="icon" aria-hidden="true" />
          Fail
        </span>
      );
    case "skip":
      return (
        <span className="status status-neutral">
          <Minus className="icon" aria-hidden="true" />
          Skipped
        </span>
      );
    default:
      return <span className="status status-neutral">{status}</span>;
  }
}

/** A plain table of check name and result. */
export function PreflightTable({ checks, label }: { checks: Check[]; label: string }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={label}>
      <table className="table table-dense">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.name}>
              <th scope="row">
                {checkLabel(c.name)}
                {isKnownCheck(c.name) && (
                  <>
                    <br />
                    <span className="mono muted" translate="no">
                      {c.name}
                    </span>
                  </>
                )}
              </th>
              <td>
                <CheckResult status={c.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
