/** The subset of the Web Storage API the kiosk uses. In the browser it is `sessionStorage` and nothing else; tests inject an in-memory one. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/** Everything the kiosk is pinned to. In the production build these come from build-time constants; nothing is read from the user. */
export interface KioskConfig {
  /** the identity service, e.g. http://id.votechain.localhost:5100/api/v3/voter (the ONLY origin that ever gets the identity cookie) */
  identityBase: string;
  /** the anonymous relayer, e.g. http://relay.votechain.localhost:5200/v1 (always called with credentials: "omit") */
  relayBase: string;
  /** a READ-ONLY JSON-RPC endpoint of the chain (no wallet, no key, never a transaction) */
  rpcUrl: string;
  chainId: number;
  contractAddress: string;
  /** optional pin of the election id; the contract's own value is always read and compared */
  electionId?: string;
  /** polling interval for credential issuance and relay status (ms) */
  pollMs?: number;
  /** how long to wait for issuance / confirmation before telling the voter it is still pending (ms) */
  issuanceTimeoutMs?: number;
  confirmTimeoutMs?: number;
}

export interface Constituency {
  code: string;
  /** bytes32, keccak256(utf8(code)) */
  id: string;
}

/** Election parameters read from the contract and cross-checked: never taken from a service or from the voter. */
export interface ElectionParams {
  ctx: { chainId: bigint; contractAddress: bigint; electionId: bigint };
  electionId: string;
  constituency: Constituency;
  /** display only */
  constituencyName: string;
  kc: number;
  candidates: string[];
  H: [bigint, bigint];
  groupId: bigint;
  depth: number;
  semaphore: string;
}

export interface WireCiphertext {
  c1: [string, string];
  c2: [string, string];
}
export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}
export interface SemaphoreProofWire {
  merkleTreeDepth: number | string;
  merkleTreeRoot: string;
  message: string;
  nullifier: string;
  scope: string;
  points: string[];
}

/**
 * The IMMUTABLE anonymous ballot, persisted for ordinary retries. Only public material plus what is needed to re-prove MEMBERSHIP: no plaintext choice, no one-hot vector, no
 * encryption randomness (those exist in memory only while the proofs are being generated). Everything except `membership` and `relay` is covered by `digest`.
 */
export interface BallotRecord {
  v: 1;
  constituency: Constituency;
  kc: number;
  H: [string, string];
  ctx: { chainId: string; contractAddress: string; electionId: string };
  scope: string;
  nullifier: string;
  ballotHash: string;
  ciphertexts: WireCiphertext[];
  validity: { proof: Groth16Proof };
  digest: string;
  /** the ONLY part that may change: a newer Semaphore proof against a newer root */
  membership: SemaphoreProofWire;
  /** the relayer's last answer for this package, so a refresh resumes instead of recasting */
  relay?: { state: string; txHash?: string };
}

export interface FlowRecord {
  v: 1;
  stage: "CREDENTIAL_REQUESTED" | "CREDENTIAL_ISSUED";
  constituency: Constituency;
  /** the voter's own PUBLIC commitment (derived from the private identity; kept only to find it in the public group) */
  commitment: string;
}

/** What the voter gets: only public recording data. No nullifier, commitment, root, candidate or identity. */
export interface Receipt {
  v: 1;
  electionId: string;
  chainId: number;
  contract: string;
  constituency: Constituency;
  ballotIndex: number;
  ballotHash: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  statement: string;
}

export interface RecordedEvidence {
  constituencyId: string;
  ballotIndex: number;
  ballotHash: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
}
