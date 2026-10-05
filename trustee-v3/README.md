# VoteChain V3 trustee toolkit

An isolated toolkit that proves the frozen V3 threshold architecture works: a **dealer-less 2-of-3 distributed key generation**, **verifiable partial
decryption** with Chaum-Pedersen proofs, **2-of-3 combination**, and **bounded integer tally recovery** over BabyJubJub, written in TypeScript (erasable
syntax, run natively by Node 22.18+, no build step).

Status: prototype. The toolkit is integrated with `VoteChainV3` for **tallying** (see "Tallying against VoteChainV3" below: chain-derived aggregate, anchored
partial decryptions, off-chain audit, two-trustee endorsement); it is **not** connected to the backend, the frontend or the relayer. V2 and `privacy-v3/` are untouched.

* No single full decryption secret ever exists. Any two trustees decrypt the encrypted **aggregate**; one alone cannot.
* The workflow is **aggregate-only**: there is no function that decrypts an individual ballot.
* Every failure aborts the ceremony (no complaint or recovery round): it restarts with fresh randomness.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | the public workflow API (the only entry point exported by `package.json`) |
| `src/params.ts`, `scalar.ts`, `point.ts` | the frozen curve, scalar arithmetic mod l, strict point validation |
| `src/schnorr.ts`, `chaum-pedersen.ts`, `proof.ts` | the two Fiat-Shamir proofs, compact `(e, z)` form |
| `src/lagrange.ts` | Lagrange coefficients at 0 mod l (applied to curve points only) |
| `src/transport.ts` | encrypted share transport (libsodium `crypto_box`, X25519) |
| `src/ceremony.ts` | the public side of the ceremony: message parsing, transcript, hash, canonical JSON, verifier, confirmations |
| `src/trustee.ts` | one trustee: its secrets live in `#private` fields; the ceremony state machine; partial decryption; encrypted export and restore |
| `src/aggregate.ts`, `threshold.ts`, `bsgs.ts` | the aggregate-only ciphertext type; verify and combine partial decryptions; baby-step giant-step |
| `src/chain-aggregate.ts` | `verifyChainAggregate`: rebuilds a constituency's aggregate from the COMPLETE `BallotRecorded` log, compares it with the contract, and mints the branded `VerifiedAggregate` |
| `src/bundle.ts`, `results.ts` | the frozen publication-bundle (64 words) and results (16 totals) encodings and hashes, byte-identical to `V3Encodings.sol` |
| `src/audit.ts` | the off-chain auditor: pinned-transcript check, proof verification of every published bundle, 2-of-3 combination, BSGS, the final-result check |
| `chain/index.ts` | the duck-typed `VoteChainV3` adapter (`./chain` export): read the log/state, publish ONE trustee's partial, endorse an audited result |
| `src/storage.ts` | encrypted-at-rest share files (Argon2id + XChaCha20-Poly1305) |
| `testing/` | test and demo support only (never imported by `src/`): ceremony harness, scripted dishonest trustee, RNG spy, torsion points, privacy-v3 adapter |
| `scripts/demo.ts`, `bench-bsgs.ts`, `make-vectors.ts`, `make-integration-vectors.ts` | the election demo, the BSGS benchmark, the known-answer vector generators |
| `spec/vectors.json`, `spec/integration-vectors.json` | frozen known-answer vectors for every encoding (checked in `test/vectors.test.ts`, `test/tally-encodings.test.ts`; the second file is also loaded by the Solidity tests) |
| `results/` | `bsgs-benchmark.json`, `demo-run.json` (public output of one demo run) |
| `demo/` | scratch space for `--store`; everything in it except its README is git-ignored |

## Libraries (exact versions, pinned)

`@zk-kit/baby-jubjub` 1.0.3 (the **same reviewed BabyJubJub implementation** privacy-v3 uses), `libsodium-wrappers-sumo` 0.8.4 (libsodium 1.0.22: X25519
`crypto_box`, Argon2id, XChaCha20-Poly1305; the standard build has no Argon2id), `@noble/hashes` 2.4.0 (keccak-256 for every protocol hash; SHA-256 appears only in the vector generator, as a convenience fingerprint of the canonical transcript JSON text). Development only: `typescript`
5.8.3, `@types/node` 24.10.1, `ethers` 6.17.0 (tests only: independent recomputation of the encodings, hashes and challenges; it never runs in the toolkit). Node 22.18 or newer.

