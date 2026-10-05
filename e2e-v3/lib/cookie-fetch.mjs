// A fetch that behaves like the BROWSER's with respect to the one thing this system's privacy boundary depends on: `credentials`.
//   credentials: "include"  -> cookies of the target host are sent and Set-Cookie is honoured
//   credentials: "omit"     -> NO cookie is ever sent and Set-Cookie is ignored
// It also sends the Origin header a browser would, and records every request, so tests can assert exactly who was sent what.
export function createCookieFetch({ origin, base = globalThis.fetch } = {}) {
  const jar = new Map(); // host -> Map(name -> value)
  const log = [];
  const fetchLike = async (url, init = {}) => {
    const target = new URL(url);
    const headers = new Headers(init.headers ?? {});
    if (origin) headers.set("Origin", origin);
    const credentials = init.credentials ?? "same-origin";
    const cookies = jar.get(target.host);
    let cookieSent = false;
    if (credentials === "include" && cookies?.size) {
      headers.set("Cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      cookieSent = true;
    }
    const entry = { method: init.method ?? "GET", url, host: target.host, path: target.pathname, credentials, cookieSent, headers: [...headers.keys()].map((k) => k.toLowerCase()), body: typeof init.body === "string" ? init.body : null, status: 0, responseText: "", responseHeaders: "" };
    log.push(entry);
    const response = await base(url, { ...init, headers });
    entry.status = response.status;
    entry.responseText = await response.clone().text();
    entry.responseHeaders = JSON.stringify([...response.headers.entries()]);
    if (credentials === "include") {
      for (const line of response.headers.getSetCookie?.() ?? []) {
        const [pair, ...attrs] = line.split(";").map((s) => s.trim());
        const eq = pair.indexOf("=");
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        const expired = attrs.some((a) => /^max-age=0$/i.test(a)) || attrs.some((a) => /^expires=/i.test(a) && Date.parse(a.slice(8)) < Date.now());
        const store = jar.get(target.host) ?? new Map();
        if (expired || value === "") store.delete(name);
        else store.set(name, value);
        jar.set(target.host, store);
      }
    }
    return response;
  };
  fetchLike.log = log;
  fetchLike.jar = jar;
  fetchLike.cookiesFor = (host) => Object.fromEntries(jar.get(host) ?? []);
  return fetchLike;
}
