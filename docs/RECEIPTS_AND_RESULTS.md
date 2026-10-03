# Receipts, public verification and results (VoteChain V2, backend)

This document describes the Step 10 API and, just as importantly, what it does **not** promise.

## The stage machine, end to end

```
AUTHENTICATED -> FACE_VERIFIED -> ELIGIBLE -> AUTH_ISSUED -> SUBMITTED -> COMPLETED
                                                                 (vote on-chain)  (receipt shown)
```

Voting actions (`/eligibility/check`, `/ballot`, `/authorization`, `/cast`, login) need the election to be **Open**.
Receipt / recovery actions (`GET /voter/receipt`, `GET /voter/status`) also work when it is **Closed**, but only for a
session that already reached the chain (`AUTH_ISSUED`, `SUBMITTED`, `COMPLETED`). Nobody can start or continue voting after close.

## Voter receipt — `GET /api/v1/voter/receipt`

* Needs a voter session in `AUTH_ISSUED` (only useful once a transaction exists), `SUBMITTED` or `COMPLETED`.
* Reconciles the voter's `VoteTicket` with the chain (never signs or broadcasts anything), independently re-verifies the
  confirmed transaction and its `BallotCast` event, and atomically moves `SUBMITTED -> COMPLETED`. Asking again returns the same
  receipt.
* `202 {stage, state: "PENDING", txHash}` while the transaction is not final (not mined, or fewer than `CHAIN_CONFIRMATIONS` blocks).
* `409 VOTE_NOT_RECORDED` when the broadcast transaction was lost and the ticket was reset; `409 RECEIPT_INVALID` /
  `404 RECEIPT_NOT_FOUND` if the chain contradicts the ticket (these never produce a receipt).
* `COMPLETED` lasts 60 seconds, then the session expires. `POST /voter/auth/logout` ends it earlier.

```jsonc
{ "data": {
    "stage": "COMPLETED", "state": "CONFIRMED", "stageExpiresAt": "…",
    "receipt": {                     // the ONLY part that may be copied, printed or turned into a QR code
      "txHash": "0x…", "blockNumber": 12, "blockHash": "0x…", "ballotIndex": "1",
      "contractAddress": "0x…", "chainId": 31337, "electionId": "0x…",
      "confirmedAt": "…",            // the block's timestamp, identical on every read
      "verifyUrl": "/api/v1/public/receipts/0x…"
    },
    "recordedSelection": { "name": "…" }   // the authenticated voter's own screen ONLY
} }
```

The portable `receipt` carries no voter id, uid, nullifier, candidate, candidate name, signature, raw transaction or session id.
`recordedSelection` is deliberately a **separate** field. A frontend must never put it into a copy / print / QR receipt.

### Why the candidate is not on the receipt — and what that does and does not mean

Leaving the candidate off the receipt keeps the printed/copyable artifact from being a ready-made proof of how someone voted.
It does **not** make VoteChain receipt-free: in V2 the candidate id is plaintext in the `BallotCast` event on a public chain, so anyone
who knows a transaction hash (a voter showing their receipt, for example) can look the vote up on the chain. The application merely
does not make that easier than necessary before the election closes.

### Re-login after success (browser closed, session expired)

Password login → face verification (never skipped) → `POST /voter/eligibility/check`. If the nullifier is already used and **this
server holds the voter's own ticket whose chain evidence verifies**, the answer is `409 ALREADY_VOTED` with
`details: { receiptAvailable: true, stage: "COMPLETED" }`, the session is completed, and `GET /voter/receipt` returns the receipt.
If the voter's vote is still in flight (broadcast, not yet mined) the answer is `409 VOTE_IN_FLIGHT` instead of a ballot; check again shortly.
In every other case the answer is `409 ALREADY_VOTED` with `details: { receiptAvailable: false }`: no receipt is fabricated and no
ownership of an arbitrary transaction is claimed. If the ticket row is lost (for example a database restore) the ballot is still on
the chain and counted, but this API cannot connect the voter to it.

