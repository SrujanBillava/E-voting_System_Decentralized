import { publicApi } from "../../api/publicApi";
import type { ResultsConstituency } from "../../api/types";
import { Alert } from "../../components/Alert";
import { ErrorState, LoadingState } from "../../components/States";
import { PhaseBanner } from "../../components/PhaseStatus";
import { usePageTitle } from "../../components/useRouteFocus";
import { formatCount } from "../../lib/format";
import { useAsync } from "../../lib/useAsync";
import { usePublicElection } from "../../layouts/PublicLayout";

/** Share of a constituency's votes, as a percentage with one decimal. BigInt arithmetic: counts arrive as strings. */
function share(votes: string, total: string): number {
  try {
    const t = BigInt(total);
    if (t === 0n) return 0;
    return Number((BigInt(votes) * 1000n) / t) / 10;
  } catch {
    return 0;
  }
}

export default function ResultsPage() {
  usePageTitle("Results");
  const election = usePublicElection();
  const results = useAsync((signal) => publicApi.results(signal));
  const notYet = results.status === "error" && results.error.code === "RESULTS_NOT_AVAILABLE";

  return (
    <div className="container stack stack-lg">
      <div className="page-head">
        <p className="eyebrow">Official results</p>
        <h1 className="h1">Results</h1>
        <p className="lede">Results are reported separately for each constituency. They are not combined into a single winner.</p>
      </div>

      {results.status === "loading" && !results.data && <LoadingState label="Loading results…" />}

      {notYet && (
        <div className="stack">
          {election.data && <PhaseBanner phase={election.data.phase}>Official results are published after the election closes.</PhaseBanner>}
          <p className="prose">There is nothing to show yet, and no partial counts are published by this site. Check back after the election has closed.</p>
        </div>
      )}

      {results.status === "error" && !notYet && <ErrorState error={results.error} title="Results could not be loaded" onRetry={results.reload} />}

      {results.data && (
        <>
          <PhaseBanner phase="Closed">Voting has closed. These are the official counts for each constituency.</PhaseBanner>
          <dl className="summary">
            <div>
              <dt>Ballots recorded</dt>
              <dd className="tabular">{formatCount(results.data.totalBallots)}</dd>
            </div>
            <div>
              <dt>Constituencies</dt>
              <dd className="tabular">{results.data.constituencies.length}</dd>
            </div>
          </dl>

          {results.data.constituencies.map((c) => (
            <ConstituencyResults key={c.code} c={c} />
          ))}

          <Alert tone="info" title="About these results">
            <p>{results.data.notice}</p>
          </Alert>
        </>
      )}
    </div>
  );
}

function ConstituencyResults({ c }: { c: ResultsConstituency }) {
  const headingId = `res-${c.code}`;
  return (
    <section className="section stack" aria-labelledby={headingId}>
      <h2 className="h2" id={headingId}>
        {c.name} <span className="mono muted">{c.code}</span>
      </h2>
      <div className="table-wrap" tabIndex={0} role="region" aria-label={`${c.name} results`}>
        <table className="table">
          <caption className="visually-hidden">{c.name}: votes by candidate</caption>
          <thead>
            <tr>
              <th scope="col">Candidate</th>
              <th scope="col" className="num">
                Votes
              </th>
              <th scope="col">Share of this constituency</th>
            </tr>
          </thead>
          <tbody>
            {c.candidates.map((cand) => {
              const pct = share(cand.votes, c.totalVotes);
              return (
                <tr key={cand.candidateId}>
                  <th scope="row">{cand.name}</th>
                  <td className="num">{formatCount(cand.votes)}</td>
                  <td>
                    <div className="cluster">
                      <div className="bar" role="img" aria-label={`${cand.name}, ${pct.toFixed(1)} percent`}>
                        <span className="bar-fill" style={{ "--value": `${pct}%` } as React.CSSProperties} />
                      </div>
                      <span className="tabular">{pct.toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Constituency total</th>
              <td className="num">{formatCount(c.totalVotes)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
