// The ceremony FAILS CLOSED. Every way a message can be malformed, forged, replayed, misdelivered or inconsistent must abort the ceremony (no complaint or
// recovery round: it restarts with fresh randomness), and an aborted trustee must stay dead.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AggregateCiphertext } from "../src/aggregate.ts";
import { buildTranscript, type Announcement, type CommitmentMessage, type EncryptedShare, type Transcript } from "../src/ceremony.ts";
import { hex32 } from "../src/encoding.ts";
import { CeremonyAbort, ToolkitError } from "../src/errors.ts";
import { FIELD_PRIME as P, G, SUBGROUP_ORDER as L, TEST_CONTEXT } from "../src/params.ts";
import { add, mul, parsePointWire, pointToWire, sub } from "../src/point.ts";
import { randomScalar } from "../src/scalar.ts";
import { Trustee } from "../src/trustee.ts";
import { attemptCeremony, clone, runCeremony, type Attempt, type Tamper } from "../testing/ceremony.ts";
import { ScriptedTrustee, runAgainst } from "../testing/malicious.ts";
import { mixedPoint, nonIdentityTorsion } from "../testing/torsion.ts";

const flipHex = (h: string): string => hex32(BigInt(h) ^ 1n);
const withMessage = <T extends { index: number }>(messages: T[], index: number, change: (m: T) => T): T[] => messages.map((m) => (m.index === index ? change(clone(m)) : m));

/** the ceremony died with `code`, at `step`, and nobody finalized */
function expectAbort(attempt: Attempt, code: string, step?: string): void {
  assert.ok(!attempt.ok, "the ceremony must fail closed");
  const error = attempt.error as ToolkitError;
  assert.ok(error instanceof ToolkitError, `a toolkit error, got ${String(error)}`);
  assert.equal(error.code, code, error.message);
  if (step) assert.equal(attempt.step, step);
  assert.ok(attempt.trustees.every((t) => t.state !== "finalized"), "no trustee may end up with a usable share");
  assert.ok(attempt.trustees.some((t) => t.state === "aborted"), "the trustee that refused is dead");
}

const aggregate = AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: 5n, ballotCount: 4, slots: [{ A: mul(G, 11n), B: mul(G, 22n) }] });

describe("abort: malformed DKG commitments", () => {
  const K0 = (m: CommitmentMessage): [string, string] => m.commitments[0] as [string, string];
  const cases: [string, (m: CommitmentMessage) => CommitmentMessage, string][] = [
    ["off-curve commitment", (m) => ({ ...m, commitments: [[flipHex(K0(m)[0]), K0(m)[1]], m.commitments[1]!] }), "INVALID_COMMITMENT"],
    ["commitment with a torsion component", (m) => ({ ...m, commitments: [pointToWire(mixedPoint(parsePointWire(K0(m), "K"), 2)), m.commitments[1]!] }), "INVALID_COMMITMENT"],
    ["pure torsion commitment (order 8)", (m) => ({ ...m, commitments: [pointToWire(nonIdentityTorsion()[4]!), m.commitments[1]!] }), "INVALID_COMMITMENT"],
    ["the identity as a commitment", (m) => ({ ...m, commitments: [[hex32(0n), hex32(1n)], m.commitments[1]!] }), "INVALID_COMMITMENT"],
    ["non-canonical coordinate (x + p)", (m) => ({ ...m, commitments: [[hex32(BigInt(K0(m)[0]) + P), K0(m)[1]], m.commitments[1]!] }), "INVALID_COMMITMENT"],
    ["uppercase hex", (m) => ({ ...m, commitments: [[K0(m)[0].replace("0x", "0X").toUpperCase(), K0(m)[1]], m.commitments[1]!] }), "INVALID_COMMITMENT"],
    ["a commitment that is not a pair", (m) => ({ ...m, commitments: [["0x00"] as unknown as [string, string], m.commitments[1]!] }), "INVALID_COMMITMENT"],
    ["too many commitments (a polynomial of degree 2 in a threshold-2 ceremony)", (m) => ({ ...m, commitments: [...m.commitments, m.commitments[0]!], proofs: [...m.proofs, m.proofs[0]!] }), "WRONG_DEGREE"],
    ["too few commitments (degree 0: every share would equal the secret)", (m) => ({ ...m, commitments: [m.commitments[0]!], proofs: [m.proofs[0]!] }), "WRONG_DEGREE"],
    ["proofs count differs from commitments count", (m) => ({ ...m, proofs: [m.proofs[0]!] }), "WRONG_DEGREE"],
    ["an extra field in the message", (m) => ({ ...m, extra: 1 }) as unknown as CommitmentMessage, "BAD_STRUCTURE"],
    ["a missing field", (m) => ({ index: m.index, commitments: m.commitments }) as unknown as CommitmentMessage, "BAD_STRUCTURE"],
    ["commitments that are not an array", (m) => ({ ...m, commitments: "nope" }) as unknown as CommitmentMessage, "BAD_STRUCTURE"],
  ];
  for (const [name, change, code] of cases) {
    it(`${name} -> ${code}`, () => {
      const attempt = attemptCeremony({ tamper: { commitments: (messages) => withMessage(messages, 3, change) } });
      expectAbort(attempt, code, "deal");
    });
  }
});

