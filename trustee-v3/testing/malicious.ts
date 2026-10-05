// TEST SUPPORT ONLY. A scripted DISHONEST trustee that speaks the same wire protocol as the honest Trustee class, built independently from the low-level
// primitives, so tests can drive honest trustees against dealers that send inconsistent, malformed or equivocating messages.
import sodium from "libsodium-wrappers-sumo";
import { computeCeremonyId, parseAnnouncements, type Announcement, type CommitmentMessage, type DkgParams, type EncryptedShare } from "../src/ceremony.ts";
import { word, hexOfBytes } from "../src/encoding.ts";
import { DEFAULT_PARAMS } from "../src/ceremony.ts";
import { G, mul, pointToWire } from "../src/point.ts";
import type { ElectionContext } from "../src/params.ts";
import { proofToWire } from "../src/proof.ts";
import { proveKnowledge } from "../src/schnorr.ts";
import { add as sAdd, mul as sMul, randomScalar } from "../src/scalar.ts";
import { generateTransportKeyPair, sealShare, type TransportKeyPair } from "../src/transport.ts";
import { Trustee } from "../src/trustee.ts";
import { clone } from "./ceremony.ts";

await sodium.ready;

export class ScriptedTrustee {
  readonly index: number;
  readonly context: ElectionContext;
  readonly params: DkgParams;
  readonly transport: TransportKeyPair = generateTransportKeyPair();
  coefficients: bigint[];
  ceremonyId = 0n;
  keys = new Map<number, Uint8Array>();

  constructor(options: { index: number; context: ElectionContext; params?: DkgParams; coefficients?: bigint[] }) {
    this.index = options.index;
    this.context = options.context;
    this.params = options.params ?? DEFAULT_PARAMS;
    this.coefficients = options.coefficients ?? Array.from({ length: this.params.t }, () => randomScalar());
  }

  announce(): Announcement {
    return { index: this.index, transportPublicKey: hexOfBytes(this.transport.publicKey) };
  }

  /** the honest wire message for the given coefficients (proofs of knowledge bound to the ceremony of these announcements) */
  commitMessage(announcements: Announcement[], coefficients: bigint[] = this.coefficients): CommitmentMessage {
    this.keys = parseAnnouncements(announcements, this.params);
    this.ceremonyId = computeCeremonyId(this.context, this.params, this.keys);
    return {
      index: this.index,
      commitments: coefficients.map((a) => pointToWire(mul(G, a))),
      proofs: coefficients.map((a, k) => proofToWire(proveKnowledge({ context: this.context, ceremonyId: this.ceremonyId, trusteeIndex: this.index, coefficientIndex: k }, a))),
    };
  }

  /** another honest-looking commitment message (same ceremony) for a different polynomial: what an equivocating dealer shows a second recipient */
  reCommit(coefficients: bigint[]): CommitmentMessage {
    return {
      index: this.index,
      commitments: coefficients.map((a) => pointToWire(mul(G, a))),
      proofs: coefficients.map((a, k) => proofToWire(proveKnowledge({ context: this.context, ceremonyId: this.ceremonyId, trusteeIndex: this.index, coefficientIndex: k }, a))),
    };
  }

  /** f(j) mod l for the given coefficients (honest evaluation) */
  valueFor(j: number, coefficients: bigint[] = this.coefficients): bigint {
    return coefficients.reduceRight((acc, c) => sAdd(sMul(acc, BigInt(j)), c), 0n);
  }

  /** an honestly encrypted share carrying ANY canonical value */
  seal(to: number, value: bigint): EncryptedShare {
    const sealed = sealShare({ ceremonyId: this.ceremonyId, from: this.index, to, share: value, senderSecretKey: this.transport.secretKey, recipientPublicKey: this.keys.get(to) as Uint8Array });
    return { from: this.index, to, ciphertext: hexOfBytes(sealed) };
  }

