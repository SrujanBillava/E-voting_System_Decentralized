# VoteChain V3 voting kiosk

The browser application a voter uses in the V3 private-voting design: **React + TypeScript + Vite**, four runtime dependencies (`react`, `react-dom`, `ethers`, `@vladmandic/human`).
It wires the frozen V3 components into one real election:

```
voter login ─► face check ─► eligibility ─► LOCAL Semaphore identity ─► only the public commitment is sent
   ─► epoch issuance ─► CREDENTIAL_ISSUED (identity session ends, cookie cleared, identity client locked for good)
   ─► [anonymous from here] public group from the relayer ─► rebuild the depth-20 tree LOCALLY, find OWN commitment, compare the root with the contract's
   ─► pin the election from the contract ─► choose a candidate ─► encrypt (frozen privacy-v3) ─► Groth16 validity proof (68 signals) ─► Semaphore depth-20 proof
   ─► immutable package ─► anonymous relayer ─► BallotRecorded seen ON-CHAIN ─► privacy-safe receipt ─► wipe the secrets
```

Everything cryptographic is the **frozen** `privacy-v3` code, bundled unchanged (see "Frozen core in the browser"). Nothing is re-implemented here.

## The trust model (read this first)

**The kiosk is a trusted endpoint.** While the voter signs in it sees who they are; while the voter chooses it sees the plaintext choice on screen and in memory.
The privacy claim of V3 is therefore **not** "the kiosk cannot know the vote". It is:

> **No single SERVER-SIDE component knows both who the voter is and what they chose.**

* the **identity service** (`identity-v3`) learns *that* a voter was allowed to vote and receives one public Semaphore commitment. It never receives a ballot, a choice, a nullifier or the private identity;
* the **relayer** (`relay-v3`) receives one anonymous encrypted ballot package. It never receives a voter id, a session, a cookie or a commitment-to-person link;
* the **contract** records an encrypted ballot and a nullifier. Nobody can decrypt it alone (2-of-3 trustees).

What this means in practice: a compromised kiosk **can** break a voter's privacy (it sees the choice). The mitigations are about keeping the kiosk honest, not about trusting it less:
a pinned, reproducible build (`npm run build:verify`), a strict Content-Security-Policy, no analytics / third-party script / CDN / remote font / dynamic code loading, no outbound call except the three configured services,
no console output about a voter, and the kiosk **has no wallet and no key** (it only *reads* the chain; it never signs or sends a transaction).

## Origin separation

| origin | what the kiosk sends | credentials |
|---|---|---|
| identity service | login, face descriptor (512 numbers, never an image), eligibility, **one public commitment**, polling for the credential | `include` — a host-only, HttpOnly, SameSite=Strict cookie that exists only on this origin |
| relayer | `GET` the public group, `POST` the encrypted package, `GET` its status | **`omit`** — no cookie, no `Authorization`, no referrer, nothing but the public package |
| JSON-RPC | read-only calls (`eth_call`, `eth_getLogs`, blocks, receipts) | none |

After `CREDENTIAL_ISSUED` the identity client is **locked** (`AnonymousGuard`): every identity method refuses *before touching the network*, and a page that reloads after issuance starts locked.
There is no unlock; a new voter is a new page session. Tests prove the request log shows no identity request after the credential delivery.

## The Semaphore identity (local, short-lived)

Created in the browser (`new Identity()`), once. Held only in **`sessionStorage` + memory** — never `localStorage`, IndexedDB, cookies or any server. `sessionStorage` keys, exhaustively:

| key | holds |
|---|---|
| `vc3.identity` | the private Semaphore identity export (a secret) |
| `vc3.flow` | stage marker + constituency + the voter's own *public* commitment |
| `vc3.ballot` | the immutable anonymous package (public material only; no choice, no one-hot vector, no randomness) |
| `vc3.receipt` | the public receipt |

After the receipt: identity, package and flow are removed; only the receipt stays until the voter chooses "Finish and clear this kiosk", which reloads the page (fresh memory for the next voter).
JavaScript cannot guarantee erasure of memory; the kiosk removes references and clears the plaintext arrays as soon as the proofs exist and makes **no guaranteed-erasure claim**.

**Fail closed.** If this tab loses its private identity after a credential was requested or issued (closed tab, cleared storage), the kiosk shows "ask a polling official" and **never requests another commitment**
(the identity service would refuse a second one anyway). Normal retries — a refresh, a network error — reuse the same identity and the same commitment.

## Ballot, retries and root expiry

* **Pinned parameters.** chain id, contract address, election id, phase `Open`, constituency, `K_c`, the candidate list, the election key `H` (checked: on curve, prime-order subgroup), the group id and depth 20 are read from the contract and cross-checked against the build's configuration. A service is never asked for them.
* **Own commitment.** The kiosk rebuilds the depth-20 tree from the relayer's *full public leaf set*, requires its exact commitment among the leaves, and requires the rebuilt root and size to equal the contract's own. There is no Merkle witness to trust.
* **Immutable package.** After the proofs exist the package is stored (`vc3.ballot`) with a keccak digest over everything an ordinary retry must not change. Every retry sends *the stored package*; it is never rebuilt, and is re-checked (`assertRecordIntact`) before each send.
* **Root expiry.** When the relayer refuses a membership proof the kiosk asks the **chain**: if the proof's root is still the contract's current root the proof is simply invalid (`PROOF_REJECTED`, no loop); otherwise **only the Semaphore membership proof is regenerated** (same ciphertexts, same validity proof, same nullifier, same digest).
* **Confirmation is on-chain.** A relay `200` is not a receipt. The receipt exists only when a matching `BallotRecorded` event is found (same constituency, nullifier, ballot hash and coordinates). A node that lies about the event is not believed.
* **Receipt** (exactly): election id, chain id, contract, constituency, ballot index, ballot hash, transaction hash, block number, block hash, block timestamp, and the sentence *"This receipt proves that an encrypted ballot was recorded. It does not prove which candidate was selected."* — no identity, voter id, biometric, commitment, nullifier, Merkle root, private identity, candidate, one-hot vector or randomness.

