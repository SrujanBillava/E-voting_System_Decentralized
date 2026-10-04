# Privacy V3 isolated core - results

Measured on: Intel Core i7-13650HX (20 logical cores), 14.8 GiB RAM, Linux 7.0.0-38, Node v24.20.0. Raw data: `bench.json`, `bench-single-thread.json`, `build-info.json`, `test-report.txt`.

## Versions (exact)

| Component | Version |
|---|---|
| circom compiler | 2.2.3 (release binary, `--O2`) |
| snarkjs | 0.7.5 (ffjavascript 0.2.63) |
| circomlib / circomlibjs | 2.0.5 / 0.1.7 |
| Semaphore V4 (`@semaphore-protocol/identity`, `group`, `proof`, `utils`) | 4.14.3 |
| Semaphore circuit artifacts (official; depth **20** = frozen architecture, depth 3 = fast tests) | `snark-artifacts.pse.dev/semaphore/4.13.0/`, the set `@semaphore-protocol/proof` 4.14.3 requests; SHA-256 pinned in `scripts/build-circuit.mjs` and `test/semaphore.depth20.test.mjs`, recorded in `build-info.json` |
| `@zk-kit/baby-jubjub` / `utils` / `artifacts` / `eddsa-poseidon` / `lean-imt` | 1.0.3 / 1.3.0 / 2.0.1 / 1.0.4 / 2.2.5 |
| poseidon-lite | 0.3.0 |
| ethers (keccak256 and ABI encoding only) | 6.13.4 |
| Powers of Tau | PSE Perpetual Powers of Tau, contribution 0080, `ppot_0080_18.ptau` (2^18, phase-2 prepared); sha256 `96932202...e711` |
| Node | v24.20.0 |

## Circuit (`circuits/ballot_validity.circom`, K = 16) - aligned with the frozen interface

| | Before the alignment pass | Now |
|---|---|---|
| Non-linear constraints | 54,590 | **49,136** (0 linear after `--O2`) |
| Wires | 54,563 | 49,105 |
| Public inputs / public outputs / private inputs | 72 / 1 / 32 | **68 / 0 / 32** (`m[16]`, `r[16]`) |
| Public signals in a proof | 73 | **68**: `[nullifier, kc, H.x, H.y, 16 slots x (C1.x, C1.y, C2.x, C2.y)]` |
| `zkey` (final) | 32.31 MiB | **25.45 MiB** (26,686,817 B) |
| `r1cs` / witness `wasm` / `verification_key.json` | 15.13 MiB / 2.33 MiB / 17 KiB | 10.30 MiB / 0.26 MiB / 16 KiB |
| Setup time (this machine) | compile 4.9 s, `zkey new` 26.6 s, contribute 2.9 s, verify 26.8 s | compile 4.1 s, `zkey new` 17.5 s, contribute 2.7 s, verify 18.3 s |
| Smallest sufficient Powers of Tau | 2^16 | 2^16 (the downloaded 2^18 file also covers K = 64) |

The 5,454 constraints removed are the 17 in-circuit Poseidon(5) hashes of the old ballot hash; the four context inputs and the `ballotHash` output are gone with them.

Cost scaling (compile only; same source, `BallotValidity(K)`): K=4 **12,284**, K=8 **24,566**, K=16 **49,136**, K=32 **98,290**, K=64 **196,628** constraints, i.e. about **3.07k constraints per candidate slot**.
The circuit has a fixed size: a constituency with 2 candidates costs the same to prove as one with 16.

