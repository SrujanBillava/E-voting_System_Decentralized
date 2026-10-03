/**
 * Errors that are SAFE to show to API clients: the status, code and message are chosen by us.
 * Anything that is not an AppError is treated as internal and is never echoed to the client.
 */
export class AppError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export const notFound = (message = "Route not found") => new AppError(404, "NOT_FOUND", message);
