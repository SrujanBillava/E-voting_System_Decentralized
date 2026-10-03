import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The browser only ever talks to the VoteChain HTTP API, on the SAME origin (/api). In development Vite proxies it to the
// backend, so the HttpOnly session cookies are first-party and no CORS is involved. In production serve both behind one origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_PROXY_TARGET || "http://localhost:5000";
  const proxy = { "/api": { target, changeOrigin: false } };
  return {
    plugins: [react(), tailwindcss()],
    server: { proxy },
    preview: { proxy },
  };
});