describe("abort: invalid Schnorr proofs of knowledge", () => {
  const scenarios: [string, (m: CommitmentMessage, all: CommitmentMessage[]) => CommitmentMessage, string][] = [
    ["a FAKE proof (random e, z)", (m) => ({ ...m, proofs: m.proofs.map(() => ({ e: hex32(randomScalar()), z: hex32(randomScalar()) })) }), "INVALID_POK"],
    ["proofs swapped between the two coefficients", (m) => ({ ...m, proofs: [m.proofs[1]!, m.proofs[0]!] }), "INVALID_POK"],
    ["only one of the two proofs is fake", (m) => ({ ...m, proofs: [m.proofs[0]!, { e: hex32(randomScalar()), z: hex32(randomScalar()) }] }), "INVALID_POK"],
    ["a proof taken from ANOTHER trustee's message (replay under another index)", (m, all) => ({ ...m, proofs: clone(all.find((x) => x.index === 2)!.proofs) }), "INVALID_POK"],
    ["a non-canonical proof (e + l)", (m) => ({ ...m, proofs: [{ e: hex32(BigInt(m.proofs[0]!.e) + L), z: m.proofs[0]!.z }, m.proofs[1]!] }), "INVALID_PROOF_ENCODING"],
    ["a zero proof", (m) => ({ ...m, proofs: [{ e: hex32(0n), z: hex32(0n) }, m.proofs[1]!] }), "INVALID_PROOF_ENCODING"],
    ["a proof that is not an object", (m) => ({ ...m, proofs: ["x", "y"] }) as unknown as CommitmentMessage, "INVALID_PROOF_ENCODING"],
  ];
  for (const [name, change, code] of scenarios) {
    it(`${name} -> ${code}`, () => {
      const attempt = attemptCeremony({ tamper: { commitments: (messages) => withMessage(messages, 3, (m) => change(m, messages)) } });
      expectAbort(attempt, code, "deal");
    });
  }

  it("a proof REPLAYED from another ceremony of the same election and the same trustee index is refused (the proof is bound to this ceremony's keys)", () => {
    const earlier = runCeremony();
    const attempt = attemptCeremony({ tamper: { commitments: (messages) => withMessage(messages, 2, () => clone(earlier.commitmentMessages[1]!)) } });
    expectAbort(attempt, "INVALID_POK", "deal");
  });

  it("the message of trustee 2 relabelled as trustee 3's (index altered) is refused: the proof is bound to the trustee index", () => {
    const attempt = attemptCeremony({ tamper: { commitments: (messages) => messages.filter((m) => m.index !== 3).map((m) => (m.index === 2 ? m : m)).concat([{ ...clone(messages.find((m) => m.index === 2)!), index: 3 }]) } });
    expectAbort(attempt, "INVALID_POK", "deal");
  });

  it("a ROGUE-KEY attack fails: a trustee that publishes K' - K_1 - K_2 to force H = K' cannot prove knowledge of that point's logarithm", () => {
    const target = mul(G, 424242n);
    const attempt = attemptCeremony({
      tamper: {
        commitments: (messages) =>
          withMessage(messages, 3, (m) => {
            const K1 = parsePointWire(messages.find((x) => x.index === 1)!.commitments[0], "K10");
            const K2 = parsePointWire(messages.find((x) => x.index === 2)!.commitments[0], "K20");
            return { ...m, commitments: [pointToWire(sub(sub(target, K1), K2)), m.commitments[1]!], proofs: [{ e: hex32(randomScalar()), z: hex32(randomScalar()) }, m.proofs[1]!] };
          }),
      },
    });
    expectAbort(attempt, "INVALID_POK", "deal");
  });
});

