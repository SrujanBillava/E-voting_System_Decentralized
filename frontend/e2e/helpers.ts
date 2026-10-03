import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type BrowserContext, type Page } from "@playwright/test";

/** Test-only helpers. The fixture CLI lives in backend-api/test/helpers and talks to the throwaway E2E database directly. */
const BACKEND_DIR = process.env.E2E_BACKEND_DIR ?? path.resolve(process.cwd(), "../backend-api");
export const BACKEND_URL = process.env.E2E_BACKEND_URL ?? "http://localhost:5100";
export const SHOTS_DIR = process.env.E2E_SHOTS_DIR ?? path.resolve(process.cwd(), "e2e/.shots");

export function fixture<T = Record<string, unknown>>(...args: string[]): T {
  const out = execFileSync("node", ["test/helpers/e2e-fixture.js", ...args], { cwd: BACKEND_DIR, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop() ?? "{}") as T;
}

export const ADMIN = { email: "admin@example.org", password: "e2e-admin-password-1" };
export const VOTER_PASSWORD = "voter password number 1";

export const totpFor = (secret: string): string => fixture<{ code: string }>("totp", secret).code;

/** A TOTP code that has not been used yet: wait for the next 30 s step if the current one was already consumed. */
export async function freshTotp(secret: string, used: Set<string>): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const code = totpFor(secret);
    if (!used.has(code)) {
      used.add(code);
      return code;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("could not obtain a fresh TOTP code");
}

export async function backendPhase(): Promise<string> {
  const r = await fetch(`${BACKEND_URL}/api/v1/public/election`);
  return ((await r.json()) as { data: { phase: string } }).data.phase;
}

// ------------------------------------------------------------------------------------------------ guards
export interface Allowed {
  status: number;
  /** substring of the request URL */
  url: string;
}
/** The only non-2xx responses a flow may produce. Everything else is a defect. */
export const EXPECTED_ANON: Allowed[] = [
  { status: 401, url: "/voter/status" }, // the kiosk asks the server who it is before anyone has signed in
  { status: 401, url: "/admin/auth/refresh" }, // the admin bootstrap before sign in
];

/**
 * Watches one page for: console errors, page errors, failed or non-whitelisted-4xx/5xx requests, any request leaving localhost,
 * and window.alert/confirm/prompt dialogs. `assertClean()` fails with the full list.
 */
export class Guard {
  errors: string[] = [];
  failed: string[] = [];
  external: string[] = [];
  dialogs: string[] = [];
  requests: string[] = [];
  constructor(
    page: Page,
    private allowed: Allowed[] = [],
  ) {
    page.on("console", (m) => {
      // Chrome logs every 4xx as a console error; those are judged by the response whitelist below.
      if (m.type() === "error" && !/Failed to load resource/.test(m.text())) this.errors.push(m.text());
    });
    page.on("pageerror", (e) => this.errors.push(`pageerror: ${e}`));
    page.on("response", (r) => {
      if (r.status() >= 400 && !this.isAllowed(r.status(), r.url())) this.failed.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
    page.on("requestfailed", (r) => {
      // a navigation or poll aborted by the page itself is not a failure of the app
      if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) this.failed.push(`FAILED ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`);
    });
    page.on("request", (r) => {
      const u = new URL(r.url());
      this.requests.push(`${r.method()} ${u.pathname}`);
      if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !/^(data|blob|about):/.test(r.url())) this.external.push(r.url());
    });
    page.on("dialog", async (d) => {
      this.dialogs.push(`${d.type()}: ${d.message()}`);
      await d.dismiss();
    });
  }
  allow(...more: Allowed[]) {
    this.allowed.push(...more);
    // also forgive matching responses that were already seen (the deliberate request happened before the whitelist call)
    this.failed = this.failed.filter((f) => !more.some((a) => f.startsWith(`${a.status} `) && f.includes(a.url)));
  }
  private isAllowed(status: number, url: string) {
    return [...EXPECTED_ANON, ...this.allowed].some((a) => a.status === status && url.includes(a.url));
  }
  assertClean(label = "") {
    const all = { errors: this.errors, failed: this.failed, external: this.external, dialogs: this.dialogs };
    expect(all, `console/network problems ${label}`).toEqual({ errors: [], failed: [], external: [], dialogs: [] });
  }
  reset() {
    this.errors = [];
    this.failed = [];
    this.external = [];
    this.dialogs = [];
  }
}

// ------------------------------------------------------------------------------------------------ text rules
/** Claims this product must never make. 'zero-knowledge' is allowed only inside the honest-limits sentences on /trust. */
export const FORBIDDEN = [/zero-knowledge/i, /anonymous/i, /tamper-proof/i, /immune/i, /cryptographically private/i, /fully secure/i, /privacy preserved/i, /sealed ballot/i, /hidden until/i];
export const SECRET_LOOKING = [/123456/, /admin123/];

export async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText + "\n" + Array.from(document.querySelectorAll("[aria-label],[title],[alt]")).map((e) => `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("title") ?? ""} ${e.getAttribute("alt") ?? ""}`).join("\n"));
}

