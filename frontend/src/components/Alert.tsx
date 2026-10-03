import type { ReactNode } from "react";

type Tone = "info" | "ok" | "warn" | "danger";

/** role="alert" for a blocking error that appears after an action; role="status" for dynamic ok/info/warn; none for static notices. */
export function Alert({ tone = "info", title, children, role }: { tone?: Tone; title?: string; children?: ReactNode; role?: "alert" | "status" }) {
  const resolved = role ?? (tone === "danger" ? "alert" : undefined);
  return (
    <div className={`alert alert-${tone}`} role={resolved}>
      <div>
        {title && <p className="alert-title">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