describe("abort: encrypted share transport", () => {
  it("CORRUPT encrypted share (a flipped byte anywhere) -> SHARE_DECRYPTION_FAILED", () => {
    for (const position of [2, 30, 60, 100, 200, 227]) {
      const attempt = attemptCeremony({
        tamper: { shares: (messages) => messages.map((m, i) => (i === 0 ? { ...m, ciphertext: m.ciphertext.slice(0, position) + (m.ciphertext[position] === "0" ? "1" : "0") + m.ciphertext.slice(position + 1) } : m)) },
      });
      expectAbort(attempt, "SHARE_DECRYPTION_FAILED", "receive");
    }
  });

  it("a share SENT TO THE WRONG TRUSTEE: delivered as is -> WRONG_RECIPIENT; relabelled as addressed to its holder -> SHARE_DECRYPTION_FAILED", () => {
    const asIs: Tamper = { shares: (messages, recipient) => (recipient === 3 ? [...messages.filter((m) => m.from !== 1), { from: 1, to: 2, ciphertext: runCeremonyShare12 }] : messages) };
    const first = runCeremony();
    const runCeremonyShare12 = first.shareMessages.find((m) => m.from === 1 && m.to === 2)!.ciphertext; // from ANOTHER ceremony, but the point is the addressing
    expectAbort(attemptCeremony({ tamper: asIs }), "WRONG_RECIPIENT", "receive");
    const relabelled: Tamper = { shares: (messages, recipient) => (recipient === 3 ? messages.map((m) => (m.from === 1 ? { from: 1, to: 3, ciphertext: runCeremonyShare12 } : m)) : messages) };
    expectAbort(attemptCeremony({ tamper: relabelled }), "SHARE_DECRYPTION_FAILED", "receive");
  });

  it("a share claimed to be from another sender (the `from` field altered) -> SHARE_DECRYPTION_FAILED: nobody can inject a share in another trustee's name", () => {
    const attempt = attemptCeremony({ tamper: { shares: (messages, recipient) => (recipient === 1 ? messages.map((m) => (m.from === 2 ? { ...m, from: 3 } : m.from === 3 ? { ...m, from: 2 } : m)) : messages) } });
    expectAbort(attempt, "SHARE_DECRYPTION_FAILED", "receive");
  });

  it("MISSING share -> MISSING_SHARE; DUPLICATE sender -> DUPLICATE_INDEX; a share addressed to nobody valid -> BAD_INTEGER; wrong shapes -> BAD_STRUCTURE", () => {
    expectAbort(attemptCeremony({ tamper: { shares: (messages) => messages.slice(1) } }), "MISSING_SHARE", "receive");
    expectAbort(attemptCeremony({ tamper: { shares: (messages) => [...messages, messages[0]!] } }), "DUPLICATE_INDEX", "receive");
    expectAbort(attemptCeremony({ tamper: { shares: (messages) => messages.map((m, i) => (i === 0 ? { ...m, from: 9 } : m)) } }), "BAD_INTEGER", "receive");
    expectAbort(attemptCeremony({ tamper: { shares: (messages) => messages.map((m, i) => (i === 0 ? ({ ...m, extra: 1 } as unknown as EncryptedShare) : m)) } }), "BAD_STRUCTURE", "receive");
    expectAbort(attemptCeremony({ tamper: { shares: () => "shares" } }), "BAD_STRUCTURE", "receive");
    expectAbort(attemptCeremony({ tamper: { shares: (messages) => messages.map((m, i) => (i === 0 ? { ...m, ciphertext: m.ciphertext.slice(0, -2) } : m)) } }), "BAD_ENCODING", "receive");
  });
});

