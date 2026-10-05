import pinned from "../../pinned-artifacts.json" with { type: "json" };
import { KioskError } from "../core/errors.ts";
import { installArtifacts, type MemFile } from "./shims/artifacts.ts";

/** Browser (and test) only. The real work is installArtifacts (the build-time replacement of privacy-v3's artifacts.js); this fetches the bundled files and refuses any that is not pinned. */
const sha256Hex = async (bytes: Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("");

let loading: Promise<void> | null = null;

/**
 * Fetches the four proving artifacts from THIS origin (`/artifacts/`, bundled with the kiosk: no CDN, no download from anywhere else), verifies each one's SHA-256 against the hashes
 * pinned in this build BEFORE it can be used, and hands them to the frozen prover as verified in-memory files. A file that does not match is refused and nothing is proved.
 * A failure (network or mismatch) is not cached: the next call tries again.
 */
export function loadProvingArtifacts(options: { base?: string; fetch?: typeof fetch; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
  loading ??= (async () => {
    const base = options.base ?? "/artifacts/";
    const get = options.fetch ?? fetch;
    const names = Object.keys(pinned.files) as (keyof typeof pinned.files)[];
    const files: Record<string, MemFile> = {};
    let done = 0;
    for (const name of names) {
      let data: Uint8Array;
      try {
        const response = await get(`${base}${name}`, { credentials: "omit", cache: "force-cache", referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error(String(response.status));
        data = new Uint8Array(await response.arrayBuffer());
      } catch {
        throw new KioskError("PROVING_FILES_UNAVAILABLE", "The proving files could not be loaded. Please try again.", { retryable: true });
      }
      if ((await sha256Hex(data)) !== pinned.files[name]) throw new KioskError("PROVING_FILES_REJECTED", "A proving file does not match this kiosk's pinned fingerprint and was refused. Nothing was prepared. Please ask a polling official.");
      files[name] = { type: "mem", data };
      options.onProgress?.(++done, names.length);
    }
    installArtifacts({ validity: { wasm: files["ballot_validity.wasm"]!, zkey: files["ballot_validity_final.zkey"]! }, semaphore20: { wasm: files["semaphore-20.wasm"]!, zkey: files["semaphore-20.zkey"]! } });
  })().catch((err: unknown) => {
    loading = null; // a failed or refused load can be retried
    throw err;
  });
  return loading;
}
export { artifactsInstalled } from "./shims/artifacts.ts";
