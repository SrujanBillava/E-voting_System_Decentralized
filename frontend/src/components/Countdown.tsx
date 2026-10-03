import { useEffect, useRef, useState } from "react";

const format = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const THRESHOLDS = [60, 30, 10];

/**
 * A visible countdown to `until`. The ticking text is NOT a live region; a separate hidden region announces only at
 * 60 / 30 / 10 seconds. `onExpire` fires once.
 */
export function Countdown({ until, label = "Time left", totalMs, onExpire }: { until: string | number | Date; label?: string; totalMs?: number; onExpire?: () => void }) {
  const end = new Date(until).getTime();
  const [now, setNow] = useState(() => Date.now());
  const [announce, setAnnounce] = useState("");
  const fired = useRef(false);
  const said = useRef(new Set<number>());
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  });

  useEffect(() => {
    fired.current = false;
    said.current = new Set();
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const left = Math.ceil((end - t) / 1000);
      for (const th of THRESHOLDS) {
        if (left <= th && left > 0 && !said.current.has(th)) {
          said.current.add(th);
          setAnnounce(`${th} seconds left`);
        }
      }
      if (t >= end && !fired.current) {
        fired.current = true;
        expire.current?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [end]);

  const left = Math.max(0, end - now);
  const urgent = left <= 30_000;
  const pct = totalMs ? Math.min(100, (left / totalMs) * 100) : undefined;
  return (
    <div className={`countdown${urgent ? " is-urgent" : ""}`}>
      <span className="countdown-label">{label}</span>
      <span className="countdown-time" translate="no">
        {format(left)}
      </span>
      {pct !== undefined && (
        <span className="countdown-bar" aria-hidden="true">
          <span style={{ "--value": `${pct}%` } as React.CSSProperties} />
        </span>
      )}
      <span className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
