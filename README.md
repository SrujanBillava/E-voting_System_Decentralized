# VoteChain

VoteChain is a privacy-preserving, decentralized electronic voting **research prototype** for authorized polling kiosks (Smart-EVM-style terminals).

* It is **not** remote voting from home. A voter uses an authorized polling terminal.
* The system identifies the voter's registered constituency and shows **only that constituency's ballot**.
* Duplicate voting is prevented.
* In V3, the voter's **identity is separated from the anonymous, encrypted ballot**: the service that knows who you are never sees what you voted, and the service that submits your ballot never learns who you are.

> Research prototype. Not audited and not production election infrastructure. See [Limitations](#limitations) and [RELEASE-V3.md](RELEASE-V3.md).

## Project evolution

| version | status | where |
|---|---|---|
| **V1** | original VoteChain prototype: Node/Express API, MongoDB voter rolls, a Hardhat `Voting` contract and a React app | preserved unchanged on branch [`v1`](https://github.com/SrujanBillava/E-voting_System_Decentralized/tree/v1) |
| **V2** | frozen | tag `v2.0.0` (commit `216bc74`), development branch `feature/voting-core` |
| **V3** | current, frozen release | tag `v3.0.0` (commit `94d974a`), branch `feature/privacy-v3` |

**V2** added a production-style flow: login and server-side voter sessions, a face (biometric) check, constituency eligibility, EIP-712 ballot authorization signed by the backend, a backend relayer that submits the vote, one-vote-per-voter enforcement, and receipts. No voter personal data is put on-chain.
But the candidate choice was **plaintext and public on-chain**, so V2 gave no cryptographic ballot secrecy.

**V3** keeps the polling-terminal model and adds cryptographic ballot secrecy:

* a browser-generated **Semaphore** identity and a constituency-specific anonymous credential, issued in epoch batches;
* the identity session **ends before voting**;
* the ballot is an **encrypted one-hot vector** (BabyJubJub exponential ElGamal) with a **Groth16** proof that it is a legal ballot, and a Semaphore proof that the voter is a member of the constituency group;
* submission through a **separate anonymous relayer**;
* **homomorphic aggregation** of the encrypted ballots on-chain, and a **dealer-less 2-of-3 DKG** whose trustees publish **Chaum-Pedersen-proven partial decryptions** of the aggregate (threshold recovery, public audit);
* a **browser kiosk** that does the voter-side work locally, and a public results page that shows a result only after the trustees finalize it.

## V3 at a glance

```
IDENTITY SIDE                                                 (knows who the voter is)
  Voter login -> Biometric verification -> Eligibility
    -> Local Semaphore identity -> Public commitment
    -> Batched credential issuance -> CREDENTIAL_ISSUED -> identity session ends
==================================== privacy boundary ====================================
ANONYMOUS SIDE                                                (never learns who the voter is)
  Candidate selection -> Local one-hot encryption -> Groth16 validity proof
    -> Semaphore membership proof -> Anonymous relay -> VoteChainV3
    -> Encrypted aggregate -> 2-of-3 trustee decryption -> Final result
```

## Repository structure

**V3 (current)**

| path | what it is |
|---|---|
| [`privacy-v3/`](privacy-v3/README.md) | V3 cryptography: ballot encryption, the Groth16 ballot-validity circuit, frozen encodings and test vectors, and the final prototype ceremony artifacts |
| [`smart-contract-v3/`](smart-contract-v3/README.md) | the `VoteChainV3` Solidity contract: Semaphore integration, encrypted tally aggregation, trustee configuration, final-result logic, and the generated Groth16 verifier |
| [`trustee-v3/`](trustee-v3/README.md) | dealer-less 2-of-3 DKG, trustee shares, Chaum-Pedersen proofs, threshold decryption and baby-step giant-step tally recovery |
| [`identity-v3/`](identity-v3/README.md) | identity-side service: voter authentication, biometric verification, anonymous credential reservation and epoch batching |
| [`relay-v3/`](relay-v3/README.md) | separate anonymous transaction relayer and public Semaphore group-data service |
| [`kiosk-v3/`](kiosk-v3/README.md) | the React/TypeScript browser voting kiosk (local identity, local encryption and proving) and the public results page |
| [`e2e-v3/`](e2e-v3/README.md) | full-stack end-to-end tests in Node and in real Chrome |

**Retained V1/V2 and shared**

| path | role |
|---|---|
| `backend-api/` | the **V2 backend** (Express, MongoDB). **Also used by V3:** `identity-v3` imports its pure biometric modules (`src/biometrics/`) and reads the same voter registry and enrolled-face data, and the V3 tests reuse its face test helpers. It must stay in place. |
| `frontend/` | the **V2 frontend**. **Also used by V3:** it is the source of the face-model assets (`npm run face:setup` there; research-licensed weights, not committed), which `kiosk-v3` copies; the V3 face step is adapted from its face code. |
| `smart-contract/` | the **V2 Hardhat/Solidity project** (`Voting.sol`). Retained V2 implementation and historical reference only; nothing in V3 imports it. |
| `docs/` | V2 design, biometric and flow documents (kept as the V2 record) |
| `RELEASE-V3.md` | the V3 release document: scope, trust model, privacy boundary, final Groth16 status and the full list of accepted limitations |

## Privacy and security properties (what the implementation supports)

* No voter personal data is placed on-chain.
* The Semaphore private identity is generated in the browser; the identity service receives only the **public commitment**.
* The identity session ends at `CREDENTIAL_ISSUED`, before the anonymous vote; the identity side never receives the ballot nullifier, ciphertexts, candidate, validity proof or ballot transaction.
* The anonymous relay never receives a voter id, name, email, biometric, identity session or credential record; the kiosk calls it without credentials.
* The ballot is encrypted locally; a Groth16 proof shows it is a legal one-hot ballot without revealing the choice.
* An election-wide Semaphore nullifier prevents duplicate anonymous voting.
* Encrypted ballots aggregate homomorphically; only the **aggregate** is decrypted. One trustee alone cannot decrypt, and 2 of 3 are required for threshold recovery.
* The chain log is public: anyone can rebuild the aggregate from the `BallotRecorded` events and audit the published partial decryptions and the result.
* A voter's receipt proves that an encrypted ballot was **recorded**; it does not prove which candidate was selected.

## Limitations

This is a research prototype. The important ones (full list in [RELEASE-V3.md](RELEASE-V3.md)):

* The **kiosk is a trusted endpoint** and sees the plaintext candidate selection locally; a malicious or compromised kiosk is an accepted threat.
* There is **no network anonymity**: a proxy or ISP can still see source addresses and timing.
* Facial liveness is **advisory / supervised**; real-webcam matching is not covered by automated end-to-end tests.
* JavaScript **cannot guarantee secure erasure** of secrets from memory.
* A voter who loses their anonymous credential after issuance **fails closed** (no second credential).
* **Two colluding trustees can decrypt individual public ciphertexts**; **two malicious trustees can endorse a false official result**, which a public audit detects.
* The prototype **DKG can be denial-of-service'd** by one malicious trustee.
* No coercion resistance and no receipt-freeness.
* The final Groth16 setup is a **research/prototype ceremony** run by one operator on one machine. It is **not an independently administered production trusted setup**.

## Technology

Solidity 0.8 with Hardhat 3 and OpenZeppelin; Semaphore V4; Circom 2.2 and snarkjs 0.7 (Groth16 on BN254); BabyJubJub (`@zk-kit/baby-jubjub`, circomlib); libsodium (trustee share files and transport); Node.js (22.18+; 24 used for development) with Express, MongoDB (Mongoose), zod and ethers 6; React 19, TypeScript and Vite; face verification in the browser with Human, the TensorFlow.js WebAssembly backend and an InsightFace GhostNet model; Playwright, axe and Chrome for the browser tests. V2 additionally uses JWT, bcrypt and TOTP for its admin and voter sessions.

## Verified release

`v3.0.0` passed a complete end-to-end election in **real Chrome**: **13 voters, 3 candidates, final tally `[7, 4, 2]`**, using the final Groth16 prototype ceremony artifacts, real Semaphore depth-20 proofs and real encrypted ballots, the anonymous relay, the 2-of-3 trustee threshold tally and public results page. The same release also passed privacy-boundary scans of both services' databases, logs and traffic, an integration attack and retry regression, and the per-package suites.

## Branches and releases

| ref | meaning |
|---|---|
| `main` | the latest consolidated repository (V3 plus repository cleanup) |
| `v1` | the preserved original `main` / V1 state |
| `feature/voting-core` | the frozen V2 development branch |
| `feature/privacy-v3` | the V3 development branch, plus the repository-cleanup commit |
| tag `v2.0.0` | the exact frozen V2 release |
| tag `v3.0.0` | the exact frozen, tested V3 release snapshot |

`main` and `feature/privacy-v3` may contain a later documentation / repository-cleanup commit; **`v3.0.0` remains the exact tested release snapshot** and does not move.

## Getting started

There is no one-command deployment. The complete system is several processes: a chain node with the deployed contracts, MongoDB, `identity-v3`, `relay-v3`, the served kiosk, and (for a tally) the trustees. [`e2e-v3`](e2e-v3/README.md) starts and exercises all of them (Hardhat node, contracts, both services as separate processes with separate databases, the kiosk in Chrome), and is the best working reference. Each package README has its own setup:

| package | start here |
|---|---|
| `privacy-v3` | `npm ci && npm run build:circuit` (provisions the proving artifacts), then `npm test` |
| `smart-contract-v3` | needs `privacy-v3`'s artifacts and `trustee-v3` installed; `npm ci && npm test` |
| `trustee-v3` | `npm ci && npm test`; `npm run demo` runs the example election in memory |
| `identity-v3` | `npm ci`, `cp .env.example .env`, `npm start` (needs MongoDB and the deployed contract) |
| `relay-v3` | `npm ci`, `cp .env.example .env`, `npm start` (needs MongoDB and the deployed contract) |
| `kiosk-v3` | `npm ci && npm run assets && npm run build` (face assets come from `frontend`: `npm run face:setup`), `npm run serve` |
| `e2e-v3` | set `MONGODB_TEST_URI` and `MONGODB_RELAY_TEST_URI` to disposable test databases, then `npm ci && npm test` and `npm run test:browser` |

The V2 stack is described in `docs/` and the `backend-api`, `frontend` and `smart-contract` directories.

## License

MIT. See [LICENSE](LICENSE).
