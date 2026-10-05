import { isKioskError } from "../core/index.ts";

/**
 * What a voter reads when something fails. KioskError messages are written to be shown (they never contain a secret, a key or a raw server answer); anything else
 * (a bug, a browser failure) gets a generic sentence, never a stack trace and never the error text itself.
 */
export function messageFor(err: unknown): string {
  if (isKioskError(err)) return err.message;
  return "Something went wrong on this kiosk. Nothing was sent. Please try again, or ask a polling official.";
}

/** Failures that mean "this voter's identity session is over": the kiosk goes back to the login. */
export const SESSION_ENDED = new Set(["UNAUTHENTICATED", "SESSION_EXPIRED", "ELECTION_CLOSED", "ELECTION_NOT_OPEN", "ISSUANCE_CLOSED"]);
export const sessionEnded = (err: unknown): boolean => isKioskError(err) && (err.status === 401 || SESSION_ENDED.has(err.code));

export const retryable = (err: unknown): boolean => isKioskError(err) && err.retryable;
export const codeOf = (err: unknown): string => (isKioskError(err) ? err.code : "UNEXPECTED");

/** The honest, plain-language statement of who sees what, shown on the first screen. */
export const TRUST_NOTICE = [
  "This kiosk is a trusted device: it sees who you are while you sign in, and it sees your choice on screen while you vote.",
  "The election servers are kept apart: the identity service learns that you were allowed to vote but never your choice; the ballot network receives only an encrypted ballot and never learns who you are.",
];

/** The reminder for the people who build and release this software. Deliberately not alarming: it is a build note, not a voter warning. */
export const PROTOTYPE_NOTICE = {
  summary: "Developer notice: test cryptographic setup",
  body: "The zero-knowledge proving files bundled with this build come from a TEST / PROTOTYPE Groth16 setup. They are fine for development and rehearsal.",
  steps: [
    "Generate the final ceremony artifacts",
    "Export the final BallotValidityVerifier",
    "Replace the browser proving zkey (and its pinned hash)",
    "Verify provenance and hashes",
    "Rerun the final end-to-end test",
  ],
  heading: "Before the final V3 freeze:",
};