## Public results

`#/results` (no sign-in, no identity service, no relayer): reads the contract and shows a constituency's totals **only once the trustees finalized it** (`Result not finalized` before). No interim plaintext exists anywhere; no trustee material ever reaches a browser.

## Frozen core in the browser

`../privacy-v3` is imported verbatim. Three build-time substitutions (see `vite.config.ts`) replace only its Node-only edges:

| Node original | in the browser |
|---|---|
| `node:crypto` (its one randomness source: `randomBytes(48)`) | `crypto.getRandomValues` — the operating system's CSPRNG |
| `node:fs` (reads a verification key the kiosk never needs) | inert stub |
| `./artifacts.js` (file paths of the proving files) | the verified bytes of the bundled files as snarkjs memory files |

The four proving artifacts are bundled with the kiosk (`/artifacts/`, no runtime download from anywhere else) and each is checked against a SHA-256 pinned in `pinned-artifacts.json` before it can be used.

## Face step

Ported from the V2 kiosk (same Human + TensorFlow-WASM + InsightFace GhostNet pipeline): camera permission handling, positioning guidance, a server challenge with a 30-second clock, the liveness action, a settled capture, then the descriptor (**numbers only**) goes to the identity service, which decides.
No frame is stored or uploaded. The camera stops the moment verification succeeds and on unmount. Mismatches count against the server's attempt budget and end in a lock only a polling official can lift.
The model files are served by the kiosk itself (`/face/…`).

The **test** biometric provider exists only in a test build: `window.__E2E_FACE__` is read by `src/face/e2eEngine.ts`, which is imported only behind the build-time constant `VITE_E2E_FACE === "1"`.
A production build does not contain it (`scripts/check-bundle.mjs` fails the build if it finds any trace; a unit test and a browser test prove the production-like build ignores the hook). There is no HTTP bypass: `identity-v3` has no such route.

## Build, serve, verify

```bash
npm ci
npm run assets          # copies + verifies the proving artifacts (../privacy-v3) and the face assets (../frontend, `npm run face:setup` there; not redistributed)
npm run build           # typecheck, vite build, check-bundle (CSP, no test hook, no secret, pinned artifacts) and writes dist/build-manifest.json
npm run build:verify    # two clean builds must be byte-identical; prints the bundle hash
npm run serve           # serves dist/ with the production headers (CSP, nosniff, DENY framing, no-referrer, Permissions-Policy)
```

The camera API needs a **secure context**: serve the kiosk over HTTPS (or from `localhost` / `*.localhost`).

Configuration is baked in at build time and never read from the voter, the URL or a server: copy `.env.production`, or pass `VITE_IDENTITY_BASE`, `VITE_RELAY_BASE`, `VITE_RPC_URL`, `VITE_CHAIN_ID`, `VITE_VOTECHAIN_ADDRESS` (and optionally `VITE_ELECTION_ID`) on the command line.
`connect-src` of the policy is derived from those three origins. The same policy is in the page's `<meta>` and in the headers `scripts/serve.mjs` sends.

## Tests

| command | what |
|---|---|
| `npm test` | 60 unit tests: session keys, receipt safety, HTTP clients (credentials, lock, no ballot method on identity), group verification with lying services, immutable package + the relay's strict schema, engine decisions (boot, credential, lost delivery), proving-file integrity check, CSP builder, static server (headers, no path escape), static source guarantees with planted-violation controls, bundle checker with planted defects |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `cd ../e2e-v3 && npm test` | the full election with the Node kiosk engine (real chain, services, proofs, trustees) + 19 integration attack/retry tests |
| `cd ../e2e-v3 && npm run test:browser` | **real Chrome**: strict-CSP enforcement, the observed voter, refresh / outage / root-expiry / lost-credential recovery, face states, axe accessibility, the real face engine under the CSP, and the complete 13-voter election in browsers |

## PROTOTYPE NOTICE (for the people who release this)

The Groth16 setup behind the bundled proving files is a **TEST / PROTOTYPE** setup. It is fine for development and rehearsal. **Before the final V3 freeze:**

1. generate the final ceremony artifacts;
2. export the final `BallotValidityVerifier`;
3. replace the browser proving zkey (and its hash in `pinned-artifacts.json`);
4. verify provenance and hashes;
5. rerun the final end-to-end test.

The kiosk shows this as a collapsed "Developer notice" in its footer; it is deliberately not a voter warning.

## Accepted limitations

* The kiosk is trusted (see above). A compromised kiosk sees the choice.
* Liveness is advisory (supervised matching, as in V2): a modified browser can fake it; the identity service cannot verify it.
* The proving key is ~27 MB and is read from the kiosk's own origin; proving speed depends on the device (measured only on the development machine, see `../e2e-v3/results/`).
* The prototype trusted-setup caveat above; the relayer's idempotency is per nullifier (an attacker who learns a nullifier cannot change a recorded ballot, only observe public data).
