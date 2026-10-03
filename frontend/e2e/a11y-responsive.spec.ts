import { expect, test, type Page } from "@playwright/test";
import { ADMIN, Guard, VIEWPORTS, VOTER_PASSWORD, adminLogin, axeViolations, backendPhase, expectNoBrowserState, fixture, newContext, shot, structureProblems, textViolations } from "./helpers";

/**
 * Accessibility + responsive sweep of every route, at four viewports, against the REAL backend (election in Setup).
 * Needs a Setup election (reset-e2e.sh); it never changes the election phase. It resets the e2e database itself (voters/admin only).
 * Per page: axe (WCAG 2.0/2.1/2.2 A+AA, includes target size and contrast), exactly one h1 / banner / main, no horizontal overflow,
 * skip link first and working, touch-target heights, minimum text size, and the design contract's "no shadow / gradient / big radius".
 */
const used = new Set<string>();
let secret = "";
const PUBLIC = ["/", "/election", "/verify", "/results", "/trust", "/accessibility"];
const ADMIN_PAGES = ["election", "voters", "constituencies", "candidates", "biometrics", "system"];
const VP = [...VIEWPORTS, { name: "320x568", width: 320, height: 568 }] as const;
const findings: string[] = [];

const slug = (p: string) => (p === "/" ? "home" : p.replace(/^\//, "").replace(/\//g, "-"));

async function ready(page: Page) {
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(/Loading|Checking/i)).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined);
}

