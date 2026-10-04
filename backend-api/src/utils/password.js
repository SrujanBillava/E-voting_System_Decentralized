/**
 * bcrypt only looks at the first 72 BYTES of a password (not characters), and silently ignores the rest. A password longer than
 * that is therefore refused everywhere instead of being truncated.
 */
export const MAX_PASSWORD_BYTES = 72;
export const exceedsBcryptLimit = (password) => typeof password === "string" && Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES;
