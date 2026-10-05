import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { BootView, Kiosk, OpenBallot, PrepareStep, Receipt } from "../core/index.ts";
import { loadProvingArtifacts } from "../crypto/artifacts.ts";
import { Alert, Busy, Steps, type StepState } from "./components.tsx";
import { FaceStep } from "./FaceStep.tsx";
import { codeOf, messageFor, retryable, sessionEnded, TRUST_NOTICE } from "./messages.ts";

type View = BootView | "starting" | "fatal";

/** One heading per screen; focus moves to it when the screen changes, so a screen-reader user hears where they are. */
function Title({ children }: { children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${children} · VoteChain kiosk`;
    ref.current?.focus({ preventScroll: true });
  }, [children]);
  return (
    <h1 ref={ref} tabIndex={-1} className="title">
      {children}
    </h1>
  );
}

/** The kiosk is single-use per voter: after a vote (or a lost credential) the page is reloaded, so the next voter starts from a fresh page session with nothing in memory. */
const startOver = (kiosk: Kiosk): void => {
  kiosk.leave();
  window.location.hash = "";
  window.location.reload();
};

export function VoterKiosk({ kiosk }: { kiosk: Kiosk }) {
  const [view, setView] = useState<View>("starting");
  const [fatal, setFatal] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const boot = useCallback(async () => {
    setView("starting");
    try {
      const next = await kiosk.boot();
      if (next === "receipt") setReceipt(kiosk.session.getReceipt());
      setView(next);
    } catch (err) {
      setFatal(err);
      setView("fatal");
    }
  }, [kiosk]);
  useEffect(() => {
    void boot();
  }, [boot]);

  const recorded = useCallback(
    (r: Receipt) => {
      setReceipt(r);
      setView("receipt");
    },
    [],
  );
  // the identity session ended (expired, election or issuance closed) before a credential existed: back to the login with nothing kept
  const sessionOver = useCallback(() => {
    kiosk.leave();
    setView("login");
  }, [kiosk]);

  switch (view) {
    case "starting":
      return (
        <>
          <Title>Starting the kiosk</Title>
          <Busy label="Starting the kiosk…" />
        </>
      );
    case "fatal":
      return (
        <>
          <Title>The kiosk could not start</Title>
          <Alert tone="danger" title="This kiosk could not reach the election services.">
            <p>{messageFor(fatal)}</p>
          </Alert>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void boot()}>
              Try again
            </button>
          </div>
        </>
      );
    case "login":
      return <LoginView kiosk={kiosk} onLoggedIn={() => setView("face")} />;
    case "face":
      return (
        <>
          <Title>Check your face</Title>
          <p className="lede">This confirms that you are the registered voter. Nothing from the camera is stored or uploaded.</p>
          <FaceStep kiosk={kiosk} onVerified={() => setView("eligibility")} onSessionEnded={sessionOver} />
        </>
      );
    case "eligibility":
      return <CredentialStep key="begin" kiosk={kiosk} mode="begin" onIssued={() => setView("ballot")} onSessionEnded={sessionOver} />;
    case "waiting":
      return <CredentialStep key="resume" kiosk={kiosk} mode="resume" onIssued={() => setView("ballot")} onSessionEnded={sessionOver} />;
    case "ballot":
      return <BallotStep kiosk={kiosk} onRecorded={recorded} />;
    case "submit":
      return <SubmitStep kiosk={kiosk} onRecorded={recorded} />;
    case "receipt":
      return receipt ? <ReceiptView receipt={receipt} onFinish={() => startOver(kiosk)} /> : <LostView kiosk={kiosk} />;
    case "credential-lost":
      return <LostView kiosk={kiosk} />;
  }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------- login

function LoginView({ kiosk, onLoggedIn }: { kiosk: Kiosk; onLoggedIn: () => void }) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await kiosk.login(identifier.trim(), password);
      setPassword("");
      onLoggedIn();
    } catch (err) {
      setPassword("");
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Title>Sign in to vote</Title>
      <p className="lede">Use the voter ID (or email) and password you were given at registration.</p>
      <form onSubmit={(e) => void submit(e)} className="stack form" aria-busy={busy || undefined}>
        <div className="field">
          <label htmlFor="identifier">Voter ID or email</label>
          <input id="identifier" name="identifier" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} required value={identifier} onChange={(e) => setIdentifier(e.target.value)} aria-describedby={error ? "login-error" : undefined} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="off" required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={error ? "login-error" : undefined} />
        </div>
        {error && (
          <div id="login-error">
            <Alert tone="danger" title="You could not be signed in.">
              <p>{error}</p>
            </Alert>
          </div>
        )}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !identifier.trim() || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
      <section className="notice" aria-labelledby="trust-title">
        <h2 id="trust-title">Who sees what</h2>
        {TRUST_NOTICE.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </section>
      <p>
        <a href="#/results">Public results</a>
      </p>
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------- credential

function CredentialStep({ kiosk, mode, onIssued, onSessionEnded }: { kiosk: Kiosk; mode: "begin" | "resume"; onIssued: () => void; onSessionEnded: () => void }) {
  type Phase = "creating" | "waiting" | "slow" | "error";
  const [phase, setPhase] = useState<Phase>("creating");
  const [error, setError] = useState<unknown>(null);
  const [ticks, setTicks] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const began = useRef(mode === "resume");
  const callbacks = useRef({ onIssued, onSessionEnded });
  useEffect(() => {
    callbacks.current = { onIssued, onSessionEnded };
  });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (!began.current) {
          setPhase("creating");
          await kiosk.beginCredential(); // eligibility -> LOCAL identity -> only the public commitment leaves this device
          began.current = true;
        }
        if (!live) return;
        setPhase("waiting");
        const result = await kiosk.awaitCredential(() => live && setTicks((n) => n + 1));
        if (!live) return;
        if (result === "ISSUED") callbacks.current.onIssued();
        else setPhase("slow");
      } catch (err) {
        if (!live) return;
        if (sessionEnded(err) && !kiosk.session.getFlow()) return callbacks.current.onSessionEnded();
        setError(err);
        setPhase("error");
      }
    })();
    return () => {
      live = false;
    };
  }, [kiosk, attempt]);

  const steps: { label: string; state: StepState }[] = [
    { label: "Eligibility confirmed", state: phase === "creating" ? "doing" : "done" },
    { label: "Private voting credential created on this device", state: phase === "creating" ? "todo" : "done" },
    { label: "Credential added to the voter list (a short wait)", state: phase === "waiting" || phase === "slow" ? "doing" : phase === "error" ? "todo" : "todo" },
  ];
  return (
    <>
      <Title>Getting your voting credential</Title>
      <p className="lede">A private voting credential is created on this device. Only its public fingerprint is sent to the election, so the credential cannot be linked to you.</p>
      <Steps steps={steps} />
      {(phase === "creating" || phase === "waiting") && <Busy label={phase === "creating" ? "Creating your credential…" : `Waiting for the next batch of credentials${ticks > 3 ? ` (${ticks} s)` : ""}…`} />}
      {phase === "slow" && (
        <Alert tone="info" title="Still waiting.">
          <p>The election network has not added your credential yet. This can take a minute. Your credential is safe on this device.</p>
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
              Keep waiting
            </button>
          </div>
        </Alert>
      )}
      {phase === "error" && (
        <Alert tone="danger" title="Your credential could not be completed yet.">
          <p>{messageFor(error)}</p>
          <div className="actions">
            {(retryable(error) || codeOf(error) === "STAGE_REQUIRED") && (
              <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            )}
            {codeOf(error) === "CREDENTIAL_CANCELLED" && (
              <button type="button" className="btn btn-primary" onClick={() => startOver(kiosk)}>
                Start again
              </button>
            )}
          </div>
        </Alert>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------- ballot

const PREPARE: { key: PrepareStep | "loading"; label: string }[] = [
  { key: "loading", label: "Preparing the proving files" },
  { key: "encrypting", label: "Encrypting your choice on this device" },
  { key: "checking", label: "Checking the ballot against the election contract" },
  { key: "validity-proof", label: "Proving the ballot is valid (zero-knowledge proof)" },
  { key: "membership-proof", label: "Proving you are an eligible voter, without saying who" },
];
const RELAY_LABEL: Record<string, string> = { QUEUED: "Queued", SIGNED: "Signed", BROADCAST: "Sent to the network", CONFIRMED: "Confirmed" };

function BallotStep({ kiosk, onRecorded }: { kiosk: Kiosk; onRecorded: (r: Receipt) => void }) {
  type Phase = "opening" | "choose" | "review" | "casting" | "sending" | "pending" | "error";
  const [phase, setPhase] = useState<Phase>("opening");
  const [open, setOpen] = useState<OpenBallot | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [step, setStep] = useState<PrepareStep | "loading" | null>(null);
  const [relay, setRelay] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<"RELAY" | "CONFIRMATION" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const files = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let live = true;
    setPhase("opening");
    files.current = loadProvingArtifacts(); // fetched from this kiosk's own origin and hash-checked, while the voter reads the list
    files.current.catch(() => undefined);
    kiosk
      .openBallot()
      .then((o) => {
        if (!live) return;
        setOpen(o);
        setPhase("choose");
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err);
        setPhase("error");
      });
    return () => {
      live = false;
    };
  }, [kiosk, attempt]);

  const finish = (outcome: Awaited<ReturnType<Kiosk["submit"]>>) => {
    setChoice(null); // the plaintext choice leaves memory with the screen
    if (outcome.kind === "RECORDED") return onRecorded(outcome.receipt);
    setPending(outcome.reason);
    setPhase("pending");
  };
  const fail = (err: unknown) => {
    if (kiosk.session.getBallot()) setChoice(null); // the package exists: from now on only the STORED package is resent, the choice is not needed
    setError(err);
    setPhase("error");
  };

  async function cast() {
    if (choice === null || !open) return;
    setError(null);
    setPhase("casting");
    setStep("loading");
    try {
      try {
        await (files.current ??= loadProvingArtifacts());
      } catch (err) {
        files.current = null; // the next try fetches afresh
        throw err;
      }
      const outcome = await kiosk.castVote({
        choice,
        open,
        onStep: (s) => {
          setStep(s);
          if (s === "membership-proof") setRelay("");
        },
        onProgress: (state) => {
          setPhase("sending");
          setRelay(state);
        },
      });
      finish(outcome);
    } catch (err) {
      fail(err);
    }
  }

  async function resend() {
    setError(null);
    setPhase("sending");
    try {
      finish(await kiosk.submit(setRelay));
    } catch (err) {
      fail(err);
    }
  }

  const candidates = open?.params.candidates ?? [];
  if (phase === "opening") {
    return (
      <>
        <Title>Preparing your ballot</Title>
        <Busy label="Checking the public voter list on the election network…" />
        <p className="muted">This kiosk reads the public list of credentials and verifies, on this device, that yours is on it.</p>
      </>
    );
  }
  if (phase === "choose" || phase === "review") {
    return (
      <>
        <Title>Choose your candidate</Title>
        <p className="lede">Constituency: {open?.params.constituencyName}</p>
        {phase === "choose" ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (choice !== null) setPhase("review");
            }}
          >
            <fieldset className="choices">
              <legend>Select one candidate</legend>
              {candidates.map((name, i) => (
                <label key={`${i}-${name}`} className={`choice${choice === i ? " choice-on" : ""}`}>
                  <input type="radio" name="candidate" value={i} checked={choice === i} onChange={() => setChoice(i)} />
                  <span>{name}</span>
                </label>
              ))}
            </fieldset>
            <div className="actions">
              <button type="submit" className="btn btn-primary" disabled={choice === null}>
                Review my choice
              </button>
            </div>
          </form>
        ) : (
          <section className="review stack" aria-labelledby="review-title">
            <h2 id="review-title">Confirm your vote</h2>
            <p>
              You chose <strong className="selection">{candidates[choice ?? 0]}</strong>.
            </p>
            <Alert tone="warn" title="This cannot be undone.">
              <p>After you cast your vote it is encrypted and sent. It cannot be changed or taken back, and this kiosk will not show your choice to anyone.</p>
            </Alert>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setPhase("choose")}>
                Go back
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void cast()} autoFocus>
                Cast my vote
              </button>
            </div>
          </section>
        )}
      </>
    );
  }
  if (phase === "casting" || phase === "sending") {
    const at = phase === "sending" ? PREPARE.length : Math.max(0, PREPARE.findIndex((p) => p.key === step));
    const steps: { label: string; state: StepState }[] = [
      ...PREPARE.map((p, i) => ({ label: p.label, state: (i < at ? "done" : i === at ? "doing" : "todo") as StepState })),
      { label: `Sending the encrypted ballot anonymously${relay ? ` — ${RELAY_LABEL[relay] ?? relay}` : ""}`, state: (phase === "sending" ? "doing" : "todo") as StepState },
      { label: "Waiting for the election network to record it", state: "todo" },
    ];
    return (
      <>
        <Title>Casting your vote</Title>
        <p className="lede">Please keep this page open. The proofs are made on this device and can take a little while.</p>
        <Steps steps={steps} />
        <Busy label={phase === "sending" ? "Sending…" : "Working…"} />
      </>
    );
  }
  if (phase === "pending") return <PendingNotice reason={pending} onAgain={() => void resend()} />;
  // error
  const havePackage = kiosk.session.getBallot() !== null;
  const canTryAgain = retryable(error) || codeOf(error) === "CHAIN_UNREACHABLE";
  return (
    <>
      <Title>Your vote has not been recorded yet</Title>
      <Alert tone="danger" title="We could not finish casting your vote.">
        <p>{messageFor(error)}</p>
        {havePackage ? <p>Your encrypted ballot is saved in this tab{canTryAgain ? " and will be sent again, not created again." : ", but it cannot be sent."}</p> : <p>Nothing was sent.</p>}
      </Alert>
      <div className="actions">
        {havePackage && canTryAgain && (
          <button type="button" className="btn btn-primary" onClick={() => void resend()}>
            Send again
          </button>
        )}
        {!havePackage && open && canTryAgain && choice !== null && (
          <button type="button" className="btn btn-primary" onClick={() => void cast()}>
            Try again
          </button>
        )}
        {!open && canTryAgain && (
          <button type="button" className="btn btn-primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        )}
      </div>
      {!canTryAgain && <p className="muted">Please ask a polling official for help.</p>}
    </>
  );
}

function PendingNotice({ reason, onAgain }: { reason: "RELAY" | "CONFIRMATION" | null; onAgain: () => void }) {
  return (
    <>
      <Title>Almost done</Title>
      <Alert tone="info" title="Your ballot has been sent but not confirmed yet.">
        <p>{reason === "CONFIRMATION" ? "The election network has not shown it as recorded yet." : "The ballot network is still processing it."} Your encrypted ballot is safe in this tab. Check again in a moment: it will not be sent twice.</p>
      </Alert>
      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onAgain}>
          Check again
        </button>
      </div>
    </>
  );
}

/** A tab that holds a prepared ballot and comes back (refresh, reopened, network outage): the stored package is sent again; nothing is rebuilt. */
function SubmitStep({ kiosk, onRecorded }: { kiosk: Kiosk; onRecorded: (r: Receipt) => void }) {
  const [phase, setPhase] = useState<"sending" | "pending" | "error">("sending");
  const [state, setState] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<"RELAY" | "CONFIRMATION" | null>(null);
  const started = useRef(false);

  const run = useCallback(async () => {
    setPhase("sending");
    setError(null);
    try {
      const outcome = await kiosk.submit(setState);
      if (outcome.kind === "RECORDED") return onRecorded(outcome.receipt);
      setPending(outcome.reason);
      setPhase("pending");
    } catch (err) {
      setError(err);
      setPhase("error");
    }
  }, [kiosk, onRecorded]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, [run]);

  if (phase === "pending") return <PendingNotice reason={pending} onAgain={() => void run()} />;
  if (phase === "error") {
    return (
      <>
        <Title>Your vote has not been recorded yet</Title>
        <Alert tone="danger" title="We could not finish sending your ballot.">
          <p>{messageFor(error)}</p>
          {retryable(error) ? <p>Your encrypted ballot is saved in this tab and will be sent again, not created again.</p> : <p>Please ask a polling official.</p>}
        </Alert>
        {retryable(error) && (
          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => void run()}>
              Send again
            </button>
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <Title>Sending your ballot</Title>
      <Busy label={`Sending the saved encrypted ballot${state ? ` — ${RELAY_LABEL[state] ?? state}` : ""}…`} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------- receipt

function ReceiptView({ receipt, onFinish }: { receipt: Receipt; onFinish: () => void }) {
  const rows: [string, string][] = [
    ["Election", receipt.electionId],
    ["Chain ID", String(receipt.chainId)],
    ["Contract", receipt.contract],
    ["Constituency", `${receipt.constituency.code}`],
    ["Ballot number", String(receipt.ballotIndex)],
    ["Ballot hash", receipt.ballotHash],
    ["Transaction", receipt.txHash],
    ["Block number", String(receipt.blockNumber)],
    ["Block hash", receipt.blockHash],
    ["Block time (UTC)", new Date(receipt.blockTimestamp * 1000).toISOString()],
  ];
  return (
    <>
      <Title>Your vote was recorded</Title>
      <Alert tone="ok" title="Thank you. Your encrypted ballot is recorded on the election network.">
        <p>The private credential on this device has been erased.</p>
      </Alert>
      <section className="receipt stack" aria-labelledby="receipt-title">
        <h2 id="receipt-title">Receipt</h2>
        <p data-testid="receipt-statement">{receipt.statement}</p>
        <dl className="facts">
          {rows.map(([name, value]) => (
            <div key={name} className="fact">
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <div className="actions no-print">
        <button type="button" className="btn" onClick={() => window.print()}>
          Print receipt
        </button>
        <button type="button" className="btn btn-primary" onClick={onFinish}>
          Finish and clear this kiosk
        </button>
      </div>
      <p className="no-print">
        <a href="#/results">Public results</a>
      </p>
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------- fail closed

/**
 * The identity service says a credential exists for this voter, but THIS tab no longer holds the private identity that goes with it (a closed tab, cleared storage). The kiosk
 * cannot vote with it and will NOT request another one by itself: that would be a second credential for one person.
 */
function LostView({ kiosk }: { kiosk: Kiosk }) {
  return (
    <>
      <Title>This kiosk cannot continue your vote</Title>
      <Alert tone="warn" title="Please ask a polling official.">
        <p>The private voting credential for this session is no longer available on this device. For everyone&apos;s privacy and security this kiosk does not create a second credential, and nothing has been sent.</p>
      </Alert>
      <div className="actions">
        <button type="button" className="btn" onClick={() => startOver(kiosk)}>
          Clear this kiosk
        </button>
      </div>
    </>
  );
}
