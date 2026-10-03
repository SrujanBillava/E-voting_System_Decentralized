import { useCallback, useRef, useState, type ReactNode } from "react";
import { Alert } from "../../components/Alert";

export interface Notice {
  tone: "ok" | "warn" | "info";
  title: string;
  text?: ReactNode;
}

/**
 * A page-level result message. The live region is always mounted (so assistive technology reliably announces new content);
 * `show(notice, true)` also moves focus to it, for the case where the control that opened a dialog no longer exists.
 */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const show = useCallback((next: Notice, focus = false) => {
    setNotice(next);
    // After the dialog that triggered this has finished closing and handing focus back to its (possibly removed) opener.
    if (focus) setTimeout(() => ref.current?.focus(), 120);
  }, []);
  const clear = useCallback(() => setNotice(null), []);
  const node = (
    <div ref={ref} tabIndex={-1} role="status" className={notice ? "mb-4" : undefined}>
      {notice && (
        <Alert tone={notice.tone} title={notice.title}>
          {notice.text}
        </Alert>
      )}
    </div>
  );
  return { show, clear, node };
}