## Parameters

* `G` = circomlib Base8, identity `O = (0, 1)`, subgroup order
  `l = 2736030358979909402780800718157159386076813972158567259200215660948447373041`. A test pins all of them to privacy-v3's own constants.
* **All scalars are mod l**: secrets, coefficients, shares, Lagrange coefficients, nonces, challenges, responses. The BN254 field prime `p` appears only in
  `point.ts`, as the modulus of point *coordinates*. `mul(point, k)` refuses a `k` that is not already reduced mod l, so a wrong-modulus bug throws instead of
  silently computing garbage. The only entropy source for scalars is `node:crypto` `randomBytes` (384 bits reduced mod l-1, plus 1: uniform in `[1, l-1]`, bias about 2^-133),
  with no seed, option or hook to replace it.
* 3 trustees, threshold 2. The code is generic in `(n, t)` with `2 <= t <= n <= 9` (a 3-of-5 ceremony is tested); the transcript pins them. `t = 1` is refused.

## The DKG (Feldman verifiable secret sharing, no dealer)

1. **Round 0.** Trustee `i` generates a fresh temporary X25519 transport key pair and announces the public half.
   `ceremonyId = keccak256(abi.encode(CEREMONY_TAG, chainId, contract, electionId, n, t, key_1 .. key_n))` binds everything below to this election and these keys.
2. **Round 1.** Trustee `i` samples `f_i(x) = a_i0 + a_i1*x` from the OS CSPRNG and publishes `K_i0 = a_i0*G`, `K_i1 = a_i1*G` with a **Schnorr proof of knowledge of every coefficient**.
3. **Round 2.** Trustee `i` sends `f_i(j)` to every other trustee `j`, encrypted and authenticated. Its coefficients are dropped immediately.
4. **Round 3.** Trustee `j` checks `f_i(j)*G == K_i0 + j*K_i1` for every sender (any failure aborts), computes `s_j = sum_i f_i(j) mod l`, and checks `s_j*G == vk_j`
   where `vk_j = sum_i (K_i0 + j*K_i1)` comes from the public commitments alone.
5. **Result.** `H = K_10 + K_20 + K_30`, and `vk_1, vk_2, vk_3`. Every `t`-subset of verification keys must interpolate to `H` (all three pairs for 2-of-3); this is checked by every
   trustee and by every verifier of the transcript.
6. **Confirmation.** Each trustee independently re-verifies the assembled transcript and compares it with its own view of the ceremony (what it was sent, what it saw), then returns
   `{index, transcriptHash, verificationKey}`. The ceremony is complete only when **all** trustees confirmed the same hash (`confirmCeremony`).

**The full secret `s = a_10 + a_20 + a_30` is never computed.** No code interpolates secret scalars (a test scans for it); shares are only ever summed by the trustee they are addressed to; Lagrange
coefficients are applied to curve points only. A test acts as an omniscient observer (it records every byte drawn from the CSPRNG): it finds that `s` was never drawn, equals no share, and
that no public output contains it, a coefficient, a nonce or a share in any spelling. The same test shows the ceremony's output is exactly what the polynomial definition prescribes
(`H = s*G`, `vk_j = s_j*G`, any two shares interpolate to `s`), and that each trustee's partial decryption really uses `s_j`.

### Schnorr proof of knowledge

`R = u*G`, `e = H(DKG_TAG, chainId, contract, electionId, ceremonyId, trusteeIndex, coefficientIndex, K, R)` with `H(x) = uint256(keccak256(abi.encode(x))) mod l`, `z = u + e*a`; the proof is `(e, z)` and the verifier recomputes `R' = z*G - e*K`. It stops rogue-key attacks
(publishing `K' - K_1 - K_2` to force `H = K'`). Replaying it into another election, ceremony, trustee slot or coefficient slot fails because every one of those is in the challenge.

### Strict validation (everywhere a value crosses a trust boundary)

Points: canonical coordinates `< p`, on the curve, in the **prime-order subgroup** (`l*P = O`; the curve has cofactor 8, so torsion components are refused), and not the identity. Scalars (`e`, `z`, shares): reduced mod l
(`z + l` is a second spelling of a valid proof and is refused), proofs also non-zero. Hex: exactly `0x` + lowercase digits of the exact length. Messages: exact field sets, no extras.

