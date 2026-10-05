import type { BallotRecord, FlowRecord, Receipt, StorageLike } from "./types.ts";

/**
 * The kiosk's only persistence: `sessionStorage` (it survives an ordinary page refresh and disappears when the tab is destroyed), never localStorage, IndexedDB or a cookie, and
 * never the backend. These four keys are ALL it ever writes (a test lists them). `identity` is the voter's private Semaphore identity; `ballot` is public material only.
 */
export const KEYS = Object.freeze({ identity: "vc3.identity", flow: "vc3.flow", ballot: "vc3.ballot", receipt: "vc3.receipt" });
export const ALL_KEYS: readonly string[] = Object.values(KEYS);

const read = <T>(storage: StorageLike, key: string, valid: (value: unknown) => boolean): T | null => {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (valid(value)) return value as T;
  } catch {
    // fall through: a damaged record is treated as absent and removed
  }
  storage.removeItem(key);
  return null;
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createSessionStore(storage: StorageLike) {
  return {
    /** the private identity export (Identity.export()); null when there is none */
    getIdentity: (): string | null => read<{ v: 1; identity: string }>(storage, KEYS.identity, (v) => isObject(v) && v.v === 1 && typeof v.identity === "string")?.identity ?? null,
    setIdentity: (identity: string) => storage.setItem(KEYS.identity, JSON.stringify({ v: 1, identity })),
    getFlow: () => read<FlowRecord>(storage, KEYS.flow, (v) => isObject(v) && v.v === 1 && (v.stage === "CREDENTIAL_REQUESTED" || v.stage === "CREDENTIAL_ISSUED") && isObject(v.constituency) && typeof v.commitment === "string"),
    setFlow: (flow: FlowRecord) => storage.setItem(KEYS.flow, JSON.stringify(flow)),
    getBallot: () => read<BallotRecord>(storage, KEYS.ballot, (v) => isObject(v) && v.v === 1 && typeof v.nullifier === "string" && typeof v.digest === "string" && Array.isArray(v.ciphertexts)),
    setBallot: (ballot: BallotRecord) => storage.setItem(KEYS.ballot, JSON.stringify(ballot)),
    getReceipt: () => read<Receipt>(storage, KEYS.receipt, (v) => isObject(v) && v.v === 1 && typeof v.txHash === "string"),
    setReceipt: (receipt: Receipt) => storage.setItem(KEYS.receipt, JSON.stringify(receipt)),
    /** removes every voting secret: the private identity, the anonymous package and the flow record. (The receipt holds only public recording data and stays.) */
    wipeVotingSecrets: () => {
      for (const key of [KEYS.identity, KEYS.ballot, KEYS.flow]) storage.removeItem(key);
    },
    /** the whole voting session, receipt included (the voter leaves the kiosk) */
    wipeAll: () => {
      for (const key of ALL_KEYS) storage.removeItem(key);
    },
    keys: (): string[] => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k): k is string => k !== null),
  };
}
export type SessionStore = ReturnType<typeof createSessionStore>;

/** An in-memory Storage, for tests and for the Node harness. */
export function memoryStorage(): StorageLike & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    dump: () => Object.fromEntries(map),
  };
}
