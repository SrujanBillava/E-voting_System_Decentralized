import { notFound as notFoundError } from "../utils/errors.js";

export function notFound(_req, _res, next) {
  next(notFoundError());
}
