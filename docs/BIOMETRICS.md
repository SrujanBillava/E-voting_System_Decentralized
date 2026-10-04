# Biometrics: face verification (`AUTHENTICATED -> FACE_VERIFIED`)

Built on `feature/biometrics` to the brief in `docs/BIOMETRICS_HANDOFF.md`. This file describes what exists, how to
use it, and what it does not prove.

**Status.** Backend and frontend are integrated on `feature/voting-core`: the browser flow (voter camera check and admin
enrolment) is in `frontend/src/features/face/`, the server decides everything (`AUTHENTICATED -> FACE_VERIFIED` is only ever
performed by the backend). **A real-webcam manual test is still required** (see "Frontend" below): all automated browser
tests use Chrome's fake camera and a test-only engine.

## What it does

1. **Enrolment (admin, Setup phase only).** The admin console captures 3 to 5 samples of a voter's face. The browser
   turns each one into a descriptor (512 numbers) and sends only those numbers. The server checks them, encrypts them
   as one template, and sets `Voter.faceEnrolled = true`.
2. **Verification (voter, election Open, session stage `AUTHENTICATED`).** The kiosk asks the server for a challenge,
   captures the voter's face, and submits the descriptor with the challenge. **The server decides**: it decrypts the
   voter's template and compares. On a match it moves the session to `FACE_VERIFIED` for 3 minutes.

No image ever leaves the browser, and no image or plaintext descriptor is ever stored.

## Honest limitation

The browser computes the descriptor, so the server only sees numbers. A modified client can submit any descriptor it
likes, and the liveness prompt runs in the browser where the server cannot check it. This is **supervised face
matching**, not cryptographic proof that a live person is present. The real control is a polling booth with an
officer watching the screen. The same note is in `backend-api/src/biometrics/constants.js`.

## API

All paths are under `/api/v1`. Errors use the usual envelope `{ error: { code, message, requestId } }`.

### Voter (session cookie; stage must be `AUTHENTICATED`)

| Method and path | Body | Success |
|---|---|---|
| `GET /voter/face/status` | none | `{ enrolled, verified, attemptsLeft, locked }`. Passive: does not extend the idle timer. Works in any stage. |
| `POST /voter/face/challenge` | none | `{ challenge, action, expiresAt, attemptsLeft }` |
| `POST /voter/face/verify` | `{ challenge, descriptor, liveness? }` | `{ stage: "FACE_VERIFIED", stageExpiresAt }` |

* `challenge` is random, bound to the session, valid for 30 seconds and usable once. Asking for a new one cancels the
  previous one. `action` (`BLINK`, `TURN_LEFT` or `TURN_RIGHT`) is what the browser asks the voter to do first.
* `descriptor` is an array of exactly 512 finite numbers. Any scale is accepted; the server normalises it.
* `liveness` is optional: `{ passed: boolean, real?: 0..1, live?: 0..1 }`. It is the browser's own report, so it can
  only refuse: `passed: false` is rejected before any comparison, and `passed: true` is just written to the audit row.

| Status | Code | Meaning |
|---|---|---|
| 403 | `FACE_MISMATCH` | Compared and refused. `error.details = { attemptsLeft, locked }`. |
| 423 | `FACE_LOCKED` | Three failed attempts in this session. No more challenges or comparisons. |
| 409 | `FACE_NOT_ENROLLED` | The voter has no face template. |
| 422 | `FACE_LIVENESS_FAILED` | The browser reported that its own liveness check failed. Costs no attempt. |
| 409 | `FACE_CHALLENGE_INVALID` | Missing, expired, already used, or issued to another session. Costs no attempt. |
| 409 | `FACE_REENROLMENT_REQUIRED` | The template was made with another model or dimension. |
| 429 | `FACE_CHALLENGE_LIMIT` | More than 10 challenges requested in one session. |
| 429 | `RATE_LIMITED` | More than 60 challenge and verify calls in a minute from one address (`voter.faceRateLimit`). |
| 409 | `STAGE_REQUIRED` | The session is not in `AUTHENTICATED` (for example already verified). |
| 400 | `VALIDATION_FAILED` | Malformed body. Names the field only, never a value. Costs no attempt. |

### Admin (bearer token)

| Method and path | Body | Success |
|---|---|---|
| `GET /admin/voters/:id/face` | none | `{ voterId, enrolled, sampleCount, enrolledAt, algorithm, needsReenrolment }` |
| `PUT /admin/voters/:id/face` | `{ descriptors: [d1, d2, d3(, d4, d5)] }` | `{ voter: { id, voterId, faceEnrolled }, face: { sampleCount, enrolledAt, algorithm } }` |
| `DELETE /admin/voters/:id/face` | none | `204` |

