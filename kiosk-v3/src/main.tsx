import { createRoot } from "react-dom/client";
import { createKiosk } from "./core/index.ts";
import { App } from "./ui/App.tsx";
import { readConfig } from "./ui/config.ts";
import "./styles.css";

// No analytics, no error reporter, no console output of anything about a voter: the kiosk talks only to the three configured services (see the CSP).
const kiosk = createKiosk({ config: readConfig(), fetch: (input, init) => window.fetch(input, init), storage: window.sessionStorage });
createRoot(document.getElementById("root")!).render(<App kiosk={kiosk} />);