/** Facts about hit targets, text size and the "ballot paper" look, read from computed styles. */
async function styleFacts(page: Page, kiosk: boolean) {
  return page.evaluate((isKiosk) => {
    const out = { smallTargets: [] as string[], smallText: [] as string[], shadows: [] as string[], gradients: [] as string[], radii: [] as string[] };
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const label = (e: Element) => `${e.tagName.toLowerCase()}${(e as HTMLElement).className ? "." + String((e as HTMLElement).className).split(" ")[0] : ""} "${(e.textContent ?? "").trim().slice(0, 28)}"`;
    // design contract: 44px public, 56px kiosk, 40px admin (dense desktop console; WCAG 2.2 AA needs 24px, which axe checks)
    const minTarget = isKiosk ? 56 : document.querySelector(".shell-admin") ? 40 : 44;
    for (const e of document.querySelectorAll("button, .btn, input:not([type=radio]):not([type=checkbox]), select, .shell-link, .choice, summary")) {
      if (!visible(e) || e.closest(".visually-hidden") || e.closest("dialog:not([open])")) continue;
      const r = e.getBoundingClientRect();
      const small = (e as HTMLElement).classList.contains("btn-sm");
      if (r.height + 0.5 < (small ? 32 : minTarget) && !e.matches(".skip-link")) out.smallTargets.push(`${label(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent ?? "").trim();
      const p = n.parentElement;
      if (!t || !p || !visible(p) || p.closest(".visually-hidden") || ["SCRIPT", "STYLE"].includes(p.tagName)) continue;
      const fs = parseFloat(getComputedStyle(p).fontSize);
      if (fs < (isKiosk ? 14 : 12)) out.smallText.push(`${fs}px "${t.slice(0, 30)}"`);
    }
    for (const e of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(e);
      if (cs.display === "none") continue;
      if (cs.boxShadow !== "none") out.shadows.push(`${label(e)} ${cs.boxShadow.slice(0, 40)}`);
      if (cs.backgroundImage.includes("gradient")) out.gradients.push(`${label(e)}`);
      const radius = Math.max(...["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"].map((k) => parseFloat((cs as unknown as Record<string, string>)[k]) || 0));
      const round = e.matches("input[type=radio], input[type=checkbox], .spinner, .brand-mark, .status::before, .step-num");
      if (radius > 4 && !round && !/%/.test(cs.borderTopLeftRadius)) out.radii.push(`${label(e)} ${radius}px`);
    }
    return out;
  }, kiosk);
}

async function auditAt(page: Page, label: string, kiosk = false, opts: { style?: boolean } = {}) {
  await ready(page);
  const a = await axeViolations(page);
  const s = await structureProblems(page);
  const bad = await textViolations(page, [secret]);
  for (const v of [...a.map((x) => `axe ${x}`), ...s, ...bad]) findings.push(`[${label}] ${v}`);
  if (opts.style !== false) {
    const f = await styleFacts(page, kiosk);
    for (const [k, v] of Object.entries(f)) if (v.length) findings.push(`[${label}] ${k}: ${v.slice(0, 4).join("; ")}${v.length > 4 ? ` (+${v.length - 4})` : ""}`);
  }
}

/** The skip link is the first tab stop and moves focus to <main>. */
async function skipLinkWorks(page: Page, label: string) {
  await page.reload(); // a fresh document: sequential focus starts at the top
  await ready(page);
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => ({ text: (document.activeElement as HTMLElement)?.textContent?.trim(), cls: (document.activeElement as HTMLElement)?.className, onScreen: (() => { const r = document.activeElement!.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.width > 0 && r.height > 0; })() }));
  if (!/skip to main/i.test(first.text ?? "")) findings.push(`[${label}] first Tab stop is "${first.text}", not the skip link`);
  else if (!first.onScreen) findings.push(`[${label}] skip link takes focus but is not visible on screen`);
  await page.keyboard.press("Enter");
  const focused = await page.evaluate(() => document.activeElement?.id);
  if (focused !== "main") findings.push(`[${label}] activating the skip link leaves focus on "${focused}", not #main`);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const phase = await backendPhase();
  if (phase !== "Setup") throw new Error(`a11y-responsive.spec needs a Setup election (backend reports ${phase}). Run reset-e2e.sh first.`);
  fixture("reset");
  secret = fixture<{ totpSecret: string }>("admin", ADMIN.email, ADMIN.password).totpSecret;
  for (const [i, c] of ["KA-BLR", "DL-DEL", "MH-MUM"].entries()) fixture("voter", `Audit Voter ${i + 1} With A Fairly Long Display Name`, `audit.voter.${i + 1}.with.a.long.address@example.org`, VOTER_PASSWORD, c);
});

test.describe("public site", () => {
  for (const vp of VP) {
    test(`all public routes at ${vp.name}`, async ({ browser }) => {
      const ctx = await newContext(browser, { viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const guard = new Guard(page, [{ status: 403, url: "/public/results" }]);
      for (const route of [...PUBLIC, "/verify/0x" + "ab".repeat(32), "/nope"]) {
        await page.goto(route);
        await auditAt(page, `public ${route} @${vp.name}`);
        await shot(page, `a11y-public-${slug(route.slice(0, 18))}-${vp.name}`, true);
        guard.allow({ status: 404, url: "/public/receipts/" });
      }
      // navigation landmark: reachable, labelled, current page marked
      await page.goto("/election");
      await ready(page);
      await expect(page.getByRole("navigation", { name: "Public" }).getByRole("link", { name: "Election", exact: true })).toHaveAttribute("aria-current", "page");
      if (vp.width >= 1024) await skipLinkWorks(page, `public @${vp.name}`);
      guard.assertClean(`public @${vp.name}`);
      await ctx.close();
    });
  }

  test("client-side navigation moves focus to <main> and updates the title", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const nav = page.getByRole("navigation", { name: "Public" });
    for (const [name, h1] of [["Election", "The election"], ["Verify a receipt", "Verify a receipt"], ["Results", "Results"], ["Guarantees and limits", ""], ["Accessibility", "Accessibility"]] as const) {
      await nav.getByRole("link", { name, exact: true }).click();
      await expect(page.locator("main")).toBeFocused();
      const title = await page.title();
      if (h1) expect(title).toContain(h1);
      expect(title).toContain("VoteChain");
    }
    // keyboard-only: Tab through the whole header, every link shows a visible focus ring
    await page.goto("/");
    await ready(page);
    const ringless: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const f = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement;
        const cs = getComputedStyle(e);
        return { body: e === document.body, name: e.textContent?.trim().slice(0, 30), outline: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2 };
      });
      if (f.body) break; // tabbed past the last control: focus left the page
      if (!f.outline) ringless.push(f.name ?? "?");
    }
    expect(ringless, "focused elements without a visible 2px+ outline").toEqual([]);
  });

  test("verify form: errors are linked, announced and focus is managed", async ({ page }) => {
    await page.goto("/verify");
    await ready(page);
    await page.getByLabel("Transaction reference").fill("nonsense");
    await page.getByRole("button", { name: "Verify receipt" }).click();
    const input = page.getByLabel("Transaction reference");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    const described = await input.getAttribute("aria-describedby");
    expect(described).toContain("tx-err");
    await expect(page.locator("#tx-err")).toBeVisible();
    // the error text is announced: it sits in a live region or the field takes focus
    const announced = await page.evaluate(() => {
      const err = document.getElementById("tx-err");
      return !!err?.closest("[role=alert],[aria-live]") || document.activeElement?.id === "tx";
    });
    if (!announced) findings.push("[public /verify] invalid-input error (#tx-err) is neither in a live region nor does the input receive focus: screen readers are not told the submit failed");
    await shot(page, "a11y-verify-invalid");
  });
});

test.describe("voter kiosk", () => {
  for (const vp of VP) {
    test(`welcome and sign-in at ${vp.name}`, async ({ browser }) => {
      const ctx = await newContext(browser, { viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const guard = new Guard(page, []);
      await page.goto("/vote");
      await auditAt(page, `kiosk welcome (Setup) @${vp.name}`, true);
      await shot(page, `a11y-kiosk-welcome-setup-${vp.name}`);
      await expect(page.getByRole("button", { name: "Begin" })).toHaveCount(0);
      await expect(page.getByText(/has not opened yet/i)).toBeVisible();
      if (vp.width >= 768) await skipLinkWorks(page, `kiosk welcome @${vp.name}`);
      guard.assertClean(`kiosk @${vp.name}`);
      await expectNoBrowserState(page, `kiosk @${vp.name}`);
      await ctx.close();
    });
  }

  test("kiosk has no navigation, no links out, and a sane Tab order on the sign-in screen", async ({ browser }) => {
    // Sign-in is only reachable when the election is Open; the screen is rendered by the real app with the phase request stubbed.
    const ctx = await newContext(browser, { viewport: { width: 1024, height: 768 } });
    const page = await ctx.newPage();
    await page.route("**/api/v1/public/election", async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      j.data.phase = "Open";
      await route.fulfill({ response: r, json: j });
    });
    await page.goto("/vote");
    await ready(page);
    await page.getByRole("button", { name: "Begin" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await auditAt(page, "kiosk sign-in @1024x768", true);
    await shot(page, "a11y-kiosk-signin-1024x768");
    await expect(page.getByRole("navigation")).toHaveCount(0);
    expect(await page.locator("a[href]").evaluateAll((a) => a.map((x) => x.getAttribute("href")).filter((h) => h !== "#main"))).toEqual([]);
    const order: string[] = [];
    await expect(page.getByLabel("Voter ID or email")).toBeFocused(); // autofocus: one decision per screen
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      order.push(await page.evaluate(() => { const e = document.activeElement as HTMLElement; return (e.getAttribute("aria-label") || (e as HTMLInputElement).labels?.[0]?.textContent || e.textContent || e.tagName).trim(); }));
    }
    // after the autofocused identifier field the order is Password, Cancel, then the primary Sign in (secondary action first)
    expect(order.slice(0, 3)).toEqual(["Password", "Cancel", "Sign in"]);
    // client-side validation: empty submit explains what to do and moves focus
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText(/Enter your voter ID/i);
    await expect(page.getByLabel("Voter ID or email")).toBeFocused();
    await shot(page, "a11y-kiosk-signin-error-1024x768");
    await ctx.close();
  });
});

test.describe("admin console", () => {
  let page: Page, guard: Guard;
  test.beforeAll(async ({ browser }) => {
    const ctx = await newContext(browser, { viewport: { width: 1280, height: 800 } });
    page = await ctx.newPage();
    guard = new Guard(page, []);
  });

  for (const vp of VP) {
    test(`login page at ${vp.name}`, async () => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/admin/login");
      await auditAt(page, `admin login @${vp.name}`);
      await shot(page, `a11y-admin-login-${vp.name}`);
      if (vp.width >= 768) await skipLinkWorks(page, `admin login @${vp.name}`);
      // validation: every empty field is named, the first invalid control gets focus
      await page.goto("/admin/login");
      await ready(page);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByLabel("Email")).toBeFocused();
      await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
      if (vp.name === "1280x800") await shot(page, "a11y-admin-login-errors-1280x800");
    });
  }

  test("sign in", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await adminLogin(page, secret, used);
    await expect(page).toHaveURL(/\/admin\/election$/);
  });

  for (const vp of VP) {
    test(`pages after sign-in at ${vp.name}`, async () => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const p of ADMIN_PAGES) {
        await page.goto(`/admin/${p}`);
        await auditAt(page, `admin /${p} @${vp.name}`);
        await shot(page, `a11y-admin-${p}-${vp.name}`, true);
        // admin shell: the rail is a single labelled nav, the phase indicator is in the header, no public nav
        await expect(page.getByRole("navigation", { name: "Administration" })).toHaveCount(1);
        await expect(page.getByRole("navigation", { name: "Public" })).toHaveCount(0);
        await expect(page.locator(".shell-header")).toContainText(/Setup|Open|Closed/);
      }
      if (vp.width >= 768) {
        await page.goto("/admin/election");
        await ready(page);
        await skipLinkWorks(page, `admin @${vp.name}`);
      }
    });
  }

  test("Add voter dialog: focus moves in, is trapped, Escape closes and returns focus", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/admin/voters");
    await ready(page);
    const opener = page.getByRole("button", { name: "Add voter" });
    await opener.click();
    const dlg = page.getByRole("dialog", { name: "Add a voter" });
    await expect(dlg).toBeVisible();
    await shot(page, "a11y-admin-voter-dialog-1280x800");
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      const ok = await page.evaluate(() => !document.activeElement || document.activeElement === document.body || !!document.activeElement.closest("dialog"));
      expect(ok, `tab ${i} reached the page behind the dialog`).toBe(true);
    }
    const probs = await axeViolations(page);
    for (const v of probs) findings.push(`[admin add-voter dialog] axe ${v}`);
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
    await expect(opener).toBeFocused();
    // scroll lock while open: the dialog opens inside a short viewport and still reaches its buttons
    await page.setViewportSize({ width: 390, height: 600 });
    await opener.click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).scrollIntoViewIfNeeded();
    await expect(dlg.getByRole("button", { name: "Cancel" })).toBeInViewport();
    await shot(page, "a11y-admin-voter-dialog-390x600");
    await page.keyboard.press("Escape");
    await expect(dlg).toBeHidden();
  });

  test("voter table at narrow widths scrolls inside its own region, the page does not", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/voters");
    await ready(page);
    const m = await page.evaluate(() => {
      const wrap = document.querySelector(".table-wrap") as HTMLElement;
      return { pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, wrapScrolls: wrap.scrollWidth > wrap.clientWidth, focusable: wrap.tabIndex === 0 };
    });
    expect(m.pageOverflow).toBe(0);
    expect(m.focusable).toBe(true);
  });

  test("sign out", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/admin/election");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    await expectNoBrowserState(page, "admin after sign out");
    guard.allow({ status: 401, url: "/admin/" });
    guard.assertClean("admin console sweep");
  });
});

test.describe("verdict", () => {
  test("no accessibility, structure, text-claim or design-contract findings", async () => {
    expect(findings).toEqual([]);
  });
});
