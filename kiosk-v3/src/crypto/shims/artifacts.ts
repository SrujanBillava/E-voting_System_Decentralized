// BUILD-TIME REPLACEMENT of privacy-v3/src/artifacts.js for the browser (same exports, same call shapes). Where the Node original returns FILE PATHS, this returns the
// VERIFIED BYTES of the locally bundled proving artifacts as snarkjs "mem" files: `{ type: "mem", data }`. They are filled in by `loadProvingArtifacts` (crypto/artifacts.ts),
// which fetches them from the kiosk's own origin and checks every file's SHA-256 against the hashes pinned in the build BEFORE any proof can use them.
export interface MemFile {
  type: "mem";
  data: Uint8Array;
}
const empty = { wasm: undefined as MemFile | undefined, zkey: undefined as MemFile | undefined };

export const ROOT = "";
export const validityArtifacts: { wasm: MemFile | undefined; zkey: MemFile | undefined; vkey: undefined; r1cs: undefined } = { ...empty, vkey: undefined, r1cs: undefined };
const semaphore = new Map<number, { wasm: MemFile | undefined; zkey: MemFile | undefined }>();

export const semaphoreArtifacts = (depth: number) => semaphore.get(depth) ?? { ...empty };

export function requireArtifacts(...files: unknown[]): void {
  if (files.some((file) => !file)) throw new Error("the proving artifacts are not loaded (or failed their integrity check)");
}

/** Called only by loadProvingArtifacts, after the integrity check. */
export function installArtifacts(parts: { validity: { wasm: MemFile; zkey: MemFile }; semaphore20: { wasm: MemFile; zkey: MemFile } }): void {
  validityArtifacts.wasm = parts.validity.wasm;
  validityArtifacts.zkey = parts.validity.zkey;
  semaphore.set(20, parts.semaphore20);
}
export const artifactsInstalled = (): boolean => Boolean(validityArtifacts.wasm && validityArtifacts.zkey && semaphore.get(20)?.zkey);
