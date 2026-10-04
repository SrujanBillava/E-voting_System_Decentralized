# VoteChain Privacy V3 - isolated cryptographic core (prototype)

**Status: standalone proof-of-concept. NOT integrated with VoteChain V2.** Nothing under `backend-api/`, `frontend/` or `smart-contract/` was touched
(branch `feature/privacy-v3`, created from the frozen tag `v2.0.0`). There is no backend, relayer, chain or UI code here, and no trustees / DKG.

It demonstrates, end to end and with real zero-knowledge proofs:

1. **Semaphore V4** anonymous group membership - one group per constituency, one **election-wide scope** (so one nullifier per voter per election)
2. **Encrypted one-hot ballots** - BabyJubJub exponential ElGamal, fresh randomness for every candidate slot, `K_MAX = 16`, canonical padding
3. A **Groth16 ballot-validity circuit** (Circom) proving the ciphertexts encrypt a one-hot vector, without revealing the choice
4. **Binding** between the Semaphore proof, the nullifier, the exact ciphertexts and the validity proof
5. **Homomorphic aggregation** and decryption of the **aggregate only**, with a temporary TEST key (no individual ballot is ever decrypted)

## Quick start

```bash
cd privacy-v3
npm install                 # exact, pinned dependencies (own package-lock.json)
npm run build:circuit       # downloads circom 2.2.3 + PSE Perpetual Powers of Tau (2^18) + the official Semaphore 4.13.0 artifacts for depth 20 (frozen)
                            # and depth 3 (fast tests), SHA-256 pinned; compiles the circuit, runs the Groth16 setup (~1 min). Everything lands in git-ignored artifacts/
npm run demo                # 5 fake Bengaluru voters, votes A,B,A -> A=2 B=1 C=0 (fixed scenario; keys, randomness and proofs are fresh every run)
npm test                    # 142 tests, real proofs, ~95 s
npm run bench               # kc = 2, 8, 16 (results/bench.json);  npm run bench:single  = no worker threads
```

Requirements: Node >= 22 (tested on 24.20), Linux x64 for the automatic circom download (otherwise put a circom 2.2.x binary at `artifacts/bin/circom`).

## Layout

```
circuits/ballot_validity.circom   the Groth16 validity circuit (K = 16 slots)
src/params.js                     K_MAX, domain tags, FIXED TEST context (chainId, contract, electionId), scope derivation
src/elgamal.js                    BabyJubJub exponential ElGamal: keygen (TEST), encrypt, add, decrypt-to-point, BSGS discrete log, election-key validation, the ONLY entropy call
src/ballot.js                     one-hot vector, per-slot encryption, ballot hash (mirrors the circuit), circuit input / public signals
src/semaphore.js                  thin adapter over @semaphore-protocol/{identity,group,proof}
src/validity.js                   snarkjs witness / prove / verify for the validity circuit
src/voter.js                      the voter side: everything secret stays here (castBallot / prepareBallot)
src/ballotbox.js                  the verifier side: strict parsing, all checks, atomic nullifier consumption, homomorphic tally
testing/fake-voters.js            TEST/DEMO ONLY: deterministic, label-derived Semaphore identities. src/ must never import this (a test enforces it)
scripts/build-circuit.mjs         reproducible build (hashes recorded in results/build-info.json)
scripts/demo.mjs, bench.mjs       demo and benchmarks
test/                             142 tests (see results/RESULTS.md for the list)
results/                          build-info.json, bench*.json, test-report.txt, RESULTS.md
```

## The protocol in one page

**Public election data:** context `(chainId, contractAddress, electionId)` (fixed test constants here; `electionId` is the full bytes32), election public key `H`, per constituency: its
bytes32 id (`keccak256(code)`), `kc` (1..16 candidates) and the Semaphore group (membership = identity commitments). **Scope** = one election-wide value (see "Known differences" below).

