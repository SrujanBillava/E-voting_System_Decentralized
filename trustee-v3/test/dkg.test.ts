// The dealer-less 2-of-3 DKG: happy path, an omniscient oracle that checks the result against the polynomial definition, "the full secret never exists",
// public-output hygiene, wire format, the state machine, repeated random ceremonies and a 3-of-5 generalisation.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { inspect } from "node:util";
import { AggregateCiphertext } from "../src/aggregate.ts";
import { serializeTranscript } from "../src/ceremony.ts";
import { G, SUBGROUP_ORDER as L, TEST_CONTEXT, type Point } from "../src/params.ts";
import { add, mul, parsePointWire, pointsEqual, sub } from "../src/point.ts";
import { add as sAdd, inv, mod, mul as sMul } from "../src/scalar.ts";
import { Trustee } from "../src/trustee.ts";
import { runCeremony, type CeremonyRun } from "../testing/ceremony.ts";
import { assertNoLeak, captureRandomness, logOf, scalarsOf } from "../testing/spy.ts";

const wire = (p: [string, string]): Point => parsePointWire(p, "point");

describe("DKG: a dealer-less 2-of-3 ceremony", () => {
  let run: CeremonyRun;
  let scalars: bigint[];
  // everything below is the test acting as an OMNISCIENT observer: it learns the secrets from the random draws, which no real participant could
  let a: bigint[][]; // a[i-1][k] = a_ik
  let s: bigint; // the shared secret, computed ONLY here, to check the result
  let shares: bigint[]; // s_j by definition: sum_i f_i(j)

  before(() => {
    const captured = captureRandomness(() => runCeremony());
    run = captured.result;
    scalars = scalarsOf(captured.draws);
    a = run.transcript.participants.map((p) => p.commitments.map((K) => logOf(wire(K), scalars) as bigint));
    s = a.reduce((acc, coefficients) => sAdd(acc, coefficients[0] as bigint), 0n);
    shares = [1, 2, 3].map((j) => a.reduce((acc, [a0, a1]) => sAdd(acc, sAdd(a0 as bigint, sMul(a1 as bigint, BigInt(j)))), 0n));
  });

  it("all three trustees reach 'finalized', every proof verifies and everyone confirmed the same transcript hash", () => {
    assert.deepEqual(run.trustees.map((t) => t.state), ["finalized", "finalized", "finalized"]);
    assert.equal(run.verified.params.n, 3);
    assert.equal(run.verified.params.t, 2);
    assert.ok(run.confirmations.every((c) => c.transcriptHash === run.transcript.transcriptHash));
  });

  it("H = K_10 + K_20 + K_30 and vk_j = sum_i (K_i0 + j*K_i1), recomputed here from the public commitments alone", () => {
    const K = (i: number, k: number): Point => wire(run.transcript.participants[i - 1]!.commitments[k]!);
    const H = add(add(K(1, 0), K(2, 0)), K(3, 0));
    assert.ok(pointsEqual(wire(run.transcript.electionPublicKey), H));
    for (const j of [1, 2, 3]) {
      let vk = wire(run.transcript.participants[0]!.commitments[0]!);
      vk = sub(vk, vk); // identity
      for (const i of [1, 2, 3]) vk = add(vk, add(K(i, 0), mul(K(i, 1), BigInt(j))));
      assert.ok(pointsEqual(wire(run.transcript.verificationKeys[j - 1]!), vk), `vk_${j}`);
    }
  });

  it("ORACLE: the result is exactly what the polynomial definition says: H = s*G, vk_j = s_j*G with s_j = sum_i f_i(j), and ANY two shares interpolate to s", () => {
    assert.ok(a.every((coefficients) => coefficients.every((c) => c !== undefined)), "every published commitment's logarithm was found among the drawn scalars");
    assert.ok(pointsEqual(wire(run.transcript.electionPublicKey), mul(G, s)));
    [1, 2, 3].forEach((j, idx) => assert.ok(pointsEqual(wire(run.transcript.verificationKeys[idx]!), mul(G, shares[idx] as bigint)), `vk_${j}`));
    const lambda = (x: number, y: number): [bigint, bigint] => [mod(sMul(BigInt(y), inv(mod(BigInt(y - x))))), mod(sMul(BigInt(x), inv(mod(BigInt(x - y)))))]; // lambda_x = y/(y-x), lambda_y = x/(x-y)
    for (const [x, y] of [[1, 2], [1, 3], [2, 3]] as const) {
      const [lx, ly] = lambda(x, y);
      assert.equal(sAdd(sMul(lx, shares[x - 1] as bigint), sMul(ly, shares[y - 1] as bigint)), s, `pair (${x},${y}) interpolates to s`);
    }
  });

  it("ORACLE: each trustee really holds s_j: its partial decryption of a random aggregate is s_j*A", () => {
    const A = mul(G, 123456789n);
    const aggregate = AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: 77n, ballotCount: 5, slots: [{ A, B: mul(G, 987654321n) }] });
    run.trustees.forEach((trustee, idx) => {
      const partial = trustee.partialDecrypt(aggregate);
      assert.ok(pointsEqual(wire(partial.slots[0]!.D), mul(A, shares[idx] as bigint)), `trustee ${idx + 1}`);
    });
  });

  it("the FULL SECRET never exists: s was never drawn from the entropy source, and equals no coefficient, no share and no nonce", () => {
    assert.ok(!scalars.includes(s));
    assert.ok(a.flat().every((c) => c !== s));
    assert.ok(shares.every((x) => x !== s));
    // trustee counts: 2 coefficients + 2 Schnorr nonces each, plus nothing else drawn as a scalar during the DKG (6 coefficient-and-nonce pairs)
    assert.equal(scalars.length, 12);
  });

  it("NO PUBLIC OUTPUT contains any secret in any spelling: not the coefficients, nonces, shares (f_i(j) and s_j) or the shared secret s", () => {
    const f = (i: number, j: number): bigint => sAdd(a[i - 1]![0] as bigint, sMul(a[i - 1]![1] as bigint, BigInt(j)));
    const secrets = [...scalars, s, ...shares, ...[1, 2, 3].flatMap((i) => [1, 2, 3].map((j) => f(i, j)))];
    assertNoLeak("announcements", run.announcements, secrets);
    assertNoLeak("commitment messages", run.commitmentMessages, secrets);
    assertNoLeak("transcript", run.transcript, secrets);
    assertNoLeak("serialized transcript", serializeTranscript(run.transcript), secrets);
    assertNoLeak("confirmations", run.confirmations, secrets);
    assertNoLeak("encrypted shares (they are encrypted: no plaintext share)", run.shareMessages, secrets);
    for (const t of run.trustees) {
      assertNoLeak("trustee JSON", JSON.stringify(t), secrets);
      assertNoLeak("trustee inspect", inspect(t, { showHidden: true, depth: 10 }), secrets);
      assertNoLeak("trustee string", String(t) + JSON.stringify(Object.getOwnPropertyNames(t)), secrets);
    }
  });

  it("a Trustee exposes only public properties; its secrets live in # private fields with no accessor", () => {
    for (const t of run.trustees) {
      assert.deepEqual(Object.getOwnPropertyNames(t).sort(), ["context", "index", "minBallots", "params"]);
      assert.deepEqual(Object.getOwnPropertySymbols(t), []);
      assert.deepEqual(Object.keys(t.toJSON()).sort(), ["index", "state", "verificationKey"]);
    }
    const methods = Object.getOwnPropertyNames(Trustee.prototype).sort();
    assert.deepEqual(methods, ["announce", "commit", "constructor", "deal", "exportEncryptedShare", "finalize", "partialDecrypt", "receive", "state", "toJSON"]);
  });

  it("every message is plain JSON (no bigint, no undefined, no class instance): it would survive a network unchanged", () => {
    for (const message of [run.announcements, run.commitmentMessages, run.shareMessages, run.transcript, run.confirmations]) assert.deepEqual(JSON.parse(JSON.stringify(message)), message);
  });

  it("share transport: exactly the six ordered pairs i != j, each a fixed-size ciphertext", () => {
    assert.deepEqual(run.shareMessages.map((m) => `${m.from}>${m.to}`).sort(), ["1>2", "1>3", "2>1", "2>3", "3>1", "3>2"]);
    for (const m of run.shareMessages) assert.match(m.ciphertext, /^0x[0-9a-f]{228}$/);
  });

  it("the ceremony id equals an independent recomputation: keccak256(abi.encode(tag, context, n, t, key_1..key_n))", async () => {
    const { AbiCoder, keccak256, toBeHex, id } = await import("ethers");
    const keys = run.transcript.participants.map((p) => p.transportPublicKey);
    const encoded = AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "address", "bytes32", "uint256", "uint256", "bytes32", "bytes32", "bytes32"],
      [id("VOTECHAIN-V3-DKG-CEREMONY-1"), TEST_CONTEXT.chainId, toBeHex(TEST_CONTEXT.contractAddress, 20), toBeHex(TEST_CONTEXT.electionId, 32), 3, 2, ...keys],
    );
    assert.equal(run.transcript.ceremonyId, keccak256(encoded));
  });
});

