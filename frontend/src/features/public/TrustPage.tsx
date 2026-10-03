import { usePageTitle } from "../../components/useRouteFocus";
import { TRUST } from "./content";

export default function TrustPage() {
  usePageTitle("How it works and limits");
  return (
    <div className="container stack stack-lg">
      <div className="page-head">
        <p className="eyebrow">Transparency</p>
        <h1 className="h1">{TRUST.title}</h1>
        <p className="lede">{TRUST.lede}</p>
      </div>

      <section className="section stack" aria-labelledby="provides">
        <h2 className="h2" id="provides">
          What VoteChain V2 provides
        </h2>
        <ul className="prose stack">
          {TRUST.provides.map((p) => (
            <li key={p.title}>
              <h3 className="h3">{p.title}</h3>
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="section stack" aria-labelledby="limits">
        <h2 className="h2" id="limits">
          What it does not provide
        </h2>
        <ul className="prose stack">
          {TRUST.limits.map((p) => (
            <li key={p.title}>
              <h3 className="h3">{p.title}</h3>
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="section stack" aria-labelledby="verify">
        <h2 className="h2" id="verify">
          What a public receipt check shows
        </h2>
        <p className="prose">{TRUST.verifyStatement}</p>
      </section>
    </div>
  );
}