`circom --inspect` reports only library-internal warnings (unused sub-component outputs such as `kcBits.out`, `LessThan.n2b.out`, the last-segment `dbl` of circomlib's scalar multipliers); nothing in the circuit's own logic is unconstrained, and the exhaustive public-signal test below confirms every one of the 68 public signals is bound.

## Timings (median of 5 warm iterations; `bench.json`) - Semaphore at the declared depth 20

Default snarkjs thread pool (20 workers), one process per kc:

| kc | JS encrypt (voter) | witness (WASM) | **validity prove** | validity prove (1st/cold) | **validity verify** | Semaphore prove (depth 20) | Semaphore verify | full `BallotBox.submit` | peak RSS |
|---|---|---|---|---|---|---|---|---|---|
| 2  |  70.7 ms | 338 ms | **1,216 ms** | 1,462 ms | **9.7 ms**  | 312 ms | 10.0 ms | 18.6 ms | 2,203 MiB |
| 8  | 282.0 ms | 339 ms | **1,224 ms** | 1,516 ms | **9.1 ms**  | 303 ms | 10.6 ms | 17.7 ms | 2,228 MiB |
| 16 | 568.8 ms | 339 ms | **1,246 ms** | 1,582 ms | **11.9 ms** | 297 ms |  8.6 ms | 18.8 ms | 2,233 MiB |

Without worker threads (`V3_SINGLE_THREAD=1`, median of 3 warm iterations; `bench-single-thread.json`) - a more honest stand-in for one browser worker or a small kiosk:

| kc | witness | **validity prove** | validity verify | Semaphore prove, depth 20 (1 thread) | peak RSS |
|---|---|---|---|---|---|
| 2  | 339 ms | **7,568 ms** | 10.9 ms | 1,749 ms | 872 MiB |
| 8  | 344 ms | **7,753 ms** | 11.1 ms | 1,759 ms | 837 MiB |
| 16 | 340 ms | **7,901 ms** | 12.5 ms | 1,762 ms | 829 MiB |

What changed against the previous pass (54,590 constraints, Semaphore at depth 3): validity proving **1.41-1.46 s -> 1.22-1.25 s** (single thread 8.7-8.9 s -> 7.6-7.9 s), witness 0.38 s -> 0.34 s, server-side submit check ~23 ms -> ~19 ms.
Semaphore proving at depth 20 is slower than the depth-3 demo: **~0.17 s -> ~0.30 s** (single thread 0.77 s -> 1.75 s), and the single-thread peak memory rose from ~0.68 GB to ~0.83-0.87 GB.

Notes: proving is ~9x parallel on this CPU. The JS encryption time grows with kc because it is BigInt scalar multiplication (~17 ms each, 2 per real slot); it is not a circuit cost.
A browser/WASM proof was **not** measured; expect several times the single-thread figure on a kiosk-class CPU.
Encrypt timings exclude the one-time election-key validation (one scalar multiplication, ~17 ms). Voter-side total at kc = 16, default pool: ~0.57 + 0.30 + 0.34 + 1.25 = **~2.5 s**; single thread: ~0.54 + 1.76 + 0.34 + 7.90 = **~10.5 s**. Server-side verification of a whole ballot: **~19 ms**.

Wire sizes (JSON): kc=2 **2,502 B**, kc=8 **4,503 B**, kc=16 **7,171 B** (ciphertexts 667 / 2,670 / 5,341 B; Semaphore proof ~1.03 KB; validity proof ~0.73 KB).
Per voter device the Semaphore depth-20 artifacts are 1.76 MiB (wasm) + 3.71 MiB (zkey) on top of the validity circuit's 0.26 MiB wasm + 25.45 MiB zkey.

On-chain verification was not implemented. Analytic estimate only (not measured): a Groth16 verifier with 68 public inputs is roughly 0.6 M gas for the validity proof alone (4-pairing check ~181k + ~6.2k per public input), plus a Semaphore depth-20 verification, plus calldata for 2-5 KB.

## Semaphore depth 20 (`test/semaphore.depth20.test.mjs`, plus every system test)

* **Proving and verifying work** at the declared depth 20 for a 5-member group (natural depth 3) and for a 1,200-member group (natural depth 11); the proof's root is the group's own root whatever the declared depth, and the full 256-bit keccak ballot hash is accepted as the message.
* **Nullifier behaviour unchanged**: the same identity and scope give the identical nullifier at depth 3 and depth 20, equal to `Poseidon(hash(scope), secret)`; it differs across identities and scopes and does not depend on the message.
* **A depth-20 proof is bound** to depth, message, scope, root and nullifier (changing any breaks verification), and the ballot box requires the declared depth (`WRONG_DEPTH` otherwise, in both directions).
* **Pinned local artifacts, no runtime download**: the files in `artifacts/semaphore` are SHA-256-checked against the pins (depth 20: wasm 1,847,949 B `6f71e555...`, zkey 3,890,175 B `33f9a067...`); every network entry point (`fetch`, `http(s).request/get`, `net`/`tls` connect) is trapped while proving and verifying at depth 20 and depth 3 and records **zero attempts**; the trap is shown to catch the Semaphore library's own downloader; a depth without local artifacts fails with "missing build artifacts" instead of downloading; `src/` never imports the downloader.

## Demo result (`npm run demo`)

5 fake Bengaluru voters (the group's natural depth is 3; every membership proof is generated at the declared depth 20). Votes A, B, A; a second ballot by the first voter is rejected `NULLIFIER_USED`.
Aggregate decrypted with the TEST key: **A = 2, B = 1, C = 0**. No individual ballot was decrypted. The scenario is fixed; the TEST key, ballot randomness and proofs are fresh from the OS CSPRNG on every run (there is deliberately no seed option).

Homomorphic test (`test/fast.elgamal.test.mjs`): `Enc([1,0,0]) + Enc([0,1,0]) + Enc([1,0,0])` -> **[2,1,0]**; 50 voters / 5 candidates match the expected counts; 4 constituencies (kc = 3, 4, 16, 3) tallied independently, sum of all totals == number of accepted ballots.

## Tests: 142 passed, 0 failed, 0 skipped (`npm test`, 96 s)

| Area | Tests |
|---|---|
| Parameters; the circuit has exactly the frozen interface and no hash / context / Poseidon (static check of the source) | 4 |
| Frozen keccak ballot hash: equals an independent hand-rolled encoding, two known-answer vectors, full 256-bit value, slot-major coordinates, binds every context field and all 64 coordinates | 5 |
| Validity statement: 68 public signals in the frozen order, circuit input layout | 1 |
| Election public key `H`: validation (off-curve, identity, all 7 non-identity torsion points of E[8], `H` + torsion, random curve points, malformed encodings) | 8 |
| Election public key `H`: enforced by the voter (`prepareBallot` / `castBallot`) and by the ballot box, for 6 invalid key classes, plus a valid-key control | 13 |
| RNG separation: no seed / RNG hook / test import / second entropy source in `src/` (static) | 5 |
| RNG separation: injected `random` / `seed` / `rng` / `entropy` options are ignored; CSPRNG sanity (behavioural) | 4 |
| BabyJubJub ElGamal, homomorphism, key validation (incl. torsion points), randomness, BSGS bound | 9 |
| Cross-check against an independent BabyJubJub implementation (circomlibjs) | 1 |
| Circuit, honest witnesses (kc = 1, 2, 3, 8, 15, 16; first and last slot; 68 public signals == JS; R1CS accepts; any nullifier value) | 13 |
| Circuit, invalid ballots unsatisfiable (each asserted to fail at the INTENDED constraint line) | 11 |
| Circuit, kc range (0, 17, 32, 100, p-1; wrong kc claims) | 7 |
| Circuit, ciphertext / key checks (modified coordinates, wrong message, wrong H, non-canonical padding, Enc(2), identity / order-2 / off-curve H, r = 2^251) | 10 |
| Direct tampering of an honest witness file is rejected by the R1CS itself (two-hot, zero-hot, value 5, padded-slot vote, ciphertext, nullifier) | 1 |
| Semaphore depth 20 with the pinned local artifacts (hashes, 5- and 1,200-member groups, nullifier invariance, binding, bad depths) | 6 |
| Semaphore proving / verifying never touch the network (trap + control, zero attempts, missing artifacts fail, no downloader in `src/`) | 4 |
| End to end at depth 20 with real Semaphore + Groth16 proofs and the ballot box (below) | 40 |

### Positive results (end to end)

* Semaphore proof (declared depth 20), validity proof and their binding all verify for the same ballot (`message == keccak ballotHash`, recomputed independently from the public data; same nullifier in both proofs; root == the constituency group's root; scope == election scope).
* Submission carries no identity / secret / randomness / plaintext vote (only `kc` ciphertexts + 2 proofs); box accepts it and consumes the nullifier.
* Bengaluru A, B, A -> [2,1,0]; Mumbai (kc=4), Delhi (kc=16, vote in the LAST slot), Chennai (kc=3, 5 voters) independent; empty constituency decrypts to zeros; wrong key cannot read the aggregate.

### Negative results (all rejected, state unchanged, nullifier not consumed unless stated)

| Required case | Result |
|---|---|
| Non-member identity | cannot generate a proof for the real group; a valid proof for its OWN group -> `NOT_A_MEMBER`; patching the root -> `BAD_MEMBERSHIP_PROOF`; other constituency's ballot relabelled -> `NOT_A_MEMBER`; other election / chain -> `WRONG_SCOPE` |
| Context binding (now through the keccak message, not the circuit) | a Semaphore proof signed over the ballot hash of another chain / contract / election (lowest bit only) / constituency, with the right scope and group -> `BALLOT_NOT_BOUND` (the correct hash is accepted); a ballot relabelled to another constituency that has the SAME group -> `BALLOT_NOT_BOUND` |
| Wrong Semaphore depth | depth-3 proof at the depth-20 box -> `WRONG_DEPTH`; depth-20 proof at a depth-3 box -> `WRONG_DEPTH`; a depth-3 proof is accepted by a box declared at depth 3; a group needing more than the declared depth is refused at construction |
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
| Wrong kc / changed nullifier / changed ciphertext | proof-level: 12 statement mutations (wrong `H`, kc 3->2/4/16, nullifier + 1 two ways, changed C1/C2 coordinates incl. padded slots) all fail; **exhaustive: every one of the 68 public signals, changed one at a time, invalidates the proof** (context mutations are covered at the box level above, since chain / contract / election / constituency are no longer circuit inputs) |

## BabyJubJub + Groth16 + Semaphore compatibility

**Nothing blocking.** Both proof systems use BN254 Groth16; BabyJubJub's base field is BN254's scalar field, so all curve arithmetic is native in both circuits. Verified empirically:

* `@zk-kit/baby-jubjub` (used by Semaphore V4), `circomlibjs` and circomlib's circuits agree on the generator `Base8`, the subgroup order, point addition, scalar multiplication and negation; JS ciphertexts satisfy the Circom constraints exactly (public signals and R1CS check).
* The JS Poseidon (`poseidon-lite`) used by `nullifierOf()` equals the nullifier Semaphore's own circuit outputs (asserted on every proof); the ballot hash no longer involves Poseidon at all.
* Semaphore's nullifier formula `Poseidon(keccak(scope) >> 8, secretScalar)` is replicated in `nullifierOf()` and asserted on every proof (the code fails loudly if a Semaphore release changes it).

Things to know (none required a parameter change):

1. **Semaphore transforms `message` and `scope`** (`keccak256 >> 8`) before they enter its circuit. The value to compare is the *original* `proof.message` against the recomputed keccak `ballotHash`; Semaphore's own verifier recomputes the transformation, so tampering with `message` breaks the proof. The keccak message is a full 256-bit value (most digests exceed the BN254 field modulus), so everything that carries it must treat it as a `uint256`, never as a field element.
2. **Semaphore artifacts are per tree depth** (1..32). With a declared depth of 20 (capacity 2^20 members) every voter loads the depth-20 circuit (1.76 MiB wasm + 3.71 MiB zkey) regardless of the constituency's size; a smaller group simply pads its Merkle path. `generateProof` downloads artifacts from `snark-artifacts.pse.dev` unless paths are passed, and `@semaphore-protocol/proof` 4.14.3 asks for artifact set 4.13.0; we pass pinned local files and block any fallback. Verification keys for all depths are embedded in the npm package, so verification is offline.
3. **`EscalarMulAny` (circomlib) assumes the base point is in the prime-order subgroup and not the identity.** The circuit only checks "on curve and x != 0"; the verifier must validate `H` once per election (`validatePublicKey`, tested with torsion points). The same note applies to any future in-circuit use of externally supplied points.
4. **snarkjs options footgun:** in 0.7.5 `singleThread` is an *object option* (`{ singleThread: true }`); passing `true` is silently ignored (we hit this).
5. **Groth16 re-randomisation:** a proof can be rewritten into a different valid proof for the same statement; the box therefore also rejects non-canonical encodings (z != 1, hex, leading zeros, extra fields) and uses the nullifier, never a proof hash, as ballot identity.
6. `@zk-kit/eddsa-poseidon` pulls `blake-hash`, which has an optional native install script (`node-gyp-build || exit 0`); the JS fallback works.
7. A fixed-size circuit means small constituencies pay the K = 16 price; compile K variants (4 / 8 / 16 / 32 / 64) if proving time matters.
8. **Scope derivation still differs from the frozen text** (Poseidon over `electionId >> 8`, frozen: keccak). The `>> 8` means election ids that differ only in their lowest 8 bits share a scope; the keccak ballot hash still separates them (tested). See `README.md`, "Known differences".

## Verdict

**A. CORE PROTOTYPE PASSED, and aligned with the frozen architecture on the three points of this pass:** keccak ballot hash outside the circuit, the 68-signal validity interface, Semaphore at depth 20 with pinned local artifacts.
One known difference remains by instruction: the Semaphore scope derivation (Poseidon instead of keccak). The core is ready to be *designed into* the application, but it is **not** a finished voting system: see "Honest limitations" in `README.md`
(single TEST key, test-only phase-2 setup, no threshold decryption / decryption proofs, no on-chain verifier, no browser measurements).