After the election has **closed**, login is refused (`ELECTION_CLOSED`), so this route is no longer available; a voter who still has
a live session can finish, and anyone with the transaction hash can use the public verification.

## Public verification — `GET /api/v1/public/receipts/:txHash` (no login, 30 requests/minute/IP)

The hash must be exactly `0x` + 64 hex digits. The verifier checks that the transaction targets the configured Voting contract, its
receipt succeeded, exactly one `BallotCast` was emitted by that contract, the block is on the node's canonical chain, at least
`CHAIN_CONFIRMATIONS` blocks have been mined, and the contract itself reports the nullifier as used with that very ballot index.

* `200 CONFIRMED` — `txHash, blockNumber, blockHash, ballotIndex, electionId, contractAddress, chainId, confirmedAt, constituency{code,name}, statement`.
  The recorded candidate is **never** returned by this endpoint, not even after the election closes. The candidate stays plaintext
  on the public chain, so this is not receipt-freeness; it only avoids making a choice easier to prove than necessary.
* `202 PENDING | CONFIRMING`, `404 RECEIPT_NOT_FOUND`, `422 RECEIPT_INVALID` (wrong contract, reverted, no ballot event, not canonical),
  `503 CHAIN_UNAVAILABLE`.

**What a `CONFIRMED` answer proves:** a ballot represented by this transaction was recorded by this VoteChain contract for this election
and constituency and remains on the canonical chain.

**What it does not prove:** who the voter was; that the recorded candidate matches the voter's intent; ballot secrecy;
receipt-freeness; coercion resistance.

## Public election — `GET /api/v1/public/election`

Election id, phase, contract address, chain id, constituencies and their candidates (names and ids, which are public on the chain
anyway). It never contains vote counts, in any phase, and no backend internals.

## Results — `GET /api/v1/public/results`

* `403 RESULTS_NOT_AVAILABLE` unless the contract phase is **Closed**. No partial or running tally is ever served by the application.
* Everything comes from `Voting.sol` (`votesOf`, `constituencyTotal`, `totalBallots`); Mongo is never an authority for a tally.
* Grouped **by constituency**; counts are strings; no global winner is declared.
* The numbers are cross-checked (candidates → constituency total → `totalBallots`). A mismatch is never served: the answer is
  `500 RESULT_INCONSISTENCY` and an audit row is written.
* A Closed election can never reopen, so the assembled result is cached in memory.

**Honest scope of "results only after close":** the official VoteChain *application* publishes results only after the election closes.
Because the blockchain is public and ballots are plaintext in V2, an external observer can derive interim counts at any time by reading
`BallotCast` events or `votesOf`. Closed-only results are an application policy, not cryptographic secrecy.

## Operational notes

* Rate limits key on `req.ip`. No `trust proxy` is configured: behind a reverse proxy every client would share one bucket, so set Express's trust-proxy deliberately (and only to the proxy you run) at deployment time.
* `/public/election` and `/public/results` are single-flight and cached in the service, with a lenient shared per-IP limit (120/min). A tally that fails the consistency check is not re-assembled for 15 seconds.
* Closed results are not held back for `CHAIN_CONFIRMATIONS` of depth; on a chain without fast finality, run the results route only after your chosen finality window.

* `CHAIN_CONFIRMATIONS` (default `1`, right for the local Hardhat chain): blocks, counting the one that contains the vote, before a
  ballot is called final by the receipt, the cast response and public verification.
* Audit events: `VOTER_RECEIPT_ISSUED`, `VOTER_RECEIPT_RECOVERED`, `RESULTS_PUBLISHED`, `RESULT_INCONSISTENCY`. Receipt rows carry no
  voter id, transaction hash or candidate. Public verification is not audited per request (it is unauthenticated, rate limited and read-only).
* The voter's `VoteTicket` links a voter to a candidate inside the backend database (it must, to submit what the voter confirmed).
  Anyone who can read that collection can link them; the audit trail cannot hide that.
