# Biometrics handoff: `AUTHENTICATED -> FACE_VERIFIED`

## Project base
This checkpoint (tag `v2-step6-base`) is the canonical **pre-biometric V2 base**. Branch from it:
`git switch feature/biometrics` (already created at the tag). **Push to `feature/biometrics`; do NOT merge it into `main`.**
The main developer continues the voting pipeline on `feature/voting-core` in parallel.

## Your responsibility (only this)
Implement the single stage transition **`AUTHENTICATED -> FACE_VERIFIED`**, plus admin face enrolment that feeds it.

## Do NOT modify
Eligibility, ballot, EIP-712 vote authorization, relayer, `castVote`, receipts, results, smart-contract semantics
(`smart-contract/` is frozen), or the admin auth / election-control architecture.

## Current stage machine (already built: `backend-api/src/auth/voterStages.js`)
`AUTHENTICATED -> FACE_VERIFIED -> ELIGIBLE -> AUTH_ISSUED -> SUBMITTED -> COMPLETED`
Use `authService.transitionStage({ sessionId, from: AUTHENTICATED, to: FACE_VERIFIED, expiresAt })`: an atomic compare-and-set
(exactly one concurrent caller wins). Gate your routes with `requireVoterSession` + `requireVoterStage("AUTHENTICATED")`.
Passive polling (`/status`) deliberately does not extend the idle timer; your meaningful endpoints use the default `touch: true`.
`stageExpiresAt` is already enforced centrally in `authenticate()`.

## Requirements
- Browser generates the face descriptor with `@vladmandic/human` (client side, later). **The server owns the verification decision.**
- Enrolment (admin only, Setup phase): store **3-5 sample descriptors** per voter as an encrypted `FaceTemplate`; set `Voter.faceEnrolled = true`.
- Encryption: **AES-256-GCM** (reuse `src/auth/secretBox.js`, bind ciphertext to the voter id via AAD) with a **separate** `FACE_TEMPLATE_ENCRYPTION_KEY`
  (new env var in `src/config/env.js`; must differ from every other secret; add to `.env.example` and `init-local-env.js`).
- Descriptor dimension is configured in **one central constant** (validate length, finite numbers, sane range).
- **Face challenge**: server-issued, bound to the session, **single-use, expiring** (about 30 s).
- **Server-side descriptor comparison** against the decrypted template; the threshold is **provisional and tunable** (config constant), tuned later on real data.
- **Max 3 failed attempts per session**, then the session is locked for this step (audited).
- Success: atomic transition `AUTHENTICATED -> FACE_VERIFIED` with a **FACE_VERIFIED TTL of about 3 minutes** (set `stageExpiresAt`; set `faceMethod` on the session).
- Voters with `faceEnrolled = false` must be rejected at this step with a clear error code.
- **No raw images** anywhere. **No plaintext descriptor storage.** **No biometric request bodies in logs** (the logger already redacts keys named `descriptor`; keep it that way and add a test).

## Honest limitation (state it in code comments and the API docs)
Browser-side liveness is **advisory** and cannot be independently trusted by the server: a modified client can submit any descriptor.
Describe this feature as **supervised face matching**, not cryptographic proof of liveness. The real control is a supervised booth.

## Parallel work: keep shared-file changes minimal
Likely **isolated additions** (new files): `src/biometrics/*` (matching, constants), `src/models/FaceTemplate.js`, `src/models/FaceChallenge.js`
(or fields on the session), `src/services/face.service.js`, `src/routes/face.routes.js`, tests under `test/chain/` or `test/integration/`.
**Shared files: minimal wiring only** (a few lines each): `src/app.js` (mount router), `src/server.js` (construct service),
`src/config/env.js` + `.env.example` + `scripts/init-local-env.js` (one new key), `src/services/audit.service.js` (allow extra safe metadata keys),
`src/routes/voter.routes.js` (only if you must). Do not reformat or refactor these.

## Tests expected
Encryption round trip and tamper detection (wrong AAD / key); enrolment (3-5 samples, admin-only, Setup-only, dimension validation);
challenge (single-use, expiry, session-bound); comparison (match, mismatch, threshold edge); attempt limit (3) and lockout; concurrency
(parallel verifies yield one transition); stage transition + TTL; privacy (no descriptors, templates, keys or challenges in responses, logs or audit rows).

## Local setup
```
cd backend-api && npm ci && npm run init:env      # then edit .env if needed
cd ../smart-contract && npm ci && npm run node    # terminal 1
cd smart-contract && npm run deploy:local          # terminal 2 (leaves the election in Setup)
cd backend-api && npm test                         # offline tests
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/evoting-test npm run test:integration && npm run test:chain   # need a disposable MongoDB
```
Chain tests open the election only inside snapshots; `npm run verify:local` in `smart-contract/` must still pass afterwards.
