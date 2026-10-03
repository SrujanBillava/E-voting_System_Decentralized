/** Small presentation helpers. No business rules live here. */
export const shortHash = (hash: string, head = 10, tail = 8): string => (hash.length <= head + tail + 1 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`);

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
export const formatDateTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTime.format(d);
};

const integer = new Intl.NumberFormat();
/** Backend uint256 values arrive as strings; they are small here, but never go through Number() unless they fit. */
export const formatCount = (value: string | number | bigint): string => {
  try {
    return integer.format(typeof value === "string" ? BigInt(value) : value);
  } catch {
    return String(value);
  }
};

export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
