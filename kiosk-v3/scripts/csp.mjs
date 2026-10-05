// THE kiosk's Content-Security-Policy, in one place: used for the <meta> tag of the build AND for the HTTP header of scripts/serve.mjs, so they can never differ.
//
// No inline script, no eval (only WebAssembly compilation: the zero-knowledge provers and the face model are WebAssembly), no remote script, no remote font, no remote
// image, no frames, no plugins, no form posts, no <base>. The page may talk ONLY to itself and to the three configured services: the identity service, the relayer and a
// read-only JSON-RPC endpoint. Workers (snarkjs' thread pool) may be created from blob: URLs.
export function originOf(url) {
  return new URL(url).origin;
}

export function buildCsp({ identityBase, relayBase, rpcUrl }, { meta = false } = {}) {
  const origins = [...new Set([identityBase, relayBase, rpcUrl].map(originOf))].join(" ");
  const directives = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self'",
    "media-src 'self'",
    "font-src 'none'",
    `connect-src 'self' ${origins}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "manifest-src 'none'",
  ];
  // frame-ancestors is not honoured in a <meta> policy (browsers warn); the HTTP header carries it
  return (meta ? directives.filter((d) => !d.startsWith("frame-ancestors")) : directives).join("; ");
}

/** the response headers a deployment must send with the kiosk (serve.mjs does) */
export const securityHeaders = (csp) => ({
  "Content-Security-Policy": csp,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": "no-store",
});
