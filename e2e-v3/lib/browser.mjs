// REAL-BROWSER SUPPORT. Builds the kiosk against a running stack, serves it with the production security headers, and drives the real system Chrome with Playwright.
// The browser is real; the webcam is Chrome's built-in fake device plus (in the TEST build only) the test face engine that stands in for a person.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { chromium } from "@playwright/test";
import { capture, person, rounded } from "../../backend-api/test/helpers/face.js";
import { waitFor } from "../../identity-v3/test/helpers/node.js";
import { ROOT } from "./stack.mjs";

export const KIOSK_DIR = path.join(ROOT, "kiosk-v3");

/** `vite build` with the stack's addresses baked in (exactly how a production build takes its configuration). `e2eFace` compiles the TEST face engine in; omit it for a production-like build. */
export function buildKiosk(stack, { outDir, e2eFace = false }) {
  const env = { ...process.env, VITE_IDENTITY_BASE: stack.kioskConfig.identityBase, VITE_RELAY_BASE: stack.kioskConfig.relayBase, VITE_RPC_URL: stack.kioskConfig.rpcUrl, VITE_CHAIN_ID: String(stack.kioskConfig.chainId), VITE_VOTECHAIN_ADDRESS: stack.kioskConfig.contractAddress, VITE_ELECTION_ID: stack.electionId };
  delete env.VITE_E2E_FACE;
  if (e2eFace) env.VITE_E2E_FACE = "1";
  const dir = path.join(KIOSK_DIR, outDir);
  execFileSync(process.execPath, [path.join(KIOSK_DIR, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", dir, "--emptyOutDir"], { cwd: KIOSK_DIR, env, stdio: "pipe" });
  return dir;
}

/** scripts/serve.mjs as its own process: the same static server and the same headers a deployment uses */
export async function serveKiosk({ dir, port }) {
  const child = spawn(process.execPath, [path.join(KIOSK_DIR, "scripts", "serve.mjs"), "--dir", dir, "--port", String(port), "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`)).ok, { timeoutMs: 30_000 }).catch((err) => {
    child.kill("SIGTERM");
    throw new Error(`the kiosk server did not start:\n${out}\n${err}`);
  });
  return { port, output: () => out, stop: () => (child.exitCode === null ? child.kill("SIGTERM") : undefined), exited: new Promise((resolve) => child.once("exit", resolve)) };
}

export const launchChrome = () => chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

/** the descriptor the test face engine reports for imaginary person `seed` (the person the voter was enrolled as when similarity is high) */
export const faceDescriptor = (seed, similarity = 0.9) => rounded(capture(person(seed), similarity, 1));

// What runs inside the page BEFORE any page script (test instrumentation only; nothing of it exists in the kiosk): the test face (descriptor of the enrolled imaginary person), a record of
// EVERY Web Storage write, every camera stream the page opened, and a trace of which heading / progress step is current, with times.
const initScript = ({ descriptor }) => {
  if (descriptor) window.__E2E_FACE__ = { descriptor };
  window.__trace = [];
  window.__writes = [];
  window.__streams = [];
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    window.__writes.push({ area: this === window.sessionStorage ? "session" : "local", key, value: String(value) });
    return setItem.call(this, key, value);
  };
  const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (getUserMedia) {
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      window.__streams.push(stream);
      return stream;
    };
  }
  const note = () => {
    const title = document.querySelector("h1")?.textContent ?? "";
    const step = document.querySelector("[aria-current=step]")?.textContent ?? "";
    const last = window.__trace[window.__trace.length - 1];
    if (!last || last.title !== title || last.step !== step) window.__trace.push({ t: performance.now(), title, step });
  };
  new MutationObserver(note).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-current"] });
};

/**
 * A fresh browser context = a fresh kiosk tab session (own cookies, own sessionStorage). Records EVERY request with the headers the browser actually sent (cookie included) and the
 * status it got, console messages, and page errors.
 */
export async function newVoterContext(browser, stack, { descriptor, viewport = { width: 1100, height: 900 } } = {}) {
  const context = await browser.newContext({ viewport });
  await context.grantPermissions(["camera"], { origin: stack.origins.kiosk });
  await context.addInitScript(initScript, { descriptor });
  const identityHost = new URL(stack.origins.identity).host;
  const relayHost = new URL(stack.origins.relay).host;
  const traffic = [];
  const byRequest = new Map();
  context.on("request", (request) => {
    const url = new URL(request.url());
    const entry = { url: request.url(), host: url.host, path: url.pathname, method: request.method(), type: request.resourceType(), body: request.postData(), headers: {}, status: 0, failed: false, responseText: "", responseHeaders: {}, at: performance.now() };
    traffic.push(entry);
    byRequest.set(request, entry);
    entry.ready = request.allHeaders().then((h) => (entry.headers = h)).catch(() => undefined);
  });
  context.on("response", (response) => {
    const entry = byRequest.get(response.request());
    if (!entry) return;
    entry.status = response.status();
    entry.responseHeaders = response.headers();
    if (entry.host === identityHost || entry.host === relayHost) entry.bodyReady = response.text().then((t) => (entry.responseText = t)).catch(() => undefined);
  });
  context.on("requestfailed", (request) => {
    const entry = byRequest.get(request);
    if (entry) entry.failed = true;
  });
  const consoleLines = [];
  context.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
  const pageErrors = [];
  context.on("weberror", (e) => pageErrors.push(String(e.error())));
  return { context, traffic, consoleLines, pageErrors, identityHost, relayHost, settled: () => Promise.all(traffic.flatMap((e) => [e.ready, e.bodyReady])) };
}

export const writesOf = (page) => page.evaluate(() => window.__writes);
export const streamsEnded = (page) => page.evaluate(() => ({ opened: window.__streams.length, live: window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length }));
export const sessionDump = (page) => page.evaluate(() => Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])));
export const localDump = (page) => page.evaluate(async () => ({ local: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])), indexedDb: (await indexedDB.databases?.())?.map((d) => d.name) ?? [], cookie: document.cookie }));

export async function login(page, stack, voter) {
  await page.goto(stack.origins.kiosk + "/");
  await page.getByLabel("Voter ID or email").fill(voter.email);
  await page.getByLabel("Password").fill(voter.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** login -> face (test engine) -> credential requested; returns once the page is waiting for the epoch cohort */
export async function toCredentialWait(page, stack, voter) {
  await login(page, stack, voter);
  await page.getByRole("heading", { name: "Check your face" }).waitFor({ timeout: 30_000 });
  await page.getByRole("heading", { name: "Getting your voting credential" }).waitFor({ timeout: 90_000 });
  await page.getByText(/Waiting for the next batch of credentials/).waitFor({ timeout: 30_000 });
}

export async function castChoice(page, candidate, { timeout = 300_000 } = {}) {
  await page.getByRole("heading", { name: "Choose your candidate" }).waitFor({ timeout: 120_000 });
  await page.getByRole("radio", { name: candidate }).check();
  await page.getByRole("button", { name: "Review my choice" }).click();
  await page.getByRole("button", { name: "Cast my vote" }).click();
  await page.getByRole("heading", { name: "Your vote was recorded" }).waitFor({ timeout });
}

export const receiptOf = async (page) => {
  const rows = await page.locator(".fact").evaluateAll((els) => els.map((el) => [el.querySelector("dt")?.textContent ?? "", el.querySelector("dd")?.textContent ?? ""]));
  return { rows: Object.fromEntries(rows), statement: await page.getByTestId("receipt-statement").textContent() };
};
export const traceOf = (page) => page.evaluate(() => window.__trace);
