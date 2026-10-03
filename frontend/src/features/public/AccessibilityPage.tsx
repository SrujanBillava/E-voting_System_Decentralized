import { usePageTitle } from "../../components/useRouteFocus";
import { ACCESSIBILITY } from "./content";

export default function AccessibilityPage() {
  usePageTitle("Accessibility");
  return (
    <div className="container stack stack-lg">
      <div className="page-head">
        <p className="eyebrow">Using VoteChain</p>
        <h1 className="h1">{ACCESSIBILITY.title}</h1>
        <p className="lede">{ACCESSIBILITY.lede}</p>
      </div>
      <ul className="prose stack">
        {ACCESSIBILITY.items.map((i) => (
          <li key={i.title}>
            <h2 className="h3">{i.title}</h2>
            <p>{i.text}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