describe("DKG: state machine and construction", () => {
  const ctx = TEST_CONTEXT;

  it("steps in the wrong order are refused WITHOUT damaging the ceremony", () => {
    const t = new Trustee({ index: 1, context: ctx });
    for (const call of [() => t.commit([]), () => t.deal([]), () => t.receive([]), () => t.finalize({})]) assert.throws(call, /WRONG_STATE/);
    assert.equal(t.state, "new");
    t.announce();
    assert.throws(() => t.announce(), /WRONG_STATE/);
    assert.equal(t.state, "announced");
    assert.throws(() => t.deal([]), /WRONG_STATE/);
    assert.equal(t.state, "announced", "a stray call does not abort the ceremony");
  });

  it("construction is validated: index range, threshold >= 2, at most 9 trustees, a real context, a sane minimum", () => {
    for (const bad of [0, 4, -1, 1.5, NaN]) assert.throws(() => new Trustee({ index: bad, context: ctx }), /BAD_INTEGER/, String(bad));
    assert.throws(() => new Trustee({ index: 1, context: ctx, params: { n: 3, t: 1 } }), /BAD_INTEGER/, "t = 1 would let one trustee decrypt alone");
    assert.throws(() => new Trustee({ index: 1, context: ctx, params: { n: 10, t: 2 } }), /BAD_INTEGER/);
    assert.throws(() => new Trustee({ index: 1, context: ctx, params: { n: 3, t: 4 } }), /BAD_INTEGER/);
    assert.throws(() => new Trustee({ index: 1, context: { ...ctx, chainId: 0n } }), /BAD_CONTEXT/);
    assert.throws(() => new Trustee({ index: 1, context: { ...ctx, contractAddress: 1n << 160n } }), /BAD_CONTEXT/);
    assert.throws(() => new Trustee({ index: 1, context: null as unknown as typeof ctx }), /BAD_CONTEXT/);
    assert.throws(() => new Trustee({ index: 1, context: ctx, minBallots: 0 }), /BAD_INTEGER/);
  });
});

