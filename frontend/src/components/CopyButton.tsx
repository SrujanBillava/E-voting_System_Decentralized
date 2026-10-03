import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";

/** Copies `text`. The visible label changes and a polite live region announces the result. */
export function CopyButton({ text, label = "Copy", copiedLabel = "Copied", className = "btn btn-secondary" }: { text: string; label?: string; copiedLabel?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onClick = async () => {
    setState((await copyText(text)) ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };
  return (
    <>
      <button type="button" className={className} onClick={onClick}>
        {state === "copied" ? copiedLabel : label}
      </button>
      <span className="visually-hidden" role="status">
        {state === "copied" ? "Copied to clipboard" : state === "failed" ? "Copy failed. Select the text and copy it manually." : ""}
      </span>
    </>
  );
}