describe("abort: a dishonest dealer (scripted adversary vs honest trustees)", () => {
  const ctx = TEST_CONTEXT;
  const adversary = (coefficients?: bigint[]): ScriptedTrustee => new ScriptedTrustee({ index: 1, context: ctx, ...(coefficients ? { coefficients } : {}) });
  const code = (outcome: ReturnType<typeof runAgainst>, index: number): string => (outcome.errors.get(index)?.error as ToolkitError).code;

  it("sanity: an HONEST scripted dealer is accepted by both honest trustees (so the failures below are caused by the deviation, not the harness)", () => {
    const outcome = runAgainst({ scripted: adversary() }, { context: ctx });
    assert.equal(outcome.errors.size, 0);
    assert.ok([...outcome.trustees.values()].every((t) => t.state === "received"));
  });

  it("a share INCONSISTENT with the dealer's commitments (f(2) + 1) -> SHARE_INCONSISTENT; the victim is dead; the other trustee is not enough to finish", () => {
    const outcome = runAgainst({ scripted: adversary(), shareFor: (j, a) => a.seal(j, j === 2 ? (a.valueFor(2) + 1n) % L : a.valueFor(j)) }, { context: ctx });
    assert.equal(code(outcome, 2), "SHARE_INCONSISTENT");
    assert.equal(outcome.trustees.get(2)!.state, "aborted");
    assert.equal(outcome.errors.has(3), false, "trustee 3 received an honest share");
    assert.throws(() => outcome.trustees.get(2)!.finalize({}), /CEREMONY_ABORTED/);
  });

  it("a share belonging to ANOTHER recipient (f(3) sent to trustee 2) -> SHARE_INCONSISTENT", () => {
    const outcome = runAgainst({ scripted: adversary(), shareFor: (j, a) => a.seal(j, j === 2 ? a.valueFor(3) : a.valueFor(j)) }, { context: ctx });
    assert.equal(code(outcome, 2), "SHARE_INCONSISTENT");
  });

  it("commitments of one polynomial but shares of another -> SHARE_INCONSISTENT at every recipient", () => {
    const other = [randomScalar(), randomScalar()];
    const outcome = runAgainst({ scripted: adversary(), shareFor: (j, a) => a.seal(j, a.valueFor(j, other)) }, { context: ctx });
    assert.equal(code(outcome, 2), "SHARE_INCONSISTENT");
    assert.equal(code(outcome, 3), "SHARE_INCONSISTENT");
  });

  it("WRONG ORDER ARITHMETIC: shares computed without reducing mod l (or mod the field prime p) are >= l and are refused as non-canonical", () => {
    const big = [L - 5n, L - 7n]; // f(2) = 3l - 19 unreduced
    const unreduced = (j: number): bigint => big[0]! + big[1]! * BigInt(j);
    assert.ok(unreduced(2) >= L && unreduced(2) < P, "chosen so that the integer value exceeds l but stays below p: reducing mod p changes nothing");
    const outcome = runAgainst({ scripted: adversary(big), shareFor: (j, a) => a.sealRaw(j, j === 2 ? unreduced(2) % P : a.valueFor(j)) }, { context: ctx });
    assert.equal(code(outcome, 2), "NON_CANONICAL_SHARE");
    const mod256 = runAgainst({ scripted: adversary(big), shareFor: (j, a) => a.sealRaw(j, j === 3 ? unreduced(3) : a.valueFor(j)) }, { context: ctx });
    assert.equal(code(mod256, 3), "NON_CANONICAL_SHARE");
  });

  it("EQUIVOCATION: a dealer that shows two recipients two different (individually valid) polynomials is caught when the transcripts are compared", () => {
    const scripted = adversary();
    const second = [randomScalar(), randomScalar()];
    const outcome = runAgainst(
      { scripted, commitFor: (recipient, honest) => (recipient === 3 ? scripted.reCommit(second) : honest), shareFor: (j, a) => a.seal(j, a.valueFor(j, j === 3 ? second : a.coefficients)) },
      { context: ctx },
    );
    assert.equal(outcome.errors.size, 0, "each recipient saw a self-consistent dealer: both finish `receive`");
    const transcript = buildTranscript({ context: ctx, announcements: outcome.announcements, commitmentMessages: outcome.commitmentsSeenBy(2) });
    assert.doesNotThrow(() => outcome.trustees.get(2)!.finalize(clone(transcript)), "the view the transcript was built from finalizes");
    assert.throws(() => outcome.trustees.get(3)!.finalize(clone(transcript)), /TRANSCRIPT_MISMATCH/, "the other recipient saw something else and refuses");
    assert.equal(outcome.trustees.get(3)!.state, "aborted");
  });
});

