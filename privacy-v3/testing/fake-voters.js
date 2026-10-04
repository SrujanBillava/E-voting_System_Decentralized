// TEST / DEMO / BENCHMARK SUPPORT ONLY. Never import this from src/ (test/fast.rng.test.mjs fails if src/ ever does).
//
// Real voter identities are generated randomly on the voter's device (`new Identity()`). These are the opposite on purpose: deterministic
// identities derived from a LABEL, so the demo, the benchmarks and the tests have repeatable "fake voters". Anyone who knows the label knows the
// secret, so these identities protect nothing.
import { Identity } from "@semaphore-protocol/identity";

export const fakeVoter = (label) => new Identity(`fake-voter:${label}`);
