// One trustee. A Trustee object holds ONLY its own secrets (its polynomial coefficients during the ceremony, then its final share s_j) in # private fields:
// there is no accessor, no serialiser and no log statement that exposes them, and trustees exchange nothing but plain, JSON-serialisable public messages.
// No code anywhere sums the trustees' secrets: the shared secret s = sum_i a_i0 does not exist in any process, only the election public key H = s*G does.
//
// State machine: new -> announced -> committed -> dealt -> received -> finalized.  ANY validation failure moves the trustee to "aborted" (secrets dropped,
// every later call refused): there is no complaint or recovery round, the ceremony restarts with fresh randomness.
import { AggregateCiphertext } from "./aggregate.ts";
import { proveDecryptionShare, verifyDecryptionShare } from "./chaum-pedersen.ts";
import {
  DEFAULT_PARAMS,
  assertParams,
  computeCeremonyId,
  computeTranscriptHash,
  deriveKeys,
  evaluateCommitments,
  parseAnnouncements,
  parseCommitmentMessages,
  verifyTranscript,
  type Announcement,
  type CommitmentMessage,
  type Confirmation,
  type DkgParams,
  type EncryptedShare,
  type ParsedParticipantMessage,
} from "./ceremony.ts";
import { assertContext, contextToWire } from "./context.ts";
import { assertInteger, exactKeys, hex32, hexOfBytes, parseHexBytes } from "./encoding.ts";
import { CeremonyAbort, InvalidInputError, ToolkitError, VerificationError } from "./errors.ts";
import { DEFAULT_MIN_BALLOTS, type ElectionContext, type Point } from "./params.ts";
import { G, mul, parsePointWire, pointToWire, pointsEqual, type WirePoint } from "./point.ts";
import { proofToWire } from "./proof.ts";
import { add as sAdd, mul as sMul, randomScalar } from "./scalar.ts";
import { decryptShareRecord, encryptShareRecord, KDF_MODERATE, type KdfParams, type ShareFile } from "./storage.ts";
import type { PartialDecryption } from "./threshold.ts";
import { SEALED_SHARE_BYTES, generateTransportKeyPair, openShare, sealShare, wipe, type TransportKeyPair } from "./transport.ts";
import { proveKnowledge } from "./schnorr.ts";

export type TrusteeState = "new" | "announced" | "committed" | "dealt" | "received" | "finalized" | "aborted";

export interface TrusteeOptions {
  readonly index: number;
  readonly context: ElectionContext;
  readonly params?: DkgParams;
  /** A Trustee refuses to partially decrypt an aggregate of fewer ballots (default 2: a 1-ballot "aggregate" is an individual ballot). */
  readonly minBallots?: number;
}

function sameContext(a: ElectionContext, b: ElectionContext): boolean {
  const x = contextToWire(a);
  const y = contextToWire(b);
  return x.chainId === y.chainId && x.contractAddress === y.contractAddress && x.electionId === y.electionId;
}

export class Trustee {
  readonly index: number;
  readonly context: ElectionContext;
  readonly params: DkgParams;
  readonly minBallots: number;

  #state: TrusteeState = "new";
  #abortCode: string | null = null;
  #transport: TransportKeyPair | null = null;
  #keys: Map<number, Uint8Array> | null = null;
  #ceremonyId: bigint | null = null;
  #coefficients: bigint[] | null = null;
  #ownMessage: ParsedParticipantMessage | null = null;
  #messages: Map<number, ParsedParticipantMessage> | null = null;
  #ownShare: bigint | null = null;
  #share: bigint | null = null;
  #verificationKey: Point | null = null;
  #transcriptHash: bigint | null = null;

  constructor(options: TrusteeOptions) {
    this.params = assertParams(options.params ?? DEFAULT_PARAMS);
    this.index = assertInteger(options.index, 1, this.params.n, "trustee index");
    this.context = assertContext(options.context);
    this.minBallots = assertInteger(options.minBallots ?? DEFAULT_MIN_BALLOTS, 1, 1 << 20, "minimum ballots");
  }