`PUT` and `DELETE` answer `409 ELECTION_LOCKED` once the election has left Setup. `PUT` replaces any earlier
enrolment. `422 FACE_SAMPLES_INCONSISTENT` means the samples do not look like one face.

## How the decision is made

* Model in the browser: **InsightFace GhostNet (strides 1)**, 512 numbers per face, after a 5-point alignment of the
  face (eyes, nose, mouth corners). Detection, landmarks and the liveness hints come from `@vladmandic/human`.
* Comparison on the server: **cosine similarity** against every enrolled sample; the best one counts.
* Accept when the best similarity is at least `MATCH_THRESHOLD` (0.45).

Every number lives in `backend-api/src/biometrics/constants.js`: the dimension, the threshold, 3 to 5 samples,
30 second challenge, 3 attempts, 3 minute `FACE_VERIFIED` lifetime.

### Why this model, and why 0.45

Measured on the library author's public sample photos (extreme expressions included). The middle row used 30 photos;
the other two used all 84 single-face photos, 16 known real people among them.

| Descriptor | Same person vs different people |
|---|---|
| Human's default `faceres` (1024 numbers) | Overlap. About 14% equal error rate. |
| InsightFace GhostNet without alignment | Overlap. About 25% equal error rate. |
| InsightFace GhostNet **with 5-point alignment** | No overlap. Lowest same-person score 0.35, highest different-person score 0.33 (2,812 different-person pairs). |

Simulating the real procedure (enrol 3 photos of a person, verify with another photo, best sample counts), over every
way of choosing the 3 photos, gave 564 genuine and 8,832 impostor trials. At 0.45 no impostor was accepted and 0.2% of
genuine attempts were refused.

**The threshold is provisional.** The photo set is small and is not booth footage. It must be tuned on real captures
from the booth camera before any real use. The `score` of every attempt is in the audit rows for exactly that purpose.

The model weights come from the InsightFace project and are published for research use. That fits a university
project; check the licence before any other use.

## What the browser must send

The server accepts any array of 512 finite numbers, but the threshold above was measured for descriptors made
**exactly** like this. A descriptor made another way (another model, or no alignment) will not match reliably.

1. **Find the face and its landmarks** with `@vladmandic/human` (face detector + 468-point mesh) on the camera frame as
   the camera delivers it. Do not mirror the frame before analysing it (a mirrored preview is fine for display).
2. **Take five points** from the mesh, in pixels of that frame:

   | Point | Mesh points | Goes to (x, y) in the 112x112 crop |
   |---|---|---|
   | eye on the left of the image | midpoint of 33 and 133 | 38.2946, 51.6963 |
   | eye on the right of the image | midpoint of 362 and 263 | 73.5318, 51.5014 |
   | nose tip | 1 | 56.0252, 71.7366 |
   | mouth corner, left of the image | 61 | 41.5493, 92.3655 |
   | mouth corner, right of the image | 291 | 70.7299, 92.2041 |

3. **Straighten and crop.** Fit one similarity transform (rotation, uniform scale, shift; least squares) that moves
   the five points onto their targets, and draw the frame through it into a 112x112 canvas with smoothing on.
4. **Run the descriptor model** on that crop: input `[1, 112, 112, 3]`, RGB, values 0 to 1 (pixel / 255). The model is
   `insightface-ghostnet-strides1` (`.json` + `.bin`, about 8.3 MB) from the `models/` folder of
   <https://github.com/vladmandic/insightface> (commit `c972aaf`). It loads with the TensorFlow.js inside Human:
   `human.tf.loadGraphModel(url)`. SHA-256 of the `.bin`: `aee0964114004762b75591a6669648ff3b171ae2e54513077c76cf83aefdda5d`.
5. **Send the 512 output numbers** as a plain JSON array. Any scale is fine (the server normalises). Rounding to
   6 decimals keeps a five-sample enrolment near 25 kb; the JSON body limit is 100 kb.

Checked twice on the sample photos, with the same result: once on the graphics (WebGL) backend with eye refinement
off, once on the processor (WebAssembly) backend with eye refinement on. In the second run the enrol-3 simulation
gave 564 genuine and 8,600 impostor trials: at 0.45 no impostor was accepted and 0.7% of genuine attempts were refused.

### Human's own descriptor is NOT used

