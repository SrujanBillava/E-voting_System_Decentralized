// The PUBLIC side of the key ceremony: strict parsing and validation of every message a trustee publishes, the public transcript, its canonical
// serialisation and hash, and the verifier anybody (an auditor, the future contract's deployer, another trustee) can run on it.
// Nothing in this file ever sees a secret.
//
// Ceremony (3 trustees, threshold 2, no dealer, Feldman verifiable secret sharing, no complaint round: ANY failure aborts and the ceremony restarts):
//   round 0  every trustee i announces a fresh temporary X25519 transport public key
//            ceremonyId = keccak256(abi.encode(CEREMONY_TAG, chainId, contract, electionId, n, t, key_1 .. key_n))   binds everything below to these keys
//   round 1  every trustee publishes K_ik = a_ik * G for its polynomial f_i(x) = a_i0 + a_i1*x  and a Schnorr proof of knowledge of every a_ik
//   round 2  trustee i sends f_i(j) to trustee j, encrypted (src/transport.ts)
//   round 3  trustee j checks f_i(j)*G == K_i0 + j*K_i1 for every i, computes s_j = sum_i f_i(j), and checks s_j*G == vk_j with vk_j computed from public data
//   result   H = sum_i K_i0;  vk_j = sum_i (K_i0 + j*K_i1);  the full secret s = sum_i a_i0 is never computed by anybody
import { assertContext, contextToWire, contextWords, parseContextWire, type WireContext } from "./context.ts";
import { assertInteger, bytesToBigInt, exactKeys, hex32, hexOfBytes, keccakWords, parseHex32, parseHexBytes } from "./encoding.ts";
import { InvalidInputError, ToolkitError, VerificationError } from "./errors.ts";
import { interpolatePointsAtZero } from "./lagrange.ts";
import { CEREMONY_TAG, DEFAULT_THRESHOLD, DEFAULT_TRUSTEES, IDENTITY, MAX_TRUSTEES, TRANSCRIPT_TAG, type ElectionContext, type Point } from "./params.ts";
import { add, isIdentity, mul, parsePointWire, pointToWire, pointsEqual, type WirePoint } from "./point.ts";
import { parseProofWire, proofToWire, type Proof, type WireProof } from "./proof.ts";
import { verifyKnowledge } from "./schnorr.ts";
import { TRANSPORT_KEY_BYTES, isUsableTransportPublicKey } from "./transport.ts";

export const TRANSCRIPT_VERSION = "votechain-v3-dkg-transcript-1";

export interface DkgParams {
  readonly n: number; // trustees
  readonly t: number; // threshold: any t of the n decrypt, t-1 learn nothing
}
export const DEFAULT_PARAMS: DkgParams = Object.freeze({ n: DEFAULT_TRUSTEES, t: DEFAULT_THRESHOLD });

export function assertParams(p: DkgParams): DkgParams {
  assertInteger(p?.n, 2, MAX_TRUSTEES, "number of trustees");
  assertInteger(p?.t, 2, p.n, "threshold"); // t >= 2: with t = 1 a single trustee could decrypt alone
  return { n: p.n, t: p.t };
}

// ------------------------------------------------------------------------------------------------------------------------------ wire types

export interface Announcement {
  index: number;
  transportPublicKey: string; // 0x + 64 hex
}
export interface CommitmentMessage {
  index: number;
  commitments: WirePoint[]; // K_i0 .. K_i(t-1)
  proofs: WireProof[]; // Schnorr proof of knowledge of a_ik, one per commitment
}
export interface EncryptedShare {
  from: number;
  to: number;
  ciphertext: string; // 0x hex of nonce || crypto_box
}
export interface Confirmation {
  index: number;
  transcriptHash: string;
  verificationKey: WirePoint;
}
export interface TranscriptParticipant {
  index: number;
  transportPublicKey: string;
  commitments: WirePoint[];
  proofs: WireProof[];
}
export interface Transcript {
  version: typeof TRANSCRIPT_VERSION;
  context: WireContext;
  threshold: number;
  trustees: number;
  ceremonyId: string;
  participants: TranscriptParticipant[];
  electionPublicKey: WirePoint;
  verificationKeys: WirePoint[];
  transcriptHash: string;
}