describe("abort: missing, duplicate and invalid trustees", () => {
  it("a MISSING trustee at every round -> MISSING_TRUSTEE (announcements, commitments), MISSING_SHARE (shares), BAD_TRANSCRIPT (transcript)", () => {
    expectAbort(attemptCeremony({ tamper: { announcements: (m) => m.slice(0, 2) } }), "MISSING_TRUSTEE", "commit");
    expectAbort(attemptCeremony({ tamper: { announcements: () => [] } }), "MISSING_TRUSTEE", "commit");
    expectAbort(attemptCeremony({ tamper: { commitments: (m) => m.slice(0, 2) } }), "MISSING_TRUSTEE", "deal");
    const dropped = (t: Transcript): Transcript => ({ ...t, participants: t.participants.slice(0, 2) });
    expectAbort(attemptCeremony({ tamper: { transcript: dropped } }), "BAD_TRANSCRIPT", "finalize");
  });

  it("a DUPLICATE trustee index -> DUPLICATE_INDEX in announcements and commitments; two trustees with ONE transport key -> DUPLICATE_TRANSPORT_KEY", () => {
    expectAbort(attemptCeremony({ tamper: { announcements: (m) => [m[0]!, m[1]!, { ...m[2]!, index: 2 }] } }), "DUPLICATE_INDEX", "commit");
    expectAbort(attemptCeremony({ tamper: { commitments: (m) => [m[0]!, m[1]!, m[1]!] } }), "DUPLICATE_INDEX", "deal");
    expectAbort(attemptCeremony({ tamper: { announcements: (m) => [m[0]!, m[1]!, { ...m[2]!, transportPublicKey: m[1]!.transportPublicKey }] } }), "DUPLICATE_TRANSPORT_KEY", "commit");
  });

  it("an INVALID trustee index (0, 4, -1, 1.5, a string, null) -> INVALID_INDEX", () => {
    for (const bad of [0, 4, -1, 1.5, "2", null, NaN]) {
      expectAbort(attemptCeremony({ tamper: { announcements: (m) => m.map((x, i) => (i === 2 ? ({ ...x, index: bad } as unknown as Announcement) : x)) } }), "INVALID_INDEX", "commit");
      expectAbort(attemptCeremony({ tamper: { commitments: (m) => m.map((x, i) => (i === 2 ? ({ ...x, index: bad } as unknown as CommitmentMessage) : x)) } }), "INVALID_INDEX", "deal");
    }
  });

  it("an unusable transport key (all zero, a low-order point, malformed hex) -> BAD_TRANSPORT_KEY / BAD_ENCODING", () => {
    const withKey = (key: string) => ({ announcements: (m: Announcement[]) => m.map((x, i) => (i === 2 ? { ...x, transportPublicKey: key } : x)) });
    expectAbort(attemptCeremony({ tamper: withKey("0x" + "00".repeat(32)) }), "BAD_TRANSPORT_KEY", "commit");
    expectAbort(attemptCeremony({ tamper: withKey("0x01" + "00".repeat(31)) }), "BAD_TRANSPORT_KEY", "commit");
    expectAbort(attemptCeremony({ tamper: withKey("0x1234") }), "BAD_ENCODING", "commit");
  });

  it("a trustee whose OWN announced key is not the one in the announcements refuses (someone swapped it) -> ANNOUNCEMENT_MISMATCH", () => {
    const other = new Trustee({ index: 1, context: TEST_CONTEXT }).announce();
    expectAbort(attemptCeremony({ tamper: { announcements: (m, recipient) => (recipient === 1 ? m.map((x) => (x.index === 1 ? other : x)) : m) } }), "ANNOUNCEMENT_MISMATCH", "commit");
  });

  it("a trustee whose own published commitments were REPLACED by another perfectly valid message of the same ceremony refuses -> OWN_COMMITMENT_ALTERED", () => {
    const trustees = [1, 2, 3].map((i) => new Trustee({ index: i, context: TEST_CONTEXT }));
    const announcements = trustees.map((t) => clone(t.announce()));
    const messages = trustees.map((t) => clone(t.commit(clone(announcements))));
    const impostor = new ScriptedTrustee({ index: 1, context: TEST_CONTEXT });
    impostor.commitMessage(announcements); // same announcements, so the same ceremony id: its proofs are valid for this ceremony
    const replaced = impostor.reCommit([randomScalar(), randomScalar()]);
    assert.throws(() => trustees[0]!.deal(clone([replaced, messages[1]!, messages[2]!])), /OWN_COMMITMENT_ALTERED/);
    assert.equal(trustees[0]!.state, "aborted");
  });
});

