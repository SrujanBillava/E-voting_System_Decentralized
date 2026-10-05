import { AppError } from "./errors.js";

/** zod parse that reports FIELD NAMES only, never submitted values. An unrecognised key (a voter id, a token, ...) is refused by name. */
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys : [i.path.join(".") || "(body)"])))];
    throw new AppError(400, "VALIDATION_FAILED", `Invalid request: ${fields.join(", ")}`);
  }
  return result.data;
}