export interface ParsedParticipant {
  readonly index: number;
  readonly transportKey: Uint8Array;
  readonly commitments: Point[];
  readonly proofs: Proof[];
}
export interface ParsedTranscript {
  readonly context: ElectionContext;
  readonly params: DkgParams;
  readonly ceremonyId: bigint;
  readonly participants: ParsedParticipant[];
  readonly electionPublicKey: Point;
  readonly verificationKeys: Point[];
  readonly transcriptHash: bigint;
}

// ------------------------------------------------------------------------------------------------------------------------------ parsing helpers

function parseIndex(value: unknown, params: DkgParams, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > params.n) throw new InvalidInputError("INVALID_INDEX", `${what} must be a trustee index in 1..${params.n}`);
  return value;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new InvalidInputError("BAD_STRUCTURE", `${what} must be an array`);
  return value;
}

/** Announcements -> index => transport public key. Exactly one valid, distinct, usable key per trustee 1..n; anything missing, duplicated or malformed aborts. */
export function parseAnnouncements(raw: unknown, params: DkgParams): Map<number, Uint8Array> {
  const list = asArray(raw, "announcements");
  if (list.length > params.n) throw new InvalidInputError("BAD_STRUCTURE", "more announcements than trustees");
  const keys = new Map<number, Uint8Array>();
  const seenKeys = new Set<string>();
  for (const item of list) {
    const o = exactKeys(item, ["index", "transportPublicKey"], "announcement");
    const index = parseIndex(o.index, params, "announcement index");
    if (keys.has(index)) throw new InvalidInputError("DUPLICATE_INDEX", `trustee ${index} announced twice`);
    const key = parseHexBytes(o.transportPublicKey, TRANSPORT_KEY_BYTES, "transportPublicKey");
    if (!isUsableTransportPublicKey(key)) throw new InvalidInputError("BAD_TRANSPORT_KEY", `trustee ${index} announced an unusable transport key`);
    const fingerprint = hexOfBytes(key);
    if (seenKeys.has(fingerprint)) throw new InvalidInputError("DUPLICATE_TRANSPORT_KEY", "two trustees announced the same transport key");
    seenKeys.add(fingerprint);
    keys.set(index, key);
  }
  if (keys.size !== params.n) throw new InvalidInputError("MISSING_TRUSTEE", `expected announcements from all ${params.n} trustees, got ${keys.size}`);
  return keys;
}

/** The ceremony id binds the election context, (n, t) and ALL transport keys: a message from another ceremony cannot be spliced into this one. */
export function computeCeremonyId(context: ElectionContext, params: DkgParams, keys: ReadonlyMap<number, Uint8Array>): bigint {
  const words: bigint[] = [CEREMONY_TAG, ...contextWords(assertContext(context)), BigInt(params.n), BigInt(params.t)];
  for (let i = 1; i <= params.n; i++) {
    const key = keys.get(i);
    if (!key) throw new InvalidInputError("MISSING_TRUSTEE", `no transport key for trustee ${i}`);
    words.push(bytesToBigInt(key));
  }
  return keccakWords(words);
}

/** Validates one trustee's round-1 message: exact shape, degree t-1, every commitment a valid non-identity subgroup point, every proof of knowledge valid. */
export function parseCommitmentMessage(raw: unknown, context: ElectionContext, ceremonyId: bigint, params: DkgParams): ParsedParticipantMessage {
  const o = exactKeys(raw, ["index", "commitments", "proofs"], "commitment message");
  const index = parseIndex(o.index, params, "commitment message index");
  const wireCommitments = asArray(o.commitments, "commitments");
  const wireProofs = asArray(o.proofs, "proofs");
  if (wireCommitments.length !== params.t) throw new InvalidInputError("WRONG_DEGREE", `trustee ${index} must publish exactly ${params.t} coefficient commitments (a polynomial of degree ${params.t - 1})`);
  if (wireProofs.length !== params.t) throw new InvalidInputError("WRONG_DEGREE", `trustee ${index} must publish exactly ${params.t} proofs of knowledge`);
  const commitments: Point[] = [];
  const proofs: Proof[] = [];
  for (let k = 0; k < params.t; k++) {
    try {
      commitments.push(parsePointWire(wireCommitments[k], `commitment ${k} of trustee ${index}`));
    } catch (error) {
      throw new InvalidInputError("INVALID_COMMITMENT", error instanceof ToolkitError ? error.message : "malformed commitment");
    }
    try {
      proofs.push(parseProofWire(wireProofs[k], `proof ${k} of trustee ${index}`));
    } catch (error) {
      throw new InvalidInputError("INVALID_PROOF_ENCODING", error instanceof ToolkitError ? error.message : "malformed proof");
    }
    if (!verifyKnowledge({ context, ceremonyId, trusteeIndex: index, coefficientIndex: k }, commitments[k], proofs[k])) {
      throw new VerificationError("INVALID_POK", `trustee ${index} did not prove knowledge of coefficient ${k}`);
    }
  }
  return { index, commitments, proofs };
}
export interface ParsedParticipantMessage {
  readonly index: number;
  readonly commitments: Point[];
  readonly proofs: Proof[];
}

