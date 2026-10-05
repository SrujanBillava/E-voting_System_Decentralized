// Serves the BUILT kiosk (dist/ or --dir) with the security headers a deployment must send, including the same Content-Security-Policy that is in the page's <meta> tag.
// A tiny static server on purpose: no framework, no middleware, nothing that can add a header or a script of its own.
//   node scripts/serve.mjs [--dir dist] [--port 5300] [--host 127.0.0.1]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCsp, securityHeaders } from "./csp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const dir = path.resolve(root, arg("--dir", "dist"));
const port = Number(arg("--port", process.env.KIOSK_PORT ?? 5300));
const host = arg("--host", "127.0.0.1");

// the three services come from the build itself (index.html's own policy is the source of truth), or from the environment for a custom deployment
const csp = (() => {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const meta = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1];
  const origins = /connect-src 'self' ([^;]+)/.exec(meta ?? "")?.[1]?.split(" ") ?? [];
  if (!meta || origins.length === 0) throw new Error("the built page has no Content-Security-Policy meta tag");
  return buildCsp({ identityBase: origins[0], relayBase: origins[1] ?? origins[0], rpcUrl: origins[2] ?? origins[0] });
})();

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".zkey": "application/octet-stream", ".bin": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://kiosk.invalid");
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, securityHeaders(csp)).end();
    return;
  }
  let file = path.normalize(path.join(dir, pathname));
  if (file !== dir && !file.startsWith(dir + path.sep)) {
    res.writeHead(403, securityHeaders(csp)).end(); // never outside the served directory (nor a sibling that merely shares its prefix)
    return;
  }
  if (url.pathname === "/") file = path.join(dir, "index.html");
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { ...securityHeaders(csp), "Content-Type": "text/plain" }).end("not found");
      return;
    }
    const isPage = file.endsWith(".html");
    res.writeHead(200, { ...securityHeaders(csp), "Cache-Control": isPage ? "no-store" : "public, max-age=3600", "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Content-Length": stat.size });
    if (req.method === "HEAD") return void res.end();
    fs.createReadStream(file).pipe(res);
  });
});
server.listen(port, host, () => console.log(`kiosk served from ${path.relative(root, dir)} at http://${host}:${port}`));
