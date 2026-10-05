/** One error type for the whole kiosk: a stable machine code, a message safe to show a voter (never a secret), and whether trying again can help. */
export class KioskError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  constructor(code: string, message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = "KioskError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}
export const isKioskError = (err: unknown): err is KioskError => err instanceof KioskError;