  get state(): TrusteeState {
    return this.#state;
  }

  /** Public information only. */
  toJSON(): { index: number; state: TrusteeState; verificationKey: WirePoint | null } {
    return { index: this.index, state: this.#state, verificationKey: this.#verificationKey ? pointToWire(this.#verificationKey) : null };
  }

  // ------------------------------------------------------------------------------------------------------------------------ ceremony

  #abort(code: string): void {
    this.#state = "aborted";
    this.#abortCode = code;
    this.#coefficients = null;
    this.#ownShare = null;
    this.#share = null;
    if (this.#transport) wipe(this.#transport.secretKey);
    this.#transport = null;
  }

  /** Runs one ceremony step: refuses a dead ceremony and wrong ordering; ANY failure inside kills the ceremony (fail closed) and is re-thrown as CeremonyAbort. */
  #step<T>(expected: TrusteeState, fn: () => T): T {
    if (this.#state === "aborted") throw new CeremonyAbort("CEREMONY_ABORTED", `trustee ${this.index}: the ceremony was aborted (${this.#abortCode}); start a new one with fresh randomness`);
    if (this.#state !== expected) throw new CeremonyAbort("WRONG_STATE", `trustee ${this.index}: this step needs the state "${expected}" but the state is "${this.#state}"`);
    try {
      return fn();
    } catch (error) {
      const code = error instanceof ToolkitError ? error.code : "INTERNAL";
      const detail = error instanceof ToolkitError ? error.detail : "unexpected failure";
      this.#abort(code);
      throw new CeremonyAbort(code, `trustee ${this.index}: ${detail}`);
    }
  }

  /** Round 0: a fresh temporary transport key pair. Only the public half leaves this object. */
  announce(): Announcement {
    return this.#step("new", () => {
      this.#transport = generateTransportKeyPair();
      this.#state = "announced";
      return { index: this.index, transportPublicKey: hexOfBytes(this.#transport.publicKey) };
    });
  }

  /** Round 1: samples the polynomial f(x) = a_0 + a_1*x (degree t-1) from the OS CSPRNG, publishes K_k = a_k*G and a proof of knowledge of every a_k. */
  commit(announcements: unknown): CommitmentMessage {
    return this.#step("announced", () => {
      const keys = parseAnnouncements(announcements, this.params);
      const mine = keys.get(this.index) as Uint8Array;
      if (hexOfBytes(mine) !== hexOfBytes((this.#transport as TransportKeyPair).publicKey)) throw new InvalidInputError("ANNOUNCEMENT_MISMATCH", "my own announced transport key is not the one in the announcements");
      const ceremonyId = computeCeremonyId(this.context, this.params, keys);
      const coefficients = Array.from({ length: this.params.t }, () => randomScalar());
      const commitments = coefficients.map((a) => mul(G, a));
      const proofs = coefficients.map((a, k) => proveKnowledge({ context: this.context, ceremonyId, trusteeIndex: this.index, coefficientIndex: k }, a));
      this.#keys = keys;
      this.#ceremonyId = ceremonyId;
      this.#coefficients = coefficients;
      this.#ownMessage = { index: this.index, commitments, proofs };
      this.#state = "committed";
      return { index: this.index, commitments: commitments.map(pointToWire), proofs: proofs.map(proofToWire) };
    });
  }

  /**
   * Round 2: validates ALL published commitments and proofs (a single bad one aborts), then encrypts f_i(j) for every other trustee j.
   * The coefficients are dropped immediately afterwards: nothing more is needed (there is no complaint round).
   */
  deal(commitmentMessages: unknown): EncryptedShare[] {
    return this.#step("committed", () => {
      const ceremonyId = this.#ceremonyId as bigint;
      const messages = parseCommitmentMessages(commitmentMessages, this.context, ceremonyId, this.params);
      const own = this.#ownMessage as ParsedParticipantMessage;
      const published = messages.get(this.index) as ParsedParticipantMessage;
      const same = published.commitments.every((K, k) => pointsEqual(K, own.commitments[k] as Point)) && published.proofs.every((p, k) => p.e === (own.proofs[k] as { e: bigint }).e && p.z === (own.proofs[k] as { z: bigint }).z);
      if (!same) throw new VerificationError("OWN_COMMITMENT_ALTERED", "the published commitments of this trustee differ from what it sent");
      const coefficients = this.#coefficients as bigint[];
      const evaluate = (j: number): bigint => {
        const x = BigInt(j);
        let acc = coefficients[coefficients.length - 1] as bigint;
        for (let k = coefficients.length - 2; k >= 0; k--) acc = sAdd(sMul(acc, x), coefficients[k] as bigint);
        return acc;
      };
      const out: EncryptedShare[] = [];
      for (let j = 1; j <= this.params.n; j++) {
        const share = evaluate(j);
        if (j === this.index) {
          this.#ownShare = share;
          continue;
        }
        const sealed = sealShare({ ceremonyId, from: this.index, to: j, share, senderSecretKey: (this.#transport as TransportKeyPair).secretKey, recipientPublicKey: (this.#keys as Map<number, Uint8Array>).get(j) as Uint8Array });
        out.push({ from: this.index, to: j, ciphertext: hexOfBytes(sealed) });
      }
      this.#messages = messages;
      this.#coefficients = null;
      this.#state = "dealt";
      return out;
    });
  }

  /**
   * Round 3: decrypts the n-1 shares addressed to this trustee, checks EVERY one against its sender's public commitments (f_i(j)*G == K_i0 + j*K_i1), computes
   * s_j = sum_i f_i(j) mod l and checks s_j*G == vk_j, where vk_j comes from the public commitments alone. Any failure aborts.
   */
  receive(encryptedShares: unknown): { index: number; verificationKey: WirePoint } {
    return this.#step("dealt", () => {
      if (!Array.isArray(encryptedShares)) throw new InvalidInputError("BAD_STRUCTURE", "shares must be an array");
      const ceremonyId = this.#ceremonyId as bigint;
      const keys = this.#keys as Map<number, Uint8Array>;
      const messages = this.#messages as Map<number, ParsedParticipantMessage>;
      const transport = this.#transport as TransportKeyPair;
      const bySender = new Map<number, Uint8Array>();
      for (const item of encryptedShares) {
        const o = exactKeys(item, ["from", "to", "ciphertext"], "encrypted share");
        const from = assertInteger(o.from, 1, this.params.n, "share sender");
        const to = assertInteger(o.to, 1, this.params.n, "share recipient");
        if (to !== this.index) throw new InvalidInputError("WRONG_RECIPIENT", `a share addressed to trustee ${to} was delivered to trustee ${this.index}`);
        if (from === this.index) throw new InvalidInputError("INVALID_INDEX", "a trustee does not send a share to itself");
        if (bySender.has(from)) throw new InvalidInputError("DUPLICATE_INDEX", `two shares from trustee ${from}`);
        bySender.set(from, parseHexBytes(o.ciphertext, SEALED_SHARE_BYTES, "ciphertext"));
      }
      for (let i = 1; i <= this.params.n; i++) if (i !== this.index && !bySender.has(i)) throw new InvalidInputError("MISSING_SHARE", `no share from trustee ${i}`);

      let total = this.#ownShare as bigint;
      for (let i = 1; i <= this.params.n; i++) {
        if (i === this.index) continue;
        const share = openShare({ ceremonyId, from: i, to: this.index, sealed: bySender.get(i) as Uint8Array, senderPublicKey: keys.get(i) as Uint8Array, recipientSecretKey: transport.secretKey });
        const expected = evaluateCommitments((messages.get(i) as ParsedParticipantMessage).commitments, this.index);
        if (!pointsEqual(mul(G, share), expected)) throw new VerificationError("SHARE_INCONSISTENT", `the share from trustee ${i} does not match its published commitments`);
        total = sAdd(total, share);
      }
      // the ownShare must also match my own commitments (it was computed from them, but check: it costs one multiplication)
      if (!pointsEqual(mul(G, this.#ownShare as bigint), evaluateCommitments((messages.get(this.index) as ParsedParticipantMessage).commitments, this.index))) throw new VerificationError("SHARE_INCONSISTENT", "my own share does not match my own commitments");

      const participants = [...messages.values()].sort((a, b) => a.index - b.index);
      const publicKeys = deriveKeys(participants, this.params);
      const vk = mul(G, total);
      if (!pointsEqual(vk, publicKeys.verificationKeys[this.index - 1] as Point)) throw new VerificationError("FINAL_SHARE_MISMATCH", "s_j*G does not equal the verification key computed from the public commitments");
      this.#share = total;
      this.#verificationKey = vk;
      this.#ownShare = null;
      wipe(transport.secretKey); // the temporary transport key has done its job
      this.#transport = null;
      this.#state = "received";
      return { index: this.index, verificationKey: pointToWire(vk) };
    });
  }

  /**
   * Final step: independently checks the assembled public transcript (every proof, H, every vk, pair consistency, the hash) AND compares it with this
   * trustee's own view of the ceremony; only then is the share usable. Returns the confirmation that goes to everybody else.
   */
  finalize(transcript: unknown): Confirmation {
    return this.#step("received", () => {
      const verified = verifyTranscript(transcript, { context: this.context, params: this.params });
      if (!verified.ok) throw new VerificationError(verified.code, verified.reason);
      const t = verified.transcript;
      const messages = this.#messages as Map<number, ParsedParticipantMessage>;
      const keys = this.#keys as Map<number, Uint8Array>;
      if (t.ceremonyId !== this.#ceremonyId) throw new VerificationError("TRANSCRIPT_MISMATCH", "the transcript is of another ceremony");
      for (const p of t.participants) {
        const mine = messages.get(p.index) as ParsedParticipantMessage;
        const sameKey = hexOfBytes(p.transportKey) === hexOfBytes(keys.get(p.index) as Uint8Array);
        const sameCommitments = p.commitments.every((K, k) => pointsEqual(K, mine.commitments[k] as Point));
        const sameProofs = p.proofs.every((pr, k) => pr.e === (mine.proofs[k] as { e: bigint }).e && pr.z === (mine.proofs[k] as { z: bigint }).z);
        if (!sameKey || !sameCommitments || !sameProofs) throw new VerificationError("TRANSCRIPT_MISMATCH", `the transcript differs from what this trustee saw for trustee ${p.index}`);
      }
      const ownHash = computeTranscriptHash(this.context, this.params, this.#ceremonyId as bigint, t.participants, t.electionPublicKey, t.verificationKeys);
      if (ownHash !== t.transcriptHash) throw new VerificationError("HASH_MISMATCH", "this trustee computes another transcript hash");
      if (!pointsEqual(t.verificationKeys[this.index - 1] as Point, this.#verificationKey as Point)) throw new VerificationError("VERIFICATION_KEY_MISMATCH", "the transcript lists another verification key for this trustee");
      this.#transcriptHash = t.transcriptHash;
      this.#state = "finalized";
      return { index: this.index, transcriptHash: hex32(t.transcriptHash), verificationKey: pointToWire(this.#verificationKey as Point) };
    });
  }

  // ------------------------------------------------------------------------------------------------------------------------ decryption

  /**
   * This trustee's partial decryption of an AGGREGATE: for every candidate slot D = s_j * A with a Chaum-Pedersen proof that D uses the share behind vk_j.
   * The only ciphertext type accepted is AggregateCiphertext; there is no way to ask a trustee about a single ballot (and it refuses aggregates below minBallots).
   * Refusals here do NOT touch the share: a bad request never bricks a finished trustee.
   */
  partialDecrypt(aggregate: AggregateCiphertext): PartialDecryption {
    if (this.#state === "aborted") throw new CeremonyAbort("CEREMONY_ABORTED", `trustee ${this.index}: the ceremony was aborted (${this.#abortCode})`);
    if (this.#state !== "finalized") throw new CeremonyAbort("CEREMONY_INCOMPLETE", `trustee ${this.index}: the ceremony is not complete (state "${this.#state}"), no decryption`);
    if (!AggregateCiphertext.isAggregate(aggregate)) throw new InvalidInputError("NOT_AN_AGGREGATE", "decryption works on an AggregateCiphertext only");
    if (!sameContext(aggregate.context, this.context)) throw new InvalidInputError("CONTEXT_MISMATCH", "the aggregate belongs to another election");
    if (aggregate.ballotCount < this.minBallots) throw new InvalidInputError("AGGREGATE_TOO_SMALL", `an aggregate of ${aggregate.ballotCount} ballot(s) would expose individual votes; this trustee needs at least ${this.minBallots}`);
    const share = this.#share as bigint;
    const vk = this.#verificationKey as Point;
    const slots = aggregate.slots.map((slot, j) => {
      const binding = { context: this.context, constituencyId: aggregate.constituencyId, slot: j, trusteeIndex: this.index };
      const { D, proof } = proveDecryptionShare(binding, share, slot.A);
      if (!verifyDecryptionShare(binding, vk, slot.A, D, proof)) throw new VerificationError("SELF_CHECK_FAILED", "the freshly made proof does not verify");
      return { slot: j, D: pointToWire(D), proof: proofToWire(proof) };
    });
    return { trusteeIndex: this.index, constituencyId: hex32(aggregate.constituencyId), slots };
  }

  // ------------------------------------------------------------------------------------------------------------------------ storage

  /** The share encrypted for storage (Argon2id + XChaCha20-Poly1305). The plaintext share never leaves this object any other way. */
  exportEncryptedShare(password: string, kdf: KdfParams = KDF_MODERATE): ShareFile {
    if (this.#state !== "finalized") throw new CeremonyAbort("CEREMONY_INCOMPLETE", `trustee ${this.index}: only a finalized trustee has a share worth storing`);
    return encryptShareRecord({ index: this.index, share: this.#share as bigint, verificationKey: this.#verificationKey as Point, transcriptHash: this.#transcriptHash as bigint, context: this.context }, password, kdf);
  }

  /**
   * A finalized trustee from its stored share file and the public transcript. Refuses a wrong password, a modified file, a weak KDF, a transcript that is not
   * the one the share belongs to, and a share that does not match its verification key (s*G == vk).
   */
  static restore(input: { file: unknown; password: string; transcript: unknown; minKdf?: KdfParams; minBallots?: number }): Trustee {
    const record = decryptShareRecord(input.file, input.password, input.minKdf ? { minKdf: input.minKdf } : {});
    const verified = verifyTranscript(input.transcript, { context: record.context });
    if (!verified.ok) throw new VerificationError(verified.code, verified.reason);
    const t = verified.transcript;
    if (t.transcriptHash !== record.transcriptHash) throw new VerificationError("TRANSCRIPT_MISMATCH", "this share belongs to another ceremony");
    if (record.index > t.params.n || !pointsEqual(t.verificationKeys[record.index - 1] as Point, record.verificationKey)) throw new VerificationError("VERIFICATION_KEY_MISMATCH", "the stored verification key is not the ceremony's");
    if (!pointsEqual(mul(G, record.share), record.verificationKey)) throw new VerificationError("SHARE_KEY_MISMATCH", "the stored share does not match its verification key");
    const trustee = new Trustee({ index: record.index, context: record.context, params: t.params, ...(input.minBallots !== undefined ? { minBallots: input.minBallots } : {}) });
    trustee.#share = record.share;
    trustee.#verificationKey = record.verificationKey;
    trustee.#transcriptHash = t.transcriptHash;
    trustee.#state = "finalized";
    return trustee;
  }
}
