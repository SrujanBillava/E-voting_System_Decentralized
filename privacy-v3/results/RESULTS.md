# Privacy V3 isolated core - results

Measured on: Intel Core i7-13650HX (20 logical cores), 14.8 GiB RAM, Linux 7.0.0-38, Node v24.20.0. Raw data: `bench.json`, `bench-single-thread.json`, `build-info.json`, `test-report.txt`.

## Versions (exact)

| Component | Version |
|---|---|
| circom compiler | 2.2.3 (release binary, `--O2`) |
| snarkjs | 0.7.5 (ffjavascript 0.2.63) |
| circomlib / circomlibjs | 2.0.5 / 0.1.7 |
| Semaphore V4 (`@semaphore-protocol/identity`, `group`, `proof`, `utils`) | 4.14.3 |
| Semaphore circuit artifacts (official, depth 3) | `snark-artifacts.pse.dev/semaphore/4.13.0/` (sha256 in `build-info.json`) |
| `@zk-kit/baby-jubjub` / `utils` / `artifacts` / `eddsa-poseidon` / `lean-imt` | 1.0.3 / 1.3.0 / 2.0.1 / 1.0.4 / 2.2.5 |
| poseidon-lite | 0.3.0 |
| ethers (keccak only) | 6.13.4 |
| Powers of Tau | PSE Perpetual Powers of Tau, contribution 0080, `ppot_0080_18.ptau` (2^18, phase-2 prepared); sha256 `96932202...e711` |
| Node | v24.20.0 |

## Circuit (`circuits/ballot_validity.circom`, K = 16)

| | |
|---|---|
| Non-linear constraints | **54,590** (0 linear after `--O2`) |
| Wires | 54,563 |
| Public inputs / public outputs / private inputs | 72 / 1 / 32 (`m[16]`, `r[16]`) |
| Public signals in a proof | 73 (`ballotHash` + 72 inputs) |
| `zkey` (final) | **32.31 MiB** |
| `r1cs` / witness `wasm` / `verification_key.json` | 15.13 MiB / 2.33 MiB / 17 KiB |
| Setup time (this machine) | compile 4.9 s, `zkey new` 26.6 s, contribute 2.9 s, verify 26.8 s; peak RSS of the build ~2.0 GB |
| Smallest sufficient Powers of Tau | 2^16 (the downloaded 2^18 file also covers K = 64) |

Cost scaling (compile only; same source, `BallotValidity(K)`): K=4 **13,886**, K=8 **27,452**, K=16 **54,590**, K=32 **108,880**, K=64 **217,490** constraints, i.e. about **3.4k constraints per candidate slot**.
The circuit has a fixed size: a constituency with 2 candidates costs the same to prove as one with 16.

