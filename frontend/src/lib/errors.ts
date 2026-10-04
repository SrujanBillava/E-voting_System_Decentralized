import { isApiError } from "../api/http";

/**
 * User-facing wording for backend error codes. The backend's `message` is safe to show, but several codes deserve clearer,
 * kiosk-appropriate text. Unknown codes fall back to the backend's own message.
 */
const MESSAGES: Record<string, string> = {
  NETWORK: "The server could not be reached. Check the connection and try again.",
  CHAIN_UNAVAILABLE: "The voting service cannot reach the ledger right now. Please try again in a moment.",
  RATE_LIMITED: "Too many attempts. Please wait a minute and try again.",
  INVALID_CREDENTIALS: "That voter ID / email and password do not match.",
  SESSION_ACTIVE: "This voter already has a session in progress. Ask a polling official for help.",
  SESSION_EXPIRED: "Your session has ended. Please start again.",
  UNAUTHENTICATED: "Your session has ended. Please start again.",
  VOTER_SUSPENDED: "This voter account cannot vote. Please see a polling official.",
  ELECTION_NOT_OPEN: "Voting has not opened yet.",
  ELECTION_CLOSED: "Voting has closed.",
  STAGE_REQUIRED: "That step is not available right now.",
  CONSTITUENCY_NOT_CONFIGURED: "Your constituency is not set up for this election. Please see a polling official.",
  AUTHORIZATION_EXPIRED: "The time to cast this ballot ran out. Please start again.",
  AUTHORIZATION_ALREADY_ISSUED: "A selection has already been confirmed for this ballot.",
  VOTE_IN_FLIGHT: "Your ballot is still being confirmed.",
  VOTE_NOT_RECORDED: "Your ballot could not be confirmed on the ledger. Please see a polling official; do not try to vote again on your own.",
  TX_REVERTED: "Your ballot could not be completed. Please see a polling official; do not try to vote again on your own.",
  CAST_IN_PROGRESS: "Your ballot is being processed. Please wait.",
  ALREADY_VOTED: "A ballot has already been accepted for this voter.",
  FACE_MISMATCH: "Face could not be verified.",
  FACE_LOCKED: "Face verification is locked for this session. Please ask a polling official for assistance.",
  FACE_NOT_ENROLLED: "No face is enrolled for this voter. Please ask a polling official.",
  FACE_CHALLENGE_INVALID: "That face check timed out. A new one will start.",
  FACE_REENROLMENT_REQUIRED: "This voter's face needs to be enrolled again. Please ask a polling official.",
  FACE_LIVENESS_FAILED: "The face check could not confirm the requested movement. Please try again.",
  FACE_CHALLENGE_LIMIT: "Too many face checks were started in this session. Please ask a polling official for assistance.",
  FACE_SAMPLES_INCONSISTENT: "The samples do not look like the same person. Capture them again.",
  RECONCILIATION_REQUIRED: "Your ballot needs to be checked by an election official. Please stay at the terminal and ask for help.",
  RECEIPT_NOT_FOUND: "No such transaction was found.",
  RECEIPT_INVALID: "This transaction is not a recorded ballot of this election.",
  RESULTS_NOT_AVAILABLE: "Official results are published after the election closes.",
  RESULT_INCONSISTENCY: "The results could not be verified and are not being published.",
  ELECTION_LOCKED: "The election is open or closed, so this configuration can no longer be changed.",
  INVALID_STEP_UP: "That authenticator code was not accepted. Wait for a new code and try again.",
  INVALID_CONFIRMATION: "The confirmation text did not match.",
  PREFLIGHT_FAILED: "The system checks did not pass, so the election was not opened.",
  WRONG_PHASE: "The election is not in the right phase for that action.",
};

/** Wording for a known code (without an ApiError instance). */
export const messageForCode = (code: string): string => MESSAGES[code] ?? "Something went wrong. Please try again.";

export function messageFor(err: unknown): string {
  if (isApiError(err)) return MESSAGES[err.code] ?? err.message;
  return "Something went wrong. Please try again.";
}

