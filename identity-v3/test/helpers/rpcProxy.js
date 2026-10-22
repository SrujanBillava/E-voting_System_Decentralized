// TEST SUPPORT. A JSON-RPC proxy in front of the local Hardhat node that can fail like a real RPC endpoint does. The identity service is pointed at the proxy
// (its own provider, its own HTTP requests), so every failure goes through the REAL ethers error paths. Tests that need the chain directly keep using the node.
//
//   modes (for every request) / rule results (per request):
//     "up"            forward to the node
//     "reset"         drop the connection without an answer (ECONNRESET)
//     "hang"          never answer (the client's request timeout fires)
//     "503"           HTTP 503 Service Unavailable
//     "rpcerror"      a JSON-RPC error object (what a lagging or overloaded node returns: "header not found")
//     "ratelimit"     a JSON-RPC error object "limit exceeded"
//     "forward-drop"  forward to the node (the request TAKES EFFECT) and then drop the connection: the client never learns that it happened
//     { result } / { error }   answer with exactly this
//   down() closes the listening socket (ECONNREFUSED) and up() opens it again on the same port.
import http from "node:http";

export async function startRpcProxy(targetUrl) {
  const state = { mode: "up", rule: null, requests: 0, byMethod: {} };
  const hung = new Set();
  const sockets = new Set();
  let port = 0;

  const answer = (res, id, payload) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
  };
  const forward = async (body) => {
    const r = await fetch(targetUrl, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: r.status, text: await r.text() };
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      let msg = null;
      try {
        msg = JSON.parse(body);
      } catch {
        // not JSON: forwarded as is
      }
      state.requests++;
      const method = msg?.method ?? "?";
      state.byMethod[method] = (state.byMethod[method] ?? 0) + 1;
      const action = state.rule?.(msg) ?? state.mode;
      try {
        if (action && typeof action === "object") return answer(res, msg?.id, action);
        switch (action) {
          case "reset":
            return req.socket.destroy();
          case "hang":
            hung.add(res);
            return undefined;
          case "503":
            res.writeHead(503);
            return res.end("Service Unavailable");
          case "rpcerror":
            return answer(res, msg?.id, { error: { code: -32603, message: "Internal error: header not found" } });
          case "ratelimit":
            return answer(res, msg?.id, { error: { code: -32005, message: "limit exceeded" } });
          case "forward-drop":
            await forward(body);
            return req.socket.destroy();
          default: {
            const { status, text } = await forward(body);
            res.writeHead(status, { "content-type": "application/json" });
            return res.end(text);
          }
        }
      } catch {
        return req.socket.destroy(); // the node itself is gone
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  let listening = false;
  const listen = () =>
    listening
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            server.off("error", reject);
            port = server.address().port;
            listening = true;
            resolve();
          });
        });
  const close = () =>
    !listening
      ? Promise.resolve()
      : new Promise((resolve) => {
          listening = false;
          for (const res of hung) res.destroy();
          hung.clear();
          for (const s of sockets) s.destroy();
          server.close(() => resolve());
        });
  await listen();

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    get listening() {
      return listening;
    },
    /** the mode for every request without a rule result */
    set(mode) {
      state.mode = mode;
    },
    /** per-request rule: return a mode/answer, or null/undefined for the current mode */
    when(rule) {
      state.rule = rule;
    },
    /** back to normal: forward everything */
    heal() {
      state.mode = "up";
      state.rule = null;
      for (const res of hung) res.destroy();
      hung.clear();
    },
    /** ECONNREFUSED from now on */
    down: close,
    up: listen,
    stop: close,
  };
}

/** a JSON-RPC message that simulates (eth_call / eth_estimateGas) a call to the function with this 4-byte selector */
export const simulates = (msg, selector) => (msg?.method === "eth_call" || msg?.method === "eth_estimateGas") && typeof msg.params?.[0]?.data === "string" && msg.params[0].data.startsWith(selector);
/** a JSON-RPC message that reads (eth_call) the function with this selector */
export const reads = (msg, selector) => msg?.method === "eth_call" && typeof msg.params?.[0]?.data === "string" && msg.params[0].data.startsWith(selector);
