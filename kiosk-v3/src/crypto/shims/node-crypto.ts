// BUILD-TIME SHIM for the browser: `node:crypto` -> the browser's CSPRNG.
//
// The frozen privacy-v3 core draws ALL its randomness (encryption randomness r, per active slot) from `randomBytes(48).toString("hex")` of node:crypto, with deliberately
// no parameter, seed or hook to substitute another source. In the browser that single call is answered by `crypto.getRandomValues`, the operating system's
// CSPRNG, and by nothing else. The frozen module itself is bundled UNCHANGED.
class RandomBytes extends Uint8Array {
  override toString(encoding?: string): string {
    if (encoding !== "hex") throw new Error("this shim only supports hex");
    return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export function randomBytes(size: number): RandomBytes {
  if (!Number.isInteger(size) || size < 1 || size > 1024) throw new RangeError("randomBytes: a size from 1 to 1024");
  const out = new RandomBytes(size);
  globalThis.crypto.getRandomValues(out);
  return out;
}
export default { randomBytes };
