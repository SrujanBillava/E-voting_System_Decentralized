// TEST SUPPORT. The leak scanner: looks for forbidden VALUES (and every common spelling of a number) in text, and for forbidden NAMES in source or schemas.
const spellings = (value) => {
  const out = new Set([String(value)]);
  if (/^[0-9]+$/.test(String(value))) {
    const hex = BigInt(String(value)).toString(16);
    out.add(hex).add(hex.padStart(64, "0")).add("0x" + hex).add("0x" + hex.padStart(64, "0"));
  }
  if (/^0x[0-9a-fA-F]+$/.test(String(value))) {
    out.add(String(value).toLowerCase()).add(String(value).slice(2).toLowerCase());
    out.add(BigInt(value).toString(10));
  }
  return [...out].filter((s) => s.length >= 8);
};

/** which of `needles` (any spelling) occur in `haystack`? Returns the offending needles. */
export function findLeaks(haystack, needles) {
  const text = String(haystack).toLowerCase();
  return needles.filter((needle) => spellings(needle).some((form) => text.includes(form.toLowerCase())));
}
export function assertNoLeaks(label, haystack, needles) {
  const leaked = findLeaks(haystack, needles);
  if (leaked.length > 0) throw new Error(`${label}: contains ${leaked.length} forbidden value(s)`);
}

/** forbidden NAMES: a regex over identifiers/keys. Returns the matching names. */
export const findForbiddenNames = (names, pattern) => names.filter((n) => pattern.test(n));
