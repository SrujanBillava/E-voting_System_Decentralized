import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { buildCsp } from "./scripts/csp.mjs";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const shim = (name: string) => here(`./src/crypto/shims/${name}`);

/**
 * The frozen privacy-v3 core is bundled UNCHANGED. Three build-time substitutions make its Node-only edges browser-safe and nothing else changes:
 *   node:crypto            -> the browser CSPRNG (the core's one source of randomness)
 *   node:fs                -> an inert stub (only used to read a verification key the kiosk never needs)
 *   privacy-v3 artifacts.js -> the integrity-checked, locally bundled proving artifacts
 */
function frozenCoreInBrowser(): Plugin {
  return {
    name: "frozen-core-in-browser",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "./artifacts.js" && importer?.includes("/privacy-v3/src/")) return shim("artifacts.ts");
      return null;
    },
  };
}

/**
 * The strict Content-Security-Policy goes into the built page as a <meta> tag, directly after the charset declaration and before any script or stylesheet (scripts/serve.mjs sends
 * the same policy as an HTTP header). Not in dev: Vite's own dev client is inline.
 */
function contentSecurityPolicy(env: Record<string, string>): Plugin {
  return {
    name: "kiosk-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const content = buildCsp({ identityBase: env.VITE_IDENTITY_BASE!, relayBase: env.VITE_RELAY_BASE!, rpcUrl: env.VITE_RPC_URL! }, { meta: true });
        const charset = '<meta charset="UTF-8" />';
        if (!html.includes(charset)) throw new Error("index.html must declare its charset first");
        return html.replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${content}" />`);
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here("."), "VITE_");
  return {
    plugins: [frozenCoreInBrowser(), react(), contentSecurityPolicy(env)],
    resolve: {
      alias: [
        { find: "node:crypto", replacement: shim("node-crypto.ts") },
        { find: "node:fs", replacement: shim("node-fs.ts") },
      ],
      dedupe: ["ethers", "snarkjs"],
    },
    // privacy-v3/src/validity.js reads process.env.V3_SINGLE_THREAD at load time: in the browser the answer is simply "not set"
    define: { "process.env.V3_SINGLE_THREAD": "undefined" },
    server: { fs: { allow: [here("."), here("../privacy-v3")] } },
    build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 8000, assetsInlineLimit: 0 },
  };
});
