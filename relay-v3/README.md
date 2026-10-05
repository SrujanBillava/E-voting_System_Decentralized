# VoteChain V3 anonymous relayer

A **separate service** that simulates, persists, signs, broadcasts and confirms anonymous `submitBallot` transactions. It has no notion of a voter, a login, a
cookie, a session or an identity: it accepts the ballot package the contract already defines and pays the gas. The identity half is [`../identity-v3`](../identity-v3).

It is not a route of the identity backend: it is its own process, with its **own configuration, relayer key, MongoDB database, logger, HTTP server and ABI**, and it imports
nothing from the identity service, V2 or a voter model. `submitBallot` stays **permissionless** on the contract: the relayer is a convenience for anonymity of the *sender*, not a privilege.

Status: prototype, local network. **No network anonymity**: whatever carries a request (a proxy, an ISP) can still see source addresses; this service neither sees nor stores them.

## The anonymous package (`POST /v1/ballots`)

Exactly the arguments of `VoteChainV3.submitBallot`, as canonical **decimal strings** (JSON numbers cannot hold 254 bits):

```json
{ "constituencyId": "0x…32 bytes",
  "membership": { "merkleTreeDepth": "20", "merkleTreeRoot": "…", "nullifier": "…", "points": ["…" x 8] },
  "coords": ["…" x 4·K_c],
  "validity": { "a": ["…","…"], "b": [["…","…"],["…","…"]], "c": ["…","…"] } }
```

Strict schemas: **any other key** (`voterId`, `jwt`, `uid`, `commitment`, a scope, a ballot hash, `kc`, `H`, ...) is refused by name, the value never echoed. The contract stays authoritative for scope, ballot
hash, K_c, H, election id, chain id and its own address. The canonical form is the ABI-encoded call data; its keccak256 is the **package hash**.

## Pipeline, idempotency and recovery

1. validate the shape; cheap local checks mirror the contract (depth 20, nullifier and coordinates inside the field);
2. **nullifier = the anonymous idempotency key**: known + same package hash -> the existing status (no second transaction); known + different package -> `409 NULLIFIER_CONFLICT`;
3. nullifier already **on-chain**: the same ballot (same constituency, same ciphertext) is reported as `CONFIRMED` from the chain's own event, any other is `409 NULLIFIER_ALREADY_USED`;
4. phase, K_c and the **contract's static simulation** (`eth_call`): invalid ballots never spend gas (`422` with the decoded reason; Semaphore's own errors are decoded too);
5. persist `QUEUED`; sign inside the **signer queue** (nonce = the provider's *pending* count) and persist the **exact raw transaction before broadcasting**; broadcast; wait for the receipt;
6. verify the receipt: success **and** a `BallotRecorded` matching the nullifier, constituency, ballot hash and coordinates, and the nullifier consumed at that block -> `CONFIRMED`.

| after a crash or failure | what happens |
|---|---|
| raw tx persisted, never broadcast | recovery rebroadcasts the **identical** bytes |
| broadcast, database never knew | receipt found -> verified -> `CONFIRMED`, nothing sent |
| transaction hash lost / replaced | the nullifier is on-chain with this exact ballot -> `CONFIRMED` (whoever sent it) |
| transaction vanished from the node | rebroadcast the same bytes |
| nonce spent by another transaction **and** nullifier unused | only now is the old transaction dead: back to `QUEUED`, a new one will be created |
| success receipt without the expected event | `FAILED(EVENT_MISSING)`, never reported as confirmed; an identical retry may resend |
| RPC down while broadcasting | `503`, state `SIGNED`; the identical retry rebroadcasts |

States: `QUEUED -> SIGNED -> BROADCAST -> CONFIRMED`, or `FAILED` (background recovery never resends a FAILED one; an identical request from a caller may). A new transaction for a nullifier exists only
after the chain has proved the previous one dead. `GET /v1/ballots/:nullifier` reports a nullifier's status (read-mostly: it reconciles, never signs).

## The public group path (for the future kiosk)

`GET /v1/groups/:constituency` (a code like `KA-BLR`, or the `0x…` id): the **full ordered leaf set** of the constituency's Semaphore group, the current root and size, the declared proof depth (20) and a
checkpoint (size, root, block time) after every batch, all from public chain events. It is **not** a Merkle-proof service and knows no voter: the kiosk rebuilds the tree, checks its own commitment is a
leaf and that the root equals the chain's, and chooses a root the contract still accepts. No secret witness, no identity-linked lookup.

## What it never stores or logs

No source IP, user agent, referer, header, cookie, request body outside the canonical ballot, request id from the caller, or identity-side id: the code never reads them (there is no cookie parser, no `trust proxy`),
inbound `X-Request-Id` is ignored, the access log writes the matched route **pattern** (never the nullifier in the path), and the logger redacts any identity-named field. CORS never allows credentials
(the future frontend calls with `credentials: "omit"`). There is a **global** request budget and no per-client limit (this process does not know its callers); throttle per client at the network edge.

## Configuration and roles (`.env.example`)

`loadEnv` refuses to start if it finds the issuer key, the owner key, trustee keys, `IDENTITY_*`, `FACE_*`, `JWT_*`, `SESSION_*`, `VOTER_*`, `COOKIE_*`, `BATCH_*` or the shared `MONGODB_URI`;
the database name must contain `relay`. The startup preflight proves the right chain/contract/election and that the relayer key is **not** the contract's issuer, owner or a trustee. Its ABI subset has no
commitment-issuance or admin function (the relayer calling `registerCommitmentBatch` is refused by the contract: `NotIssuer`). Conceptual hostname: `relay.votechain.localhost` (loopback only).

```bash
npm ci
cp .env.example .env
npm start
npm run sync:abi         # from ../smart-contract-v3/artifacts (compile it first); npm run check:abi fails on drift
npm test                 # unit + static privacy-boundary scans (no database, no chain)
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/votechain_relay_v3_test npm run test:chain
```

`test:chain` starts a standalone Hardhat node (from `../smart-contract-v3`, compiled) on a free port, deploys the real stack and sends **real** Semaphore + Groth16 ballots built by `../privacy-v3`
(build it first). One instance is assumed (in-process signer queue, as in V2). The group endpoint reads the whole event log in one query (no pagination for hosted RPCs with block-range caps).
