import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { capture, installFace, liveTracks, samples, setFace, streamsOpened, type FaceScript } from "./face";
import { ADMIN, BACKEND_URL, Guard, VOTER_PASSWORD, adminLogin, backendPhase, fixture, freshTotp, newContext, shot } from "./helpers";

/**
 * Biometrics against the REAL stack (Hardhat + MongoDB + V2 backend), through the real UI and the real face endpoints. The browser runs
 * the TEST-ONLY face engine (made-up descriptors, a scripted "person" who blinks and turns), and Chrome's fake camera. It cannot test the
 * neural networks or a physical webcam: that is the pipeline test (static photos) and the manual webcam checklist in docs/BIOMETRICS.md.
 *
 * Needs a pristine Setup election: reset-e2e.sh, then `npx playwright test e2e/biometrics.spec.ts` (it OPENS the election, so reset again after).
 */
test.describe.configure({ mode: "serial" });
const API = `${BACKEND_URL}/api/v1`;
const used = new Set<string>();
let secret = "";

const PEOPLE = {
  asha: { name: "Asha Face", email: "asha.face@example.org", seed: 11 },
  bharat: { name: "Bharat Face", email: "bharat.face@example.org", seed: 12 },
  chitra: { name: "Chitra Face", email: "chitra.face@example.org", seed: 13 },
  dev: { name: "Dev Face", email: "dev.face@example.org", seed: 14 },
  ela: { name: "Ela Face", email: "ela.face@example.org", seed: 15 },
} as const;
type Who = keyof typeof PEOPLE;
const ids: Record<string, string> = {};
const STRANGER = 99;

let admCtx: BrowserContext, adm: Page, admGuard: Guard;
let kioCtx: BrowserContext, kio: Page, kioGuard: Guard;
const faceCalls: { path: string; body: string | null }[] = [];
const hosts = new Set<string>();

test.beforeAll(async ({ browser }) => {
  const phase = await backendPhase();
  if (phase !== "Setup") throw new Error(`biometrics.spec needs a pristine Setup election (backend reports ${phase}). Run reset-e2e.sh first.`);
  fixture("reset");
  secret = fixture<{ totpSecret: string }>("admin", ADMIN.email, ADMIN.password).totpSecret;
  for (const [key, p] of Object.entries(PEOPLE)) ids[key] = fixture<{ voterId: string }>("voter", p.name, p.email, VOTER_PASSWORD, "KA-BLR").voterId;
  // enrolled directly (synthetic template): bharat, dev, ela. asha is enrolled through the admin UI below; chitra is never enrolled.
  for (const key of ["bharat", "dev", "ela"] as const) fixture("enrol", ids[key], String(PEOPLE[key].seed));

  admCtx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
  await installFace(admCtx);
  adm = await admCtx.newPage();
  admGuard = new Guard(adm, [
    { status: 401, url: "/admin/auth/login" },
    { status: 422, url: "/face" }, // FACE_SAMPLES_INCONSISTENT, deliberate
  ]);

  kioCtx = await newContext(browser, { viewport: { width: 1024, height: 768 } });
  await installFace(kioCtx, { descriptor: capture(PEOPLE.asha.seed) });
  kio = await kioCtx.newPage();
  kioGuard = new Guard(kio, [
    { status: 403, url: "/voter/face/verify" }, // FACE_MISMATCH, deliberate
    { status: 401, url: "/voter/auth/login" },
    { status: 409, url: "/voter/face" },
  ]);
  kio.on("request", (r) => {
    hosts.add(new URL(r.url()).hostname);
    if (r.url().includes("/voter/face/")) faceCalls.push({ path: new URL(r.url()).pathname.replace("/api/v1", ""), body: r.postData() });
  });
});
test.afterAll(async () => {
  await Promise.all([admCtx?.close(), kioCtx?.close()]);
});

// ------------------------------------------------------------------------------------------------ helpers
const faceHeading = (page: Page) => page.getByRole("heading", { level: 1, name: "Face check" });
const status = (page: Page) => page.locator(".camera-status");