/** Parses the n round-1 messages: one per trustee 1..n, each fully validated. */
export function parseCommitmentMessages(raw: unknown, context: ElectionContext, ceremonyId: bigint, params: DkgParams): Map<number, ParsedParticipantMessage> {
  const list = asArray(raw, "commitment messages");
  if (list.length > params.n) throw new InvalidInputError("BAD_STRUCTURE", "more commitment messages than trustees");
  const out = new Map<number, ParsedParticipantMessage>();
  for (const item of list) {
    const message = parseCommitmentMessage(item, context, ceremonyId, params);
    if (out.has(message.index)) throw new InvalidInputError("DUPLICATE_INDEX", `trustee ${message.index} published commitments twice`);
    out.set(message.index, message);
  }
  if (out.size !== params.n) throw new InvalidInputError("MISSING_TRUSTEE", `expected commitments from all ${params.n} trustees, got ${out.size}`);
  return out;
}

// ------------------------------------------------------------------------------------------------------------------------------ Feldman arithmetic

/** sum over k of j^k * K_k, by Horner's rule in the group: the public commitment to f(j) of a polynomial committed as (K_0, .., K_(t-1)). */
export function evaluateCommitments(commitments: readonly Point[], j: number): Point {
  const x = BigInt(j);
  let acc: Point = commitments[commitments.length - 1] as Point;
  for (let k = commitments.length - 2; k >= 0; k--) acc = add(mul(acc, x), commitments[k] as Point);
  return acc;
}

function subsets(n: number, t: number): number[][] {
  const out: number[][] = [];
  const walk = (start: number, chosen: number[]): void => {
    if (chosen.length === t) {
      out.push([...chosen]);
      return;
    }
    for (let i = start; i <= n; i++) walk(i + 1, [...chosen, i]);
  };
  walk(1, []);
  return out;
}

/** The three public results of a set of validated commitments. Used identically by the builder, the verifier and every trustee. */
export function deriveKeys(participants: readonly { index: number; commitments: readonly Point[] }[], params: DkgParams): { electionPublicKey: Point; verificationKeys: Point[] } {
  let H: Point = [IDENTITY[0], IDENTITY[1]];
  for (const p of participants) H = add(H, p.commitments[0] as Point);
  if (isIdentity(H)) throw new VerificationError("INVALID_ELECTION_KEY", "the election public key is the identity");
  const verificationKeys: Point[] = [];
  for (let j = 1; j <= params.n; j++) {
    let vk: Point = [IDENTITY[0], IDENTITY[1]];
    for (const p of participants) vk = add(vk, evaluateCommitments(p.commitments, j));
    if (isIdentity(vk)) throw new VerificationError("INVALID_VERIFICATION_KEY", `verification key ${j} is the identity`);
    verificationKeys.push(vk);
  }
  // pair consistency: interpolating ANY t verification keys at 0 must give H (every pair for 2-of-3)
  for (const subset of subsets(params.n, params.t)) {
    const point = interpolatePointsAtZero(subset, subset.map((i) => verificationKeys[i - 1] as Point));
    if (!pointsEqual(point, H)) throw new VerificationError("INCONSISTENT_KEYS", `verification keys ${subset.join(",")} do not interpolate to the election public key`);
  }
  return { electionPublicKey: H, verificationKeys };
}

