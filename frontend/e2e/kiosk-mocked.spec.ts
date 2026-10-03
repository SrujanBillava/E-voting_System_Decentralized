import { expect, test, type Page, type Request } from "@playwright/test";
import { Guard, auditPage, shot, textViolations } from "./helpers";

/**
 * Kiosk states that are hard or impossible to produce on the real chain, driven with page.route stubs (no backend, no chain).
 * Every test starts its own stub server in the page; /api/v1 calls without a stub are recorded and fail the test.
 *
 * The tests also run against the dev server (React StrictMode double-runs effects), which these flows must survive.
 */

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  abort?: boolean;
}
type Handler = (req: Request, n: number) => Reply | Promise<Reply>;
const ok = (data: unknown, status = 200): Reply => ({ status, body: { data } });
const fail = (status: number, code: string, message = "stub message", details?: Record<string, unknown>): Reply => ({ status, body: { error: { code, message, requestId: "stub", details } } });
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const VOTER = { voterId: "VC-STUBVOTER1", name: "Stub Voter", constituencyCode: "KA-BLR", faceEnrolled: true };
const CANDS = [
  { candidateId: "1", name: "Amit Sharma" },
  { candidateId: "2", name: "Rahul Verma" },
  { candidateId: "3", name: "Neha Joshi" },
];
const TX = "0x" + "c".repeat(64);
const RECEIPT = { txHash: TX, blockNumber: 42, blockHash: "0x" + "d".repeat(64), ballotIndex: "7", contractAddress: "0x" + "1".repeat(40), chainId: 31337, electionId: "0x" + "e".repeat(64), confirmedAt: iso(0), verifyUrl: `/verify/${TX}` };

const status = (stage: string, phase = "Open") => ok({ voter: VOTER, stage, stageExpiresAt: iso(300_000), sessionExpiresAt: iso(600_000), electionPhase: phase });
const confirmedReceipt = (name = "Neha Joshi") => ok({ stage: "COMPLETED", state: "CONFIRMED", stageExpiresAt: iso(60_000), receipt: RECEIPT, recordedSelection: { name } });

class Stub {
  calls: Record<string, Request[]> = {};
  unstubbed: string[] = [];
  handlers: Record<string, Handler>;
  constructor(page: Page, handlers: Record<string, Handler>) {
    this.handlers = {
      "GET /public/election": () => ok({ electionId: RECEIPT.electionId, phase: "Open", contractAddress: RECEIPT.contractAddress, chainId: 31337, constituencies: [] }),
      "GET /voter/status": () => fail(401, "UNAUTHENTICATED"),
      "GET /voter/ballot": () => ok({ electionId: RECEIPT.electionId, constituency: { code: "KA-BLR", name: "Bengaluru" }, candidates: CANDS }),
      "POST /voter/auth/logout": () => ({ status: 204 }),
      ...handlers,
    };
    void page.route("**/api/v1/**", async (route) => {
      const req = route.request();
      const key = `${req.method()} ${new URL(req.url()).pathname.replace("/api/v1", "")}`;
      (this.calls[key] ??= []).push(req);
      const h = this.handlers[key];
      if (!h) {
        this.unstubbed.push(key);
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "UNSTUBBED", message: key } }) });
      }
      const r = await h(req, this.calls[key].length);
      if (r.abort) return route.abort("failed");
      if (r.status === 204) return route.fulfill({ status: 204 });
      return route.fulfill({ status: r.status, contentType: "application/json", headers: r.headers, body: JSON.stringify(r.body ?? {}) });
    });
  }
  count = (key: string) => this.calls[key]?.length ?? 0;
}

let guard: Guard;
test.beforeEach(async ({ page }) => {
  guard = new Guard(page, []);
  await page.setViewportSize({ width: 1024, height: 768 });
});
test.afterEach(() => {
  expect({ errors: guard.errors, external: guard.external, dialogs: guard.dialogs }).toEqual({ errors: [], external: [], dialogs: [] });
});

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