Human's built-in 1024-number descriptor (`face.embedding`) is clearly less accurate on the same photos (about 14% equal
error rate on single pairs) and is never read by the frontend. Templates enrolled with one model cannot be used with the
other.

## Frontend (`frontend/src/features/face/`)

* **One shared pipeline** (`humanEngine.ts`) for the voter check and admin enrolment. `snapshot.ts` bounds the longest frame side
  to 1920 pixels before detection, using the same aspect ratio (within integer-pixel rounding) and no full-resolution intermediate
  canvas. Human landmarks and the GhostNet crop both use that bounded, unmirrored frame, including for 4K/8K sources.
* **Human 3.3.6** (WASM backend, models served locally, IndexedDB model cache off) is used only for face detection, the 468-point
  mesh (five landmarks: eye centres from mesh 33/133 and 362/263, nose 1, mouth corners 61/291, always in the UNMIRRORED frame)
  and the eye/yaw hints for the advisory liveness movement. Human's own descriptor, emotion, antispoof and liveness are off.
* **InsightFace GhostNet (strides1, 512-D)** makes the descriptor. The frame is aligned with a least-squares similarity transform
  of the five landmarks onto the 112x112 ArcFace template, fed as RGB 0..1, `[1,112,112,3]`; output 512 finite numbers
  (`toPrecision(9)`, lossless float32), validated before sending (length, finite, magnitude). Exactly one face is required.
* **Model assets are served from the app's own origin** (`/face/human`, `/face/wasm`, `/face/ghostnet`): nothing is loaded from a
  CDN at run time. The GhostNet weights are InsightFace training-data models (**non-commercial research use**) and are
  therefore NOT committed. Run once after `npm install`, and in every build pipeline:

  ```
  cd frontend && npm run face:setup     # downloads the pinned GhostNet files (SHA-256 verified), copies Human models + wasm
  npm run face:check                    # verifies them
  ```

  `face:check` checks presence of Human/WASM copies and pinned hashes of GhostNet. It does not detect or repair corrupted existing
  Human/WASM copies; compare them with the installed packages and replace affected copies explicitly when troubleshooting.

  If the site sets a Content-Security-Policy, `script-src` needs `'wasm-unsafe-eval'` (otherwise Human silently falls back to
  WebGL, which is slower). The face code is a lazy chunk, loaded only on the voter face screen and the admin enrolment dialog.
* **Voter flow:** server status -> camera + models -> one well-positioned face -> `POST /voter/face/challenge` -> the requested
  BLINK / TURN_LEFT / TURN_RIGHT observed locally -> look straight -> 512-D descriptor -> `POST /voter/face/verify` -> re-read
  `GET /voter/status`. BLINK requires an open-eye baseline, closure and reopening, followed by three consecutive usable, frontal,
  open-eye frames. A second closure resets settling; the actual capture frame is checked again before GhostNet inference. A rejected
  capture starts a new challenge without submitting a descriptor or consuming a server comparison attempt.
  An expired or invalid challenge is replaced by a new one, never reused. Mismatch shows "Face could not be
  verified." with the attempts remaining (never a score); a locked session says to ask a polling official and has no unlock button.
  Specific messages exist for every face error code, camera denied/missing, model load failure and network failure.
* **Admin flow:** Voters -> Biometrics: 3 good samples ("Sample N of 3", optionally up to 5) through `PUT /admin/voters/:id/face`;
  re-enrol and remove (with confirmation) only while the election is in Setup; descriptors and photos are never displayed or stored.
* **Camera and privacy:** frames never leave the browser (only the 512 numbers are sent), nothing is written to local/session
  storage, IndexedDB or downloads, and the camera is stopped on success, logout, expiry, End session, route change, unmount and
  dialog close.
* **Testing without a camera:** `VITE_E2E_FACE=1` compiles in a test-only engine (scripted movement, synthetic descriptors).
  `npm run check:bundle` proves a normal build does not contain it, contains no secrets, and keeps the face code lazy.

### Honest limits (read before relying on this)

* **Liveness is advisory.** The blink/turn check is measured in the browser; a determined attacker controlling the browser can
  fake it. It is not proof of liveness and not an anti-spoofing guarantee. The decision that counts is the server's
  descriptor comparison and attempt limit.
* **0.45 is provisional.** It was chosen on ~27-82 studio photos (0 impostors accepted, about 0.9% of genuine refused with
  3 enrolment samples). That is a measurement on a small sample, not a false-accept rate; tune it on real booth cameras.
