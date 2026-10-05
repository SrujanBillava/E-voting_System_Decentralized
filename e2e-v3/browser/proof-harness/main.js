// TEST-ONLY. A tiny page that drives the kiosk's OWN ballot code (the same modules, the same frozen privacy-v3 core, the same hash-checked artifact loader) inside a real browser,
// WITHOUT the identity service or the relayer, so the final Groth16 key can be exercised end to end with no database. Built by e2e-v3/lib/browser.mjs (buildHarness) with the kiosk's
// own Vite configuration (same shims, same strict CSP); it is not part of the kiosk and nothing of it ships.
import { buildBallot } from "../../../kiosk-v3/src/core/ballot.ts";
import { createChainReader } from "../../../kiosk-v3/src/core/chain.ts";
import { loadProvingArtifacts } from "../../../kiosk-v3/src/crypto/artifacts.ts";
import { Group, Identity } from "../../../kiosk-v3/src/crypto/privacy.ts";

let identity = null;
window.__harness = {
  newIdentity() {
    identity = new Identity();
    return identity.commitment.toString();
  },
  /** the kiosk's loader: fetch from this origin, SHA-256 against the pins, then install. Resolves to "ok" or "<code>: <message>". */
  loadArtifacts: () => loadProvingArtifacts().then(() => "ok", (err) => `${err.code}: ${err.message}`),
  async prove({ config, code, leaves, choice }) {
    const t0 = performance.now();
    await loadProvingArtifacts();
    const loadMs = performance.now() - t0;
    const chain = createChainReader(config);
    const params = await chain.pinElection(code);
    const built = await buildBallot({ identity, params, choice, group: new Group(leaves.map(BigInt)), chain });
    return { record: built.record, timings: built.timings, loadMs, wallMs: performance.now() - t0 };
  },
};
