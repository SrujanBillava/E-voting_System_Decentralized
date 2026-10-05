// The public API of the trustee toolkit: the trustee WORKFLOW. Decryption is aggregate-only by construction: the only ciphertext type any function here
// accepts is AggregateCiphertext (per-slot sums for a whole constituency); there is no function that decrypts a single ballot.
// Low-level primitives (point arithmetic, the two proofs, share transport) live in their own modules for the tests and are deliberately NOT exported here.
export { Trustee } from "./trustee.ts";
export type { TrusteeOptions, TrusteeState } from "./trustee.ts";
export { AggregateCiphertext } from "./aggregate.ts";
export type { AggregateSlot } from "./aggregate.ts";
export { DEFAULT_PARAMS, TRANSCRIPT_VERSION, buildTranscript, confirmCeremony, deserializeTranscript, serializeTranscript, verifyTranscript } from "./ceremony.ts";
export type { Announcement, CommitmentMessage, Confirmation, DkgParams, EncryptedShare, ParsedTranscript, Transcript, VerifyResult } from "./ceremony.ts";
export { combinePartialDecryptions, tallyAggregate, verifyPartialDecryption } from "./threshold.ts";
export type { Combined, PartialDecryption, PartialSlot, TallyResult } from "./threshold.ts";
export { KDF_MODERATE, KDF_SENSITIVE, readShareFile, writeShareFile } from "./storage.ts";
export type { KdfParams, ShareFile } from "./storage.ts";
export { DEFAULT_MIN_BALLOTS, DEFAULT_THRESHOLD, DEFAULT_TRUSTEES, MAX_BALLOT_COUNT, MAX_SLOTS, SUBGROUP_ORDER, TEST_CONTEXT } from "./params.ts";
export type { ElectionContext, Point } from "./params.ts";
export { CeremonyAbort, InvalidInputError, ToolkitError, VerificationError } from "./errors.ts";