describe("abort: transcripts", () => {
  const swap = (hex: string): string => flipHex(hex);

  it("a TAMPERED transcript is refused by every trustee, whatever field is changed (and never as an INTERNAL error)", () => {
    const mutations: [string, (t: Transcript) => Transcript][] = [
      ["election public key", (t) => ({ ...t, electionPublicKey: [swap(t.electionPublicKey[0]), t.electionPublicKey[1]] })],
      ["election public key replaced by another valid point", (t) => ({ ...t, electionPublicKey: pointToWire(mul(G, 5n)) })],
      ["a verification key", (t) => ({ ...t, verificationKeys: [t.verificationKeys[0]!, pointToWire(mul(G, 6n)), t.verificationKeys[2]!] })],
      ["a commitment", (t) => ({ ...t, participants: withMessage(t.participants, 2, (p) => ({ ...p, commitments: [pointToWire(add(parsePointWire(p.commitments[0], "K"), G)), p.commitments[1]!] })) })],
      ["a proof", (t) => ({ ...t, participants: withMessage(t.participants, 1, (p) => ({ ...p, proofs: [{ e: swap(p.proofs[0]!.e), z: p.proofs[0]!.z }, p.proofs[1]!] })) })],
      ["a transport key", (t) => ({ ...t, participants: withMessage(t.participants, 3, (p) => ({ ...p, transportPublicKey: swap(p.transportPublicKey) })) })],
      ["the ceremony id", (t) => ({ ...t, ceremonyId: swap(t.ceremonyId) })],
      ["the context (chain id)", (t) => ({ ...t, context: { ...t.context, chainId: "1" } })],
      ["the context (election id)", (t) => ({ ...t, context: { ...t.context, electionId: swap(t.context.electionId) } })],
      ["the threshold", (t) => ({ ...t, threshold: 3 })],
      ["the trustee count", (t) => ({ ...t, trustees: 4 })],
      ["the participant order", (t) => ({ ...t, participants: [t.participants[1]!, t.participants[0]!, t.participants[2]!] })],
      ["an extra field", (t) => ({ ...t, note: "hi" }) as unknown as Transcript],
      ["the version", (t) => ({ ...t, version: "v2" }) as unknown as Transcript],
    ];
    for (const [name, mutate] of mutations) {
      const attempt = attemptCeremony({ tamper: { transcript: (t) => mutate(t) } });
      assert.ok(!attempt.ok, name);
      const error = attempt.ok ? undefined : (attempt.error as ToolkitError);
      assert.ok(error instanceof ToolkitError && error.code !== "INTERNAL", `${name}: ${String(error)}`);
      assert.ok(attempt.trustees.every((t) => t.state !== "finalized"), name);
    }
  });

  it("a MISMATCHED transcript hash (altered by one bit) -> HASH_MISMATCH", () => {
    expectAbort(attemptCeremony({ tamper: { transcript: (t) => ({ ...t, transcriptHash: swap(t.transcriptHash) }) } }), "HASH_MISMATCH", "finalize");
  });

  it("the valid transcript of ANOTHER ceremony (self-consistent, same election) -> TRANSCRIPT_MISMATCH: this trustee never took part in that one", () => {
    const other = runCeremony();
    expectAbort(attemptCeremony({ tamper: { transcript: () => clone(other.transcript) } }), "TRANSCRIPT_MISMATCH", "finalize");
  });

  it("a trustee announcement from ANOTHER ceremony spliced in (a trustee key from another ceremony) -> the ceremony ids disagree and the proofs fail", () => {
    const foreign = runCeremony().announcements[2]!;
    expectAbort(attemptCeremony({ tamper: { announcements: (m, recipient) => (recipient === 1 ? m.map((x) => (x.index === 3 ? foreign : x)) : m) } }), "INVALID_POK", "deal");
  });

  it("a transcript from another ELECTION context is refused by a trustee of this one", () => {
    const other = runCeremony({ context: { chainId: 1n, contractAddress: 0x1111n, electionId: 0x2222n } });
    expectAbort(attemptCeremony({ tamper: { transcript: () => clone(other.transcript) } }), "CONTEXT_MISMATCH", "finalize");
  });
});

