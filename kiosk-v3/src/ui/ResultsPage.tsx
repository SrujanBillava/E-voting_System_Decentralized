import { useCallback, useEffect, useState } from "react";
import type { ElectionResult, Kiosk } from "../core/index.ts";
import { Alert, Busy } from "./components.tsx";
import { messageFor } from "./messages.ts";

interface Row {
  code: string;
  name: string;
  result: ElectionResult;
}

/**
 * The PUBLIC result page. It needs no sign-in and has no secret: it reads the election contract and shows a constituency's totals ONLY once the trustees have finalized it.
 * Before that it says "Result not finalized" and shows nothing else about the count (no interim tally exists in plaintext anywhere, and no trustee material reaches a browser).
 */
export function ResultsPage({ kiosk }: { kiosk: Kiosk }) {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; error: unknown } | { kind: "ready"; rows: Row[] }>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const list = await kiosk.chain.listConstituencies();
      const rows = await Promise.all(list.map(async (c): Promise<Row> => ({ code: c.code, name: c.name, result: c.finalized ? await kiosk.results(c.code) : { finalized: false } })));
      setState({ kind: "ready", rows });
    } catch (err) {
      setState({ kind: "error", error: err });
    }
  }, [kiosk]);
  useEffect(() => {
    document.title = "Public results · VoteChain kiosk";
    void load();
  }, [load]);

  return (
    <>
      <h1 className="title">Public results</h1>
      <p className="lede">Results appear here only after the election trustees have finalized them on the election contract. Anyone can read them; no sign-in is needed.</p>
      {state.kind === "loading" && <Busy label="Reading the election contract…" />}
      {state.kind === "error" && (
        <Alert tone="danger" title="The results could not be read.">
          <p>{messageFor(state.error)}</p>
        </Alert>
      )}
      {state.kind === "ready" && state.rows.length === 0 && <p>This election has no constituencies.</p>}
      {state.kind === "ready" &&
        state.rows.map((row) => (
          <section key={row.code} className="result stack" aria-labelledby={`result-${row.code}`}>
            <h2 id={`result-${row.code}`}>{row.name}</h2>
            {row.result.finalized ? (
              <>
                <table className="tally">
                  <caption className="visually-hidden">Final result for {row.name}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Candidate</th>
                      <th scope="col" className="num">
                        Votes
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {row.result.candidates.map((c) => (
                      <tr key={c.name}>
                        <th scope="row">{c.name}</th>
                        <td className="num">{c.votes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="muted">
                  Ballots counted: {row.result.ballotCount}. Result fingerprint: <span className="mono">{row.result.resultsHash}</span>
                </p>
              </>
            ) : (
              <p className="pending-result">Result not finalized</p>
            )}
          </section>
        ))}
      <div className="actions">
        <button type="button" className="btn" onClick={() => void load()}>
          Refresh
        </button>
        <a className="btn btn-link" href="#/">
          Back to voting
        </a>
      </div>
    </>
  );
}