/** Returns every forbidden-claim/secret match on the page. On /trust the two honest-limits sentences are excised first. */
export async function textViolations(page: Page, extraSecrets: string[] = []): Promise<string[]> {
  let text = await visibleText(page);
  if (new URL(page.url()).pathname === "/trust") {
    text = text.replace(/Not zero-knowledge/gi, "").replace(/There is no zero-knowledge or other cryptographic privacy layer in this version\./gi, "");
  }
  const bad: string[] = [];
  for (const re of [...FORBIDDEN, ...SECRET_LOOKING]) if (re.test(text)) bad.push(`${page.url()} matches ${re}`);
  for (const s of extraSecrets) if (s && text.includes(s)) bad.push(`${page.url()} shows a secret value`);
  return bad;
}

// ------------------------------------------------------------------------------------------------ browser state
export async function storageDump(page: Page) {
  return page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), cookie: document.cookie }));
}
export async function expectNoBrowserState(page: Page, label = "") {
  const s = await storageDump(page);
  expect(s, `browser storage/cookies visible to JS ${label}`).toEqual({ local: [], session: [], cookie: "" });
  const idb = await page.evaluate(async () => ((indexedDB as unknown as { databases?: () => Promise<unknown[]> }).databases ? await (indexedDB as unknown as { databases: () => Promise<unknown[]> }).databases() : []));
  expect(idb, `indexedDB ${label}`).toEqual([]);
}

export async function shot(page: Page, name: string, fullPage = false) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), fullPage });
}

// ------------------------------------------------------------------------------------------------ flows
export async function adminLogin(page: Page, secret: string, used: Set<string>, password = ADMIN.password) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Authenticator code").fill(await freshTotp(secret, used));
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function kioskSignIn(page: Page, identifier: string, password = VOTER_PASSWORD) {
  await page.goto("/vote");
  await page.getByRole("button", { name: "Begin" }).click();
  await page.getByLabel("Voter ID or email").fill(identifier);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function newContext(browser: import("@playwright/test").Browser, opts: Parameters<import("@playwright/test").Browser["newContext"]>[0] = {}): Promise<BrowserContext> {
  return browser.newContext({ baseURL: `http://localhost:${process.env.E2E_PORT ?? 5173}`, ...opts });
}

export const VIEWPORTS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "390x844", width: 390, height: 844 },
] as const;

// ------------------------------------------------------------------------------------------------ structure audit
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export async function axeViolations(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

/** Structural facts every page must satisfy. Returns human-readable problems (empty = fine). */
export async function structureProblems(page: Page, opts: { dialogOpen?: boolean } = {}): Promise<string[]> {
  const f = await page.evaluate(() => {
    const count = (sel: string) => document.querySelectorAll(sel).length;
    const labels = Array.from(document.querySelectorAll("nav")).map((n) => n.getAttribute("aria-label") ?? "");
    return {
      h1: count("h1"),
      banner: count("header.shell-header, [role=banner]"),
      main: count("main, [role=main]"),
      contentinfo: count("footer, [role=contentinfo]"),
      navDup: labels.length - new Set(labels).size,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      lang: document.documentElement.lang,
      title: document.title,
    };
  });
  const p: string[] = [];
  if (f.h1 !== 1) p.push(`${f.h1} <h1> elements (need exactly 1)`);
  if (f.banner !== 1) p.push(`${f.banner} banner landmarks (need 1)`);
  if (f.main !== 1) p.push(`${f.main} main landmarks (need 1)`);
  if (f.contentinfo > 1) p.push(`${f.contentinfo} footer landmarks`);
  if (f.navDup > 0) p.push("duplicate nav landmark labels");
  if (f.overflow > 0) p.push(`horizontal overflow of ${f.overflow}px`);
  if (f.lang !== "en") p.push(`html lang is "${f.lang}"`);
  if (!f.title || f.title === "frontend") p.push(`document.title is "${f.title}"`);
  void opts;
  return p;
}

/** axe (WCAG 2.2 AA) + structure. Collected, not thrown, so one run reports every page. */
export async function auditPage(page: Page, label: string, sink: string[]) {
  for (const v of await axeViolations(page)) sink.push(`[${label}] axe ${v}`);
  for (const v of await structureProblems(page)) sink.push(`[${label}] ${v}`);
}
