// A transparent JSON-RPC proxy in front of the Hardhat node: it adds CORS for the kiosk's origin (a browser needs it) and RECORDS every JSON-RPC method the kiosk used, so a test can
// prove the kiosk only ever READS the chain (it has no wallet, no key, and never asks anybody to sign or send anything).
import http from "node:http";

export async function startRpcProxy({ target, allowedOrigin, port = 0 }) {
  const methods = [];
  // test hooks: `tamper(request, response)` may rewrite what a (malicious) node answers; `failNext = n` makes the next n requests fail like a node that is down
  const hooks = { tamper: null, failNext: 0 };
  const server = http.createServer(async (req, res) => {
    const cors = { "Access-Control-Allow-Origin": allowedOrigin ?? "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600", Vary: "Origin" };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const parsed = JSON.parse(body);
      for (const call of Array.isArray(parsed) ? parsed : [parsed]) methods.push(call.method);
    } catch {
      // not JSON: forwarded as is
    }
    if (hooks.failNext > 0) {
      hooks.failNext--;
      res.writeHead(503, cors).end('{"error":"down"}');
      return;
    }
    try {
      const upstream = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
      let text = await upstream.text();
      if (hooks.tamper) {
        try {
          const changed = hooks.tamper(JSON.parse(body), JSON.parse(text));
          if (changed) text = JSON.stringify(changed);
        } catch {
          // an unparseable exchange is forwarded untouched
        }
      }
      res.writeHead(upstream.status, { ...cors, "content-type": "application/json" }).end(text);
    } catch {
      res.writeHead(502, cors).end('{"error":"upstream"}');
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address();
  return { url: `http://127.0.0.1:${actual}`, port: actual, methods, hooks, stop: () => server.close() };
}
