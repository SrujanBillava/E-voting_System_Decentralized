import { ErrorState, LoadingState } from "../../components/States";
import { PhaseBanner } from "../../components/PhaseStatus";
import { usePageTitle } from "../../components/useRouteFocus";
import { usePublicElection } from "../../layouts/PublicLayout";
import { PHASE_COPY } from "./content";

export default function ElectionPage() {
  usePageTitle("The election");
  const election = usePublicElection();
  return (
    <div className="container stack stack-lg">
      <div className="page-head">
        <p className="eyebrow">Public record</p>
        <h1 className="h1">The election</h1>
        <p className="lede">The constituencies and candidates standing in this election. Vote counts are not shown here.</p>
      </div>

      {election.status === "loading" && !election.data && <LoadingState label="Loading the election…" />}
      {election.status === "error" && <ErrorState error={election.error} title="The election could not be loaded" onRetry={election.reload} />}

      {election.data && (
        <>
          <PhaseBanner phase={election.data.phase}>{PHASE_COPY[election.data.phase].text}</PhaseBanner>

          <section className="section stack" aria-labelledby="ref">
            <h2 className="h2" id="ref">
              Election record
            </h2>
            <dl className="dl">
              <div className="dl-row">
                <dt>Election identifier</dt>
                <dd className="mono" translate="no">
                  {election.data.electionId}
                </dd>
              </div>
              <div className="dl-row">
                <dt>Election contract</dt>
                <dd className="mono" translate="no">
                  {election.data.contractAddress}
                </dd>
              </div>
              <div className="dl-row">
                <dt>Network</dt>
                <dd className="mono tabular" translate="no">
                  chain {election.data.chainId}
                </dd>
              </div>
            </dl>
          </section>

          <section className="section stack" aria-labelledby="cons">
            <h2 className="h2" id="cons">
              Constituencies and candidates
            </h2>
            {election.data.constituencies.length === 0 ? (
              <p className="muted">No constituencies have been added yet.</p>
            ) : (
              <div className="grid gap-x-12 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
                {election.data.constituencies.map((c) => (
                  <div key={c.code} className="stack stack-sm">
                    <h3 className="h3">
                      {c.name} <span className="mono muted">{c.code}</span>
                    </h3>
                    {c.candidates.length === 0 ? (
                      <p className="muted">No candidates yet.</p>
                    ) : (
                      <ul className="stack stack-sm">
                        {c.candidates.map((cand) => (
                          <li key={cand.candidateId}>{cand.name}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
