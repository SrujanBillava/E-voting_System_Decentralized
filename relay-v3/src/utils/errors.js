/** Errors that are SAFE to show to API clients: the status, code and message are chosen by us. Anything else is internal and never echoed. */
export class AppError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = options?.details;
  }
}