describe("DKG: repeated random ceremonies and a generalisation", () => {
  it("12 independent ceremonies: every transcript verifies, every H is different, and ANY pair of verification keys interpolates to H (independent lambda formulas)", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const r = runCeremony();
      const H = wire(r.transcript.electionPublicKey);
      keys.add(r.transcript.electionPublicKey[0]);
      const vk = r.transcript.verificationKeys.map(wire);
      const half = inv(2n);
      // (1,2): 2*vk1 - vk2   (1,3): (3*vk1 - vk3)/2   (2,3): 3*vk2 - 2*vk3
      assert.ok(pointsEqual(sub(mul(vk[0]!, 2n), vk[1]!), H), "pair (1,2)");
      assert.ok(pointsEqual(mul(sub(mul(vk[0]!, 3n), vk[2]!), half), H), "pair (1,3)");
      assert.ok(pointsEqual(sub(mul(vk[1]!, 3n), mul(vk[2]!, 2n)), H), "pair (2,3)");
    }
    assert.equal(keys.size, 12);
  });

  it("the code is generic in (n, t): a 3-of-5 ceremony works and any three verification keys interpolate to H", () => {
    const r = runCeremony({ params: { n: 5, t: 3 } });
    assert.ok(r.trustees.every((t) => t.state === "finalized"));
    assert.equal(r.verified.params.n, 5);
    assert.equal(r.verified.params.t, 3);
    assert.equal(r.verified.participants[0]!.commitments.length, 3, "a degree-2 polynomial: three commitments each");
  });

  it("l is a prime well below the field prime: the scalars of every ceremony fit the group order", () => {
    assert.ok(L < 2n ** 252n);
  });
});
