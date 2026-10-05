// scripts/check-bundle.mjs is what stands between a build and a release: prove it passes a clean build and FAILS on every planted defect.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCsp } from "../../scripts/csp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(root, "scripts", "check-bundle.mjs");
const artifacts = path.join(root, "public", "artifacts");
const have = fs.existsSync(path.join(artifacts, "ballot_validity_final.zkey"));
const services = { identityBase: "http://id.test:1/api", relayBase: "http://relay.test:2/v1", rpcUrl: "http://rpc.test:3" };
const ANVIL_KEY_0 = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("check-bundle: a build is released only if it passes", { skip: have ? false : 'run "npm run assets" first' }, () => {
  let dir: string;
  const page = (csp = buildCsp(services, { meta: true }), body = '<script type="module" src="/assets/app.js"></script>') => `<!doctype html><html><head><meta charset="UTF-8" /><meta http-equiv="Content-Security-Policy" content="${csp}" />${body}</head><body></body></html>`;
  const run = (...extra: string[]) => spawnSync(process.execPath, [script, "--dir", dir, "--no-manifest", ...extra], { encoding: "utf8" });
  const reset = () => {
    for (const f of ["assets/leak.js", "assets/leak.css"]) fs.rmSync(path.join(dir, f), { force: true });
    fs.writeFileSync(path.join(dir, "index.html"), page());
    for (const f of fs.readdirSync(artifacts)) {
      const target = path.join(dir, "artifacts", f);
      if (!fs.existsSync(target) || fs.statSync(target).size !== fs.statSync(path.join(artifacts, f)).size) fs.copyFileSync(path.join(artifacts, f), target);
    }
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-bundle-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.mkdirSync(path.join(dir, "artifacts"));
    fs.mkdirSync(path.join(dir, "face", "ghostnet"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "export const x = 1;");
    fs.writeFileSync(path.join(dir, "face", "ghostnet", "insightface-ghostnet-strides1.json"), "{}");
    reset();
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("passes a clean build", () => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /bundle OK/);
  });

  const defects: [string, () => void, RegExp][] = [
    ["the test face engine in the bundle", () => fs.writeFileSync(path.join(dir, "assets", "leak.js"), 'const e = "e2e-fake";'), /test face engine/],
    ["the test hook name in the bundle", () => fs.writeFileSync(path.join(dir, "assets", "leak.js"), "window.__E2E_FACE__ = {};"), /test face engine/],
    ["a biometric bypass flag", () => fs.writeFileSync(path.join(dir, "assets", "leak.js"), 'const f = process.env.SKIP_FACE;'), /test biometric hook/],
    ["a well-known development private key", () => fs.writeFileSync(path.join(dir, "assets", "leak.js"), `const k = "0x${ANVIL_KEY_0}";`), /development private key/],
    ["a database URI", () => fs.writeFileSync(path.join(dir, "assets", "leak.js"), 'const u = "mongodb://127.0.0.1/evoting";'), /service secret/],
    ["an issuer key variable", () => fs.writeFileSync(path.join(dir, "assets", "leak.js"), "const k = ISSUER_PRIVATE_KEY;"), /service secret/],
    ["an unsafe-inline policy", () => fs.writeFileSync(path.join(dir, "index.html"), page(buildCsp(services, { meta: true }).replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"))), /unsafe-inline|not the kiosk's policy/],
    ["a policy that is not the kiosk's", () => fs.writeFileSync(path.join(dir, "index.html"), page("default-src *")), /not the kiosk's policy|connect-src|no Content-Security-Policy/],
    ["no policy at all", () => fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><head><meta charset="UTF-8" /></head></html>'), /no Content-Security-Policy/],
    ["an inline script", () => fs.writeFileSync(path.join(dir, "index.html"), page(undefined, "<script>alert(1)</script>")), /inline script/],
    ["a script from another origin", () => fs.writeFileSync(path.join(dir, "index.html"), page(undefined, '<script src="https://cdn.example.com/x.js"></script>')), /another origin/],
    ["a remote font or import in a stylesheet", () => fs.writeFileSync(path.join(dir, "assets", "leak.css"), "@import url(https://fonts.example.com/x.css);"), /remote resource/],
    ["a proving artifact that is not the pinned one", () => { const f = path.join(dir, "artifacts", "semaphore-20.zkey"); fs.rmSync(f); fs.writeFileSync(f, "tampered"); }, /not the pinned file/],
    ["a missing proving artifact", () => fs.rmSync(path.join(dir, "artifacts", "ballot_validity.wasm")), /missing from the build/],
  ];
  for (const [what, plant, expected] of defects) {
    it(`FAILS on ${what}`, () => {
      reset();
      plant();
      const result = run();
      assert.equal(result.status, 1, `${what} was not caught: ${result.stdout}`);
      assert.match(result.stderr, expected);
      reset();
    });
  }

  it("writes a deterministic manifest: every file's SHA-256, sorted, no timestamp; the same build twice gives the same bytes", () => {
    reset();
    const once = spawnSync(process.execPath, [script, "--dir", dir], { encoding: "utf8" });
    assert.equal(once.status, 0, once.stderr);
    const first = fs.readFileSync(path.join(dir, "build-manifest.json"), "utf8");
    const twice = spawnSync(process.execPath, [script, "--dir", dir], { encoding: "utf8" });
    assert.equal(twice.status, 0);
    assert.equal(fs.readFileSync(path.join(dir, "build-manifest.json"), "utf8"), first);
    const manifest = JSON.parse(first);
    assert.deepEqual(Object.keys(manifest.files), [...Object.keys(manifest.files)].sort());
    assert.ok(Object.values(manifest.files).every((h) => /^[0-9a-f]{64}$/.test(h as string)));
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(first), "no timestamp");
    assert.ok("artifacts/ballot_validity_final.zkey" in manifest.files);
    assert.ok(!("build-manifest.json" in manifest.files));
  });
});