/** keccak256(abi.encode(...)) of every public field in fixed order and width: the value a contract can pin. */
export function computeTranscriptHash(
  context: ElectionContext,
  params: DkgParams,
  ceremonyId: bigint,
  participants: readonly ParsedParticipant[],
  electionPublicKey: Point,
  verificationKeys: readonly Point[],
): bigint {
  const words: bigint[] = [TRANSCRIPT_TAG, ...contextWords(context), BigInt(params.n), BigInt(params.t), ceremonyId];
  for (const p of participants) {
    words.push(BigInt(p.index), bytesToBigInt(p.transportKey));
    for (const K of p.commitments) words.push(K[0], K[1]);
    for (const proof of p.proofs) words.push(proof.e, proof.z);
  }
  words.push(electionPublicKey[0], electionPublicKey[1]);
  for (const vk of verificationKeys) words.push(vk[0], vk[1]);
  return keccakWords(words);
}

// ------------------------------------------------------------------------------------------------------------------------------ transcript

function toWireTranscript(t: ParsedTranscript): Transcript {
  return {
    version: TRANSCRIPT_VERSION,
    context: contextToWire(t.context),
    threshold: t.params.t,
    trustees: t.params.n,
    ceremonyId: hex32(t.ceremonyId),
    participants: t.participants.map((p) => ({
      index: p.index,
      transportPublicKey: hexOfBytes(p.transportKey),
      commitments: p.commitments.map(pointToWire),
      proofs: p.proofs.map(proofToWire),
    })),
    electionPublicKey: pointToWire(t.electionPublicKey),
    verificationKeys: t.verificationKeys.map(pointToWire),
    transcriptHash: hex32(t.transcriptHash),
  };
}

export interface BuildInput {
  readonly context: ElectionContext;
  readonly params?: DkgParams;
  readonly announcements: unknown;
  readonly commitmentMessages: unknown;
}

/** Assembles the public transcript from the public messages, validating everything. Throws on the first problem (the ceremony then restarts from scratch). */
export function buildTranscript(input: BuildInput): Transcript {
  const params = assertParams(input.params ?? DEFAULT_PARAMS);
  const context = assertContext(input.context);
  const keys = parseAnnouncements(input.announcements, params);
  const ceremonyId = computeCeremonyId(context, params, keys);
  const messages = parseCommitmentMessages(input.commitmentMessages, context, ceremonyId, params);
  const participants: ParsedParticipant[] = [];
  for (let i = 1; i <= params.n; i++) {
    const m = messages.get(i) as ParsedParticipantMessage;
    participants.push({ index: i, transportKey: keys.get(i) as Uint8Array, commitments: m.commitments, proofs: m.proofs });
  }
  const { electionPublicKey, verificationKeys } = deriveKeys(participants, params);
  const transcriptHash = computeTranscriptHash(context, params, ceremonyId, participants, electionPublicKey, verificationKeys);
  return toWireTranscript({ context, params, ceremonyId, participants, electionPublicKey, verificationKeys, transcriptHash });
}

/** Strict structural parse of an untrusted transcript. Validates shapes and points; does NOT check proofs or recompute anything (verifyTranscript does). */
export function parseTranscriptStructure(raw: unknown): ParsedTranscript {
  const o = exactKeys(raw, ["version", "context", "threshold", "trustees", "ceremonyId", "participants", "electionPublicKey", "verificationKeys", "transcriptHash"], "transcript");
  if (o.version !== TRANSCRIPT_VERSION) throw new InvalidInputError("BAD_TRANSCRIPT", "unknown transcript version");
  const context = parseContextWire(o.context);
  const params = assertParams({ n: o.trustees as number, t: o.threshold as number });
  const participantsRaw = asArray(o.participants, "participants");
  if (participantsRaw.length !== params.n) throw new InvalidInputError("BAD_TRANSCRIPT", "the transcript must list every trustee");
  const participants: ParsedParticipant[] = participantsRaw.map((item, position) => {
    const p = exactKeys(item, ["index", "transportPublicKey", "commitments", "proofs"], "transcript participant");
    if (p.index !== position + 1) throw new InvalidInputError("BAD_TRANSCRIPT", "participants must be listed in index order 1..n");
    const commitments = asArray(p.commitments, "commitments");
    const proofs = asArray(p.proofs, "proofs");
    if (commitments.length !== params.t || proofs.length !== params.t) throw new InvalidInputError("WRONG_DEGREE", `participant ${position + 1} has the wrong number of commitments or proofs`);
    return {
      index: position + 1,
      transportKey: parseHexBytes(p.transportPublicKey, TRANSPORT_KEY_BYTES, "transportPublicKey"),
      commitments: commitments.map((c, k) => parsePointWire(c, `commitment ${k} of trustee ${position + 1}`)),
      proofs: proofs.map((pr, k) => parseProofWire(pr, `proof ${k} of trustee ${position + 1}`)),
    };
  });
  const vkRaw = asArray(o.verificationKeys, "verificationKeys");
  if (vkRaw.length !== params.n) throw new InvalidInputError("BAD_TRANSCRIPT", "need one verification key per trustee");
  return {
    context,
    params,
    ceremonyId: parseHex32(o.ceremonyId, "ceremonyId"),
    participants,
    electionPublicKey: parsePointWire(o.electionPublicKey, "electionPublicKey"),
    verificationKeys: vkRaw.map((v, i) => parsePointWire(v, `verificationKey ${i + 1}`)),
    transcriptHash: parseHex32(o.transcriptHash, "transcriptHash"),
  };
}