### Share transport

libsodium `crypto_box` (X25519, XSalsa20-Poly1305), `nonce(24) || box(plaintext)` with `plaintext = "V3-SHARE" || ceremonyId || from || to || share` (74 bytes, 114 sealed). The box authenticates the **sender** (it needs the sender's transport secret) and
the recipient's key; the header inside binds ceremony, sender and recipient (no replay into another ceremony, no reflection, no delivery to the wrong trustee). Transport private keys exist only for the ceremony and are wiped after `receive`.
The share's *correctness* is checked separately against the sender's public commitments.

## Threshold decryption of the aggregate

* Trustee `i`, per candidate slot, from the aggregate half `A`: `D_i = s_i*A`, with a **Chaum-Pedersen proof** that `log_G(vk_i) == log_A(D_i)`: nonce `u`, `a = u*G`, `b = u*A`,
  `e = H(PDEC_TAG, chainId, contract, electionId, constituency, slot, trusteeIndex, vk_i, A, D_i, a, b)` with the same `H(x) = uint256(keccak256(abi.encode(x))) mod l`, `z = u + e*s_i`; the verifier recomputes `a' = z*G - e*vk_i`, `b' = z*A - e*D_i`.
* Any two trustees `a, b`: `S = lambda_a*D_a + lambda_b*D_b`, `M = B - S = t*G`, then `t` by baby-step giant-step in `[0, ballotCount]`. Pairs `(1,2)`, `(1,3)`, `(2,3)` give **identical** points
  (tested on 18 random aggregates over 6 independent ceremonies, plus the 7/4/2 election).
* `tallyAggregate` verifies **every** supplied partial decryption (proofs, constituency, slot layout, distinct trustees), refuses fewer than `t`, re-checks `t*G == M`, and checks that the totals add up to the ballot count
  (every valid ballot is one-hot, so they must). A lying ballot count, a tampered `B`, a wrong key and a non-one-hot total are all caught.

### Aggregate-only by construction

The only ciphertext type any workflow function accepts is `AggregateCiphertext`: per-slot sums for a whole constituency with the ballot count, creatable only through `create` (per-slot sums) or `fromBallotLog` (recomputed from the public
`BallotRecorded` log, the way an independent trustee does it). A `Trustee` refuses an aggregate of fewer than `minBallots` ballots (default **2**: a one-ballot "aggregate" *is* an individual ballot) and an aggregate of another election context. Tests inspect the exported API
(an exact list), the prototype's methods, every function name containing "decrypt", and the package `exports` (low-level primitives cannot be deep-imported). **Residual risk, by nature of threshold ElGamal:** a trustee cannot tell a genuine aggregate from a single ballot
presented with a false `ballotCount`. The defence is not the `minBallots` guard but the integrated path below: a trustee decrypts only a `VerifiedAggregate`, which exists only after the aggregate was **recomputed from the complete on-chain ballot log** and compared with the contract's.

An empty aggregate (zero ballots: the identity in every slot, exactly the contract's initial state) tallies to zeros without any trustee.

## Tallying against VoteChainV3

After the election is **Closed** (all of this is public data; nothing here needs a secret except step 3):

1. **Pinned configuration.** In Setup the contract owner pins the DKG transcript hash, the three trustee addresses, `vk_1..vk_3` and `H` (exactly `n = 3`, `t = 2`; immutable once the election is Open; `openElection` fails without it). Every trustee and auditor re-derives the transcript hash from the published transcript, checks `{n: 3, t: 2}`, and that its `H` and `vk_i` equal the pinned ones (`verifyPinnedTranscript`).
2. **Chain-derived aggregate** (`verifyChainAggregate`). The adapter reads the election's COMPLETE `BallotRecorded` log, checks indices `1..N` (a missing, duplicated or reordered event is refused), rebuilds the constituency's aggregate locally by point addition, and compares **every active A/B slot and the ballot count** with the contract. Any mismatch refuses. Only the resulting `VerifiedAggregate` (a branded type that cannot be constructed or forged outside that function) is accepted by `Trustee.partialDecryptVerified`; an aggregate handed in by any other component is refused. A constituency with exactly **one** valid ballot is therefore tallyable (the log check, not `minBallots`, is the guard); an empty one has nothing to decrypt (all zeros).
3. **Publication.** Each trustee decrypts the verified aggregate (the existing Chaum-Pedersen proofs, unchanged) and publishes a **bundle**: `PDEC_BUNDLE_TAG = keccak256("VOTECHAIN-V3-PDEC-BUNDLE-1")`; 16 slots x `(D.x, D.y, e, z)` = 64 words, padded slots all zero. The contract computes the bundle hash itself (`keccak256(abi.encode(tag, chainId, contract, electionId, transcriptHash, trusteeIndex, constituencyId, ballotCount, K_c, words[64]))`), stores only that hash, and emits the active words. Only the trustee pinned for that index may publish, once per constituency, never replaced. The proofs are **not** verified on-chain (shape only: canonical on-curve `D`, `0 < e, z < l`, canonical padding).
4. **Audit** (`auditConstituency` / `auditFromChain`, no secret needed): pinned transcript, aggregate rebuilt from all events, publications read, bundle hashes recomputed and compared with the stored ones, **every Chaum-Pedersen proof verified off-chain**, duplicate trustee indices refused, at least two valid trustees required, points combined with the existing Lagrange code, totals by BSGS, `t*G` re-checked, bounds checked, `sum == ballotCount`. The full secret `s` is never reconstructed (the integration modules cannot even do scalar arithmetic).
5. **Endorsement and finalization.** A trustee that published endorses the totals it audited (`RESULTS_TAG = keccak256("VOTECHAIN-V3-RESULTS-1")`; `uint256[16]` zero-padded; the contract hashes tag, chainId, contract, electionId, transcriptHash, constituency, ballotCount, K_c, totals itself). Totals must be exactly `K_c` values, each `<=` the ballot count, summing to the ballot count. **Two distinct trustees endorsing the same hash finalize the constituency**, immutably; there is no tie-break, no replacement, no second endorsement. Finalized totals are readable (`finalResult`) only after finalization.

**Accepted prototype limitation.** The contract cannot verify proofs, so **two malicious trustees can still endorse (and thereby finalize) a false result.** This is accepted for the prototype because the public auditor can independently verify their published partials and the decrypted aggregate: `verifyFinalResult` / `readVerifiedFinalResult` raise `FINAL_RESULT_MISMATCH` for a finalized result that differs from the audited one (demonstrated in `smart-contract-v3/test/tally.test.js`).

**Process separation.** A trustee's whole input is ONE encrypted share file + the public transcript + public chain data (`publishFromShareFile`, which calls `Trustee.restore` once); there is no function that takes several share files or several trustees. In production run **one OS process on one machine per trustee**, each with its own signer; the auditor needs no secret. The tests hold several trustees in one process for convenience only.

## Transcript (public, canonical, pinnable)

```
{ version, context{chainId, contractAddress, electionId}, threshold, trustees, ceremonyId,
  participants[{index, transportPublicKey, commitments[2 points], proofs[2 {e,z}]}], electionPublicKey, verificationKeys[3], transcriptHash }
```

Only public data: no coefficient, share, nonce or private transport key. `serializeTranscript` is canonical (fixed key order, no whitespace, one hex form); `deserializeTranscript` refuses any other spelling.
`transcriptHash = keccak256(abi.encode(TRANSCRIPT_TAG, chainId, contract, electionId, n, t, ceremonyId, per trustee: index, transportKey, K_0.x, K_0.y, K_1.x, K_1.y, e_0, z_0, e_1, z_1, then H.x, H.y, then vk_j.x, vk_j.y))`:
all static 32-byte words (`7 + n*(2 + 4t) + 2 + 2n` of them: 45 for the 2-of-3 ceremony), so a contract can recompute or pin it. `verifyTranscript` re-derives everything (ceremony id, every proof, `H`, every `vk`, pair consistency, the hash) and compares; changing **any one field** by the smallest amount fails it.
`spec/vectors.json` freezes the tags, the Lagrange coefficients, the ceremony id, a Schnorr proof, a Chaum-Pedersen proof (each with its exact preimage and raw hash) and a complete transcript; the tests check each against an independent ethers recomputation, and a drift test fails if the file is not exactly what `scripts/make-vectors.ts` emits.

Tags (bytes32 = keccak256 of the label): `CEREMONY_TAG` "VOTECHAIN-V3-DKG-CEREMONY-1", `DKG_TAG` "VOTECHAIN-V3-DKG-1" (Schnorr), `TRANSCRIPT_TAG` "VOTECHAIN-V3-DKG-TRANSCRIPT-1", `PDEC_TAG` "VOTECHAIN-V3-PDEC-1".
**One hash family, keccak-256, over static `abi.encode` words (EVM-native: a contract can recompute any of them).** The Fiat-Shamir challenges are `e = uint256(keccak256(preimage)) mod l`, with the preimages listed above, tag first (11 words for the Schnorr proof, 17 for Chaum-Pedersen); the ceremony id and the transcript hash are plain keccak-256. Reducing a 256-bit hash mod the 251-bit l is not exactly uniform (2^256 / l is about 42.3, so about a third of the residues are 43/42 times as likely as the rest); for a Fiat-Shamir challenge that costs about 0.02 bits of min-entropy (the likeliest challenge has probability 43/2^256, about 2^-250.57, against 2^-250.60 for a uniform one), so soundness is unaffected. `spec/vectors.json` records each preimage and the raw 256-bit hash before the reduction.
The election context is the **placeholder** `TEST_CONTEXT` (privacy-v3's test constants) until the real contract address and election id are pinned.

## Storage at rest

One trustee's share only, in its own directory (`demo/trustee-1/`, `-2/`, `-3/`), never all three in one file. `key = Argon2id(password, random 16-byte salt)` (libsodium `crypto_pwhash`, `ALG_ARGON2ID13`, 32 bytes);
`ciphertext = XChaCha20-Poly1305-IETF(share, 24-byte random nonce, associated data = the canonical JSON of the whole header)`. **Default cost: MODERATE = 3 passes, 256 MiB** (about half a second here); SENSITIVE (4 passes, 1 GiB) is available.
The header (cost parameters, salt, nonce, index, verification key, transcript hash, context) is authenticated; a file below the floor is refused before any key derivation (downgrade) and absurd costs are refused too (memory exhaustion). A wrong password and any tampering fail identically.
Passwords are 12 to 1024 characters, NFKC-normalised, and **never hard-coded**: they come from the caller (`TRUSTEE_V3_PASSWORD_1..3` in the demo). Files are written `0600` in a `0700` directory and never overwritten. `Trustee.restore` rebuilds a finalized trustee from the file and the public transcript
(and checks `s*G == vk`). Share files are git-ignored (`demo/*`, `trustee-*/`, `*.share.json`, `*.pem`, `*.key`, `.env*`), and a test walks the workspace for unignored key-like files.

## Running

```bash
npm ci
npm run typecheck          # tsc --noEmit, strict
npm test                   # the whole suite (about 3 minutes; some files run in parallel)
npm run demo               # the 7/4/2 election, in memory
TRUSTEE_V3_PASSWORD_1=... TRUSTEE_V3_PASSWORD_2=... TRUSTEE_V3_PASSWORD_3=... node scripts/demo.ts --store demo --out results/demo-run.json
npm run bench:bsgs         # add -- --extended for 10^7 and 10^8
npm run vectors            # regenerate spec/vectors.json and spec/integration-vectors.json (npm run vectors:check fails on drift instead of writing)
```

The privacy-v3 core is used by tests and the demo only, through one adapter (`testing/pv3.ts`); run `npm ci` in `../privacy-v3` first. `src/` never imports it.

## Measured on this machine (pure JavaScript, one thread)

* Whole ceremony (3 trustees in one process, everything verified by everyone): about 2.2 s. One partial decryption: about 0.12 s per candidate slot per trustee. Verifying one Chaum-Pedersen proof: about 55 ms. (A BabyJubJub scalar multiplication costs about 13 ms in this library.)
* BSGS (`results/bsgs-benchmark.json`, medians; the table is built once per bound and reused across slots):

| ballots | baby steps | table build | solve, worst case (t = bound) | solve, random t |
|---|---|---|---|---|
| 100 | 11 | 0.6 ms | 0.4 ms | 0.14 ms |
| 1,000 | 32 | 1.2 ms | 1.1 ms | 0.7 ms |
| 10,000 | 101 | 3.7 ms | 3.6 ms | 1.8 ms |
| 100,000 | 317 | 11.5 ms | 11.4 ms | 5.2 ms |
| 1,000,000 | 1,001 | 36.9 ms | 35.8 ms | 17.8 ms |
| 10,000,000 | 3,163 | 116 ms | 113 ms | 54.5 ms |
| 100,000,000 | 10,001 | 363 ms | 360 ms | 183 ms |

A constituency holds at most 2^20 = 1,048,576 ballots (a depth-20 Semaphore group), so tally recovery is never the bottleneck: the Chaum-Pedersen proofs dominate.

## Limits and decisions (read before relying on this)

* **JavaScript is not constant-time and cannot erase memory.** BabyJubJub arithmetic and `BigInt` operations are variable-time, and a secret `BigInt` cannot be zeroed after use (references are dropped; the transport secret key and plaintext buffers *are* zeroed). A hardened implementation would be needed against a local side-channel or memory-scraping adversary on a trustee machine.
* **Feldman VSS has a known (benign for ElGamal voting) bias:** a trustee that publishes last could influence the distribution of `H` by aborting. The proofs of knowledge stop rogue keys; no commit-then-reveal round was added (not in the frozen design). **No robustness:** one dishonest trustee can force a restart, never a wrong key.
* **Sender authentication of shares** comes from the transport keys announced in round 0 (authenticated `crypto_box`); `crypto_box` is deniable, which is irrelevant here because every share is checked against public commitments. The announcements themselves must reach all trustees over an authentic channel (an equivocating announcer is caught as a ceremony-id mismatch and aborts everything).
* **File permissions:** `0600` cannot be enforced on every filesystem. The repository's own drive reports `777` for everything, so the demo prints a warning; the files are encrypted anyway, but real shares belong on a filesystem that honours permissions.
* The minimum-ballots guard (default 2) is an addition to the frozen design and applies to the low-level `partialDecrypt` only; it is hygiene, not the security boundary (the chain-log verification is). The integrated path accepts a verified single ballot.
* Subgroup membership of `H` and `vk_i` is a **ceremony duty** (the verified transcript guarantees it); the contract checks only that they are on the curve, non-identity and mutually consistent (`H = 2 vk_1 - vk_2`, `vk_3 = 2 vk_2 - vk_1`, `vk_1 != vk_2`), with point additions, never a scalar multiplication.
* **Chain reads.** The adapter asks for the whole `BallotRecorded` log in one `queryFilter` and reads the contract state in separate calls. A node that truncates the range, or a reorg between the reads, makes the checks fail (log length `!=` `totalBallots`, aggregate mismatch): the failure mode is a refusal, never a wrong aggregate. A hosted RPC with a block-range cap would need chunked reads (not implemented), and trustees should wait for finality before acting.
* The trustee protocol is simulated in one process with JSON-cloned messages (so no object reference can carry a secret between trustees); a networked deployment needs an authenticated bulletin board.

## Tests

`npm test` runs every file under `test/`: parameters and curve constants against privacy-v3; scalar, point, encoding and Lagrange primitives; the Schnorr and Chaum-Pedersen proofs (honest, independent challenge check, every forgery, replay, torsion, identity, zero and wrong-modulus case);
share transport; the DKG (oracle, leakage, state machine, 12 random ceremonies, 3-of-5); every abort scenario (malformed commitments, invalid proofs, rogue key, corrupt, misdelivered and inconsistent shares, a dishonest dealer, equivocation, missing, duplicate and invalid trustees,
tampered transcripts and hashes, keys from another ceremony, decryption before completion); transcripts; threshold decryption (6 ceremonies x 3 random aggregates x every pair, one trustee alone, duplicates, every tampering, aggregate-only, edge cases); BSGS; encrypted storage and restore;
hygiene (entropy, modulus, logging, secrets); API inspection; privacy-v3 interoperability; the demo script; known-answer vectors; and for the tallying integration `tally-encodings` (tags, 73-word bundle and 24-word results hashes against independent `abi.encode`, every field bound, drift check) and
`tally-integration` (every trustee pair; a missing, duplicated, reordered, re-indexed or modified log event; the fake-aggregate attack; every tampered, mismatched or malformed publication; one valid trustee, duplicate trustees, mixed transcripts, out-of-bound and non-summing results; process separation; no secret arithmetic).
The contract side of the same flow, with real Semaphore and Groth16 proofs on a Hardhat chain, is `smart-contract-v3/test/trustees.test.js` and `tally.test.js`.