**Voter (browser, in production):** Semaphore identity -> `nullifier = Poseidon(hash(scope), secret)` (Poseidon is Semaphore's own internal primitive).
Choose candidate `c < kc` -> `m = one-hot(c)` (length 16, zeros after `kc`) -> for `j < kc`: `C1_j = r_j*G`, `C2_j = m_j*G + r_j*H` with a fresh `r_j`;
slots `j >= kc` are the canonical identity pair `((0,1),(0,1))`. Then the **frozen ballot hash**, computed outside any circuit:

```
ballotHash = uint256( keccak256( abi.encode( bytes32 tag, uint256 chainId, address contract, bytes32 electionId, bytes32 constituencyId, uint256[64] coords ) ) )
coords     = for slot j = 0..15: [C1.x, C1.y, C2.x, C2.y]      (slot-major, padded slots included as the identity pair; 64 words)
tag        = keccak256("VOTECHAIN-V3-BALLOT-1")                 (prototype value)
```

It is a full 256-bit value used directly as the **Semaphore message** (Semaphore hashes message and scope again, keccak >> 8, before its circuit). The voter proves membership **at depth 20**
with that message and the election scope, and a Groth16 validity proof for the statement below. Only the `kc` real ciphertexts and the two proofs are sent.

**Validity circuit statement: 68 public signals, no public outputs**, in this order: `nullifier, kc, H.x, H.y`, then for each of the 16 slots `C1.x, C1.y, C2.x, C2.y`. Private witness `m[16], r[16]`.
The circuit proves: `1 <= kc <= 16`; every `m_j` is a bit; `m_j = 0` for `j >= kc`; `sum m = 1`; every public ciphertext equals `Enc_H(m_j; r_j)` (padded slots exactly the identity pair);
`H` is on the curve with `x != 0`; the nullifier is constrained (a proof cannot be moved to another nullifier). It contains **no hash and no context**: chain, contract, election and constituency are
bound by the externally computed keccak message that the Semaphore proof fixes together with the nullifier, the group and the depth.

**Ballot box (verifier):** rejects anything that is not *exactly* the canonical wire format; then checks, in this order: scope == election scope; depth == the declared depth 20; Merkle root == this constituency's group root;
`Semaphore message == keccak ballotHash` recomputed from the ciphertexts it received; nullifier unused; Semaphore proof; validity proof against the 68-signal statement **the box rebuilds itself**
(its own `H` and `kc`, the Semaphore nullifier, the received ciphertexts). Only then is the nullifier consumed **atomically** and the ciphertexts added into the per-candidate sums.
Aggregates are decrypted (TEST key) only after the election: `C2sum - s*C1sum = total*G`, then a baby-step giant-step discrete log.

## Alignment with the frozen architecture

| | Before | Now |
|---|---|---|
| Ballot hash / Semaphore message | Poseidon chain computed inside the validity circuit | `keccak256(abi.encode(...))` computed outside the circuit (voter and verifier, later the contract) |
| Validity circuit public signals | 73 (`ballotHash` output + chainId, contract, electionId, constituencyId, kc, H, nullifier, 64 coords) | **68**: `nullifier, kc, H.x, H.y`, 64 coords; no output |
| Constraints | 54,590 | **49,136** |
| Semaphore depth | 3 (demo groups) | **20** for every proof; depth 3 only in fast tests |

Poseidon is now used only where Semaphore itself needs it (identity commitment and nullifier, via the Semaphore libraries and `nullifierOf`) and for the election scope (below).
The depth-20 artifacts are the pinned Semaphore **4.13.0** set that `@semaphore-protocol/proof` 4.14.3 requests; they are loaded from `artifacts/semaphore` with SHA-256 checks, and the adapter never lets the
library download anything (`test/semaphore.depth20.test.mjs` traps every network entry point while proving and verifying at depth 20).

### Known differences from the frozen architecture (not changed in this pass)

* **Scope.** The frozen text says the election scope is `keccak(tag, chainid, contract, electionId)`; the prototype still derives it with Poseidon over `(tag, chainId, contract, electionId >> 8)`.
  Because of the `>> 8` an election id that differs from another only in its lowest 8 bits would get the *same* scope (a test shows the keccak ballot hash still tells them apart). Moving the scope to keccak is a one-line change.
* **Assumptions the contract must match** (the frozen text does not fix them): the ABI types above (`uint256[64]` encoded as a static array), the slot-major coordinate order, hashing all 64 coordinates with padding included, and the tag value.
  `test/fast.params.test.mjs` pins two known-answer hashes (identity padding, and sequential coordinates) plus an independent hand-rolled encoding for the implementer to reproduce.

## Two invariants that are enforced, not just documented

**Election public key `H`.** circomlib's variable-base multiplication assumes the base point is in the prime-order subgroup and is not the identity, and the circuit only checks
"on the curve, x != 0". So `src/elgamal.js` exports one reusable check, `validatePublicKey(H)` / `assertValidPublicKey(H)`: canonical field elements, on the curve, not the identity,
and `l*H = identity`. It rejects off-curve points, the identity, **every** non-identity point of the torsion subgroup (order 2, 4 and 8) and any key with a torsion component added.
It is enforced at both trust boundaries: the voter before encrypting (`prepareBallot`, hence `castBallot`) and the verifier when the `BallotBox` is created.
`test/fast.publickey.test.mjs` enumerates the whole torsion subgroup E[8] (checked to have the order profile 1,2,4,4,8,8,8,8) and tests both boundaries.
The check costs one scalar multiplication (~17 ms); it is not part of the reported `encrypt` timings.

**Randomness.** All ballot randomness (per-slot `r`, the TEST key) comes from the operating system's CSPRNG through `crypto.randomBytes`, called in exactly one place (`randomScalar()` in `src/elgamal.js`).
There is no seed, RNG parameter or hook anywhere in `src/`, and no deterministic generator exists at all (the earlier `--seed` demo flag and `src/rng.js` were removed).
The only deterministic things are the label-derived fake voters in `testing/`, which `src/` may not import. `encrypt(H, m, r)` is the bare mathematical primitive that takes an explicit `r`; inside the core only `encryptVector()` calls it, always with `randomScalar()`.
`test/fast.rng.test.mjs` fails if `src/` ever mentions a seed, an `rng`, a parameter named `random`, `Math.random`, another entropy API, or imports test/demo code, and checks that injected `random`/`seed`/`rng` options are ignored.

## What is tested

See `results/RESULTS.md` for the complete list. In short: every required negative case (non-member, reused nullifier, two-hot, zero-hot, value 5, padded-slot vote, modified ciphertext,
wrong encryption key, copied ciphertext/validity proof under another nullifier, malformed proofs, same nullifier twice - including concurrently), **plus** wrong `kc`, wrong context
(other chain / contract / election / constituency, rejected through the keccak message), a field wrap-around ballot `[2, -1, 0...]`, torsion-point election keys, direct tampering of a witness against the R1CS, an exhaustive
check that flipping *any one* of the 68 public signals invalidates a proof, and depth 20 end to end (pinned artifacts, nullifier unchanged by depth, no network access).

## Honest limitations (read before building on this)

* **The election key is a single TEST key** generated in memory. Whoever holds it can decrypt every individual ballot. Threshold key generation and *proofs of correct decryption* are the next milestone and are not here.
* **The Groth16 setup is a test setup**: phase 1 is the real Perpetual Powers of Tau (contribution 80), phase 2 is **one local contribution** (`results/build-info.json`). A production deployment needs a multi-party phase-2 ceremony for the validity circuit. (Semaphore's own artifacts come from its ceremony and are used as downloaded; their SHA-256 is recorded.)
* **Voters who sell or are coerced into proving their vote can do so** (they know `r_j`): no receipt-freeness / coercion resistance, as already accepted for V2.
* **Anonymity is only as good as the group and the network**: the group must be published and auditable (a registrar could add fake members), groups of 1-2 members are not anonymous, and IP/timing metadata is out of scope.
* **K_MAX = 16 is a hard limit of the compiled circuit.** Real constituencies can have more candidates; cost is linear (~3.4k constraints per slot, see RESULTS). The circuit costs the same for kc = 2 as for kc = 16.
* **Browser proving was not measured** (Node CLI only). Single-threaded Node proving takes ~7.9 s (validity) + ~1.8 s (Semaphore, depth 20) on a fast desktop CPU, so a kiosk-class device needs real measurement.
* The ballot box is in-memory; the real one needs a database with a unique index on the nullifier, rate limiting, and an audit log. Groth16 proofs are *re-randomisable*, so the nullifier (never a proof hash) is the identity of a ballot.
* The JS ElGamal code uses `node:crypto` for randomness; a browser build needs `crypto.getRandomValues`.
* On-chain verification (68 public inputs for the validity proof, plus the Semaphore verifier at depth 20) was **not** built or measured.