export interface Expectations {
  readonly context?: ElectionContext;
  readonly params?: DkgParams;
  /** the hash pinned somewhere trusted (the contract, the trustees' confirmations) */
  readonly transcriptHash?: string;
}
export type VerifyResult = { ok: true; transcript: ParsedTranscript } | { ok: false; code: string; reason: string };

const VERIFIED = new WeakSet<object>();
/** True only for a ParsedTranscript that verifyTranscript itself produced (a caller cannot forge one): downstream code then skips re-verification. */
export const isVerifiedTranscript = (value: unknown): value is ParsedTranscript => typeof value === "object" && value !== null && VERIFIED.has(value);

/**
 * The auditor's check. Re-derives EVERYTHING from the published transport keys and commitments (ceremony id, every proof of knowledge, H, every vk, pair
 * consistency, the hash) and compares with what the transcript claims. Never throws; anything wrong is { ok: false }.
 */
export function verifyTranscript(raw: unknown, expected: Expectations = {}): VerifyResult {
  try {
    const t = parseTranscriptStructure(raw);
    if (expected.context) {
      const a = contextToWire(expected.context);
      const b = contextToWire(t.context);
      if (a.chainId !== b.chainId || a.contractAddress !== b.contractAddress || a.electionId !== b.electionId) return fail("CONTEXT_MISMATCH", "transcript is for another election context");
    }
    if (expected.params && (expected.params.n !== t.params.n || expected.params.t !== t.params.t)) return fail("PARAMS_MISMATCH", "transcript uses other (n, t)");
    const keys = new Map(t.participants.map((p) => [p.index, p.transportKey] as const));
    for (const p of t.participants) if (!isUsableTransportPublicKey(p.transportKey)) return fail("BAD_TRANSPORT_KEY", `trustee ${p.index} has an unusable transport key`);
    if (new Set(t.participants.map((p) => hexOfBytes(p.transportKey))).size !== t.params.n) return fail("DUPLICATE_TRANSPORT_KEY", "two trustees share a transport key");
    const ceremonyId = computeCeremonyId(t.context, t.params, keys);
    if (ceremonyId !== t.ceremonyId) return fail("CEREMONY_ID_MISMATCH", "the ceremony id does not match the transport keys");
    for (const p of t.participants) {
      for (let k = 0; k < t.params.t; k++) {
        if (!verifyKnowledge({ context: t.context, ceremonyId, trusteeIndex: p.index, coefficientIndex: k }, p.commitments[k], p.proofs[k])) {
          return fail("INVALID_POK", `trustee ${p.index} coefficient ${k}: proof of knowledge does not verify`);
        }
      }
    }
    const { electionPublicKey, verificationKeys } = deriveKeys(t.participants, t.params);
    if (!pointsEqual(electionPublicKey, t.electionPublicKey)) return fail("ELECTION_KEY_MISMATCH", "the election public key is not the sum of the constant-term commitments");
    for (let j = 0; j < t.params.n; j++) if (!pointsEqual(verificationKeys[j] as Point, t.verificationKeys[j] as Point)) return fail("VERIFICATION_KEY_MISMATCH", `verification key ${j + 1} does not follow from the commitments`);
    const hash = computeTranscriptHash(t.context, t.params, ceremonyId, t.participants, electionPublicKey, verificationKeys);
    if (hash !== t.transcriptHash) return fail("HASH_MISMATCH", "the transcript hash does not match its contents");
    if (expected.transcriptHash !== undefined && parseHex32(expected.transcriptHash, "expected transcript hash") !== hash) return fail("HASH_MISMATCH", "the transcript hash differs from the pinned one");
    VERIFIED.add(t);
    return { ok: true, transcript: t };
  } catch (error) {
    return error instanceof ToolkitError ? fail(error.code, error.message) : fail("INTERNAL", "unexpected error while verifying the transcript");
  }
}

