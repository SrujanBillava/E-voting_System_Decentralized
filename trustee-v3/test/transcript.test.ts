// The public ceremony transcript: canonical serialisation, an independent hash check, and verification that catches ANY change to ANY field.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { AbiCoder, id as keccakOfText, keccak256 } from "ethers";
import { buildTranscript, confirmCeremony, deserializeTranscript, serializeTranscript, verifyTranscript, type Transcript } from "../src/ceremony.ts";
import { hex32 } from "../src/encoding.ts";
import { TEST_CONTEXT } from "../src/params.ts";
import { runCeremony, clone, type CeremonyRun } from "../testing/ceremony.ts";

describe("transcript: format, hash and canonical serialisation", () => {
  let run: CeremonyRun;
  before(() => {
    run = runCeremony();
  });

  it("contains ONLY public data: context, trustee indices, transport PUBLIC keys, commitments, proofs, H, vk_1..vk_3 and the hash", () => {
    const allowed = new Set(["version", "context", "chainId", "contractAddress", "electionId", "threshold", "trustees", "ceremonyId", "participants", "index", "transportPublicKey", "commitments", "proofs", "e", "z", "electionPublicKey", "verificationKeys", "transcriptHash"]);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) (keys.add(k), walk(v));
    };
    walk(run.transcript);
    for (const key of keys) assert.ok(allowed.has(key), `unexpected field ${key}`);
    assert.equal(run.transcript.participants.length, 3);
    assert.equal(run.transcript.verificationKeys.length, 3);
    assert.deepEqual(run.transcript.participants.map((p) => p.index), [1, 2, 3]);
    assert.equal(run.transcript.participants[0]!.commitments.length, 2);
  });

  it("the transcript hash equals an INDEPENDENT recomputation: keccak256(abi.encode(tag, context, n, t, ceremony, per-trustee data, H, vks))", () => {
    const t = run.transcript;
    const values: bigint[] = [BigInt(keccakOfText("VOTECHAIN-V3-DKG-TRANSCRIPT-1")), TEST_CONTEXT.chainId, TEST_CONTEXT.contractAddress, TEST_CONTEXT.electionId, 3n, 2n, BigInt(t.ceremonyId)];
    for (const p of t.participants) {
      values.push(BigInt(p.index), BigInt(p.transportPublicKey));
      for (const K of p.commitments) values.push(BigInt(K[0]), BigInt(K[1]));
      for (const pr of p.proofs) values.push(BigInt(pr.e), BigInt(pr.z));
    }
    values.push(BigInt(t.electionPublicKey[0]), BigInt(t.electionPublicKey[1]));
    for (const vk of t.verificationKeys) values.push(BigInt(vk[0]), BigInt(vk[1]));
    assert.equal(values.length, 7 + 3 * (2 + 4 + 4) + 2 + 6);
    assert.equal(t.transcriptHash, keccak256(AbiCoder.defaultAbiCoder().encode(values.map(() => "uint256"), values)));
  });

  it("serialisation is canonical and deterministic: the same transcript is always the same bytes, and it round-trips", () => {
    const text = serializeTranscript(run.transcript);
    assert.equal(serializeTranscript(clone(run.transcript)), text);
    assert.deepEqual(deserializeTranscript(text), run.transcript);
    assert.equal(serializeTranscript(deserializeTranscript(text)), text);
    assert.ok(!text.includes("\n") && !text.includes(" "), "no whitespace");
    assert.ok(text.length < 8000, `compact: ${text.length} bytes`);
    assert.ok(text.indexOf('"version"') < text.indexOf('"context"') && text.indexOf('"context"') < text.indexOf('"participants"') && text.indexOf('"participants"') < text.indexOf('"transcriptHash"'), "fixed key order");
  });

  it("two parties assembling the transcript from the same public messages get byte-identical output and the same hash", () => {
    const again = buildTranscript({ context: TEST_CONTEXT, announcements: run.announcements, commitmentMessages: run.commitmentMessages });
    assert.equal(serializeTranscript(again), serializeTranscript(run.transcript));
    assert.equal(again.transcriptHash, run.transcript.transcriptHash);
  });

  it("deserialisation refuses every non-canonical spelling: pretty printing, reordered keys, uppercase hex, extra whitespace, trailing data", () => {
    const text = serializeTranscript(run.transcript);
    const parsed = JSON.parse(text);
    const reordered = JSON.stringify({ transcriptHash: parsed.transcriptHash, ...parsed });
    for (const bad of [JSON.stringify(parsed, null, 2), reordered, text.replace(/0x[0-9a-f]{64}/, (m) => m.toUpperCase().replace("0X", "0x")), " " + text, text + " ", text + "{}", "not json", "", "null", "[]"]) {
      assert.throws(() => deserializeTranscript(bad), /BAD_TRANSCRIPT|BAD_ENCODING|BAD_STRUCTURE/, bad.slice(0, 40));
    }
    assert.throws(() => deserializeTranscript(5 as unknown as string), /BAD_TRANSCRIPT/);
  });

  it("the honest transcript verifies, from its JSON text, and returns the verified keys", () => {
    const result = verifyTranscript(JSON.parse(serializeTranscript(run.transcript)), { context: TEST_CONTEXT, params: { n: 3, t: 2 }, transcriptHash: run.transcript.transcriptHash });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(hex32(result.transcript.transcriptHash), run.transcript.transcriptHash);
      assert.equal(result.transcript.verificationKeys.length, 3);
    }
  });
});

