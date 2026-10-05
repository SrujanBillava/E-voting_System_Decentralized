# VoteChain V3 identity service

The server-side **identity half** of Privacy V3: it logs a voter in, verifies the face, confirms eligibility and issues exactly **one anonymous credential
per voter per election**, by inserting the voter's *public* Semaphore identity commitment into their constituency's group on-chain, in **epoch cohorts**.
Then the identity session **ends**. It never sees a ballot. The anonymous half is the separate [`../relay-v3`](../relay-v3).

Status: prototype, local network; the ballot-validity proving key is the final prototype / research Groth16 ceremony's, not an independently governed production setup (see `../privacy-v3/spec/final-ceremony.json`). V2 (`../backend-api`, tag `v2.0.0`), `../privacy-v3`,
`../trustee-v3` and `../smart-contract-v3` are untouched.

## The privacy boundary

```
IDENTITY SIDE (this service)                          ANONYMOUS SIDE (../relay-v3)
voter login -> face -> eligibility                    kiosk: reads the PUBLIC group, rebuilds the tree, proves membership locally
  -> receives the PUBLIC commitment ------\           anonymous package -> simulate -> persist -> sign -> broadcast -> BallotRecorded
  -> reserves ONE credential               \
  -> epoch batch on-chain (issuer key)      +-- nothing flows across: the kiosk generates the private identity itself
  -> CREDENTIAL_ISSUED, session deleted ---/
```

The identity side **never learns** the voter's private Semaphore identity, a nullifier, an encrypted ballot, a candidate, a validity proof or a ballot
transaction hash. Its ABI subset has no ballot function, event or error; no model has a field for one; it has no ballot, receipt, cast or result route; and
`test/boundary` scans its database, logs and every response for them after real ballots were cast through the relayer. The relayer, symmetrically, never
learns a voter id, uid, name, email, biometric, identity-session id or credential record. Network metadata (source addresses) is outside this prototype's scope.

## Stages (`src/auth/voterStages.js`)

`AUTHENTICATED -> FACE_VERIFIED -> ELIGIBLE -> COMMITMENT_PENDING -> CREDENTIAL_ISSUED` (terminal). There is no `SUBMITTED`/`COMPLETED`: those are V2 stages and
this service has no knowledge of ballot submission. Only the next stage is reachable (atomic compare-and-set); nothing moves backwards.

## API (`/api/v3/voter`, cookie `vc3_voter`)

| | stage needed | |
|---|---|---|
| `POST /auth/login`, `/auth/logout`, `GET /status` | | refused after `closeIssuance`, in Setup, when Closed, and for a voter who already holds (or is receiving) a credential |
| `GET /face/status`, `POST /face/challenge`, `/face/verify` | AUTHENTICATED | the V2 supervised face matching (its pure modules are reused, not copied) |
| `POST /eligibility/check` | FACE_VERIFIED | election Open, issuance open, the voter's OWN constituency exists, cap not reached |
| `POST /credential` `{ "commitment": "<decimal>" }` | ELIGIBLE | **the only input**: the public commitment. Any other key (a constituency, a voter id, ...) is refused |
| `GET /credential` | COMMITMENT_PENDING | `PENDING`, or once issued the PUBLIC group data (`constituency`, `group: {groupId, merkleTreeDepth, root, size}`) delivered ONCE: the session is deleted and the cookie cleared |

The backend derives the election, the voter, the registered constituency and eligibility. The caller cannot choose another constituency. There is **no Merkle
witness** and no identity-linked proof service: the kiosk fetches the full public leaf set from the relayer's `GET /v1/groups/:constituency`, rebuilds the tree,
checks its own commitment is a leaf and picks a root the contract accepts.

## One credential per voter (`models/CredentialIssuance.js`)

The unique index on `(electionId, voterId)` is the enforcement; reservation is atomic. States `RESERVED -> BATCHED -> ISSUED`, or `CANCELLED`.
A reservation that **never reached the chain** may be cancelled and retried on the *same* record (cap reached, issuance closed, a commitment somebody else
registered, repeated failures). After the commitment is on-chain nothing releases, cancels or reissues it: only `finalize` moves it, to `ISSUED`.
Hard browser/device loss after on-chain issuance **fails closed** in this prototype (no recovery or reissue).

### Data minimisation after issuance

| while pending | after `ISSUED` / `CANCELLED` |
|---|---|
| `commitment`, `constituencyId`, `reservedAt`, `reservedEpoch`, `batchId`, `failures` | all removed |
| | **kept forever: `{_id (random UUID), electionId, voterId, state}`** |

No timestamps (no `createdAt`/`updatedAt`; `_id` is a UUID, not an ObjectId, which would embed its creation time). The session, its face-challenge row and its
terminal stage are deleted at delivery (or swept within a minute); the audit trail is structured log lines carrying a short session reference, never a voter
id, commitment, batch or transaction. The **batch record is not voter-linked** (no voter id) and keeps `txHash`, block, epoch and root; its commitments and raw
transaction are removed at `FINALIZED`. (For a cohort of ONE the Merkle root of a one-leaf tree *is* the commitment: public chain data pointing at no voter.)
Residual metadata this framework cannot remove: MongoDB's own oplog/journal and the physical order of documents on disk; request-level access logs carry
timestamps (no identity) and, with the proxy's, source addresses.

