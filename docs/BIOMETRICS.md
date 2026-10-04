# Biometrics: face verification (`AUTHENTICATED -> FACE_VERIFIED`)

Built on `feature/biometrics` to the brief in `docs/BIOMETRICS_HANDOFF.md`. This file describes what exists, how to
use it, and what it does not prove.

**Status.** The backend (API, storage, decision, tests) is complete. This branch contains **no frontend code**: the
camera screens are built by the frontend owner on `feature/voting-core`. "What the browser must send" below is the
contract they need.

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

### If the frontend uses Human's own descriptor instead

Human's built-in descriptor (`face.embedding`, 1024 numbers, no extra model file) is simpler to produce. To accept it:

* in `backend-api/src/biometrics/constants.js` change `FACE_MODEL`, `DESCRIPTOR_LENGTH` (1024) and `MATCH_THRESHOLD`;
* update the five unit tests that pin the old numbers (`face.descriptor.test.js`, `face.http.test.js`);
* round the values in the browser: five samples of 1024 numbers at full precision are about 108 kb, over the limit.

It is clearly less accurate on the same 84 photos (cosine similarity, enrol 3, best sample counts):

| Threshold | Genuine attempts refused | Impostors accepted |
|---|---|---|
| 0.55 | 6.4% | 16.07% |
| 0.60 | 11.7% | 2.31% |
| 0.65 | 15.8% | 0.24% |
| 0.70 | 34.9% | 0.00% |

There is no threshold where both numbers are low, because same-person and different-person scores overlap
(about 14% equal error rate on single pairs). Human's own `similarity()` function did worse than cosine (about 21%).
Templates enrolled with one model cannot be used with the other: the voters must be enrolled again.

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
* Deleting a voter does not delete their template. The row is encrypted and bound to that voter's id, so it is
  unusable, but `voterService.remove()` should also call `FaceTemplate.deleteOne({ voterId })`. That file is shared,
  so the one-line change is left to the merge.
* `express.json` is limited to 100 kb. Five samples are about 25 kb when the browser rounds to 6 decimals.
* `src/auth/secretBox.js` accepts shortened GCM tags, which is Node's default. The template code checks the sizes
  itself. The same hardening would help the admin TOTP secrets: pass `{ authTagLength: 16 }` to `createDecipheriv`.
  That file is shared, so it is left to its owner.

## Merging with `feature/voting-core`

Checked against `feature/voting-core` at `570e5bd`. Git merges every shared file by itself except one:

**`backend-api/src/server.js`.** Keep the voting-core version of the block and add the face service to it:

```js
    const voter = voterWiring(audit);
    const faceService = createFaceService({ Voter, VoterSession, FaceTemplate, FaceChallenge, authService: voter.authService, chain, audit, templateKey: config.secrets.faceTemplateKey });
    voter.faceService = faceService;
    const publicService = createPublicService({ chain, audit });
    const app = createApp({ config, logger, healthService, admin: { authService, electionService, voterService, configService, faceService }, voter, publicService });
```

The three imports at the top of the file (`FaceChallenge`, `FaceTemplate`, `createFaceService`) merge by themselves.

`backend-api/test/helpers/e2e-fixture.js` drops the database under a running server. Add `FaceTemplate.syncIndexes()`
and `FaceChallenge.syncIndexes()` to its `reset` list, next to the other models, so the unique indexes come back.
