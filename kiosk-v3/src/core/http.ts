import { KioskError } from "./errors.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The origin-separation switch. Once the credential is issued the kiosk is in ANONYMOUS MODE for good: `lock()` is called and the identity client then refuses every request
 * BEFORE touching the network. There is no unlock. (A fresh voter is a fresh page session.)
 */
export class AnonymousGuard {
  #locked = false;
  get locked(): boolean {
    return this.#locked;
  }
  lock(): void {
    this.#locked = true;
  }
}

interface Reply {
  status: number;
  body: unknown;
}

async function send(fetchFn: FetchLike, url: string, method: "GET" | "POST", credentials: "include" | "omit", payload: unknown, label: string): Promise<Reply> {
  const init: RequestInit = { method, credentials, headers: { Accept: "application/json", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) }, cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) };
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch {
    throw new KioskError(`${label}_UNREACHABLE`, `The ${label.toLowerCase()} service could not be reached.`, { retryable: true });
  }
  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new KioskError(`${label}_BAD_RESPONSE`, `The ${label.toLowerCase()} service answered something unexpected.`, { retryable: response.status >= 500, status: response.status });
    }
  }
  return { status: response.status, body };
}

const errorOf = (reply: Reply): { code: string; message: string } => {
  const e = (reply.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return { code: typeof e?.code === "string" ? e.code : "UNKNOWN", message: typeof e?.message === "string" ? e.message : "The request was refused." };
};
const dataOf = <T>(reply: Reply): T => {
  const data = (reply.body as { data?: T } | null)?.data;
  if (data === undefined) throw new KioskError("BAD_RESPONSE", "The service answered something unexpected.", { status: reply.status });
  return data;
};

export interface IdentityDescriptor {
  voter: { name: string; constituencyCode: string; faceEnrolled: boolean };
  stage: string;
  stageExpiresAt: string;
}
export interface FaceStatus {
  enrolled: boolean;
  verified: boolean;
  attemptsLeft: number;
  locked: boolean;
}
export interface FaceChallenge {
  challenge: string;
  action: "BLINK" | "TURN_LEFT" | "TURN_RIGHT";
  expiresAt: string;
  attemptsLeft: number;
}
export type FaceVerifyResult = { verified: true; stage: string; stageExpiresAt: string } | { verified: false; attemptsLeft: number; locked: boolean };
export interface CredentialIssued {
  state: "CREDENTIAL_ISSUED";
  constituency: { code: string; id: string };
  group: { groupId: string; merkleTreeDepth: number; root: string; size: number };
}
export type CredentialPoll = { state: "PENDING" } | CredentialIssued;

/**
 * THE IDENTITY CLIENT. The only code that sends the identity cookie (`credentials: "include"`), and only to the identity base. It offers login, face, eligibility and the
 * credential: there is NO method for a ballot, a receipt or a result, and once the guard is locked there is no method at all.
 */
export function createIdentityClient(options: { fetch: FetchLike; base: string; guard: AnonymousGuard }) {
  const { base, guard } = options;
  const call = async (method: "GET" | "POST", path: string, payload?: unknown): Promise<Reply> => {
    if (guard.locked) throw new KioskError("IDENTITY_LOCKED", "The identity session is over; this kiosk now only works anonymously.");
    return send(options.fetch, `${base}${path}`, method, "include", payload, "IDENTITY");
  };
  const ok = <T>(reply: Reply): T => {
    if (reply.status >= 200 && reply.status < 300) return dataOf<T>(reply);
    const { code, message } = errorOf(reply);
    throw new KioskError(code, message, { status: reply.status, retryable: reply.status >= 500 || reply.status === 429 });
  };
  return {
    login: async (identifier: string, password: string) => ok<IdentityDescriptor>(await call("POST", "/auth/login", { identifier, password })),
    logout: async () => {
      await call("POST", "/auth/logout", {});
    },
    status: async () => ok<IdentityDescriptor>(await call("GET", "/status")),
    faceStatus: async () => ok<FaceStatus>(await call("GET", "/face/status")),
    faceChallenge: async () => ok<FaceChallenge>(await call("POST", "/face/challenge", {})),
    faceVerify: async (input: { challenge: string; descriptor: number[]; liveness?: { passed: boolean } }) => ok<FaceVerifyResult>(await call("POST", "/face/verify", input)),
    eligibility: async () => ok<{ eligible: boolean; stage: string; constituency: { code: string; name: string } }>(await call("POST", "/eligibility/check", {})),
    /** the ONLY thing the identity side ever receives about the voter's anonymous identity: the public commitment */
    requestCredential: async (commitment: string) => ok<{ state: "PENDING" }>(await call("POST", "/credential", { commitment })),
    pollCredential: async () => ok<CredentialPoll>(await call("GET", "/credential")),
  };
}
export type IdentityClient = ReturnType<typeof createIdentityClient>;

export interface RelayGroup {
  constituencyId: string;
  groupId: string;
  merkleTreeDepth: number;
  root: string;
  size: number;
  leaves: string[];
  checkpoints: { size: number; root: string; blockNumber: number; timestamp: number | null }[];
}
export interface RelayBallotStatus {
  state: "QUEUED" | "SIGNED" | "BROADCAST" | "CONFIRMED" | "FAILED";
  nullifier: string;
  txHash?: string;
  blockNumber?: number;
  ballotIndex?: number;
  failureCode?: string;
}
export interface RelayWirePackage {
  constituencyId: string;
  membership: { merkleTreeDepth: string; merkleTreeRoot: string; nullifier: string; points: string[] };
  coords: string[];
  validity: { a: string[]; b: string[][]; c: string[] };
}
export type RelayReply = { ok: true; status: number; data: RelayBallotStatus } | { ok: false; status: number; code: string; message: string };

/**
 * THE RELAY CLIENT. Every request is `credentials: "omit"`: no cookie, and it sends no Authorization header, no voter id, no session id, nothing but the public package
 * (or a nullifier / a constituency in the path). It has no access to the identity guard or the identity base.
 */
export function createRelayClient(options: { fetch: FetchLike; base: string }) {
  const { base } = options;
  const call = (method: "GET" | "POST", path: string, payload?: unknown) => send(options.fetch, `${base}${path}`, method, "omit", payload, "RELAY");
  return {
    getGroup: async (constituency: string): Promise<RelayGroup> => {
      const reply = await call("GET", `/groups/${encodeURIComponent(constituency)}`);
      if (reply.status !== 200) {
        const { code, message } = errorOf(reply);
        throw new KioskError(`RELAY_${code}`, message, { status: reply.status, retryable: reply.status >= 500 });
      }
      return dataOf<RelayGroup>(reply);
    },
    postBallot: async (pkg: RelayWirePackage): Promise<RelayReply> => interpret(await call("POST", "/ballots", pkg)),
    getBallot: async (nullifier: string): Promise<RelayReply> => interpret(await call("GET", `/ballots/${encodeURIComponent(nullifier)}`)),
  };
}
function interpret(reply: Reply): RelayReply {
  if (reply.status >= 200 && reply.status < 300) return { ok: true, status: reply.status, data: dataOf<RelayBallotStatus>(reply) };
  const { code, message } = errorOf(reply);
  return { ok: false, status: reply.status, code, message };
}
export type RelayClient = ReturnType<typeof createRelayClient>;