  /** an encrypted share carrying ANY 256-bit value, even one that is not reduced mod l (bypasses the canonical check of sealShare, like a buggy or hostile dealer would) */
  sealRaw(to: number, rawValue: bigint): EncryptedShare {
    const plaintext = new Uint8Array(74);
    plaintext.set(new TextEncoder().encode("V3-SHARE"), 0);
    plaintext.set(word(this.ceremonyId), 8);
    plaintext[40] = this.index;
    plaintext[41] = to;
    plaintext.set(word(rawValue), 42);
    const nonce = sodium.randombytes_buf(24);
    const box = sodium.crypto_box_easy(plaintext, nonce, this.keys.get(to) as Uint8Array, this.transport.secretKey);
    return { from: this.index, to, ciphertext: hexOfBytes(new Uint8Array([...nonce, ...box])) };
  }
}

export interface Adversary {
  scripted: ScriptedTrustee;
  /** the commitment message this recipient is shown (default: the honest one) */
  commitFor?: (recipient: number, honest: CommitmentMessage) => CommitmentMessage;
  /** the share this recipient is sent (default: f(recipient) honestly) */
  shareFor?: (recipient: number, adversary: ScriptedTrustee) => EncryptedShare;
}

export interface Outcome {
  /** the honest trustees by index */
  trustees: Map<number, Trustee>;
  /** the first error each honest trustee hit, with the step it hit it in */
  errors: Map<number, { step: string; error: unknown }>;
  announcements: Announcement[];
  /** all n commitment messages exactly as this recipient saw them (so a test can build the transcript of any one trustee's view) */
  commitmentsSeenBy: (recipient: number) => CommitmentMessage[];
}

/** Runs the honest trustees 1..n except the adversary's index against the scripted dealer. Each honest trustee's failure is recorded, not thrown. */
export function runAgainst(adversary: Adversary, options: { context: ElectionContext; params?: DkgParams }): Outcome {
  const params = options.params ?? DEFAULT_PARAMS;
  const trustees = new Map<number, Trustee>();
  const errors = new Map<number, { step: string; error: unknown }>();
  for (let i = 1; i <= params.n; i++) if (i !== adversary.scripted.index) trustees.set(i, new Trustee({ index: i, context: options.context, params }));
  const attempt = <T>(trustee: Trustee, step: string, fn: () => T): T | undefined => {
    if (errors.has(trustee.index)) return undefined;
    try {
      return fn();
    } catch (error) {
      errors.set(trustee.index, { step, error });
      return undefined;
    }
  };

  const announcements: Announcement[] = [];
  for (let i = 1; i <= params.n; i++) announcements.push(i === adversary.scripted.index ? adversary.scripted.announce() : clone(trustees.get(i)!.announce()));
  const honestCommits = new Map<number, CommitmentMessage>();
  for (const t of trustees.values()) attempt(t, "commit", () => honestCommits.set(t.index, clone(t.commit(clone(announcements)))));
  const defaultAdversaryMessage = adversary.scripted.commitMessage(announcements);
  const messageFor = (recipient: number): CommitmentMessage => (adversary.commitFor ? adversary.commitFor(recipient, defaultAdversaryMessage) : defaultAdversaryMessage);

  const sharesTo = new Map<number, EncryptedShare[]>();
  for (const t of trustees.values()) sharesTo.set(t.index, []);
  for (const t of trustees.values()) {
    const all = [...honestCommits.values(), messageFor(t.index)].sort((a, b) => a.index - b.index);
    const dealt = attempt(t, "deal", () => t.deal(clone(all)));
    for (const share of dealt ?? []) sharesTo.get(share.to)?.push(clone(share)); // shares to the adversary are not needed
  }
  for (const t of trustees.values()) {
    const adversaryShare = adversary.shareFor ? adversary.shareFor(t.index, adversary.scripted) : adversary.scripted.seal(t.index, adversary.scripted.valueFor(t.index));
    sharesTo.get(t.index)?.push(clone(adversaryShare));
  }
  for (const t of trustees.values()) attempt(t, "receive", () => t.receive(clone(sharesTo.get(t.index))));

  const commitmentsSeenBy = (recipient: number): CommitmentMessage[] => clone([...honestCommits.values(), messageFor(recipient)].sort((a, b) => a.index - b.index));
  return { trustees, errors, announcements, commitmentsSeenBy };
}
