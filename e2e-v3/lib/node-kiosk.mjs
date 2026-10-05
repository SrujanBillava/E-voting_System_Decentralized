// The kiosk engine, running in Node exactly as the browser runs it: the same TypeScript source, a cookie-honouring fetch, an in-memory sessionStorage, the real chain reader.
// Only the webcam is a stand-in (a descriptor of the enrolled imaginary person).
import { capture, person, rounded } from "../../backend-api/test/helpers/face.js";
import { createChainReader, createKiosk, memoryStorage } from "../../kiosk-v3/src/core/index.ts";
import { createCookieFetch } from "./cookie-fetch.mjs";

/** a safe, test-only stand-in for the physical camera: a capture of imaginary person `seed` (similarity controls whether it matches the enrolment) */
export const testFace = (seed, similarity = 0.9) => ({ descriptor: async () => ({ descriptor: rounded(capture(person(seed), similarity, 1)), liveness: { passed: true } }) });

export function nodeKiosk(stack, overrides = {}) {
  const storage = overrides.storage ?? memoryStorage();
  const fetch = overrides.fetch ?? createCookieFetch({ origin: stack.origins.kiosk });
  const chain = overrides.chain ?? createChainReader(stack.kioskConfig);
  const kiosk = createKiosk({ config: { ...stack.kioskConfig, ...(overrides.config ?? {}) }, fetch, storage, chain });
  return { kiosk, storage, fetch, chain };
}