function fail(code: string, reason: string): VerifyResult {
  return { ok: false, code, reason };
}

/** Canonical serialisation: fixed key order, array order = index order, no whitespace, hex in one fixed form. The same transcript is always the same bytes. */
export function serializeTranscript(t: Transcript): string {
  const wirePoint = (p: WirePoint): WirePoint => [p[0], p[1]];
  const canonical: Transcript = {
    version: t.version,
    context: { chainId: t.context.chainId, contractAddress: t.context.contractAddress, electionId: t.context.electionId },
    threshold: t.threshold,
    trustees: t.trustees,
    ceremonyId: t.ceremonyId,
    participants: t.participants.map((p) => ({
      index: p.index,
      transportPublicKey: p.transportPublicKey,
      commitments: p.commitments.map(wirePoint),
      proofs: p.proofs.map((pr) => ({ e: pr.e, z: pr.z })),
    })),
    electionPublicKey: wirePoint(t.electionPublicKey),
    verificationKeys: t.verificationKeys.map(wirePoint),
    transcriptHash: t.transcriptHash,
  };
  return JSON.stringify(canonical);
}

/** Parses a serialised transcript and insists on the canonical form (reordered keys, whitespace or other spellings are refused). Does not verify it. */
export function deserializeTranscript(json: string): Transcript {
  if (typeof json !== "string") throw new InvalidInputError("BAD_TRANSCRIPT", "a transcript is a JSON string");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidInputError("BAD_TRANSCRIPT", "not valid JSON");
  }
  const wire = toWireTranscript(parseTranscriptStructure(value));
  if (serializeTranscript(wire) !== json) throw new InvalidInputError("BAD_TRANSCRIPT", "not in the canonical serialisation");
  return wire;
}

// ------------------------------------------------------------------------------------------------------------------------------ confirmations

export function parseConfirmation(raw: unknown, params: DkgParams): { index: number; transcriptHash: bigint; verificationKey: Point } {
  const o = exactKeys(raw, ["index", "transcriptHash", "verificationKey"], "confirmation");
  return { index: parseIndex(o.index, params, "confirmation index"), transcriptHash: parseHex32(o.transcriptHash, "transcriptHash"), verificationKey: parsePointWire(o.verificationKey, "verificationKey") };
}

/**
 * The ceremony is complete only when EVERY trustee has independently confirmed the same transcript hash and its own verification key. Returns the verified
 * transcript (H, vk_1..vk_n), which is the only thing worth registering anywhere; throws otherwise.
 */
export function confirmCeremony(transcript: unknown, confirmations: unknown, expected: Expectations = {}): ParsedTranscript {
  const verified = verifyTranscript(transcript, expected);
  if (!verified.ok) throw new VerificationError(verified.code, verified.reason);
  const t = verified.transcript;
  const list = asArray(confirmations, "confirmations");
  const seen = new Set<number>();
  for (const item of list) {
    const c = parseConfirmation(item, t.params);
    if (seen.has(c.index)) throw new VerificationError("DUPLICATE_INDEX", `trustee ${c.index} confirmed twice`);
    seen.add(c.index);
    if (c.transcriptHash !== t.transcriptHash) throw new VerificationError("HASH_MISMATCH", `trustee ${c.index} confirmed a different transcript`);
    if (!pointsEqual(c.verificationKey, t.verificationKeys[c.index - 1] as Point)) throw new VerificationError("VERIFICATION_KEY_MISMATCH", `trustee ${c.index} holds a different verification key`);
  }
  if (seen.size !== t.params.n) throw new VerificationError("MISSING_TRUSTEE", "not every trustee confirmed the transcript");
  return t;
}
