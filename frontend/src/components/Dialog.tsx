import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Modal built on the native <dialog> (focus trap, inert background and Esc come from the browser).
 *  - Focus lands on the heading, never on the action buttons, so a destructive button is never the initial focus.
 *  - Escape and Cancel close it unless `busy` (an action is in flight).
 *  - A click on the backdrop does NOTHING (it cannot trigger or dismiss an irreversible action by accident).
 *  - Focus returns to the element that opened it.
 */
export function Dialog({ open, title, onClose, busy = false, children, actions }: { open: boolean; title: string; onClose: () => void; busy?: boolean; children: ReactNode; actions: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      headingRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      opener.current?.focus();
    }
  }, [open]);

  useEffect(
    () => () => {
      if (ref.current?.open) ref.current.close();
    },
    [],
  );

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault(); // we close it ourselves, through the `open` prop
        if (!busy) onClose();
      }}
    >
      {open && (
        <>
          <h2 id={id} className="h2" tabIndex={-1} ref={headingRef}>
            {title}
          </h2>
          {children}
          <div className="dialog-actions">{actions}</div>
        </>
      )}
    </dialog>
  );
}