/** Walks the ballot -> review -> confirm path for a stub whose server stage is ELIGIBLE. */
async function pickAndConfirm(page: Page, name = "Neha Joshi") {
  await expect(h1(page, "Your ballot")).toBeVisible();
  await page.getByRole("radio", { name }).check();
  await page.getByRole("button", { name: "Review my selection" }).click();
  await expect(h1(page, "Review your selection")).toBeVisible();
  await page.getByRole("button", { name: "Confirm and cast vote" }).click();
}

test.describe("eligibility", () => {
  test("VOTE_IN_FLIGHT: says the ballot is still being confirmed, polls, never offers the ballot, then resolves", async ({ page }) => {
    const stub = new Stub(page, {
      "GET /voter/status": () => status("FACE_VERIFIED"),
      "POST /voter/eligibility/check": (_r, n) => (n < 3 ? fail(409, "VOTE_IN_FLIGHT", "in flight") : fail(409, "ALREADY_VOTED", "done", { receiptAvailable: true })),
    });
    await page.goto("/vote");
    await expect(h1(page, "Your ballot is still being confirmed")).toBeVisible();
    await expect(page.getByText(/still being confirmed/i).first()).toBeVisible();
    await expect(page.getByText("You do not need to vote again.")).toBeVisible();
    await shot(page, "mock-kiosk-in-flight");
    // never offers the ballot or any way to cast
    await expect(page.getByRole("button", { name: /view my ballot|begin|review|confirm|cast/i })).toHaveCount(0);
    await expect(page.getByRole("radio")).toHaveCount(0);
    // it looks again by itself (every ~3 s) and follows the server answer once the ballot is final
    await expect(h1(page, "A ballot has already been accepted")).toBeVisible({ timeout: 15_000 });
    expect(stub.count("POST /voter/eligibility/check")).toBe(3);
    expect(stub.count("GET /voter/ballot") + stub.count("POST /voter/authorization") + stub.count("POST /voter/cast")).toBe(0);
    expect(stub.unstubbed).toEqual([]);
  });

  test("ALREADY_VOTED with receiptAvailable=false: exact wording, no receipt button, no way to vote", async ({ page }) => {
    const stub = new Stub(page, {
      "GET /voter/status": () => status("FACE_VERIFIED"),
      "POST /voter/eligibility/check": () => fail(409, "ALREADY_VOTED", "x", { receiptAvailable: false }),
    });
    await page.goto("/vote");
    await expect(h1(page, "A ballot has already been accepted")).toBeVisible();
    await expect(page.getByText("This election already contains an accepted ballot for your voter authorization. A receipt cannot be recovered from this terminal.")).toBeVisible();
    await expect(page.getByRole("button", { name: /receipt/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /ballot|vote|begin|try again/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "End session" })).toBeVisible();
    await shot(page, "mock-kiosk-already-voted-no-receipt");
    const probs: string[] = [];
    await auditPage(page, "already voted (no receipt)", probs);
    expect(probs).toEqual([]);
    expect(stub.unstubbed).toEqual([]);
  });

  test("ALREADY_VOTED with receiptAvailable=true offers the receipt, which then shows the confirmed receipt", async ({ page }) => {
    let stage = "FACE_VERIFIED";
    const stub = new Stub(page, {
      "GET /voter/status": () => status(stage),
      "POST /voter/eligibility/check": () => {
        stage = "COMPLETED";
        return fail(409, "ALREADY_VOTED", "x", { receiptAvailable: true });
      },
      "GET /voter/receipt": () => confirmedReceipt(),
    });
    await page.goto("/vote");
    await page.getByRole("button", { name: "View my receipt" }).click();
    await expect(h1(page, "Your vote has been recorded")).toBeVisible();
    await expect(page.locator(".receipt")).toContainText(TX);
    expect(stub.unstubbed).toEqual([]);
  });

  test("a network failure while checking eligibility offers 'Try again'; ELECTION_CLOSED shows the closed notice", async ({ page }) => {
    let closed = false; // the server answers /status the same way once the election is closed (it decides, not the browser)
    const stub = new Stub(page, {
      "GET /voter/status": () => (closed ? fail(409, "ELECTION_CLOSED", "closed") : status("FACE_VERIFIED")),
      "POST /voter/eligibility/check": (_r, n) => (n === 1 ? { status: 0, abort: true } : ((closed = true), fail(409, "ELECTION_CLOSED", "closed"))),
    });
    await page.goto("/vote");
    await expect(h1(page, "We could not check your eligibility")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(h1(page, "Voting is closed")).toBeVisible();
    expect(stub.unstubbed).toEqual([]);
  });
});

test.describe("casting and receipts", () => {
  test("RECONCILIATION_REQUIRED from /cast: ask an official, and there is no way to vote again", async ({ page }) => {
    const stub = new Stub(page, {
      "GET /voter/status": () => status("ELIGIBLE"),
      "POST /voter/authorization": () => ok({ ticketId: "t1", stage: "AUTH_ISSUED", expiresAt: iso(120_000) }),
      "POST /voter/cast": () => fail(409, "RECONCILIATION_REQUIRED", "needs reconciliation"),
    });
    await page.goto("/vote");
    await pickAndConfirm(page);
    await expect(h1(page, "Please ask a polling official")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(/checked by an election official/i);
    await expect(page.getByRole("alert")).toContainText(/Do not try to vote again/i);
    await expect(page.getByRole("button", { name: /try again|retry|vote|cast|confirm/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "End session" })).toBeVisible();
    await shot(page, "mock-kiosk-reconciliation");
    expect(stub.count("POST /voter/cast")).toBe(1);
    expect(stub.count("POST /voter/authorization")).toBe(1);
    expect(stub.unstubbed).toEqual([]);
  });

  test("VOTE_NOT_RECORDED from /receipt: safe message and no 'vote again' control", async ({ page }) => {
    const stub = new Stub(page, {
      "GET /voter/status": () => status("SUBMITTED"),
      "GET /voter/receipt": () => fail(409, "VOTE_NOT_RECORDED", "tx reverted: 0xdeadbeef RPC node error at https://internal"),
    });
    await page.goto("/vote");
    await expect(h1(page, "Your ballot was not recorded")).toBeVisible();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText(/ask a polling official/i);
    await expect(alert).toContainText(/do not try to vote again/i);
    await expect(page.getByRole("button", { name: /again|retry|vote|cast|confirm|begin|ballot/i })).toHaveCount(0);
    expect(await page.locator("body").innerText()).not.toMatch(/deadbeef|internal|revert/i); // the raw backend text is replaced by safe wording
    await shot(page, "mock-kiosk-vote-not-recorded");
    expect(stub.unstubbed).toEqual([]);
  });

  test("a dropped connection on /cast is retried with the SAME Idempotency-Key and the cast body is empty", async ({ page }) => {
    let stage = "ELIGIBLE";
    const keys: (string | undefined)[] = [];
    const bodies: (string | null)[] = [];
    const stub = new Stub(page, {
      "GET /voter/status": () => status(stage),
      "POST /voter/authorization": () => {
        stage = "AUTH_ISSUED";
        return ok({ ticketId: "t1", stage, expiresAt: iso(120_000) });
      },
      "POST /voter/cast": (req, n) => {
        keys.push(req.headers()["idempotency-key"]);
        bodies.push(req.postData());
        if (n <= 2) return { status: 0, abort: true };
        stage = "SUBMITTED";
        return ok({ stage: "SUBMITTED", state: "CONFIRMED", txHash: TX });
      },
      "GET /voter/receipt": () => confirmedReceipt(),
    });
    await page.goto("/vote");
    // before the voter confirms, the server has not been asked to authorize anything
    await expect(h1(page, "Your ballot")).toBeVisible();
    await page.getByRole("radio", { name: "Neha Joshi" }).check();
    await page.getByRole("button", { name: "Review my selection" }).click();
    await expect(h1(page, "Review your selection")).toBeVisible();
    expect(stub.count("POST /voter/authorization")).toBe(0);
    expect(stub.count("POST /voter/cast")).toBe(0);
    await page.getByRole("button", { name: "Confirm and cast vote" }).click();
    await expect(h1(page, "Your vote has been recorded")).toBeVisible({ timeout: 30_000 });
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBeTruthy();
    expect(new Set(keys).size, `Idempotency-Key must be identical across retries: ${keys.join(", ")}`).toBe(1);
    for (const b of bodies) expect(JSON.parse(b ?? "{}")).toEqual({});
    expect(stub.count("POST /voter/authorization")).toBe(1); // the authorization is not repeated by a cast retry
    expect(JSON.parse(stub.calls["POST /voter/authorization"][0].postData() ?? "{}")).toEqual({ candidateId: "3" });
    expect(stub.unstubbed).toEqual([]);
  });

  test("after the bounded automatic retries, 'Try again' re-sends the SAME Idempotency-Key", async ({ page }) => {
    let stage = "ELIGIBLE";
    const keys: (string | undefined)[] = [];
    const stub = new Stub(page, {
      "GET /voter/status": () => status(stage),
      "POST /voter/authorization": () => {
        stage = "AUTH_ISSUED";
        return ok({ ticketId: "t1", stage, expiresAt: iso(120_000) });
      },
      "POST /voter/cast": (req, n) => {
        keys.push(req.headers()["idempotency-key"]);
        if (n <= 4) return { status: 0, abort: true };
        stage = "SUBMITTED";
        return ok({ stage, state: "CONFIRMED", txHash: TX });
      },
      "GET /voter/receipt": () => confirmedReceipt(),
    });
    await page.goto("/vote");
    await pickAndConfirm(page);
    await expect(h1(page, "Connection problem")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("alert")).toContainText(/not confirmed yet/i);
    await shot(page, "mock-kiosk-connection-problem");
    expect(keys).toHaveLength(4);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(h1(page, "Your vote has been recorded")).toBeVisible({ timeout: 15_000 });
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size, `keys: ${keys.join(", ")}`).toBe(1);
    expect(stub.count("POST /voter/authorization")).toBe(1);
  });

  test("receipt 202 PENDING keeps polling, then the 200 receipt appears", async ({ page }) => {
    const stub = new Stub(page, {
      "GET /voter/status": () => status("SUBMITTED"),
      "GET /voter/receipt": (_r, n) => (n <= 2 ? ok({ stage: "SUBMITTED", state: "PENDING", txHash: TX }, 202) : confirmedReceipt()),
    });
    await page.goto("/vote");
    await expect(h1(page, "Confirming your ballot")).toBeVisible();
    await expect(page.getByText("Waiting for confirmation…")).toBeVisible();
    await shot(page, "mock-kiosk-receipt-pending");
    await expect(h1(page, "Your vote has been recorded")).toBeVisible({ timeout: 15_000 });
    expect(stub.count("GET /voter/receipt")).toBe(3);
    await expect(page.locator(".recorded-selection")).toContainText("Neha Joshi");
    await expect(page.locator(".receipt")).toContainText("7"); // ballot number
    expect(stub.unstubbed).toEqual([]);
  });

  test("a receipt that stays pending says it is taking longer and that the ballot is not lost", async ({ page }) => {
    const stub = new Stub(page, {
      "GET /voter/status": () => status("SUBMITTED"),
      "GET /voter/receipt": () => ok({ stage: "SUBMITTED", state: "PENDING", txHash: TX }, 202),
    });
    await page.clock.install();
    await page.goto("/vote");
    await expect(h1(page, "Confirming your ballot")).toBeVisible();
    for (let i = 0; i < 40 && !(await page.getByText(/taking longer than usual/i).first().isVisible()); i++) {
      await page.clock.fastForward(1600); // one poll interval; the response arrives in real time
      await page.waitForTimeout(80);
    }
    await expect(page.getByText(/taking longer than usual/i).first()).toBeVisible();
    await expect(page.getByText(/has not been lost/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /vote|cast|again/i })).toHaveCount(0);
    expect(stub.count("GET /voter/receipt")).toBeGreaterThan(10);
  });
});

