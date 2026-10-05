import { useEffect, useState } from "react";
import type { Kiosk } from "../core/index.ts";
import { Shell } from "./components.tsx";
import { ResultsPage } from "./ResultsPage.tsx";
import { VoterKiosk } from "./Voting.tsx";

/** Two screens only: the voter's kiosk and the public results page (`#/results`). The hash keeps the page a static file: nothing is routed through a server. */
export function App({ kiosk }: { kiosk: Kiosk }) {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return <Shell>{hash.startsWith("#/results") ? <ResultsPage kiosk={kiosk} /> : <VoterKiosk kiosk={kiosk} />}</Shell>;
}