describe("transcript: verification catches ANY change", () => {
  let run: CeremonyRun;
  before(() => {
    run = runCeremony();
  });

  /** every leaf of the transcript, with a function that returns a copy with that leaf changed by the smallest possible amount */
  function leafMutations(t: Transcript): [string, Transcript][] {
    const out: [string, Transcript][] = [];
    const visit = (node: unknown, path: (string | number)[]): void => {
      if (Array.isArray(node)) node.forEach((v, i) => visit(v, [...path, i]));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) visit(v, [...path, k]);
      else {
        const copy = clone(t) as unknown as Record<string, unknown>;
        let target: Record<string | number, unknown> = copy;
        for (const step of path.slice(0, -1)) target = target[step] as Record<string | number, unknown>;
        const last = path[path.length - 1]!;
        const value = target[last];
        if (typeof value === "number") target[last] = value + 1;
        else if (typeof value === "string" && /^0x[0-9a-f]+$/.test(value)) target[last] = value.slice(0, -1) + (value.endsWith("0") ? "1" : "0");
        else if (typeof value === "string" && /^[0-9]+$/.test(value)) target[last] = String(BigInt(value) + 1n);
        else target[last] = "tampered";
        out.push([path.join("."), copy as unknown as Transcript]);
      }
    };
    visit(t, []);
    return out;
  }

  it("flipping the smallest possible amount in ANY single field (every one of the leaves) makes verification fail, and never with an internal error", () => {
    const mutations = leafMutations(run.transcript);
    assert.ok(mutations.length >= 45, `${mutations.length} leaves`);
    for (const [path, mutated] of mutations) {
      const result = verifyTranscript(mutated);
      assert.ok(!result.ok, `changing ${path} must be detected`);
      if (!result.ok) assert.notEqual(result.code, "INTERNAL", `${path}: ${result.reason}`);
    }
  });

  it("structural damage fails: missing, extra, null, wrong-typed, swapped and truncated parts", () => {
    const t = run.transcript;
    const damaged: [string, unknown][] = [
      ["null", null],
      ["array", []],
      ["string", "transcript"],
      ["missing participants", (({ participants: _p, ...rest }) => rest)(t)],
      ["extra field", { ...t, extra: 1 }],
      ["participants not an array", { ...t, participants: {} }],
      ["a participant dropped", { ...t, participants: t.participants.slice(1) }],
      ["a participant duplicated", { ...t, participants: [t.participants[0], t.participants[0], t.participants[2]] }],
      ["participants swapped", { ...t, participants: [t.participants[1], t.participants[0], t.participants[2]] }],
      ["verification keys truncated", { ...t, verificationKeys: t.verificationKeys.slice(0, 2) }],
      ["verification keys reversed", { ...t, verificationKeys: [...t.verificationKeys].reverse() }],
      ["a commitment removed", { ...t, participants: t.participants.map((p, i) => (i === 0 ? { ...p, commitments: p.commitments.slice(1) } : p)) }],
      ["a proof removed", { ...t, participants: t.participants.map((p, i) => (i === 1 ? { ...p, proofs: p.proofs.slice(1) } : p)) }],
      ["the hash as a number", { ...t, transcriptHash: 5 }],
      ["the context as a string", { ...t, context: "ctx" }],
      ["H as an object", { ...t, electionPublicKey: { x: 1, y: 2 } }],
    ];
    for (const [name, value] of damaged) {
      const result = verifyTranscript(value);
      assert.ok(!result.ok, name);
      if (!result.ok) assert.notEqual(result.code, "INTERNAL", `${name}: ${result.reason}`);
    }
  });

  it("expectations are enforced: another election context, other (n, t), or another pinned hash is refused", () => {
    const t = run.transcript;
    const ctx = { chainId: 1n, contractAddress: 0xabcn, electionId: 0xdefn };
    const wrongContext = verifyTranscript(t, { context: ctx });
    assert.ok(!wrongContext.ok && wrongContext.code === "CONTEXT_MISMATCH");
    for (const field of ["chainId", "contractAddress", "electionId"] as const) {
      const r = verifyTranscript(t, { context: { ...TEST_CONTEXT, [field]: TEST_CONTEXT[field] + 1n } });
      assert.ok(!r.ok && r.code === "CONTEXT_MISMATCH", field);
    }
    const wrongParams = verifyTranscript(t, { params: { n: 5, t: 3 } });
    assert.ok(!wrongParams.ok && wrongParams.code === "PARAMS_MISMATCH");
    const wrongHash = verifyTranscript(t, { transcriptHash: hex32(BigInt(t.transcriptHash) + 1n) });
    assert.ok(!wrongHash.ok && wrongHash.code === "HASH_MISMATCH");
    assert.ok(verifyTranscript(t, { transcriptHash: t.transcriptHash }).ok);
  });

  it("the transcript of another ceremony is a perfectly valid transcript of ANOTHER ceremony: it differs in everything and verifies only on its own terms", () => {
    const other = runCeremony();
    assert.ok(verifyTranscript(other.transcript).ok);
    assert.notEqual(other.transcript.transcriptHash, run.transcript.transcriptHash);
    assert.notEqual(other.transcript.ceremonyId, run.transcript.ceremonyId);
    assert.notDeepEqual(other.transcript.electionPublicKey, run.transcript.electionPublicKey);
    const pinned = verifyTranscript(other.transcript, { transcriptHash: run.transcript.transcriptHash });
    assert.ok(!pinned.ok && pinned.code === "HASH_MISMATCH", "pinning the hash of THIS ceremony refuses the other one");
  });

  it("mixing commitments of two ceremonies inside one transcript fails: the proofs are bound to their own ceremony", () => {
    const other = runCeremony();
    const mixed = clone(run.transcript);
    mixed.participants[1] = clone(other.transcript.participants[1]!);
    const result = verifyTranscript(mixed);
    assert.ok(!result.ok);
  });
});

