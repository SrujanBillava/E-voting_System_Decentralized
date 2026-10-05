// Error types of the trustee toolkit. Messages carry a stable machine-readable code and PUBLIC context only (indices, field names):
// never a secret scalar, share, nonce, password or key, because errors end up in logs.

export class ToolkitError extends Error {
  readonly code: string;
  /** the message without the code prefix */
  readonly detail: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = new.target.name;
    this.code = code;
    this.detail = message;
  }
}

/** A value handed to an API (or received from a peer) is malformed or out of range. */
export class InvalidInputError extends ToolkitError {}

/** The key ceremony failed and is dead: there is no complaint or recovery round, the ceremony must restart with fresh randomness. */
export class CeremonyAbort extends ToolkitError {}

/** A proof, transcript or partial decryption did not verify. */
export class VerificationError extends ToolkitError {}