describe("abort: no decryption before the ceremony is complete, and an aborted trustee stays dead", () => {
  it("partialDecrypt and exportEncryptedShare are refused in every state before 'finalized'", () => {
    const t = new Trustee({ index: 1, context: TEST_CONTEXT });
    assert.throws(() => t.partialDecrypt(aggregate), /CEREMONY_INCOMPLETE/);
    t.announce();
    assert.throws(() => t.partialDecrypt(aggregate), /CEREMONY_INCOMPLETE/);
    assert.throws(() => t.exportEncryptedShare("a long enough password"), /CEREMONY_INCOMPLETE/);
    // walk a whole ceremony and probe after each step
    const trustees = [new Trustee({ index: 1, context: TEST_CONTEXT }), new Trustee({ index: 2, context: TEST_CONTEXT }), new Trustee({ index: 3, context: TEST_CONTEXT })];
    const announcements = trustees.map((x) => clone(x.announce()));
    const commits = trustees.map((x) => clone(x.commit(clone(announcements))));
    for (const x of trustees) assert.throws(() => x.partialDecrypt(aggregate), /CEREMONY_INCOMPLETE/);
    const shares = trustees.flatMap((x) => x.deal(clone(commits)).map(clone));
    for (const x of trustees) assert.throws(() => x.partialDecrypt(aggregate), /CEREMONY_INCOMPLETE/);
    for (const x of trustees) x.receive(clone(shares.filter((m) => m.to === x.index)));
    for (const x of trustees) assert.throws(() => x.partialDecrypt(aggregate), /CEREMONY_INCOMPLETE/, "received but not yet confirmed against the transcript");
    const transcript = buildTranscript({ context: TEST_CONTEXT, announcements, commitmentMessages: commits });
    for (const x of trustees) x.finalize(clone(transcript));
    for (const x of trustees) assert.doesNotThrow(() => x.partialDecrypt(aggregate));
  });

  it("after ANY abort every later call is refused, including decryption: nothing is recoverable from a dead trustee", () => {
    const attempt = attemptCeremony({ tamper: { shares: (m) => m.slice(1) } });
    assert.ok(!attempt.ok);
    const dead = attempt.trustees.find((t) => t.state === "aborted")!;
    for (const call of [() => dead.announce(), () => dead.commit([]), () => dead.deal([]), () => dead.receive([]), () => dead.finalize({}), () => dead.partialDecrypt(aggregate), () => dead.exportEncryptedShare("a long enough password")]) {
      assert.throws(call, /CEREMONY_ABORTED|CEREMONY_INCOMPLETE/);
    }
    assert.equal(dead.state, "aborted");
    assert.equal(dead.toJSON().verificationKey, null);
  });

  it("abort errors never contain secret values: they name codes, indices and fields only", () => {
    const attempt = attemptCeremony({ tamper: { shares: (m) => m.map((x, i) => (i === 0 ? { ...x, ciphertext: x.ciphertext.slice(0, 60) + "00" + x.ciphertext.slice(62) } : x)) } });
    assert.ok(!attempt.ok);
    const text = String((attempt.error as Error).message) + String((attempt.error as Error).stack ?? "");
    assert.doesNotMatch(text, /[0-9a-f]{40,}/i, "no long hex string");
    assert.doesNotMatch(text, /\d{30,}/, "no long number");
    assert.ok(attempt.error instanceof CeremonyAbort);
  });
});