describe("transcript: confirmations (the trustees independently confirm the registered key)", () => {
  let run: CeremonyRun;
  before(() => {
    run = runCeremony();
  });
  const bad = (confirmations: unknown, code: RegExp): void => assert.throws(() => confirmCeremony(run.transcript, confirmations, { context: TEST_CONTEXT }), code);

  it("all three matching confirmations complete the ceremony and return the verified transcript", () => {
    const verified = confirmCeremony(run.transcript, run.confirmations, { context: TEST_CONTEXT });
    assert.equal(hex32(verified.transcriptHash), run.transcript.transcriptHash);
  });

  it("a missing confirmation, a duplicate, another hash, another verification key, a wrong index, extra fields or the wrong shape all refuse", () => {
    const c = run.confirmations;
    bad(c.slice(0, 2), /MISSING_TRUSTEE/);
    bad([c[0], c[1], c[1]], /DUPLICATE_INDEX/);
    bad([c[0], c[1], { ...c[2]!, transcriptHash: hex32(BigInt(c[2]!.transcriptHash) + 1n) }], /HASH_MISMATCH/);
    bad([c[0], c[1], { ...c[2]!, verificationKey: c[0]!.verificationKey }], /VERIFICATION_KEY_MISMATCH/);
    bad([c[0], c[1], { ...c[2]!, index: 9 }], /INVALID_INDEX/);
    bad([c[0], c[1], { ...c[2]!, extra: 1 }], /BAD_STRUCTURE/);
    bad("confirmations", /BAD_STRUCTURE/);
    bad([], /MISSING_TRUSTEE/);
  });

  it("confirmations from ANOTHER ceremony do not confirm this one", () => {
    const other = runCeremony();
    bad(other.confirmations, /HASH_MISMATCH/);
  });
});
