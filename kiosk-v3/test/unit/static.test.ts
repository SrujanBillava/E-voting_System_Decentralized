// STATIC GUARANTEES about the kiosk's own source (not the frozen privacy core, not node_modules): what it must never do, found by reading what it does.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string) => path.relative(root, f);

/** code without comments (line and block); string contents are kept, which is what the URL check needs */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const FORBIDDEN: [string, RegExp][] = [
  ["localStorage", /\blocalStorage\b/],
  ["IndexedDB", /\bindexedDB\b|\bIDBFactory\b/],
  ["document.cookie", /document\.cookie/],
  ["console output", /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\b/],
  ["a wallet, signer or injected provider", /\b(Wallet|JsonRpcSigner|getSigner|BrowserProvider|window\.ethereum|eth_requestAccounts)\b/],
  ["sending or signing anything on a chain", /\b(sendTransaction|sendRawTransaction|signTransaction|signMessage|signTypedData|eth_send\w*|eth_sign\w*|personal_sign)\b/],
  ["eval / new Function / string timers", /\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/],
  ["raw HTML injection", /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/],
  ["another network API", /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|sendBeacon|importScripts|navigator\.serviceWorker/],
  ["analytics / error reporting", /google-analytics|googletagmanager|gtag\s*\(|mixpanel|sentry|segment\.com|hotjar|datadog/i],
  ["a hard-coded remote URL", /["'`]https?:\/\/(?!www\.w3\.org)[^"'`]*["'`]/],
];
/** the files that are allowed to call fetch: the two HTTP clients' transport, the artifact loader, and the entry point that hands window.fetch to the engine */
const MAY_FETCH = new Set(["src/core/http.ts", "src/crypto/artifacts.ts", "src/main.tsx"]);

function scan(files: string[], read: (f: string) => string): string[] {
  const found: string[] = [];
  for (const file of files) {
    const code = stripComments(read(file));
    for (const [what, re] of FORBIDDEN) if (re.test(code)) found.push(`${rel(file)}: ${what}`);
    if (/(^|[^\w.])fetch\s*\(|window\.fetch|globalThis\.fetch/.test(code) && !MAY_FETCH.has(rel(file))) found.push(`${rel(file)}: fetch outside the allowed files`);
  }
  return found;
}

describe("the kiosk source", () => {
  it("never touches localStorage, IndexedDB or cookies, never logs, never has a wallet, signer or transaction call, and calls out only through its two HTTP clients and the artifact loader", () => {
    assert.ok(sources.length > 30, `${sources.length} source files were scanned`);
    assert.deepEqual(scan(sources, (f) => fs.readFileSync(f, "utf8")), []);
  });

  it("the scanner is not blind: a planted violation of every kind is caught", () => {
    const planted: Record<string, string> = {
      "src/x1.ts": 'localStorage.setItem("k", "v");',
      "src/x2.ts": "indexedDB.open('x');",
      "src/x3.ts": "document.cookie = 'a=b';",
      "src/x4.ts": "console.log(identity.export());",
      "src/x5.ts": "const w = new Wallet(key);",
      "src/x6.ts": "await provider.send('eth_sendRawTransaction', [tx]);",
      "src/x7.ts": "eval('1');",
      "src/x8.ts": "el.innerHTML = html;",
      "src/x9.ts": "new WebSocket(url);",
      "src/x10.ts": "import 'mixpanel-browser';",
      "src/x11.ts": 'const u = "https://evil.example/collect";',
      "src/x12.ts": "await fetch(url);",
      "src/x13.ts": "setTimeout('alert(1)', 0);",
    };
    const found = scan(Object.keys(planted).map((f) => path.join(root, f)), (f) => planted[rel(f)]!);
    assert.equal(found.length, Object.keys(planted).length, found.join("\n"));
    // a comment mentioning a forbidden thing is NOT a violation
    assert.deepEqual(scan([path.join(root, "src/c.ts")], () => "// we never use localStorage or console.log here\n/* indexedDB */ const ok = 1;"), []);
  });

  it("'credentials: include' appears exactly once (the identity client); the relay client and the artifact loader use 'omit'", () => {
    const code = (f: string) => stripComments(fs.readFileSync(path.join(root, f), "utf8"));
    const all = sources.map((f) => stripComments(fs.readFileSync(f, "utf8"))).join("\n");
    assert.equal(all.match(/"include"\s*,\s*payload/g)?.length, 1, "exactly one call site sends credentials");
    assert.equal(all.match(/credentials:\s*"include"(?!\s*\|)/g), null, "and no request object sets them any other way");
    assert.ok(code("src/core/http.ts").includes('send(options.fetch, `${base}${path}`, method, "include", payload, "IDENTITY")'));
    assert.ok(code("src/core/http.ts").includes('send(options.fetch, `${base}${path}`, method, "omit", payload, "RELAY")'));
    assert.ok(code("src/crypto/artifacts.ts").includes('credentials: "omit"'));
  });

  it("the test face engine is reachable ONLY behind the build-time constant VITE_E2E_FACE (so a production build drops it)", () => {
    const users = sources.filter((f) => /e2eEngine/.test(fs.readFileSync(f, "utf8")) && !f.endsWith("e2eEngine.ts"));
    assert.deepEqual(users.map(rel), ["src/face/engine.ts"]);
    assert.match(fs.readFileSync(path.join(root, "src/face/engine.ts"), "utf8"), /import\.meta\.env\.VITE_E2E_FACE === "1" \? new \(await import\("\.\/e2eEngine\.ts"\)\)/);
    assert.ok(!fs.readFileSync(path.join(root, ".env.production"), "utf8").includes("VITE_E2E_FACE"));
  });

  it("depends on almost nothing: the runtime dependency list is fixed", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@vladmandic/human", "ethers", "react", "react-dom"]);
  });
});
