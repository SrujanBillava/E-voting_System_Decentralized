import { Link } from "react-router-dom";
import { PhaseBanner } from "../../components/PhaseStatus";
import { usePageTitle } from "../../components/useRouteFocus";
import { usePublicElection } from "../../layouts/PublicLayout";
import { LANDING, PHASE_COPY } from "./content";

export default function LandingPage() {
  usePageTitle("Supervised polling-terminal voting");
  const election = usePublicElection();
  const phase = election.data?.phase;
  return (
    <div className="container stack stack-lg pt-6">
      {phase && <PhaseBanner phase={phase}>{PHASE_COPY[phase].text}</PhaseBanner>}

      <div className="page-head">
        <p className="eyebrow">VoteChain</p>
        <h1 className="h-display">{LANDING.title}</h1>
        <p className="lede">{LANDING.lede}</p>
        <div className="actions">
          <Link className="btn btn-primary" to="/election">
            See the election
          </Link>
          <Link className="btn btn-secondary" to="/verify">
            Verify a receipt
          </Link>
        </div>
      </div>

      <section className="section stack" aria-labelledby="how">
        <h2 className="h2" id="how">
          How voting works at the terminal
        </h2>
        <ol className="grid gap-x-12 gap-y-6 md:grid-cols-2">
          {LANDING.steps.map((s, i) => (
            <li key={s.title}>
              <h3 className="h3">
                <span className="tabular">{i + 1}.</span> {s.title}
              </h3>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section stack" aria-labelledby="scope">
        <h2 className="h2" id="scope">
          What to expect from the record
        </h2>
        <div className="grid gap-x-12 gap-y-6 md:grid-cols-2">
          {LANDING.anchors.map((a) => (
            <div key={a.title}>
              <h3 className="h3">{a.title}</h3>
              <p>{a.text}</p>
            </div>
          ))}
        </div>
        <p>
          <Link to="/trust">Read what VoteChain does and does not guarantee</Link>
        </p>
      </section>
    </div>
  );
}
