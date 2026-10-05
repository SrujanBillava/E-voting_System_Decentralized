# VoteChain V3 end-to-end harness

Runs the **complete private-voting lifecycle** against the real system. Nothing is mocked except the physical webcam.

| piece | in the harness |
|---|---|
| chain | a Hardhat JSON-RPC node (free port) with the official Semaphore stack, the generated `BallotValidityVerifier` and `VoteChainV3`, configured with the real key of a real 2-of-3 trustee ceremony |
| identity side | `identity-v3` as its own OS process (own port, own MongoDB database, own keys) |
| ballot side | `relay-v3` as its own OS process (own port, own MongoDB database, own key) |
| kiosk | the real kiosk — in Node (the same TypeScript the browser runs) **and** in real Chrome (the built kiosk, served with its production headers) |
| proofs | real Groth16 (frozen 68-signal circuit) and real Semaphore depth-20 proofs |
| trustees | the real `trustee-v3` code: aggregate from the chain log, partial decryptions, audit, endorsements, finalization |
| webcam | Chrome's fake camera + (test build only) the test face engine; in Node a descriptor of the enrolled imaginary person |

## Running

```bash
export MONGODB_TEST_URI="mongodb://127.0.0.1:27017/votechain_identity_v3_test"        # disposable; name must contain "test"
export MONGODB_RELAY_TEST_URI="mongodb://127.0.0.1:27017/votechain_relay_v3_test"      # disposable; name must contain "test" and "relay"
npm ci
npm test                 # Node: the 13-voter election, 19 integration attack/retry tests, a smoke test
npm run test:browser     # real Chrome (system Chrome, headless): see below
```

Never point these at the V2 `evoting` database; the helpers refuse a database whose name lacks `test`.

**MongoDB safety.** The local `mongod` (8.2.6) aborts when `createIndexes` races `dropDatabase`, so the harness creates indexes **once**, empties collections with `deleteMany` between runs, and drops the test databases **once** at the very end after the services have exited.

If a port is busy the harness picks another free one; it never stops a process it did not start.

## What is covered

* `test/lifecycle.test.mjs` — **13 voters, one constituency, 3 candidates, three epoch cohorts, A = 7, B = 4, C = 2** with the Node kiosk: receipts vs `BallotRecorded` events, origin separation from the request logs, the kiosk's read-only RPC use, no result before finalization, trustees 1 + 3, the public result `[7, 4, 2]`, privacy-boundary scans of both databases, both services' logs and all traffic (with planted-leak controls proving the scanners work), and Node performance numbers.
* `test/attacks.test.mjs` — integration attacks and retries: lying relayer / node / group, tampered packages, expired roots (only membership regenerated), duplicates and conflicts, outages at every boundary, reloads, a lost credential delivery, device loss (fail closed), phase changes.
* `browser/kiosk.browser.test.mjs` — the kiosk in real Chrome: the CSP refuses inline script, `eval`, remote script / image / frame / socket / beacon / font and `<base>` while WebAssembly and blob workers (the provers) work; one voter observed request by request (cookie only to the identity origin; relay requests carry no cookie / authorization / referrer; no identity request after `CREDENTIAL_ISSUED`; the camera stops; the four documented `sessionStorage` keys only; `localStorage` / IndexedDB / cookies empty; the receipt; the console); refresh while pending / after issuance; relay outage + refresh (the same package is resent, not rebuilt); root expiry in the browser (only the membership proof is regenerated); lost credential (fail closed); face states (mismatch → lock, unenrolled, camera refused, model load failure); axe accessibility (WCAG 2.1 A/AA + best practice) and keyboard operation; the public result before finalization; the **production-like build** (no test hook, `check-bundle` passes, the real Human + TensorFlow WASM + GhostNet engine runs under the CSP, nothing is uploaded).
* `browser/lifecycle.browser.test.mjs` — **the same 13-voter election with every voter in a real browser**, then the trustees, then the public result page showing exactly `[7, 4, 2]` with the contract's own result fingerprint (axe clean, fits a 375 px phone), and the same privacy-boundary scans over browser traffic.

Results of the performance runs are written to `results/` (`performance-node.json`, `performance-browser.json`, `performance-browser-election.json`). They are measurements of the development machine, not promises.
