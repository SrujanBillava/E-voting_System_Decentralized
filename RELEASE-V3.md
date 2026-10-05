# VoteChain V3 (`v3.0.0`): release notes and accepted limitations

VoteChain V3 is a privacy-preserving voting **prototype** built next to the frozen V2 (`v2.0.0`, commit `216bc74`, untouched). One election, one constituency or several, anonymous encrypted ballots
(Semaphore V4 membership + BabyJubJub ElGamal + a Groth16 ballot-validity proof), a 2-of-3 threshold of trustees, a trusted voting kiosk in the browser.

| package | what it is |
|---|---|
| [`privacy-v3`](privacy-v3/README.md) | the frozen cryptographic core, encodings (`ENCODINGS.md`, `spec/vectors.json`) and the final prototype Groth16 ceremony (`spec/final-ceremony.json`) |
| [`smart-contract-v3`](smart-contract-v3/README.md) | `VoteChainV3` (+ the generated final prototype verifier) |
| [`trustee-v3`](trustee-v3/README.md) | dealer-less 2-of-3 DKG, Chaum-Pedersen partial decryptions, aggregate-only tally |
| [`identity-v3`](identity-v3/README.md) | voter login, biometric check, anonymous credential issuance (epoch batching) |
| [`relay-v3`](relay-v3/README.md) | the separate anonymous submission relayer and public group data |
| [`kiosk-v3`](kiosk-v3/README.md) | the browser kiosk (local identity, local encryption and proving) and the public results page |
| [`e2e-v3`](e2e-v3/README.md) | the complete lifecycle in Node and in real Chrome, 13 voters, tally `[7, 4, 2]` |

## Release state

`v3.0.0` is the exact, fully tested release snapshot (commit `94d974a`) and never moves. Later commits on `feature/privacy-v3` and `main` are repository-only (documentation and cleanup: the root README, removed boilerplate); they change no source, test, artifact or cryptographic behaviour.

## Trust model and privacy boundary

* **Identity side** (`identity-v3`): knows who the voter is, that the voter was eligible and passed the face check, and the voter's *public* Semaphore commitment. It never receives a ballot, a nullifier, a ciphertext, the choice or a transaction hash, and its session ends at `CREDENTIAL_ISSUED`.
* **Anonymous side** (`relay-v3`, the contract): receives one encrypted package and sends it; it never learns a voter id, name, email, biometric, session, credential record or the link between a voter and a commitment. Relay calls from the kiosk carry no credentials.
* **Kiosk** (`kiosk-v3`): a trusted endpoint. It creates the private Semaphore identity locally, encrypts and proves locally, and holds no wallet or key. The claim is that no single *server-side* component knows both who the voter is and what they chose.
* **Trustees** (`trustee-v3`): 2-of-3; one trustee alone cannot decrypt. The tally is the decrypted *aggregate*; the contract finalizes a constituency when two trustees endorse the same result, and anyone can recompute and audit it from the public chain log.

## Groth16 status: FINAL PROTOTYPE / RESEARCH CEREMONY

The ballot-validity circuit is final and unchanged (49,136 constraints, 68 public signals, `K_MAX = 16`). Its proving key is the output of a **final prototype / research ceremony**: the public PSE Perpetual Powers of Tau as
phase 1, then three phase-2 contributions and a public beacon, **all performed on one development machine by one operator**. It is a correctly verified Groth16 setup, but it is **not an independently governed production
trusted setup**. The single final zkey is committed (it cannot be rebuilt) and hash-pinned in `privacy-v3/spec/final-ceremony.json`, the generated Solidity verifier and the kiosk. A production election needs a genuinely
independent phase 2, then a regenerated verifier, a new kiosk pin and a new end-to-end run.

## Accepted limitations

* **The kiosk is a trusted endpoint.** It sees who the voter is at login and the plaintext choice on screen; the privacy claim is that no single *server-side* component knows both.
* **A compromised kiosk can observe the plaintext candidate selection.**
* **No network anonymity.** Whatever carries a request (a proxy, an ISP) can see source addresses and timing; the services neither see nor store them, but the network can.
* **Facial liveness is advisory / supervised.** The identity service cannot verify it and a modified browser can fake it.
* **Real webcam matching is not fully automated end to end.** The automated tests use Chrome's fake camera and a test face engine (present only in the test build); the real engine is only loaded against synthetic video.
* **JavaScript cannot guarantee erasure of secrets from memory.** The kiosk removes references and clears plaintext arrays; it makes no guaranteed-erasure claim.
* **Credential loss after issuance fails closed.** A voter whose tab loses its private Semaphore identity cannot vote and the kiosk never requests a second credential.
* **Two colluding trustees can decrypt individual (public) ciphertexts.** The tally workflow is aggregate-only by software policy; the threshold is 2.
* **Two malicious trustees can endorse a false official result.** The contract does not verify Chaum-Pedersen proofs; the public audit detects the discrepancy from public data (`FINAL_RESULT_MISMATCH`).
* **The prototype DKG can be denied by one malicious trustee** (any failure aborts and restarts; there is no robustness round). It can never produce a wrong key.
* **The Groth16 ceremony is a research / prototype ceremony on one operator and one machine** (see above).
* **Hosted-RPC log pagination and scaling are not production hardened.** The relay's group endpoint, the trustee chain adapter and the kiosk read event logs with plain range queries.
* **Deployment assumes the documented prototype process model:** one relayer instance, one identity instance, trustees simulated or run as separate processes on trusted machines, a single local chain for the tests.
* Small anonymity sets are not anonymous (a group of 1-2 members), voters can prove how they voted (no receipt-freeness), and V3 is not audited.

## Verify a checkout

```bash
# per package: npm ci && npm test            (identity/relay/e2e need disposable MongoDB test databases; see their READMEs)
# privacy-v3:  npm run build:circuit          (provisions + hash-checks the committed final zkey; --verify-zkey re-verifies it, ~20 s)
# kiosk-v3:    npm run build && npm run build:verify
# e2e-v3:      npm test && npm run test:browser
```