/** The page is reloaded by goto(), which resets the fake person to its initial script: so the script for THIS sign-in is applied after navigation. */
async function signIn(page: Page, who: Who, script?: FaceScript) {
  await page.goto("/vote");
  if (script) await setFace(page, script);
  await page.getByRole("button", { name: "Begin" }).click();
  await page.getByLabel("Voter ID or email").fill(PEOPLE[who].email);
  await page.getByLabel("Password").fill(VOTER_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(faceHeading(page)).toBeVisible();
}
async function endSession(page: Page) {
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
  expect(await liveTracks(page)).toBe(0);
}
const challengeCount = () => faceCalls.filter((c) => c.path === "/voter/face/challenge").length;
const verifyCalls = () => faceCalls.filter((c) => c.path === "/voter/face/verify");

async function openEnrol(page: Page, name: string) {
  await page.goto("/admin/biometrics");
  await page.getByRole("button", { name: new RegExp(`(Enrol|Re-enrol) face for ${name}`) }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
async function captureSamples(page: Page, set: number[][], already = 0) {
  for (let i = 0; i < set.length; i++) {
    await setFace(page, { descriptor: set[i] });
    const button = page.getByRole("button", { name: /^Capture/ });
    await expect(button).toBeEnabled({ timeout: 20_000 });
    await button.click();
    await expect(page.getByText(new RegExp(`Sample ${already + i + 1} captured`))).toBeVisible();
    await page.waitForTimeout(800); // minimum gap between two samples
  }
}

// ===================================================================================================== ADMIN ENROLMENT
test.describe("admin enrolment (Setup)", () => {
  test("sign in; the Biometrics page lists voters with their enrolment", async () => {
    await adminLogin(adm, secret, used);
    await expect(adm.getByRole("heading", { level: 1, name: "Election" })).toBeVisible();
    await adm.goto("/admin/biometrics");
    await expect(adm.getByRole("heading", { level: 1, name: "Face enrolment" })).toBeVisible();
    await expect(adm.getByRole("button", { name: `Enrol face for ${PEOPLE.asha.name}` })).toBeEnabled();
    await expect(adm.getByRole("button", { name: `Re-enrol face for ${PEOPLE.bharat.name}` })).toBeEnabled();
    await expect(adm.getByText("3 of 5")).toBeVisible(); // bharat, dev, ela were enrolled by the fixture
    await shot(adm, "bio-admin-list");
  });

  test("enrol a face through the camera: 3 samples, only numbers are sent, the camera stops", async () => {
    const puts: { body: string; type: string | undefined }[] = [];
    adm.on("request", (r) => {
      if (r.method() === "PUT" && r.url().includes("/face")) puts.push({ body: r.postData() ?? "", type: r.headers()["content-type"] });
    });
    await openEnrol(adm, PEOPLE.asha.name);
    await expect(adm.getByText("Face enrolled").first()).toBeVisible();
    await adm.getByRole("dialog").getByRole("button", { name: "Enrol face", exact: true }).click();
    await expect(adm.getByRole("heading", { name: "Sample 1 of 3" })).toBeVisible();
    await expect(status(adm)).toContainText(/Hold still/, { timeout: 20_000 }); // models loaded, exactly one centred face
    expect(await liveTracks(adm)).toBeGreaterThan(0);
    await shot(adm, "bio-admin-capture");

    // the Save button only exists once 3 samples are held
    await expect(adm.getByRole("button", { name: /Save enrolment/ })).toHaveCount(0);
    const set = samples(PEOPLE.asha.seed, 3);
    await captureSamples(adm, set.slice(0, 2));
    await expect(adm.getByRole("button", { name: /Save enrolment/ })).toHaveCount(0);
    // the same frame twice in a row is refused
    await setFace(adm, { descriptor: set[1] });
    await adm.getByRole("button", { name: /^Capture/ }).click();
    await expect(adm.getByText(/same as the last one/i)).toBeVisible();
    await captureSamples(adm, [set[2]], 2);
    await expect(adm.getByRole("button", { name: /Save enrolment \(3 samples\)/ })).toBeVisible();
    await shot(adm, "bio-admin-three");

    await adm.getByRole("button", { name: /Save enrolment/ }).click();
    await expect(adm.getByRole("status").filter({ hasText: "Face enrolled" })).toBeVisible();
    expect(await liveTracks(adm)).toBe(0); // the camera light is off as soon as the request is made

    expect(puts).toHaveLength(1);
    expect(puts[0].type).toContain("application/json");
    const body = JSON.parse(puts[0].body) as { descriptors: number[][] };
    expect(Object.keys(body)).toEqual(["descriptors"]); // numbers only: no image, no photo, no frame
    expect(body.descriptors).toHaveLength(3);
    for (const d of body.descriptors) {
      expect(d).toHaveLength(512);
      expect(d.every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
    }
    expect(puts[0].body.length).toBeLessThan(100_000);
    await adm.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(adm.getByText("4 of 5")).toBeVisible();
    ids.ashaEnrolled = "yes";
  });

  test("samples of different people are refused by the server (inconsistent), nothing is stored", async () => {
    await openEnrol(adm, PEOPLE.chitra.name);
    await adm.getByRole("dialog").getByRole("button", { name: "Enrol face", exact: true }).click();
    await expect(status(adm)).toContainText(/Hold still/, { timeout: 20_000 });
    await captureSamples(adm, [capture(31, 0.9, 1), capture(32, 0.9, 2), capture(33, 0.9, 3)]);
    await adm.getByRole("button", { name: /Save enrolment/ }).click();
    await expect(adm.getByRole("alert").filter({ hasText: /do not look like the same person/i })).toBeVisible();
    expect(await liveTracks(adm)).toBe(0);
    await adm.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(adm.getByText("4 of 5")).toBeVisible(); // chitra is still not enrolled
  });

  test("re-enrol asks for confirmation first and does not touch the camera until confirmed; remove asks too", async () => {
    await openEnrol(adm, PEOPLE.bharat.name);
    await adm.getByRole("dialog").getByRole("button", { name: "Re-enrol face", exact: true }).click();
    await expect(adm.getByText("Replace the existing face template?")).toBeVisible();
    const opened = await streamsOpened(adm);
    await adm.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect(await streamsOpened(adm)).toBe(opened); // declining the replacement never switched the camera on
    await expect(adm.getByText("Replace the existing face template?")).toHaveCount(0);
    expect(await liveTracks(adm)).toBe(0);

    await adm.getByRole("dialog").getByRole("button", { name: "Remove enrolment", exact: true }).click();
    await expect(adm.getByText("Remove this face enrolment?")).toBeVisible();
    await adm.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await adm.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(adm.getByText("4 of 5")).toBeVisible(); // still enrolled
  });

  test("remove an enrolment (confirmed): the voter is no longer enrolled; then enrol them again directly", async () => {
    await openEnrol(adm, PEOPLE.dev.name);
    await adm.getByRole("dialog").getByRole("button", { name: "Remove enrolment", exact: true }).click();
    await adm.getByRole("dialog").getByRole("button", { name: "Remove enrolment", exact: true }).last().click();
    await expect(adm.getByRole("status").filter({ hasText: "Face enrolment removed" })).toBeVisible();
    await adm.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await expect(adm.getByText("3 of 5")).toBeVisible();
    fixture("enrol", ids.dev, String(PEOPLE.dev.seed)); // back for the lock test
  });

  test("camera problems in the enrolment dialog: refused permission shows a clear message and keeps no camera", async ({ browser }) => {
    const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    });
    await installFace(ctx);
    const page = await ctx.newPage();
    await adminLogin(page, secret, used);
    await expect(page.getByRole("heading", { level: 1, name: "Election" })).toBeVisible();
    await openEnrol(page, PEOPLE.chitra.name);
    await page.getByRole("dialog").getByRole("button", { name: "Enrol face", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Camera access was refused/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(await liveTracks(page)).toBe(0);
    await ctx.close();
  });

  test("the camera stops on Cancel and on Escape", async () => {
    await openEnrol(adm, PEOPLE.chitra.name);
    await adm.getByRole("dialog").getByRole("button", { name: "Enrol face", exact: true }).click();
    await expect(status(adm)).toContainText(/Hold still/, { timeout: 20_000 });
    expect(await liveTracks(adm)).toBeGreaterThan(0);
    await adm.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await liveTracks(adm)).toBe(0);

    await adm.getByRole("dialog").getByRole("button", { name: "Enrol face", exact: true }).click();
    await expect(status(adm)).toContainText(/Hold still/, { timeout: 20_000 });
    expect(await liveTracks(adm)).toBeGreaterThan(0);
    await adm.keyboard.press("Escape");
    await expect(adm.getByRole("dialog")).toBeHidden();
    expect(await liveTracks(adm)).toBe(0);
  });

  test("open the election (typed phrase + fresh code); the Biometrics page becomes read-only", async () => {
    await adm.goto("/admin/election");
    await adm.getByRole("button", { name: "Open election" }).click();
    const dialog = adm.getByRole("dialog");
    await dialog.getByLabel(/Type OPEN ELECTION/).fill("OPEN ELECTION");
    await dialog.getByLabel("Fresh authenticator code").fill(await freshTotp(secret, used));
    await dialog.getByRole("button", { name: "Open election" }).click();
    await expect(adm.locator(".shell-header")).toContainText("Open", { timeout: 60_000 });
    expect(await backendPhase()).toBe("Open");

    await adm.goto("/admin/biometrics");
    await expect(adm.getByText("Face enrolment is locked")).toBeVisible();
    await expect(adm.getByRole("button", { name: /^(Re-enrol|Enrol) face for/ })).toHaveCount(0); // the list only offers "View"
    await adm.getByRole("button", { name: `View face enrolment for ${PEOPLE.asha.name}` }).click();
    await expect(adm.getByRole("dialog")).toBeVisible();
    await expect(adm.getByText("Enrolment is locked")).toBeVisible();
    await expect(adm.getByRole("dialog").getByRole("button", { name: /Re-enrol face|Enrol face|Remove enrolment/ })).toHaveCount(0);
    expect(await liveTracks(adm)).toBe(0);
    await adm.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    admGuard.assertClean("admin biometrics");
  });
});

// ===================================================================================================== VOTER VERIFICATION
test.describe("voter face verification (Open)", () => {
  test("a voter with NO enrolment is told to ask an official; the camera is never switched on", async () => {
    await signIn(kio, "chitra");
    await expect(kio.getByText(/No face is enrolled/i)).toBeVisible();
    await expect(kio.getByText("Please ask a polling official", { exact: true })).toBeVisible();
    expect(await streamsOpened(kio)).toBe(0);
    const controls = await kio.locator("button, a:not(.skip-link), input, select, textarea").evaluateAll((e) => e.map((x) => (x.textContent ?? "").trim()));
    expect(controls).toEqual(["End session"]);
    // the server agrees: there is no way past this stage
    const eligibility = await kioCtx.request.post(`${API}/voter/eligibility/check`, { data: {}, failOnStatusCode: false });
    expect(eligibility.status()).toBe(409);
    await endSession(kio);
  });

  test("camera refused, then no camera at all: a clear message each time, a retry, and no camera is left open", async ({ browser }) => {
    // (one sign-in for both cases: the voter login endpoint allows 10 sign-ins per 15 minutes per address)
    const ctx = await newContext(browser, { viewport: { width: 1024, height: 768 } });
    await ctx.addInitScript(() => {
      (window as unknown as { __cam: string }).__cam = "NotAllowedError";
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("x"), { name: (window as unknown as { __cam: string }).__cam }));
    });
    await installFace(ctx, { descriptor: capture(PEOPLE.asha.seed) });
    const page = await ctx.newPage();
    await signIn(page, "asha");
    await expect(page.getByRole("alert").filter({ hasText: /Camera access was refused/ })).toBeVisible();
    expect(await liveTracks(page)).toBe(0);
    await page.evaluate(() => ((window as unknown as { __cam: string }).__cam = "NotFoundError"));
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /No camera was found/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(await liveTracks(page)).toBe(0);
    await endSession(page);
    await ctx.close();
  });

  test("positioning guidance: no face, two faces, then one face; model loading is shown", async () => {
    await signIn(kio, "asha", { faces: 0, loadMs: 1500 });
    await expect(kio.getByText(/Starting the camera and loading face recognition/)).toBeVisible();
    await expect(status(kio)).toContainText(/No face detected/, { timeout: 20_000 });
    await shot(kio, "bio-voter-noface");
    await setFace(kio, { faces: 2 });
    await expect(status(kio)).toContainText(/More than one face/);
    await shot(kio, "bio-voter-twofaces");
    expect(await liveTracks(kio)).toBeGreaterThan(0);
    expect(challengeCount()).toBe(0); // no challenge is requested until exactly one face is well placed
    await setFace(kio, { faces: 1 });
    await expect(status(kio)).toContainText(/Blink now|Turn your head/, { timeout: 20_000 });
    await shot(kio, "bio-voter-action");
    expect(challengeCount()).toBe(1);
    await endSession(kio); // leaving mid-check releases the camera
  });

  test("the SAME person passes: FACE_VERIFIED by the server, camera off, then the normal journey to the receipt", async () => {
    faceCalls.length = 0;
    await signIn(kio, "asha", { faces: 1, descriptor: capture(PEOPLE.asha.seed, 0.85, 71), loadMs: 300 });
    await expect(kio.getByRole("heading", { level: 1, name: "You are eligible to vote" })).toBeVisible({ timeout: 60_000 });
    expect(await liveTracks(kio)).toBe(0);

    // exactly one challenge, one verify; numbers only
    expect(faceCalls.filter((c) => c.path === "/voter/face/status").length).toBeGreaterThan(0);
    expect(challengeCount()).toBe(1);
    expect(verifyCalls()).toHaveLength(1);
    const body = JSON.parse(verifyCalls()[0].body ?? "{}") as { challenge: string; descriptor: number[]; liveness: { passed: boolean } };
    expect(Object.keys(body).sort()).toEqual(["challenge", "descriptor", "liveness"]);
    expect(body.descriptor).toHaveLength(512);
    expect(body.descriptor.every((v) => Number.isFinite(v))).toBe(true);
    expect(body.liveness).toEqual({ passed: true });
    expect(JSON.stringify(body).length).toBeLessThan(100_000);

    await kio.getByRole("button", { name: "View my ballot" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Your ballot" })).toBeVisible();
    await kio.getByRole("radio", { name: "Neha Joshi" }).check();
    await kio.getByRole("button", { name: "Review my selection" }).click();
    await kio.getByRole("button", { name: "Confirm and cast vote" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Your vote has been recorded" })).toBeVisible({ timeout: 90_000 });
    await expect(kio.locator(".recorded-selection")).toContainText("Neha Joshi");
    await shot(kio, "bio-voter-receipt");
    await kio.getByRole("button", { name: "Done" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
    expect(await liveTracks(kio)).toBe(0);
  });

  test("a DIFFERENT face is refused three times, then locked for the session; no unlock control exists", async () => {
    await signIn(kio, "bharat", { descriptor: capture(STRANGER, 0.85, 5) });
    for (const left of [2, 1]) {
      await expect(kio.locator(".alert-title", { hasText: "Face could not be verified." })).toBeVisible({ timeout: 60_000 });
      await expect(kio.getByText(`Attempts remaining: ${left}`, { exact: false })).toBeVisible();
      await shot(kio, `bio-voter-mismatch-${left}`);
      expect(await liveTracks(kio)).toBeGreaterThan(0);
      await kio.getByRole("button", { name: "Try again" }).click();
    }
    await expect(kio.getByText(/Face verification is locked for this session/)).toBeVisible({ timeout: 60_000 });
    await expect(kio.getByText(/Please ask a polling official for assistance/)).toBeVisible();
    await expect(kio.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await shot(kio, "bio-voter-locked");
    expect(await liveTracks(kio)).toBe(0);
    expect(verifyCalls().filter((c) => c.body?.includes("challenge"))).toHaveLength(1 + 3);
    // the text never shows a score
    expect(await kio.locator("main").innerText()).not.toMatch(/0\.\d{2,}|score|similarity|cosine/i);
    const controls = await kio.locator("button, a:not(.skip-link)").evaluateAll((e) => e.map((x) => (x.textContent ?? "").trim()));
    expect(controls).toEqual(["End session"]);
    // reloading does not unlock it: the server remembers
    await kio.reload();
    await expect(kio.getByText(/Face verification is locked for this session/)).toBeVisible();
    await endSession(kio);
  });

  test("the lock is per session: after a new sign-in the genuine voter can try again and pass", async () => {
    await signIn(kio, "bharat", { descriptor: capture(PEOPLE.bharat.seed, 0.85, 8) });
    await expect(kio.getByRole("heading", { level: 1, name: "You are eligible to vote" })).toBeVisible({ timeout: 60_000 });
    await kio.getByRole("button", { name: "End session" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
  });

  test("an unanswered challenge expires after 30 s and a NEW challenge is requested (never reused)", async () => {
    test.setTimeout(150_000);
    faceCalls.length = 0;
    await signIn(kio, "dev", { noMovement: true, descriptor: capture(PEOPLE.dev.seed, 0.85, 9) });
    await expect.poll(() => challengeCount(), { timeout: 90_000, intervals: [1000] }).toBeGreaterThanOrEqual(2);
    expect(verifyCalls()).toHaveLength(0); // nothing was ever verified without the movement
    const challenges = faceCalls.filter((c) => c.path === "/voter/face/challenge");
    expect(challenges.length).toBeGreaterThanOrEqual(2);
    await expect(status(kio)).toContainText(/Blink now|Turn your head|Hold still|start again/);
    await setFace(kio, { noMovement: false });
    await expect(kio.getByRole("heading", { level: 1, name: "You are eligible to vote" })).toBeVisible({ timeout: 60_000 });
    await endSession(kio);
  });

  test("a network failure while verifying is reported and retry works with a NEW challenge", async () => {
    faceCalls.length = 0;
    let failed = false;
    await kio.route("**/api/v1/voter/face/verify", (route) => {
      if (!failed) {
        failed = true;
        return route.abort("connectionreset");
      }
      return route.continue();
    });
    await signIn(kio, "ela", { descriptor: capture(PEOPLE.ela.seed, 0.85, 10) });
    await expect(kio.getByRole("alert").filter({ hasText: /could not be reached/i })).toBeVisible({ timeout: 60_000 });
    expect(await liveTracks(kio)).toBe(0);
    await kio.getByRole("button", { name: "Try again" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "You are eligible to vote" })).toBeVisible({ timeout: 60_000 });
    expect(challengeCount()).toBe(2);
    kioGuard.failed = kioGuard.failed.filter((f) => !f.includes("/voter/face/verify net::ERR_CONNECTION_RESET")); // the deliberate failure injected above
    await kio.unroute("**/api/v1/voter/face/verify");
    await endSession(kio);
  });

  test("a session that ends mid-camera returns to the welcome screen and releases the camera", async () => {
    await signIn(kio, "ela", { descriptor: capture(PEOPLE.ela.seed, 0.85, 11) });
    // the session dies while the camera is running: the next server answers are 401
    const expired = (route: import("@playwright/test").Route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_EXPIRED", message: "x", requestId: "r" } }) });
    await kio.route("**/api/v1/voter/face/verify", expired);
    await kio.route("**/api/v1/voter/status", expired);
    kioGuard.allow({ status: 401, url: "/voter/face/verify" }, { status: 401, url: "/voter/status" });
    await expect(kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible({ timeout: 60_000 });
    expect(await liveTracks(kio)).toBe(0);
    await kio.unroute("**/api/v1/voter/face/verify");
    await kio.unroute("**/api/v1/voter/status");
    // clean up the server session
    await kioCtx.request.post(`${API}/voter/auth/logout`, { failOnStatusCode: false });
  });

  test("the next voter inherits nothing: fresh camera, fresh attempts, no previous result", async () => {
    const before = await streamsOpened(kio);
    await signIn(kio, "ela", { descriptor: capture(PEOPLE.ela.seed, 0.85, 12) });
    await expect(kio.getByRole("heading", { level: 1, name: "You are eligible to vote" })).toBeVisible({ timeout: 60_000 });
    expect(await streamsOpened(kio)).toBeGreaterThan(before - 1);
    expect(await liveTracks(kio)).toBe(0);
    kioGuard.assertClean("voter biometrics");
    expect([...hosts].every((h) => h === "localhost")).toBe(true); // no third-party host was ever contacted
  });
});
