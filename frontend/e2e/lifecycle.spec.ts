import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  ADMIN,
  BACKEND_URL,
  Guard,
  VOTER_PASSWORD,
  auditPage,
  backendPhase,
  expectNoBrowserState,
  fixture,
  freshTotp,
  kioskSignIn,
  newContext,
  shot,
  storageDump,
  textViolations,
} from "./helpers";

/**
 * ONE ordered scenario against the REAL stack (Hardhat + MongoDB + V2 backend). Needs a pristine Setup election:
 *   reset-e2e.sh   (fresh chain, 0 ballots)   then   npx playwright test e2e/lifecycle.spec.ts
 * It cannot be re-run without a reset because the election lifecycle is one way (Setup -> Open -> Closed).
 * The face step is a visual shell on this branch: the fixture CLI places the live session at FACE_VERIFIED, exactly like the
 * trusted server-side primitive the biometric step will use. Nothing in the app is bypassed.
 */
test.describe.configure({ mode: "serial" });

const API = `${BACKEND_URL}/api/v1`;
const used = new Set<string>();
let secret = "";

let pubCtx: BrowserContext, pub: Page, pubGuard: Guard;
let admCtx: BrowserContext, adm: Page, admGuard: Guard;
let kioCtx: BrowserContext, kio: Page, kioGuard: Guard;
const castBodies: { url: string; key: string | undefined; body: string | null }[] = [];
const publicBodies: { url: string; status: number; text: string }[] = [];
const problems: string[] = []; // axe / structure / text-rule findings, asserted in the last test so one run lists everything

const ALICE = { name: "Alice Voter", email: "alice.voter@example.org", code: "KA-BLR", pick: "Neha Joshi" };
const UMA = { name: "Uma Delhi", email: "uma.delhi@example.org", code: "DL-DEL", password: "ui created password 1" };
const CAROL = { name: "Carol Voter", email: "carol.voter@example.org", code: "MH-MUM" };
let aliceId = "";
let umaId = "";
let carolId = "";
let aliceTx = "";
let umaTx = "";
let umaPick = "";
let names: Record<string, string[]> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const radio = (page: Page, name: string) => page.getByRole("radio", { name });

async function scan(page: Page, label: string, withAxe = true) {
  await page.getByRole("heading", { level: 1 }).first().waitFor(); // lazy-loaded route chunks: audit the page, not the Suspense fallback
  problems.push(...(await textViolations(page, [secret])).map((v) => `[${label}] ${v}`));
  if (withAxe) await auditPage(page, label, problems);
}