## Epoch batching (`services/batcher.service.js`)

Reservations are grouped by the epoch (30 s of chain time) they were made in. At the first tick of a **later** epoch the cohort of one constituency is sent as
**one** batch: at most `MAX_BATCH` = 128, at most the remaining voter cap, **never more than one batch per constituency per epoch** (the contract refuses a second),
commitments **sorted by value** (the public order says nothing about who reserved first). A cohort of one is sent only because nobody else reserved in that epoch.
The gas limit is **explicit** (`150k + 100k per commitment`, capped at 2^24): Hardhat/Osaka estimation over-probes near large batches.

A batch is a persisted state machine, one lease-guarded driver at a time, one issuer queue (nonce = the provider's pending count, read inside the queue):

| state | meaning | after a crash |
|---|---|---|
| `PREPARED` | reservations claimed, nothing signed | members re-read; signed (or dropped if empty) |
| `SIGNED` | the **exact raw transaction is persisted before any broadcast** | rebroadcast the identical bytes |
| `BROADCAST` | sent | receipt -> verify; known pending -> wait; unknown & nonce free -> rebroadcast; **exactly this cohort already in the group's events -> finalize (never release)**; nonce spent by another tx and cohort not on-chain -> released (the chain proved it dead) |
| `CONFIRMED` | receipt success **and** `CommitmentBatchRegistered` + Semaphore `MembersAdded` carry exactly the persisted commitments | each voter record `BATCHED -> ISSUED` atomically, linkage removed; restart finishes the rest |
| `FINALIZED` | no record points at it | commitments and raw tx removed |
| `FAILED` / `RECONCILE_REQUIRED` | receipt reverted (cohort released) / success without the expected evidence (a human decides; nothing is auto-released or auto-issued) | |

`recover()` runs at startup (one instance is assumed, as in V2: stale leases are cleared); a timer runs `tick()`.

## Configuration and roles (`.env.example`)

`loadEnv` is pure and lists every problem by name, never by value. The process holds **only the issuer key** and refuses to start if it finds the relayer key, the
owner key, trustee keys, `RELAY_*`, or V2's JWT/nullifier secrets. The startup preflight proves the right chain, contract and election, that the key *is* the contract's
issuer, that it is not the owner or a trustee, and that the frozen constants (30 s epochs, MAX_BATCH 128) hold. `IDENTITY_MONGODB_URI` must not name a relayer database. `LOGIN_RATE_LIMIT_MAX` (default 10 per 15 min per source address) and `FACE_RATE_LIMIT_MAX` (60 per minute) are the only per-address limits; a polling booth whose voters all log in from one kiosk address must raise them.
Conceptual hostname: `id.votechain.localhost` (loopback only; terminate TLS in front).

## Running and tests

```bash
npm ci
cp .env.example .env     # fill the issuer key (the contract's issuer) and the face key
npm start
npm run sync:abi         # refresh src/chain/generated from ../smart-contract-v3/artifacts (compile it first); npm run check:abi fails on drift
```

```bash
npm test                 # unit: environment, stage machine, data model, static privacy-boundary scans (no database, no chain)
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/votechain_identity_v3_test npm run test:chain
MONGODB_TEST_URI=... MONGODB_RELAY_TEST_URI=mongodb://127.0.0.1:27017/votechain_relay_v3_test npm run test:boundary
```

`test:chain` starts a standalone Hardhat node (from `../smart-contract-v3`, compiled) on a **free** port (it never touches a busy one), deploys the real stack, and drives the
service over HTTP with a disposable MongoDB (the database name must contain `test`; collections are emptied between tests, never dropped, because a local mongod 8.2.6 aborted
when `createIndexes` raced `dropDatabase`). Crash tests use a test-only hook that throws at a named point and then start a "restarted process". `test:boundary` also needs
`../privacy-v3` built (`npm run build:circuit` there) and `../relay-v3` installed.

## Reuse from V2, and limits

Reused unchanged by import: the biometric constants, descriptor, matching and the AES-GCM template box. Re-implemented for V3 (V2's versions are stateful and V2-staged): login/session,
face challenge, eligibility, credential, batching. The voter registry and face templates are **V2's collections**, read-only, never indexed from here; V3's own collections are suffixed `_v3`.
A voter who closes the browser after reserving cannot log in again until the credential is issued (`CREDENTIAL_IN_PROGRESS`), and then not at all (`CREDENTIAL_ALREADY_ISSUED`): the kiosk learns of issuance from the public group (its commitment becomes a leaf), not from a second session. A reservation that is never batched stays until issuance closes. Face matching is **supervised** (see V2's biometric constants): the server cannot prove liveness. One backend instance is assumed (in-process issuer queue). The credential endpoints have
no per-voter rate limit beyond the stage machine. `closeIssuance` is the operational response to a suspected issuer compromise (no rotation in Open).