`circom --inspect` reports only library-internal warnings (unused sub-component outputs such as `kcBits.out`, `LessThan.n2b.out`, the last-segment `dbl` of circomlib's scalar multipliers); nothing in the circuit's own logic is unconstrained, and the exhaustive public-signal test below confirms every public signal is bound.

## Timings (median of 5 warm iterations; `bench.json`)

Default snarkjs thread pool (20 workers), one process per kc:

| kc | JS encrypt (voter) | witness (WASM) | **validity prove** | validity prove (1st/cold) | **validity verify** | Semaphore prove (depth 3) | Semaphore verify | full `BallotBox.submit` | peak RSS |
|---|---|---|---|---|---|---|---|---|---|
| 2  |  75.5 ms | 382 ms | **1,414 ms** | 1,760 ms | **9.0 ms**  | 148 ms | 9.3 ms | 22.4 ms | 2,281 MiB |
| 8  | 292.7 ms | 376 ms | **1,428 ms** | 1,752 ms | **10.2 ms** | 171 ms | 9.1 ms | 22.9 ms | 2,327 MiB |
| 16 | 573.6 ms | 378 ms | **1,460 ms** | 1,724 ms | **9.9 ms**  | 192 ms | 9.2 ms | 22.6 ms | 2,328 MiB |

Without worker threads (`V3_SINGLE_THREAD=1`, median of 3 warm iterations; `bench-single-thread.json`) - a more honest stand-in for one browser worker or a small kiosk:

| kc | witness | **validity prove** | validity verify | Semaphore prove (1 thread) | peak RSS |
|---|---|---|---|---|---|
| 2  | 377 ms | **8,666 ms** | 11.6 ms | 758 ms | 695 MiB |
| 8  | 372 ms | **8,764 ms** | 10.9 ms | 761 ms | 678 MiB |
| 16 | 376 ms | **8,859 ms** | 13.2 ms | 768 ms | 684 MiB |

Notes: proving is ~9x parallel on this CPU (13 s CPU for 1.5 s wall). The JS encryption time grows with kc because it is BigInt scalar multiplication (~17 ms each, 2 per real slot); it is not a circuit cost.
A browser/WASM proof was **not** measured; expect several times the single-thread figure on a kiosk-class CPU.
Encrypt timings exclude the one-time election-key validation (one scalar multiplication, ~17 ms). Voter-side total at kc = 16, default pool: ~0.57 + 0.19 + 0.38 + 1.46 = **~2.6 s**; single thread: ~0.54 + 0.77 + 0.38 + 8.86 = **~10.5 s**. Server-side verification of a whole ballot: **~23 ms**.

Wire sizes (JSON): kc=2 **2,506 B**, kc=8 **4,499 B**, kc=16 **7,173 B** (ciphertexts 672 / 2,668 / 5,343 B; Semaphore proof ~1.0 KB; validity proof ~0.73 KB).

On-chain verification was not implemented. Analytic estimate only (not measured): a Groth16 verifier with 73 public inputs is roughly 0.65-0.7 M gas for the validity proof alone (4-pairing check ~181k + ~6.2k per public input), plus a Semaphore verification, plus calldata for 2-5 KB.

## Demo result (`npm run demo`)

5 fake Bengaluru voters (Semaphore group depth 3). Votes A, B, A; a second ballot by the first voter is rejected `NULLIFIER_USED`.
Aggregate decrypted with the TEST key: **A = 2, B = 1, C = 0**. No individual ballot was decrypted. The scenario is fixed; the TEST key, ballot randomness and proofs are fresh from the OS CSPRNG on every run (there is deliberately no seed option).

Homomorphic test (`test/fast.elgamal.test.mjs`): `Enc([1,0,0]) + Enc([0,1,0]) + Enc([1,0,0])` -> **[2,1,0]**; 50 voters / 5 candidates match the expected counts; 4 constituencies (kc = 3, 4, 16, 3) tallied independently, sum of all totals == number of accepted ballots.

## Tests: 123 passed, 0 failed, 0 skipped (`npm test`, 87 s)

| Area | Tests |
|---|---|
| Parameters, domain tag == circuit constant, ballot-hash sensitivity to every context field / coordinate | 5 |
| Election public key `H`: validation (off-curve, identity, all 7 non-identity torsion points of E[8], `H` + torsion, random curve points, malformed encodings) | 8 |
| Election public key `H`: enforced by the voter (`prepareBallot` / `castBallot`) and by the ballot box, for 6 invalid key classes, plus a valid-key control | 13 |
| RNG separation: no seed / RNG hook / test import / second entropy source in `src/` (static) | 5 |
| RNG separation: injected `random` / `seed` / `rng` / `entropy` options are ignored; CSPRNG sanity (behavioural) | 4 |
| BabyJubJub ElGamal, homomorphism, key validation (incl. torsion points), randomness, BSGS bound | 9 |
| Cross-check against an independent BabyJubJub implementation (circomlibjs) | 1 |
| Circuit, honest witnesses (kc = 1, 2, 3, 8, 15, 16; first and last slot; public signals == JS; R1CS accepts; any nullifier value) | 13 |
| Circuit, invalid ballots unsatisfiable (each asserted to fail at the INTENDED constraint line) | 11 |
| Circuit, kc range (0, 17, 32, 100, p-1; wrong kc claims) | 7 |
| Circuit, ciphertext / key checks (modified C1x/C1y/C2x/C2y, wrong message, wrong H, non-canonical padding, Enc(2), identity / order-2 / off-curve H, r = 2^251) | 10 |
| Direct tampering of an honest witness file is rejected by the R1CS itself (two-hot, zero-hot, value 5, padded-slot vote, ciphertext, nullifier) | 1 |
| End to end with real Semaphore + Groth16 proofs and the ballot box (below) | 36 |

### Positive results (end to end)

* Semaphore proof, validity proof and their binding all verify for the same ballot (`message == ballotHash`, same nullifier in both proofs, root == the constituency group's root, scope == election scope).
* Submission carries no identity / secret / randomness / plaintext vote (only `kc` ciphertexts + 2 proofs); box accepts it and consumes the nullifier.
* Bengaluru A, B, A -> [2,1,0]; Mumbai (kc=4), Delhi (kc=16, vote in the LAST slot), Chennai (kc=3, 5 voters) independent; empty constituency decrypts to zeros; wrong key cannot read the aggregate.

### Negative results (all rejected, state unchanged, nullifier not consumed unless stated)

| Required case | Result |
|---|---|
| Non-member identity | cannot generate a proof for the real group; a valid proof for its OWN group -> `NOT_A_MEMBER`; patching the root -> `BAD_MEMBERSHIP_PROOF`; other constituency's ballot relabelled -> `NOT_A_MEMBER`; other election / chain -> `WRONG_SCOPE` |
| Reused nullifier | second ballot by the same voter (different choice) -> `NULLIFIER_USED`; totals unchanged |
| Two-hot `[1,1,0..]` | witness unsatisfiable at `total === 1`; borrowed validity proof -> `BAD_VALIDITY_PROOF` |
| Zero-hot `[0,0,0..]` | unsatisfiable at `total === 1`; borrowed proof -> `BAD_VALIDITY_PROOF` |
| Invalid value 5 (also 2, and the wrap-around `[2,-1,0..]`) | unsatisfiable at `m[j] * (m[j] - 1) === 0`; borrowed proof -> `BAD_VALIDITY_PROOF` |
| Vote in a padded slot | unsatisfiable at `inactiveMask[j] === 0` (slot 3, slot 15, only-padded); on the wire extra / missing ciphertexts -> `WRONG_CANDIDATE_COUNT` |
| Modified ciphertext | `BALLOT_NOT_BOUND` (message mismatch); if the voter re-proves membership -> `BAD_VALIDITY_PROOF`; circuit rejects each modified coordinate |
| Wrong encryption public key | circuit rejects `H'` for a ballot made under `H`; box configured with `H'` -> `BAD_VALIDITY_PROOF`; ballot made under the wrong key -> `BAD_VALIDITY_PROOF`; identity / order-2 / off-curve / torsion `H` refused |
| Copied ciphertext + validity proof under another nullifier | Mallory's own valid Semaphore proof + Frank's ciphertexts and validity proof -> `BAD_VALIDITY_PROOF`; Frank's proof verifies only for Frank's nullifier; Mallory can still vote honestly afterwards |
| Malformed proofs | 46 malformed submissions / proofs (truncated, non-numeric, hex, leading zeros, >= field, wrong protocol / curve, extra fields, z != 1, swapped / zero / reversed points, garbage top level) -> 36 `MALFORMED`, 4 `BAD_VALIDITY_PROOF`, 3 `BAD_MEMBERSHIP_PROOF`, 1 `NOT_A_MEMBER`, 1 `WRONG_CANDIDATE_COUNT`, 1 `UNKNOWN_CONSTITUENCY`; the box never throws and state is unchanged; the genuine ballot is then accepted |
| Same nullifier twice | sequential -> `NULLIFIER_USED`; three concurrent identical submissions -> exactly one accepted |
| Wrong kc / changed context / changed nullifier | proof-level: 16 statement mutations (kc 3->2/4/16, other chain / contract / election / constituency, nullifier + 1, changed ballotHash, changed C1/C2 coordinates incl. padded slots) all fail; **exhaustive: every one of the 73 public signals, changed one at a time, invalidates the proof** |

## BabyJubJub + Groth16 + Semaphore compatibility

**Nothing blocking.** Both proof systems use BN254 Groth16; BabyJubJub's base field is BN254's scalar field, so all curve arithmetic is native in both circuits. Verified empirically:

* `@zk-kit/baby-jubjub` (used by Semaphore V4), `circomlibjs` and circomlib's circuits agree on the generator `Base8`, the subgroup order, point addition, scalar multiplication and negation; JS ciphertexts satisfy the Circom constraints exactly (public signals and R1CS check).
* The JS Poseidon (`poseidon-lite`) equals circomlib's in-circuit Poseidon (the ballot hash computed in JS equals the circuit's `ballotHash` output).
* Semaphore's nullifier formula `Poseidon(keccak(scope) >> 8, secretScalar)` is replicated in `nullifierOf()` and asserted on every proof (the code fails loudly if a Semaphore release changes it).

Things to know (none required a parameter change):

1. **Semaphore transforms `message` and `scope`** (`keccak256 >> 8`) before they enter its circuit. The value to compare is the *original* `proof.message` against the recomputed `ballotHash`; Semaphore's own verifier recomputes the transformation, so tampering with `message` breaks the proof.
2. **Semaphore artifacts are per tree depth** (1..32); the group size picks the circuit the voter must load (depth 3 = up to 8 members here). `generateProof` downloads them from `snark-artifacts.pse.dev` unless paths are passed; we pass local files. Verification keys for all depths are embedded in the npm package, so verification is offline.
3. **`EscalarMulAny` (circomlib) assumes the base point is in the prime-order subgroup and not the identity.** The circuit only checks "on curve and x != 0"; the verifier must validate `H` once per election (`validatePublicKey`, tested with torsion points). The same note applies to any future in-circuit use of externally supplied points.
4. **snarkjs options footgun:** in 0.7.5 `singleThread` is an *object option* (`{ singleThread: true }`); passing `true` is silently ignored (we hit this).
5. **Groth16 re-randomisation:** a proof can be rewritten into a different valid proof for the same statement; the box therefore also rejects non-canonical encodings (z != 1, hex, leading zeros, extra fields) and uses the nullifier, never a proof hash, as ballot identity.
6. `@zk-kit/eddsa-poseidon` pulls `blake-hash`, which has an optional native install script (`node-gyp-build || exit 0`); the JS fallback works.
7. A fixed-size circuit means small constituencies pay the K = 16 price; compile K variants (4 / 8 / 16 / 32 / 64) if proving time matters.

## Verdict

**A. CORE PROTOTYPE PASSED.** Every requirement of the brief was implemented with the specified parameters (Semaphore V4, one group per constituency, election-wide scope, K_MAX = 16, BabyJubJub exponential ElGamal with fresh per-slot randomness, Groth16, ballot hash bound to context and exact ciphertexts, aggregate-only decryption). No parameter had to change.
The core is ready to be *designed into* the application, but it is **not** a finished voting system: see "Honest limitations" in `README.md` (single TEST key, test-only phase-2 setup, no threshold decryption / decryption proofs, no on-chain verifier, no browser measurements).