test.beforeAll(async ({ browser }) => {
  const phase = await backendPhase();
  if (phase !== "Setup") throw new Error(`lifecycle.spec needs a pristine Setup election (backend reports ${phase}). Run reset-e2e.sh first.`);
  fixture("reset");
  secret = fixture<{ totpSecret: string }>("admin", ADMIN.email, ADMIN.password).totpSecret;
  aliceId = fixture<{ voterId: string }>("voter", ALICE.name, ALICE.email, VOTER_PASSWORD, ALICE.code).voterId;
  carolId = fixture<{ voterId: string }>("voter", CAROL.name, CAROL.email, VOTER_PASSWORD, CAROL.code).voterId;

  const el = (await (await fetch(`${API}/public/election`)).json()) as { data: { constituencies: { code: string; candidates: { name: string }[] }[] } };
  names = Object.fromEntries(el.data.constituencies.map((c) => [c.code, c.candidates.map((x) => x.name)]));

  pubCtx = await newContext(browser);
  pub = await pubCtx.newPage();
  pubGuard = new Guard(pub, [
    { status: 403, url: "/public/results" }, // RESULTS_NOT_AVAILABLE before close
    { status: 404, url: "/public/receipts/" }, // unknown transaction
  ]);
  pub.on("response", async (r) => {
    if (r.url().includes("/api/v1/public/")) publicBodies.push({ url: r.url(), status: r.status(), text: await r.text().catch(() => "") });
  });

  admCtx = await newContext(browser);
  adm = await admCtx.newPage();
  admGuard = new Guard(adm, [
    { status: 401, url: "/admin/auth/login" }, // the deliberate wrong password
    { status: 401, url: "/admin/election/open" }, // the deliberate wrong authenticator code
  ]);

  kioCtx = await newContext(browser, { viewport: { width: 1024, height: 768 } });
  await kioCtx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${process.env.E2E_PORT ?? 5173}` });
  kio = await kioCtx.newPage();
  kioGuard = new Guard(kio, []);
  kio.on("request", (r) => {
    if (r.url().includes("/voter/cast")) castBodies.push({ url: r.url(), key: r.headers()["idempotency-key"], body: r.postData() });
  });
});

test.afterAll(async () => {
  await Promise.all([pubCtx?.close(), admCtx?.close(), kioCtx?.close()]);
});

// ===================================================================================================== PUBLIC, SETUP
test.describe("public site while the election is in Setup", () => {
  test("landing, election, results notice, verify validation, trust limits", async () => {
    await pub.setViewportSize({ width: 1280, height: 800 });
    await pub.goto("/");
    await expect(pub.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(pub.locator(".shell-meta")).toContainText("Setup");
    await shot(pub, "life-public-landing-setup");
    await scan(pub, "public / (Setup)");

    await pub.getByRole("navigation", { name: "Public" }).getByRole("link", { name: "Election", exact: true }).click();
    await expect(pub).toHaveURL(/\/election$/);
    await expect(pub.getByRole("heading", { level: 1, name: "The election" })).toBeVisible();
    for (const [code, list] of Object.entries(names)) {
      await expect(pub.getByRole("heading", { level: 3, name: new RegExp(code) })).toBeVisible();
      for (const n of list) await expect(pub.getByText(n, { exact: true })).toBeVisible();
    }
    // no counts anywhere on the election page
    expect(await pub.locator("main").innerText()).not.toMatch(/\d+\s+votes?|ballots? recorded/i);
    await shot(pub, "life-public-election-setup", true);
    await scan(pub, "public /election (Setup)");

    await pub.getByRole("navigation", { name: "Public" }).getByRole("link", { name: "Results" }).click();
    await expect(pub.getByRole("heading", { level: 1, name: "Results" })).toBeVisible();
    await expect(pub.getByText(/published after the election closes/i).first()).toBeVisible();
    await expect(pub.getByRole("table")).toHaveCount(0);
    expect(await pub.locator("main").innerText()).not.toMatch(/\d/); // no numbers at all in the main region
    await shot(pub, "life-public-results-setup");
    await scan(pub, "public /results (Setup)");

    await pub.goto("/verify");
    await pub.getByLabel("Transaction reference").fill("0x1234");
    await pub.getByRole("button", { name: "Verify receipt" }).click();
    await expect(pub.getByText(/0x followed by 64 characters/i)).toBeVisible();
    await expect(pub).toHaveURL(/\/verify$/); // rejected client side: no navigation, no request
    expect(pubGuard.requests.filter((r) => r.includes("/public/receipts/"))).toEqual([]);
    await expect(pub.getByLabel("Transaction reference")).toHaveAttribute("aria-invalid", "true");
    await scan(pub, "public /verify (invalid)");

    await pub.goto("/trust");
    await expect(pub.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(pub.getByText("Not zero-knowledge")).toBeVisible();
    await expect(pub.getByText(/plaintext on the ledger/i)).toBeVisible();
    await expect(pub.getByText(/Not receipt-free and not coercion-resistant/i)).toBeVisible();
    await expect(pub.getByText(/operator and backend are trusted/i)).toBeVisible();
    await shot(pub, "life-public-trust", true);
    await scan(pub, "public /trust");

    await pub.goto("/accessibility");
    await scan(pub, "public /accessibility");
    await pub.goto("/no-such-page");
    await expect(pub.getByRole("heading", { level: 1 })).toBeVisible();
    await scan(pub, "public 404");

    // the public site never links into the voter terminal or the admin console
    for (const path of ["/", "/election", "/verify", "/results", "/trust", "/accessibility"]) {
      await pub.goto(path);
      const hrefs = await pub.locator("a[href]").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
      expect(hrefs.filter((h) => /^\/(vote|admin)/.test(h ?? "")), `public links on ${path}`).toEqual([]);
    }
    pubGuard.assertClean("public pages in Setup");
  });
});

// ===================================================================================================== ADMIN
test.describe("admin console", () => {
  test("wrong password shows an alert and stays on the login page", async () => {
    await adm.goto("/admin/login");
    await scan(adm, "admin /login");
    await shot(adm, "life-admin-login");
    await adm.getByLabel("Email").fill(ADMIN.email);
    await adm.getByLabel("Password").fill("definitely the wrong password");
    await adm.getByLabel("Authenticator code").fill("123456");
    await adm.getByRole("button", { name: "Sign in" }).click();
    await expect(adm.getByRole("alert")).toContainText(/not correct/i);
    await expect(adm).toHaveURL(/\/admin\/login/);
    // the authenticator field was cleared (one-time code) and the message does not say which of the three was wrong
    await expect(adm.getByLabel("Authenticator code")).toHaveValue("");
    await expect(adm.getByRole("alert")).not.toContainText(/password is|email is|no such/i);
    await shot(adm, "life-admin-login-error");
  });

  test("correct login lands on the election page in Setup; no token in storage", async () => {
    await adm.getByLabel("Email").fill(ADMIN.email);
    await adm.getByLabel("Password").fill(ADMIN.password);
    await adm.getByLabel("Authenticator code").fill(await freshTotp(secret, used));
    await adm.getByRole("button", { name: "Sign in" }).click();
    await expect(adm).toHaveURL(/\/admin\/election$/);
    await expect(adm.getByRole("heading", { level: 1, name: "Election control" })).toBeVisible();
    await expect(adm.locator(".shell-header")).toContainText("Setup");
    await expect(adm.getByRole("button", { name: "Open election" })).toBeVisible();
    await expect(adm.getByRole("button", { name: /reopen/i })).toHaveCount(0);
    await shot(adm, "life-admin-election-setup", true);
    await scan(adm, "admin /election (Setup)");
    // the admin session lives in memory + an HttpOnly cookie only
    await expectNoBrowserState(adm, "after admin sign in");
    // the public nav is not part of the admin shell
    await expect(adm.getByRole("navigation", { name: "Public" })).toHaveCount(0);
    await expect(adm.getByRole("link", { name: /^(verify a receipt|results)$/i })).toHaveCount(0);
  });

  test("creates a voter through the Voters page and sees it listed", async () => {
    await adm.getByRole("link", { name: "Voters", exact: true }).click();
    await expect(adm.getByRole("heading", { level: 1, name: "Voters" })).toBeVisible();
    await expect(adm.getByRole("row", { name: /Alice Voter/ })).toBeVisible();
    await shot(adm, "life-admin-voters-setup", true);
    await scan(adm, "admin /voters (Setup)");

    await adm.getByRole("button", { name: "Add voter" }).click();
    const dlg = adm.getByRole("dialog", { name: "Add a voter" });
    await expect(dlg).toBeVisible();
    // invalid first: the first invalid control gets focus and the error is linked
    await dlg.getByRole("button", { name: "Add voter" }).click();
    await expect(dlg.getByLabel("Full name")).toBeFocused();
    await expect(dlg.getByLabel("Full name")).toHaveAttribute("aria-invalid", "true");
    await shot(adm, "life-admin-voter-dialog-errors");
    await scan(adm, "admin voter dialog (errors)");
    await dlg.getByLabel("Full name").fill(UMA.name);
    await dlg.getByLabel("Email").fill(UMA.email);
    await dlg.getByLabel("Initial password").fill("short");
    await dlg.getByLabel("Constituency").selectOption(UMA.code);
    await dlg.getByRole("button", { name: "Add voter" }).click();
    await expect(dlg.locator(".field-error")).toContainText(/at least 12 characters/i);
    await dlg.getByLabel("Initial password").fill(UMA.password);
    await dlg.getByRole("button", { name: "Add voter" }).click();
    await expect(dlg).toBeHidden();
    const notice = adm.getByRole("status").filter({ hasText: "Voter added" });
    await expect(notice).toBeVisible();
    umaId = ((await notice.innerText()).match(/VC-[A-Z0-9]+/) ?? [])[0] ?? "";
    expect(umaId).toMatch(/^VC-/);
    await expect(adm.getByRole("row", { name: new RegExp(UMA.name) })).toBeVisible();
    await expect(adm.getByRole("row", { name: new RegExp(UMA.name) })).toContainText(umaId);
    // the password the official typed is not echoed back anywhere
    expect(await adm.locator("body").innerText()).not.toContain(UMA.password);

    // filters live in the URL
    await adm.getByLabel("Search").fill("uma.delhi");
    await adm.getByRole("button", { name: "Search" }).click();
    await expect(adm).toHaveURL(/search=uma\.delhi/);
    await expect(adm.getByRole("row", { name: /Alice Voter/ })).toHaveCount(0);
    await adm.getByRole("button", { name: "Clear filters" }).click();
    await expect(adm.getByRole("row", { name: /Alice Voter/ })).toBeVisible();
  });

  test("constituencies and candidates pages read the contract data", async () => {
    await adm.getByRole("link", { name: "Constituencies", exact: true }).click();
    await expect(adm.getByRole("heading", { level: 1, name: "Constituencies" })).toBeVisible();
    for (const code of Object.keys(names)) await expect(adm.locator("main").getByText(code).first()).toBeVisible();
    await shot(adm, "life-admin-constituencies-setup", true);
    await scan(adm, "admin /constituencies (Setup)");

    await adm.getByRole("link", { name: "Candidates", exact: true }).click();
    await expect(adm.getByRole("heading", { level: 1, name: "Candidates" })).toBeVisible();
    await expect(adm.getByText("Neha Joshi").first()).toBeVisible();
    await shot(adm, "life-admin-candidates-setup", true);
    await scan(adm, "admin /candidates (Setup)");

    for (const p of ["biometrics", "system"]) {
      await adm.getByRole("link", { name: p === "system" ? "System" : "Biometrics", exact: true }).click();
      await expect(adm.getByRole("heading", { level: 1 })).toBeVisible();
      await shot(adm, `life-admin-${p}`, true);
      await scan(adm, `admin /${p}`);
    }
  });

  test("Open dialog: focus, Escape, disabled-until-valid, wrong code, then open for real", async () => {
    await adm.getByRole("link", { name: "Election", exact: true }).click();
    const opener = adm.getByRole("button", { name: "Open election" });
    await opener.click();
    const dlg = adm.getByRole("dialog", { name: "Open the election?" });
    await expect(dlg).toBeVisible();
    // focus lands on the heading, never on the action buttons
    const active = await adm.evaluate(() => ({ tag: document.activeElement?.tagName, inDialog: !!document.activeElement?.closest("dialog") }));
    expect(active).toMatchObject({ tag: "H2", inDialog: true });
    await shot(adm, "life-admin-open-dialog");
    await scan(adm, "admin open dialog");
    // tab stays inside the dialog
    for (let i = 0; i < 10; i++) {
      await adm.keyboard.press("Tab");
      // native modal dialog: focus may rest on <body> (the browser UI) after the last control, but never on background content
      expect(await adm.evaluate(() => !document.activeElement || document.activeElement === document.body || !!document.activeElement.closest("dialog")), `tab ${i} reaches background content`).toBe(true);
    }
    // Escape cancels and focus returns to the opener
    await adm.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(opener).toBeFocused();
    expect(await backendPhase()).toBe("Setup");

    await opener.click();
    const confirm = dlg.getByRole("button", { name: "Open election" });
    await expect(confirm).toBeDisabled();
    await dlg.getByLabel(/Type OPEN ELECTION/).fill("open election"); // wrong case
    await dlg.getByLabel("Fresh authenticator code").fill("123456");
    await expect(confirm).toBeDisabled();
    await dlg.getByLabel(/Type OPEN ELECTION/).fill("OPEN ELECTION");
    await dlg.getByLabel("Fresh authenticator code").fill("12345");
    await expect(confirm).toBeDisabled();
    await dlg.getByLabel("Fresh authenticator code").fill("12a456"); // the field strips non-digits
    await expect(dlg.getByLabel("Fresh authenticator code")).toHaveValue("12456");
    await dlg.getByLabel("Fresh authenticator code").fill("000000");
    await expect(confirm).toBeEnabled();
    // a wrong code is rejected with an alert, nothing changes, the code field is cleared and refocused
    await confirm.click();
    await expect(dlg.getByRole("alert")).toContainText(/not changed/i);
    await expect(dlg.getByLabel("Fresh authenticator code")).toHaveValue("");
    await expect(dlg.getByLabel("Fresh authenticator code")).toBeFocused();
    await expect(adm.locator(".shell-header")).toContainText("Setup");
    expect(await backendPhase()).toBe("Setup");
    await shot(adm, "life-admin-open-dialog-rejected");

    // now for real, slowed down so the "not yet" state can be observed
    await dlg.getByLabel(/Type OPEN ELECTION/).fill("OPEN ELECTION");
    await dlg.getByLabel("Fresh authenticator code").fill(await freshTotp(secret, used));
    await adm.route("**/api/v1/admin/election/open", async (route) => {
      await sleep(1500);
      await route.continue();
    });
    await confirm.click();
    await expect(dlg.getByRole("button", { name: "Opening election…" })).toBeVisible();
    await expect(dlg.getByText(/Do not close this page/i)).toBeVisible();
    await expect(adm.locator(".shell-header")).toContainText("Setup"); // not flipped before the backend answered
    await expect(adm.locator(".shell-header")).toContainText("Open", { timeout: 60_000 });
    await adm.unroute("**/api/v1/admin/election/open");
    await expect(dlg).toBeHidden();
    expect(await backendPhase()).toBe("Open");
    await expect(adm.getByRole("status").filter({ hasText: "Election opened" })).toBeVisible();
    await expect(adm.getByRole("button", { name: "Open election" })).toHaveCount(0);
    await expect(adm.getByRole("button", { name: /reopen/i })).toHaveCount(0);
    await shot(adm, "life-admin-election-open", true);
    await scan(adm, "admin /election (Open)");
  });

  test("configuration pages are read-only once open (no action controls in the DOM)", async () => {
    await adm.getByRole("link", { name: "Voters", exact: true }).click();
    await expect(adm.getByRole("heading", { level: 1, name: "Voters" })).toBeVisible();
    await expect(adm.getByText(/frozen|read-only/i).first()).toBeVisible();
    await expect(adm.getByRole("row", { name: /Alice Voter/ })).toBeVisible();
    await expect(adm.locator("main").getByRole("button", { name: /^(add|edit|delete|reset)/i })).toHaveCount(0);
    await expect(adm.getByRole("columnheader", { name: "Actions" })).toHaveCount(0);
    await shot(adm, "life-admin-voters-open", true);
    await scan(adm, "admin /voters (Open)");

    await adm.getByRole("link", { name: "Constituencies", exact: true }).click();
    await expect(adm.getByRole("heading", { level: 1, name: "Constituencies" })).toBeVisible();
    await expect(adm.getByText(/frozen|read-only/i).first()).toBeVisible();
    await expect(adm.locator("main form")).toHaveCount(0);
    await expect(adm.locator("main").getByRole("button", { name: /^(add|edit|delete|remove)/i })).toHaveCount(0);
    await scan(adm, "admin /constituencies (Open)");

    await adm.getByRole("link", { name: "Candidates", exact: true }).click();
    await expect(adm.getByRole("heading", { level: 1, name: "Candidates" })).toBeVisible();
    await expect(adm.getByText(/frozen|read-only/i).first()).toBeVisible();
    await expect(adm.locator("main form")).toHaveCount(0);
    await expect(adm.locator("main").getByRole("button", { name: /^(add|edit|delete|remove)/i })).toHaveCount(0);
    await scan(adm, "admin /candidates (Open)");

    // the UI hiding the controls is not the security boundary: a cookie-only request is refused (no token reachable from JS)
    const status = await adm.evaluate(async () => (await fetch("/api/v1/admin/voters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x", email: "x@example.org", password: "x".repeat(14), constituencyCode: "KA-BLR" }), credentials: "include" })).status);
    expect([401, 403]).toContain(status);
    admGuard.allow({ status, url: "/admin/voters" });
  });
});

// ===================================================================================================== KIOSK
/** The Transaction row of the receipt (the Election row is also a 0x + 64 hex value). */
const txOf = async (page: Page) => (await page.locator(".receipt .dl-row", { hasText: "Transaction" }).locator("dd").innerText()).trim().match(/^0x[0-9a-f]{64}$/i)?.[0];

async function chooseAndCast(page: Page, pick: string): Promise<string> {
  await expect(page.getByRole("heading", { level: 1, name: "Your ballot" })).toBeVisible();
  await radio(page, pick).check();
  await page.getByRole("button", { name: "Review my selection" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review your selection" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm and cast vote" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Your vote has been recorded" })).toBeVisible({ timeout: 90_000 });
  const tx = (await txOf(page)) ?? "";
  expect(tx).toMatch(/^0x[0-9a-f]{64}$/i);
  return tx;
}

/** After "Done" / "End session" the terminal must show the WELCOME screen (every piece of per-voter UI state is discarded). */
async function doneShowsWelcome() {
  const welcome = kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" });
  await expect(welcome).toBeVisible();
}

test.describe("voter kiosk (supervised terminal)", () => {
  test("welcome screen while open; sign in; face step is a shell with no bypass", async () => {
    await kio.goto("/vote");
    await expect(kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
    await expect(kio.getByRole("button", { name: "Begin" })).toBeEnabled();
    await shot(kio, "life-kiosk-welcome-open");
    await scan(kio, "kiosk welcome (Open)");
    // a terminal has no navigation of any kind
    const links = await kio.locator("a[href]").evaluateAll((a) => a.map((x) => x.getAttribute("href")).filter((h) => h !== "#main"));
    expect(links).toEqual([]);
    await expect(kio.getByRole("navigation")).toHaveCount(0);

    // wrong password: alert, still on the sign-in screen
    await kio.getByRole("button", { name: "Begin" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await shot(kio, "life-kiosk-signin");
    await scan(kio, "kiosk sign in");
    await kio.getByLabel("Voter ID or email").fill(ALICE.email);
    await kio.getByLabel("Password").fill("wrong wrong wrong 1");
    await kio.getByRole("button", { name: "Sign in" }).click();
    await expect(kio.getByRole("alert")).toContainText(/do not match/i);
    await expect(kio.getByLabel("Password")).toHaveValue("");
    await shot(kio, "life-kiosk-signin-error");
    kioGuard.allow({ status: 401, url: "/voter/auth/login" });

    await kio.getByLabel("Voter ID or email").fill(ALICE.email);
    await kio.getByLabel("Password").fill(VOTER_PASSWORD);
    await kio.getByRole("button", { name: "Sign in" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Face check" })).toBeVisible();
    await expect(kio.getByText(/not available on this terminal/i)).toBeVisible();
    await expect(kio.locator(".shell-header")).toContainText("Open");
    await expect(kio.locator(".countdown")).toBeVisible();
    await shot(kio, "life-kiosk-face-shell");
    await scan(kio, "kiosk face shell");

    // the only controls are 'End session' and 'Check again': no skip / verify-anyway affordance of any kind
    const controls = await kio.locator("button, a:not(.skip-link), [role=button], input, select, textarea").evaluateAll((e) => e.map((x) => (x.textContent ?? "").trim()));
    expect([...controls].sort()).toEqual(["Check again", "End session"]);
    expect(controls.join(" ")).not.toMatch(/skip|verify anyway|bypass|continue without|override|simulate|demo/i);

    // "Check again" before the server moved the stage changes nothing
    await kio.getByRole("button", { name: "Check again" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Face check" })).toBeVisible();
    // a hard refresh renders the server stage
    await kio.reload();
    await expect(kio.getByRole("heading", { level: 1, name: "Face check" })).toBeVisible();
  });

  test("the kiosk follows the SERVER stage: FACE_VERIFIED -> eligibility -> ballot", async () => {
    fixture("stage", aliceId, "FACE_VERIFIED");
    await kio.getByRole("button", { name: "Check again" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "You are eligible to vote" })).toBeVisible();
    await expect(kio.getByText("Your ballot is for Bengaluru.")).toBeVisible();
    await shot(kio, "life-kiosk-eligible");
    await scan(kio, "kiosk eligibility");
    // refresh on the eligibility screen: the server is now at ELIGIBLE, so the ballot is shown
    await kio.reload();
    await expect(kio.getByRole("heading", { level: 1, name: "Your ballot" })).toBeVisible();
  });

  test("ballot: own constituency only, nothing preselected, native radios, keyboard works", async () => {
    const radios = kio.getByRole("radio");
    await expect(radios).toHaveCount(names["KA-BLR"].length);
    await expect(kio.locator("fieldset.choice-list > legend")).toHaveText(/choose one candidate/i);
    await expect(kio.locator("input[type=radio]:checked")).toHaveCount(0);
    for (const n of names["KA-BLR"]) await expect(radio(kio, n)).toBeVisible();
    for (const other of [...names["DL-DEL"], ...names["MH-MUM"]]) await expect(kio.getByText(other, { exact: true })).toHaveCount(0);
    await expect(kio.getByRole("button", { name: "Review my selection" })).toBeDisabled();
    // no counts on the ballot
    expect(await kio.locator("main").innerText()).not.toMatch(/\bvotes\b|\btally\b|leading/i);
    await shot(kio, "life-kiosk-ballot-empty");
    await scan(kio, "kiosk ballot");

    // keyboard: arrow keys move + select within the group
    await radios.first().focus();
    await kio.keyboard.press("ArrowDown");
    await kio.keyboard.press("ArrowDown");
    await expect(radios.nth(2)).toBeChecked();
    await expect(radios.nth(2)).toBeFocused();
    await expect(radio(kio, "Neha Joshi")).toBeChecked();
    // space selects the focused radio (focus the 5th without selecting, then press Space)
    await radios.nth(4).focus();
    await kio.keyboard.press("Space");
    await expect(radios.nth(4)).toBeChecked();
    await expect(kio.locator("input[type=radio]:checked")).toHaveCount(1);
    await radios.nth(2).focus();
    await kio.keyboard.press("Space");
    await expect(radio(kio, ALICE.pick)).toBeChecked();
    await expect(kio.getByRole("button", { name: "Review my selection" })).toBeEnabled();
    await shot(kio, "life-kiosk-ballot-selected");
  });

  test("review restates the choice; Change selection keeps it; /authorization is only called on Confirm", async () => {
    await kio.getByRole("button", { name: "Review my selection" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Review your selection" })).toBeVisible();
    await expect(kio.locator("main")).toContainText(ALICE.pick);
    await shot(kio, "life-kiosk-review");
    await scan(kio, "kiosk review");
    expect(kioGuard.requests.filter((r) => r.includes("/voter/authorization")), "/authorization must not be called before Confirm").toEqual([]);

    await kio.getByRole("button", { name: "Change selection" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Your ballot" })).toBeVisible();
    await expect(radio(kio, ALICE.pick)).toBeChecked(); // preserved
    expect(kioGuard.requests.filter((r) => r.includes("/voter/authorization"))).toEqual([]);
    await kio.getByRole("button", { name: "Review my selection" }).click();
    await expect(kio.locator("main")).toContainText(ALICE.pick);
  });

  test("confirm and cast: progress, then the receipt (selection on screen only)", async () => {
    await kio.getByRole("button", { name: "Confirm and cast vote" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: /Casting your vote|Your vote has been recorded/ })).toBeVisible();
    await shot(kio, "life-kiosk-casting");
    await expect(kio.getByRole("heading", { level: 1, name: "Your vote has been recorded" })).toBeVisible({ timeout: 90_000 });

    // the cast request carries an Idempotency-Key and an EMPTY body (the candidate was committed by /authorization)
    expect(castBodies.length).toBeGreaterThanOrEqual(1);
    expect(castBodies[0].key).toMatch(/[0-9a-f-]{8,}/i);
    expect(JSON.parse(castBodies[0].body ?? "{}")).toEqual({});
    expect(kioGuard.requests.filter((r) => r.includes("/voter/authorization")).length).toBe(1);

    // receipt content
    await expect(kio.getByRole("heading", { level: 2, name: "Your recorded selection" })).toBeVisible();
    await expect(kio.locator(".recorded-selection")).toContainText(ALICE.pick);
    const receipt = kio.locator(".receipt");
    await expect(receipt).toContainText("Ballot number");
    await expect(receipt).toContainText("Election");
    await expect(receipt).toContainText("Block");
    aliceTx = (await txOf(kio)) ?? "";
    expect(aliceTx).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect(receipt).not.toContainText(ALICE.pick);
    await expect(kio.locator(".countdown")).toContainText(/Screen closes in/);
    await shot(kio, "life-kiosk-receipt");
    await scan(kio, "kiosk receipt");

    // Copy receipt: clipboard text has the reference and NOT the candidate
    await kio.getByRole("button", { name: "Copy receipt" }).click();
    await expect(kio.getByRole("button", { name: "Receipt copied" })).toBeVisible();
    const clip = await kio.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(aliceTx);
    expect(clip).toContain("Ballot number");
    expect(clip).not.toContain(ALICE.pick);
    expect(clip.toLowerCase()).not.toMatch(/neha|joshi|candidate|selection/);

    // print.css hides the recorded selection and every control; the receipt block stays
    await kio.emulateMedia({ media: "print" });
    await expect(kio.locator(".recorded-selection")).toBeHidden();
    await expect(kio.locator(".shell-footer")).toBeHidden();
    await expect(kio.locator(".receipt")).toBeVisible();
    expect(await kio.locator("body").innerText()).not.toContain(ALICE.pick);
    await kio.emulateMedia({ media: "screen" });

    // a hard refresh still renders the receipt from the server
    await kio.reload();
    await expect(kio.getByRole("heading", { level: 1, name: "Your vote has been recorded" })).toBeVisible();
    await expect(kio.locator(".receipt")).toContainText(aliceTx);
  });

  test("Done returns to the welcome screen; a refresh shows welcome; no browser state is left", async () => {
    await kio.getByRole("button", { name: "Done" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
    expect(await kio.locator("body").innerText()).not.toContain(ALICE.pick);
    expect(await kio.locator("body").innerText()).not.toContain(aliceTx);
    await kio.reload();
    await expect(kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
    await expect(kio.getByRole("button", { name: "Begin" })).toBeEnabled();
    await expectNoBrowserState(kio, "after a full voter flow");
    for (const c of await kioCtx.cookies()) expect(c.httpOnly, `cookie ${c.name} must be HttpOnly`).toBe(true);
  });

  test("the same voter signs in again: already accepted, receipt is available and identical", async () => {
    await kioskSignIn(kio, aliceId);
    await expect(kio.getByRole("heading", { level: 1, name: "Face check" })).toBeVisible();
    fixture("stage", aliceId, "FACE_VERIFIED");
    kioGuard.allow({ status: 409, url: "/voter/eligibility/check" }, { status: 403, url: "/voter/eligibility/check" });
    await kio.getByRole("button", { name: "Check again" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "A ballot has already been accepted" })).toBeVisible();
    await expect(kio.getByText("You have already voted")).toBeVisible();
    await expect(kio.getByRole("button", { name: "View my receipt" })).toBeVisible();
    await expect(kio.getByRole("button", { name: /^(begin|view my ballot|try again|vote)/i })).toHaveCount(0);
    await shot(kio, "life-kiosk-already-voted");
    await scan(kio, "kiosk already voted");
    await kio.getByRole("button", { name: "View my receipt" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Your vote has been recorded" })).toBeVisible({ timeout: 30_000 });
    await expect(kio.locator(".receipt")).toContainText(aliceTx);
    await kio.getByRole("button", { name: "Done" }).click();
    await doneShowsWelcome();
  });

  test("a second, UI-created voter votes in another constituency for a different candidate", async () => {
    await kioskSignIn(kio, umaId, UMA.password); // the voter the official created through the Voters page
    await expect(kio.getByRole("heading", { level: 1, name: "Face check" })).toBeVisible();
    fixture("stage", umaId, "FACE_VERIFIED");
    await kio.getByRole("button", { name: "Check again" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "You are eligible to vote" })).toBeVisible();
    await expect(kio.getByText(/Delhi/).first()).toBeVisible();
    await kio.getByRole("button", { name: "View my ballot" }).click();
    await expect(kio.getByRole("heading", { level: 1, name: "Your ballot" })).toBeVisible();
    await expect(kio.getByRole("radio")).toHaveCount(names["DL-DEL"].length);
    for (const n of names["KA-BLR"]) await expect(kio.getByText(n, { exact: true })).toHaveCount(0);
    umaPick = names["DL-DEL"][1];
    umaTx = await chooseAndCast(kio, umaPick);
    expect(umaTx).not.toBe(aliceTx);
    await expect(kio.locator(".recorded-selection")).toContainText(umaPick);
    await kio.getByRole("button", { name: "Done" }).click();
    await doneShowsWelcome();
  });

  test("roles are separated: voter cookie vs admin console, admin session vs kiosk", async ({ browser }) => {
    // --- a voter session cookie cannot reach the admin console or its API
    await kioskSignIn(kio, carolId);
    await expect(kio.getByRole("heading", { level: 1, name: "Face check" })).toBeVisible();
    await kio.goto("/admin/election");
    await expect(kio).toHaveURL(/\/admin\/login/);
    const adminApi = await kio.evaluate(async () => {
      const out: Record<string, number> = {};
      for (const p of ["/api/v1/admin/election", "/api/v1/admin/voters", "/api/v1/admin/auth/me"]) out[p] = (await fetch(p, { credentials: "include" })).status;
      out.refresh = (await fetch("/api/v1/admin/auth/refresh", { method: "POST", credentials: "include" })).status;
      return out;
    });
    for (const [p, s] of Object.entries(adminApi)) expect([401, 403], `${p} with a voter cookie`).toContain(s);
    kioGuard.allow({ status: 401, url: "/admin/" }, { status: 403, url: "/admin/" });
    // and the voter session was not harmed
    await kio.goto("/vote");
    await expect(kio.getByRole("heading", { level: 1, name: "Face check" })).toBeVisible();
    await kio.getByRole("button", { name: "End session" }).click();
    await expect(kio.getByRole("button", { name: "Begin" })).toBeVisible();

    // --- an admin session shows no admin data on the kiosk and gives no voter API access
    await adm.goto("/vote");
    await expect(adm.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
    const kioskText = await adm.locator("body").innerText();
    expect(kioskText).not.toMatch(/Administration|Sign out|admin@example|System checks/);
    expect(await adm.evaluate(async () => (await fetch("/api/v1/voter/status", { credentials: "include" })).status)).toBe(401);
    admGuard.allow({ status: 401, url: "/voter/status" });
    await scan(adm, "kiosk viewed from the admin browser");
    // the kiosk has no links to results / verify / admin, and no public nav
    const hrefs = await adm.locator("a[href]").evaluateAll((a) => a.map((x) => x.getAttribute("href")));
    expect(hrefs.filter((h) => h !== "#main")).toEqual([]);

    // --- an anonymous browser: every admin route redirects to the login page
    const anonCtx = await newContext(browser);
    const anon = await anonCtx.newPage();
    const anonGuard = new Guard(anon, [{ status: 401, url: "/admin/auth/refresh" }]);
    for (const p of ["election", "voters", "constituencies", "candidates", "biometrics", "system"]) {
      await anon.goto(`/admin/${p}`);
      await expect(anon).toHaveURL(/\/admin\/login/);
    }
    anonGuard.assertClean("anonymous admin redirects");
    await anonCtx.close();
    // the admin returns to the console afterwards (cookie rotation survived all of the above)
    await adm.goto("/admin/election");
    await expect(adm.getByRole("heading", { level: 1, name: "Election control" })).toBeVisible();
    await expect(adm.locator(".shell-header")).toContainText("Open");
  });
});

// ===================================================================================================== PUBLIC, OPEN
test.describe("public site while voting is open", () => {
  test("verify a real receipt: recorded, ballot number, constituency, never the candidate", async () => {
    await pub.setViewportSize({ width: 1280, height: 800 });
    await pub.goto("/verify");
    await pub.getByLabel("Transaction reference").fill(aliceTx);
    await pub.getByRole("button", { name: "Verify receipt" }).click();
    await expect(pub).toHaveURL(new RegExp(`/verify/${aliceTx}$`, "i"));
    await expect(pub.getByText("Ballot recorded")).toBeVisible();
    const dl = pub.locator("dl.dl");
    await expect(dl).toContainText("Ballot number");
    await expect(dl).toContainText("Bengaluru");
    await expect(dl).toContainText("KA-BLR");
    await expect(dl).toContainText(aliceTx);
    await expect(dl).toContainText("Block");
    await shot(pub, "life-public-verify-recorded", true);
    await scan(pub, "public /verify (recorded)");
    const allNames = Object.values(names).flat();
    const body = await pub.locator("body").innerText();
    for (const n of allNames) expect(body, `verify page must not name ${n}`).not.toContain(n);
    expect(await pub.evaluate(() => document.documentElement.outerHTML)).not.toContain("Neha");

    // the API response behind it has no candidate either
    const resp = publicBodies.filter((b) => b.url.includes(`/public/receipts/${aliceTx.toLowerCase()}`)).at(-1);
    expect(resp?.status).toBe(200);
    expect(resp?.text ?? "").not.toMatch(/candidate|Neha/i);

    // a deep link works
    await pub.goto(`/verify/${umaTx}`);
    await expect(pub.getByText("Ballot recorded")).toBeVisible();
    await expect(pub.locator("dl.dl")).toContainText("Delhi");
    for (const n of allNames) expect(await pub.locator("body").innerText()).not.toContain(n);

    // an unknown hash is a role=alert, not a crash
    await pub.goto(`/verify/0x${"ab".repeat(32)}`);
    await expect(pub.getByRole("alert")).toContainText("No such transaction");
    await shot(pub, "life-public-verify-unknown");
    await scan(pub, "public /verify (unknown)");
    // an upper-case, padded paste is accepted and normalised
    await pub.goto("/verify");
    await pub.getByLabel("Transaction reference").fill(`  ${aliceTx.toUpperCase().replace("0X", "0x")}  `);
    await pub.getByRole("button", { name: "Verify receipt" }).click();
    await expect(pub.getByText("Ballot recorded")).toBeVisible();
  });

  test("results are not published and no tally is served while voting is open", async () => {
    const before = publicBodies.length;
    await pub.goto("/results");
    await expect(pub.getByText(/published after the election closes/i).first()).toBeVisible();
    await expect(pub.locator(".phase-banner")).toContainText("Open");
    await expect(pub.getByRole("table")).toHaveCount(0);
    expect(await pub.locator("main").innerText()).not.toMatch(/\d/);
    await shot(pub, "life-public-results-open");
    await scan(pub, "public /results (Open)");
    // every /public/* response seen so far: nothing resembling a tally or a vote count
    for (const b of publicBodies) {
      if (b.url.includes("/public/receipts/") && b.status === 200) continue; // a ballot's position is not a tally
      expect(b.text, `${b.url} must carry no tallies`).not.toMatch(/"votes"|"totalVotes"|"totalBallots"|"tally"|"count"/i);
    }
    const res = publicBodies.slice(before).find((b) => b.url.endsWith("/public/results"));
    expect(res?.status).toBe(403);
    expect(res?.text).toContain("RESULTS_NOT_AVAILABLE");
    const election = await (await fetch(`${API}/public/election`)).text();
    expect(election).not.toMatch(/votes|tally|totalBallots|ballotCount/i);
    // election page: phase Open, still no counts
    await pub.goto("/election");
    await expect(pub.locator(".phase-banner")).toContainText("Open");
    expect(await pub.locator("main").innerText()).not.toMatch(/\d+\s+votes?|ballots? recorded/i);
    pubGuard.assertClean("public pages while Open");
  });
});

// ===================================================================================================== ADMIN CLOSE
test.describe("closing the election", () => {
  test("close through the dialog with a typed phrase and a fresh code; header flips only after the backend confirms", async () => {
    await adm.goto("/admin/election");
    await expect(adm.getByRole("heading", { level: 1, name: "Election control" })).toBeVisible();
    await expect(adm.locator(".summary")).toContainText("Ballots recorded");
    await expect(adm.locator(".summary")).toContainText("2"); // two ballots recorded
    const opener = adm.getByRole("button", { name: "Close election" });
    await opener.click();
    const dlg = adm.getByRole("dialog", { name: "Close the election?" });
    await expect(dlg).toBeVisible();
    await expect(dlg.getByText(/cannot be reopened/i)).toBeVisible();
    expect(await adm.evaluate(() => document.activeElement?.tagName)).toBe("H2");
    await shot(adm, "life-admin-close-dialog");
    await scan(adm, "admin close dialog");
    await adm.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(opener).toBeFocused();
    expect(await backendPhase()).toBe("Open");

    await opener.click();
    const confirm = dlg.getByRole("button", { name: "Close election" });
    await expect(confirm).toBeDisabled();
    await dlg.getByLabel(/Type CLOSE ELECTION/).fill("CLOSE ELECTION");
    await expect(confirm).toBeDisabled();
    await dlg.getByLabel("Fresh authenticator code").fill(await freshTotp(secret, used));
    await expect(confirm).toBeEnabled();
    await adm.route("**/api/v1/admin/election/close", async (route) => {
      await sleep(1500);
      await route.continue();
    });
    await confirm.click();
    await expect(dlg.getByRole("button", { name: "Closing election…" })).toBeVisible();
    await expect(adm.locator(".shell-header")).toContainText("Open");
    await expect(adm.locator(".shell-header")).toContainText("Closed", { timeout: 60_000 });
    await adm.unroute("**/api/v1/admin/election/close");
    await expect(dlg).toBeHidden();
    expect(await backendPhase()).toBe("Closed");
    await expect(adm.getByRole("status").filter({ hasText: "Election closed" })).toBeVisible();
    // no way back: no open / reopen control anywhere in the console
    await expect(adm.getByRole("button", { name: /open|reopen/i })).toHaveCount(0);
    await expect(adm.getByRole("link", { name: /reopen/i })).toHaveCount(0);
    await shot(adm, "life-admin-election-closed", true);
    await scan(adm, "admin /election (Closed)");
    for (const [p, label] of [["voters", "Voters"], ["constituencies", "Constituencies"], ["candidates", "Candidates"], ["biometrics", "Biometrics"], ["system", "System"]] as const) {
      await adm.getByRole("link", { name: label, exact: true }).click();
      await expect(adm.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(adm.locator("main").getByRole("button", { name: /^(add|edit|delete|reset|open|reopen)/i })).toHaveCount(0);
      void p;
    }
    // sign out works and the session is really gone
    await adm.getByRole("button", { name: "Sign out" }).click();
    await expect(adm).toHaveURL(/\/admin\/login/);
    await adm.goto("/admin/election");
    await expect(adm).toHaveURL(/\/admin\/login/);
    await expectNoBrowserState(adm, "after the whole admin flow");
    admGuard.allow({ status: 401, url: "/admin/" });
    admGuard.assertClean("admin flows");
  });
});

// ===================================================================================================== AFTER CLOSE
test.describe("after the election has closed", () => {
  test("results grouped by constituency with the right numbers; no global winner", async () => {
    await pub.setViewportSize({ width: 1280, height: 800 });
    await pub.goto("/results");
    await expect(pub.getByRole("heading", { level: 2, name: /Bengaluru/ })).toBeVisible();
    await expect(pub.getByRole("heading", { level: 2, name: /Delhi/ })).toBeVisible();
    await expect(pub.getByRole("heading", { level: 2, name: /Mumbai/ })).toBeVisible();
    await expect(pub.locator(".phase-banner")).toContainText("Closed");
    const num = async (table: string, rowName: string) => Number((await pub.getByRole("region", { name: `${table} results` }).getByRole("row", { name: new RegExp(rowName) }).locator("td.num").innerText()).replace(/\D/g, ""));
    expect(await num("Bengaluru", "Neha Joshi")).toBe(1);
    expect(await num("Bengaluru", "Amit Sharma")).toBe(0);
    expect(await num("Delhi", umaPick)).toBe(1);
    expect(await num("Delhi", names["DL-DEL"][0])).toBe(0);
    expect(await num("Bengaluru", "Constituency total")).toBe(1);
    expect(await num("Delhi", "Constituency total")).toBe(1);
    expect(await num("Mumbai", "Constituency total")).toBe(0);
    await expect(pub.locator(".summary")).toContainText("Ballots recorded");
    await expect(pub.locator(".summary")).toContainText("2");
    // per-constituency presentation only: no winner / elected / overall leader
    expect((await pub.locator("main").innerText()).replace(/not combined into a single winner/i, "")).not.toMatch(/winner|elected|leading|overall|national|majority|highest/i);
    await shot(pub, "life-public-results-closed", true);
    await scan(pub, "public /results (Closed)");
    expect(publicBodies.filter((b) => b.url.endsWith("/public/results")).at(-1)?.status).toBe(200);
    // verify still works and still never names the candidate
    await pub.goto(`/verify/${aliceTx}`);
    await expect(pub.getByText("Ballot recorded")).toBeVisible();
    for (const n of Object.values(names).flat()) expect(await pub.locator("body").innerText()).not.toContain(n);
    await scan(pub, "public /verify (Closed)");
    await pub.goto("/election");
    await expect(pub.locator(".phase-banner")).toContainText("Closed");
    await scan(pub, "public /election (Closed)");
    for (const p of ["/", "/trust", "/accessibility"]) {
      await pub.goto(p);
      await expect(pub.locator(".shell-meta")).toContainText("Closed");
    }
    await expectNoBrowserState(pub, "after the public flows");
    pubGuard.assertClean("public pages (whole spec)");
  });

  test("the kiosk says voting has closed and cannot start a session", async () => {
    await kio.goto("/vote");
    await expect(kio.getByRole("heading", { level: 1, name: "VoteChain Secure Polling Terminal" })).toBeVisible();
    await expect(kio.getByText("Voting has closed").first()).toBeVisible();
    await expect(kio.getByRole("button", { name: "Begin" })).toHaveCount(0);
    await expect(kio.locator(".shell-header")).toContainText("Closed");
    await shot(kio, "life-kiosk-welcome-closed");
    await scan(kio, "kiosk welcome (Closed)");
    // going around the UI does not help: the server refuses the login and sets no session cookie
    const r = await kioCtx.request.post(`${API}/voter/auth/login`, { data: { identifier: carolId, password: VOTER_PASSWORD }, failOnStatusCode: false });
    expect(r.ok()).toBe(false);
    expect(await kioCtx.cookies()).toEqual([]);
    expect((await kioCtx.request.post(`${API}/voter/eligibility/check`, { data: {}, failOnStatusCode: false })).ok()).toBe(false);
    await kio.reload();
    await expect(kio.getByRole("button", { name: "Begin" })).toHaveCount(0);
    kioGuard.allow({ status: 401, url: "/voter/" }, { status: 403, url: "/voter/" }, { status: 409, url: "/voter/" });
    kioGuard.assertClean("kiosk flows");
  });

  test("quality gates collected during the run: axe, structure, forbidden claims, secrets", async () => {
    expect(problems).toEqual([]);
    expect(JSON.stringify(await storageDump(kio))).not.toContain(secret);
  });
});
