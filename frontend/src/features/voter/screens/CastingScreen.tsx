import { useEffect, useRef, useState } from "react";
import { isApiError } from "../../../api/http";
import type { PublicCandidate } from "../../../api/types";
import { voterApi } from "../../../api/voterApi";
import { Alert } from "../../../components/Alert";
import { usePageTitle } from "../../../components/useRouteFocus";
import { messageFor } from "../../../lib/errors";
import { KioskFrame } from "../KioskFrame";
import { useKiosk } from "../useKioskSession";

type Phase = "preparing" | "submitting" | "confirming";
const STEPS: { phase: Phase; label: string }[] = [
  { phase: "preparing", label: "Preparing your secure ballot" },
  { phase: "submitting", label: "Submitting your ballot" },
  { phase: "confirming", label: "Waiting for confirmation" },
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newKey = () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

type Failure = { title: string; message: string; retry?: boolean; official?: boolean };

function failureOf(err: unknown): Failure {
  const code = isApiError(err) ? err.code : "UNKNOWN";
  if (code === "NETWORK" || code === "CHAIN_UNAVAILABLE") return { title: "Connection problem", message: messageFor(err), retry: true };
  if (code === "AUTHORIZATION_EXPIRED") return { title: "Time ran out", message: messageFor(err) };
  const official = ["VOTE_NOT_RECORDED", "RECONCILIATION_REQUIRED", "TX_REVERTED", "AUTHORIZATION_ALREADY_ISSUED", "AUTHORIZATION_REJECTED", "ALREADY_VOTED", "VOTER_SUSPENDED", "INVALID_CANDIDATE", "CANDIDATE_NOT_IN_CONSTITUENCY", "CONSTITUENCY_NOT_CONFIGURED", "ELECTION_NOT_OPEN"];
  if (official.includes(code)) return { title: "Please ask a polling official", message: messageFor(err), official: true };
  return { title: "Your ballot could not be submitted", message: messageFor(err), retry: true, official: true };
}

/**
 * ELIGIBLE (confirmed on the review screen) -> authorization -> cast -> receipt. The cast request carries an
 * Idempotency-Key, so a retry after a lost connection can never record a second ballot.
 * Shows only plain-language progress: no signature, gas, wallet, nonce, nullifier or transaction detail.
 */
export default function CastingScreen({ candidate }: { candidate: PublicCandidate | null }) {
  usePageTitle("Casting your vote");
  const { refresh, sessionLost, finish } = useKiosk();
  const [phase, setPhase] = useState<Phase>(candidate ? "preparing" : "submitting");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = useRef(newKey());
  const authorized = useRef(candidate === null); // already AUTH_ISSUED (e.g. after a refresh): nothing to authorize
  const job = useRef<{ attempt: number; promise: Promise<void> } | null>(null);

  useEffect(() => {
    // The work (authorize -> cast) runs ONCE per attempt, even when React StrictMode runs this effect twice in development:
    // both runs await the same promise and only the run that is still mounted acts on the outcome.
    if (job.current?.attempt !== attempt) {
      job.current = {
        attempt,
        promise: (async () => {
          if (!authorized.current && candidate) {
            setPhase("preparing");
            await voterApi.authorize(candidate.candidateId);
            authorized.current = true;
          }
          setPhase("submitting");
          for (let tries = 0; ; tries++) {
            try {
              const r = await voterApi.cast(key.current);
              if (r.status === 202) setPhase("confirming");
              return;
            } catch (err) {
              // A dropped connection is ambiguous, and retrying the SAME key is safe. Bounded, then the voter decides.
              if (isApiError(err) && (err.code === "NETWORK" || err.code === "CAST_IN_PROGRESS") && tries < 3) {
                await sleep(1500 * (tries + 1));
                continue;
              }
              throw err;
            }
          }
        })(),
      };
    }
    let live = true;
    job.current.promise
      .then(async () => {
        // The server stage decides the next screen. A 202 can leave the session at AUTH_ISSUED for a moment (another request holds
        // the claim), so keep asking (passive, cheap) until the stage moves; unmounting stops the loop.
        while (live) {
          await refresh();
          await sleep(2000);
        }
      })
      .catch((err: unknown) => {
        if (!live) return;
        if (isApiError(err) && (err.status === 401 || err.code === "SESSION_EXPIRED")) return sessionLost("expired");
        if (isApiError(err) && (err.code === "ELECTION_CLOSED" || err.code === "STAGE_REQUIRED")) return void refresh(); // the server decides
        setFailure(failureOf(err));
      });
    return () => {
      live = false;
    };
  }, [attempt, candidate, refresh, sessionLost]);

  const index = STEPS.findIndex((s) => s.phase === phase);

  if (failure) {
    return (
      <KioskFrame
        step={5}
        title={failure.title}
        secondary={
          <button type="button" className="btn btn-secondary btn-lg" onClick={() => void finish()}>
            End session
          </button>
        }
        primary={
          failure.retry ? (
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={() => {
                setFailure(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          ) : undefined
        }
      >
        <Alert tone="danger" title="Your ballot is not confirmed yet">
          <p>{failure.message}</p>
          {failure.official && <p>Please stay at the terminal and ask a polling official. Do not try to vote again on your own.</p>}
        </Alert>
      </KioskFrame>
    );
  }

  return (
    <KioskFrame step={5} title="Casting your vote" intro="Please wait. Do not leave the terminal.">
      <ol className="progress-list" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s.phase} className={i < index ? "is-done" : undefined} aria-current={i === index ? "step" : undefined}>
            <span aria-hidden="true">{i < index ? "✓" : i === index ? "→" : "·"}</span>
            <span>
              {s.label}
              {i < index && <span className="visually-hidden"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="visually-hidden" role="status">
        {STEPS[index]?.label}
      </p>
    </KioskFrame>
  );
}