* Descriptors may differ slightly between browsers/GPUs; enrol and verify on the same kind of terminal where possible.
* Heavily rolled heads (45 degrees or more) can produce an unrelated descriptor without any error; the server mismatch check
  is the control.

### Real webcam manual test (still required)

Run the stack, `npm run face:setup`, open `/admin` and enrol a real person, Open the election, then on `/vote` sign in and pass
the check. In DevTools check: Network shows only same-origin requests (no CDN) and no request body larger than ~35 KB containing
anything except `challenge`, `descriptor` and `liveness`; Console is free of descriptors/challenges; Application shows nothing
stored; the camera light goes off on success, End session, tab close and navigation away. Also try glasses, poor light, a
photo on a phone screen (it may pass: liveness is advisory), another person (must fail), and three failures (must lock).

## What is stored

| Collection | Contents |
|---|---|
| `facetemplates` | One row per enrolled voter: `voterId`, `box` (AES-256-GCM ciphertext of the samples, `select: false`), `sampleCount`, `dimension`, `algorithm`, `templateVersion`, `enrolledBy`, `enrolledAt`. |
| `facechallenges` | One row per voter session: the SHA-256 of the current challenge, its action and expiry, `usedAt`, the attempt counter, `lockedAt`, `verifiedAt`. Removed about an hour after the session's absolute expiry. |

* The key is `FACE_TEMPLATE_ENCRYPTION_KEY` (32 random bytes as hex). Startup fails if it is missing, weak, equal to
  or contained in any other secret, or present in a connection string. The voter's database id is the additional
  authenticated data, so a template row copied onto another voter does not decrypt. A shortened IV or tag is refused.
* Using a challenge and counting the attempt are **one atomic update**, so parallel requests cannot reuse a challenge
  or get past three comparisons.
* Audit actions: `FACE_ENROLLED`, `FACE_ENROLMENT_REJECTED`, `FACE_ENROLMENT_REMOVED`, `FACE_VERIFY_SUCCESS`,
  `FACE_VERIFY_FAILURE` (with a `reason`), `FACE_LOCKED`. They hold the voter id, attempt number, score and the
  liveness label. Never a descriptor, template, key or challenge.

## Setup

Add the new key to an existing `backend-api/.env` (a fresh `npm run init:env` writes it for you):

```
FACE_TEMPLATE_ENCRYPTION_KEY=<output of: openssl rand -hex 32>
```

Losing or changing this key makes every enrolled face unusable. The voters must then be enrolled again.

## Tests

```
cd backend-api
npm test                                                               # offline, includes test/unit/face.*.test.js
MONGODB_TEST_URI=mongodb://127.0.0.1:27017/evoting-test npm run test:chain   # includes test/chain/face.test.js
```

The chain tests need the local node and a fresh `npm run deploy:local` (see `docs/BIOMETRICS_HANDOFF.md`).
**They delete the whole database named in `MONGODB_TEST_URI`**, so give them a throwaway database, never one with
data you want to keep.

`test/unit/face.service.test.js` covers the paths a healthy database never takes (a duplicate insert, a write that
fails after the step is granted, an index build that fails). `test/chain/face.test.js` covers enrolment (admin only, Setup only, 3 to 5 samples, dimension, mixed faces),
the challenge (single use, expiry, session bound, limit), comparison (match, mismatch, threshold edge), the attempt
limit and lockout, concurrency, the stage transition and its lifetime, and privacy of responses, logs and audit rows.

## Known limits and follow-ups

* The attempt limit is per session, as specified. A voter who logs in again gets three new attempts; login itself
  is rate limited and allows one live session per voter.
* Deleting a voter now also deletes their face template and pending challenges (`voterService.remove()`, scoped to that
  voter; a failed cleanup is audited as `VOTER_FACE_CLEANUP_FAILED`). Opening an election is refused (`PREFLIGHT_FAILED`,
  `face.templates`) while an enrolled template cannot be read with the configured key.
* FACE_VERIFIED lasts 3 minutes.
* `express.json` is limited to 100 kb. Five samples are about 25 kb when the browser rounds to 6 decimals.
* `src/auth/secretBox.js` accepts shortened GCM tags, which is Node's default. The template code checks the sizes
  itself. The same hardening would help the admin TOTP secrets: pass `{ authTagLength: 16 }` to `createDecipheriv`.
  That file is shared, so it is left to its owner.

## Merge note

`feature/biometrics` (9c578f9) was merged into `feature/voting-core`; `server.js` wires `createFaceService` into the admin and
voter routers, and `e2e-fixture.js` syncs the Face model indexes.