test.describe("session and service problems", () => {
  const sessionExpiryScenario = async (page: Page) => {
    let signedIn = false;
    const stub = new Stub(page, {
      "GET /voter/status": () => (signedIn ? status("ELIGIBLE") : fail(401, "UNAUTHENTICATED")),
      "POST /voter/auth/login": () => {
        signedIn = true;
        return ok({ voter: VOTER, stage: "AUTHENTICATED", stageExpiresAt: iso(300_000) });
      },
      "POST /voter/authorization": () => {
        signedIn = false;
        return fail(401, "SESSION_EXPIRED", "expired");
      },
    });
    await page.goto("/vote");
    await page.getByRole("button", { name: "Begin" }).click();
    await page.getByLabel("Voter ID or email").fill("stub@example.org");
    await page.getByLabel("Password").fill("whatever password 1");
    await page.getByRole("button", { name: "Sign in" }).click();
    await pickAndConfirm(page);
    await expect(h1(page, "VoteChain Secure Polling Terminal").or(h1(page, "Sign in"))).toBeVisible();
    return stub;
  };

  test("SESSION_EXPIRED (401) in the middle of casting ends the session and clears the previous voter's choice", async ({ page }) => {
    const stub = await sessionExpiryScenario(page);
    expect(await page.locator("body").innerText()).not.toContain("Neha Joshi");
    expect(stub.count("POST /voter/cast")).toBe(0);
    expect(stub.unstubbed).toEqual([]);
  });

  test("an expired session returns to the WELCOME screen, not the Sign in form", async ({ page }) => {
    await sessionExpiryScenario(page);
    await expect(h1(page, "VoteChain Secure Polling Terminal")).toBeVisible();
  });

  test("ELECTION_CLOSED (409) while confirming shows the closed notice, not an error", async ({ page }) => {
    let closed = false;
    const stub = new Stub(page, {
      "GET /voter/status": () => (closed ? fail(409, "ELECTION_CLOSED", "closed") : status("ELIGIBLE")),
      "POST /voter/authorization": () => ((closed = true), fail(409, "ELECTION_CLOSED", "closed")),
    });
    await page.goto("/vote");
    await pickAndConfirm(page);
    await expect(h1(page, "Voting is closed")).toBeVisible();
    await expect(page.getByText(/no longer accepting ballots/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Return to the start" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await shot(page, "mock-kiosk-closed-notice");
    expect(stub.count("POST /voter/cast")).toBe(0);
    await page.getByRole("button", { name: "Return to the start" }).click();
    await expect(h1(page, "VoteChain Secure Polling Terminal")).toBeVisible();
  });

  test("the voting service being unavailable (503) shows a notice with a retry that recovers", async ({ page }) => {
    let up = false;
    const stub = new Stub(page, {
      "GET /voter/status": () => (up ? fail(401, "UNAUTHENTICATED") : fail(503, "CHAIN_UNAVAILABLE", "node down")),
    });
    await page.goto("/vote");
    await expect(h1(page, "This terminal cannot reach the voting service")).toBeVisible();
    await expect(page.getByText(/ask a polling official/i)).toBeVisible();
    await shot(page, "mock-kiosk-unavailable");
    up = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(h1(page, "VoteChain Secure Polling Terminal")).toBeVisible();
    expect(stub.unstubbed).toEqual([]);
  });

  test("a network failure while loading the terminal shows the same unavailable notice", async ({ page }) => {
    new Stub(page, { "GET /voter/status": () => ({ status: 0, abort: true }) });
    await page.goto("/vote");
    await expect(h1(page, "This terminal cannot reach the voting service")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("ballot load failure offers a retry and never shows a partial ballot", async ({ page }) => {
    let failing = true; // flipped before the retry; independent of how many requests React (StrictMode) makes
    new Stub(page, {
      "GET /voter/status": () => status("ELIGIBLE"),
      "GET /voter/ballot": () => (failing ? fail(503, "CHAIN_UNAVAILABLE") : ok({ electionId: RECEIPT.electionId, constituency: { code: "KA-BLR", name: "Bengaluru" }, candidates: CANDS })),
    });
    await page.goto("/vote");
    await expect(page.getByText(/could not be loaded/i).first()).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review my selection" })).toBeDisabled();
    failing = false;
    await page.getByRole("button", { name: /try again|retry/i }).click();
    await expect(page.getByRole("radio")).toHaveCount(3);
    await expect(page.locator("input[type=radio]:checked")).toHaveCount(0);
  });
});

test.describe("one voter after another on the same terminal", () => {
  test("the next voter must not inherit the previous voter's UI state (no preselection, no automatic casting)", async ({ page }) => {
    let who: "none" | "first" | "second" = "none";
    let stage = "ELIGIBLE";
    const stub = new Stub(page, {
      "GET /voter/status": () => (who === "none" ? fail(401, "UNAUTHENTICATED") : status(stage)),
      "POST /voter/auth/login": () => {
        who = who === "none" && stub.count("POST /voter/auth/login") === 1 ? "first" : "second";
        stage = who === "first" ? "ELIGIBLE" : "FACE_VERIFIED";
        return ok({ voter: VOTER, stage, stageExpiresAt: iso(300_000) });
      },
      "POST /voter/authorization": () => {
        stage = "AUTH_ISSUED";
        return ok({ ticketId: "t", stage, expiresAt: iso(120_000) });
      },
      "POST /voter/cast": () => {
        stage = "SUBMITTED";
        return ok({ stage, state: "CONFIRMED", txHash: TX });
      },
      "GET /voter/receipt": () => confirmedReceipt(),
      "POST /voter/auth/logout": () => {
        who = "none";
        return { status: 204 };
      },
      "POST /voter/eligibility/check": () => {
        stage = "ELIGIBLE";
        return ok({ eligible: true, stage, stageExpiresAt: iso(300_000), electionId: RECEIPT.electionId, constituency: { code: "KA-BLR", name: "Bengaluru" } });
      },
    });
    const signIn = async () => {
      const begin = page.getByRole("button", { name: "Begin" });
      await expect(begin.or(page.getByLabel("Voter ID or email"))).toBeVisible();
      if (await begin.isVisible()) await begin.click();
      await page.getByLabel("Voter ID or email").fill("v@example.org");
      await page.getByLabel("Password").fill("password password 1");
      await page.getByRole("button", { name: "Sign in" }).click();
    };
    await page.goto("/vote");
    await signIn(); // voter one, same page, no reload from here on
    await pickAndConfirm(page, "Neha Joshi");
    await expect(h1(page, "Your vote has been recorded")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();

    // voter two (same constituency) now signs in; the terminal is the same React tree
    await expect(h1(page, "VoteChain Secure Polling Terminal").or(h1(page, "Sign in"))).toBeVisible();
    await signIn();
    await page.getByRole("button", { name: "View my ballot" }).click();
    await expect(h1(page, "Your ballot")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("input[type=radio]:checked")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review my selection" })).toBeDisabled();
    expect(stub.count("POST /voter/authorization"), "voter two must not be authorized without choosing").toBe(1);
  });
});

test.describe("screens at the kiosk and tablet sizes", () => {
  for (const vp of [
    { w: 1024, h: 768, n: "1024x768" },
    { w: 768, h: 1024, n: "768x1024" },
    { w: 390, h: 844, n: "390x844" },
  ]) {
    test(`ballot, review and receipt layout at ${vp.n}: no overflow, the pinned action bar never hides the primary action`, async ({ page }) => {
      await page.setViewportSize({ width: vp.w, height: vp.h });
      let stage = "ELIGIBLE";
      new Stub(page, {
        "GET /voter/status": () => status(stage),
        "GET /voter/ballot": () => ok({ electionId: RECEIPT.electionId, constituency: { code: "KA-BLR", name: "Bengaluru" }, candidates: [...CANDS, ...[4, 5, 6, 7].map((i) => ({ candidateId: String(i), name: `Candidate Number ${i}` }))] }),
        "POST /voter/authorization": () => ok({ ticketId: "t", stage: (stage = "AUTH_ISSUED"), expiresAt: iso(120_000) }),
        "POST /voter/cast": () => ok({ stage: (stage = "SUBMITTED"), state: "CONFIRMED", txHash: TX }),
        "GET /voter/receipt": () => confirmedReceipt(),
      });
      await page.goto("/vote");
      await expect(h1(page, "Your ballot")).toBeVisible();
      const probs: string[] = [];
      await auditPage(page, `ballot ${vp.n}`, probs);
      // the pinned bar's buttons are inside the viewport and not clipped
      const bar = await page.locator(".shell-footer .btn").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, h: r.height }; }));
      for (const b of bar) {
        expect(b.l).toBeGreaterThanOrEqual(0);
        expect(b.r).toBeLessThanOrEqual(vp.w + 0.5);
        if (vp.w > 640) expect(b.b).toBeLessThanOrEqual(vp.h + 0.5); // on a phone the bar is not pinned (a phone is not a kiosk); the button is reached by scrolling
        expect(b.h).toBeGreaterThanOrEqual(44);
      }
      // radio rows are tall enough for touch
      const rows = await page.locator(".choice").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      for (const r of rows) expect(r).toBeGreaterThanOrEqual(56);
      // how many candidates are visible without scrolling (recorded as an annotation, judged in the report)
      const visibleRows = await page.locator(".choice").evaluateAll((els, h) => els.filter((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= h - (document.querySelector(".shell-footer")?.getBoundingClientRect().height ?? 0); }).length, vp.h);
      test.info().annotations.push({ type: "visible-candidates-without-scrolling", description: `${vp.n}: ${visibleRows} of 7` });
      await shot(page, `mock-kiosk-ballot-${vp.n}`);
      await page.getByRole("radio", { name: "Candidate Number 7" }).check();
      await shot(page, `mock-kiosk-ballot-last-selected-${vp.n}`);
      // the last row can be scrolled clear of the pinned bar
      const clear = await page.getByRole("radio", { name: "Candidate Number 7" }).evaluate((e) => { window.scrollTo(0, document.documentElement.scrollHeight); const r = e.closest("label")!.getBoundingClientRect(); return document.querySelector(".shell-footer")!.getBoundingClientRect().top - r.bottom; });
      expect(clear, "last candidate row hidden behind the pinned action bar").toBeGreaterThanOrEqual(0);
      await page.getByRole("button", { name: "Review my selection" }).click();
      await expect(h1(page, "Review your selection")).toBeVisible();
      await auditPage(page, `review ${vp.n}`, probs);
      await shot(page, `mock-kiosk-review-${vp.n}`);
      await page.getByRole("button", { name: "Confirm and cast vote" }).click();
      await expect(h1(page, "Your vote has been recorded")).toBeVisible({ timeout: 15_000 });
      await auditPage(page, `receipt ${vp.n}`, probs);
      await shot(page, `mock-kiosk-receipt-${vp.n}`);
      // the transaction reference can be reached by scrolling and is not hidden behind the bar
      const txClear = await page.locator(".receipt .dl-row", { hasText: "Transaction" }).evaluate((e) => { window.scrollTo(0, document.documentElement.scrollHeight); return document.querySelector(".shell-footer")!.getBoundingClientRect().top - e.getBoundingClientRect().bottom; });
      expect(txClear).toBeGreaterThanOrEqual(0);
      expect(probs).toEqual([]);
      const forbidden = await textViolations(page);
      expect(forbidden).toEqual([]);
    });
  }
});
