// End-to-end with REAL proofs: Semaphore V4 anonymous membership + BabyJubJub ElGamal one-hot ballot + Groth16 validity proof,
// verified by a ballot box that also enforces the binding between them, one-ballot-per-nullifier, and homomorphic tallying.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { BallotBox } from "../src/ballotbox.js";
import { ballotHash, padCiphertexts, validityCircuitInput, validityPublicSignals } from "../src/ballot.js";
import { add, decryptToPoint, generateTestKeyPair, makeDiscreteLog } from "../src/elgamal.js";
import { G, SEMAPHORE_DEPTH, TEST_CONTEXT, constituencyIdValue, electionScope } from "../src/params.js";
import { makeGroup, proveMembership, verifyMembership } from "../src/semaphore.js";
import { fakeVoter } from "../testing/fake-voters.js";
import { castBallot, prepareBallot, wireCiphertexts } from "../src/voter.js";
import { proveValidity, shutdownProver, verifyValidity } from "../src/validity.js";
import { SKIP_NO_ARTIFACTS, vec } from "./helpers.mjs";

const ctx = TEST_CONTEXT;
const wire = (o) => JSON.parse(JSON.stringify(o)); // everything that crosses the voter -> server boundary must survive JSON
const CONSTITUENCIES = { "KA-BLR": 3, "MH-MUM": 4, "DL-DEL": 16, "TN-CHE": 3 }; // Bengaluru, Mumbai, Delhi (16 candidates), Chennai
const BLR = "KA-BLR", MUM = "MH-MUM", DEL = "DL-DEL", CHE = "TN-CHE";

describe("Privacy V3 core: anonymous encrypted verified ballots", { skip: SKIP_NO_ARTIFACTS }, () => {
  let H, secret, H2;
  let voters, groups, box;
  const bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
  const state = () => ({ ledger: box.ledger.length, used: box.used.size, sums: JSON.stringify(Object.keys(CONSTITUENCIES).map((c) => box.aggregate(c)), bigintSafe) });
  const rejected = (res, reason) => {
    assert.equal(res.accepted, false, `must be rejected (got ${JSON.stringify(res).slice(0, 200)})`);
    assert.equal(res.reason, reason, res.detail);
  };
  const honest = async (code, index, choice) => {
    const out = await castBallot({ identity: voters[code][index], group: groups[code], ctx, constituency: code, kc: CONSTITUENCIES[code], choice, H });
    return { ...out, submission: wire(out.submission) };
  };
  const accept = async (b) => {
    const res = await box.submit(b.submission);
    assert.equal(res.accepted, true, JSON.stringify(res));
    return res;
  };
  const statementOf = (b, over = {}) => {
    const i = b.internals;
    return validityPublicSignals({ kc: over.kc ?? i.kc, H: over.H ?? i.H, nullifier: over.nullifier ?? i.nullifier, ciphertexts: over.ciphertexts ?? i.ciphertexts });
  };

  before(() => {
    ({ publicKey: H, secret } = generateTestKeyPair()); // TEST key: lives only in this process
    ({ publicKey: H2 } = generateTestKeyPair());
    voters = Object.fromEntries(Object.keys(CONSTITUENCIES).map((c) => [c, [1, 2, 3, 4, 5].map((n) => fakeVoter(`${c}-${n}`))]));
    groups = Object.fromEntries(Object.entries(voters).map(([c, v]) => [c, makeGroup(v)]));
    box = new BallotBox({ ctx, publicKey: H, constituencies: Object.fromEntries(Object.entries(CONSTITUENCIES).map(([c, kc]) => [c, { kc, group: groups[c] }])) });
  });
  after(shutdownProver);

  describe("one ballot: every component verifies, and they are bound to each other", () => {
    let alice;
    it("Alice (member 1 of 5 in Bengaluru) casts a ballot; the Semaphore proof, the validity proof and their binding all verify", async () => {
      alice = await honest(BLR, 0, 0);
      const { semaphore, validity } = alice.submission;
      assert.equal(await verifyMembership(semaphore), true, "Semaphore proof");
      assert.equal(semaphore.merkleTreeRoot, groups[BLR].root.toString(), "proves membership of THIS constituency's group");
      assert.equal(semaphore.scope, electionScope(ctx).toString(), "election-wide scope");
      assert.equal(semaphore.merkleTreeDepth, SEMAPHORE_DEPTH, "generated at the declared depth 20 (the group itself has 5 members)");
      assert.equal(semaphore.message, alice.internals.hash.toString(), "Semaphore message == keccak ballotHash of the exact ciphertexts + context");
      assert.equal(alice.internals.hash, ballotHash(ctx, constituencyIdValue(BLR), alice.internals.ciphertexts), "recomputed independently from the public data");
      const statement = statementOf(alice);
      assert.equal(statement.length, 68, "nullifier, kc, H.x, H.y and 64 coordinates");
      assert.equal(await verifyValidity(validity.proof, statement), true, "validity proof");
      assert.equal(statement[0], semaphore.nullifier, "the validity proof is bound to the SAME nullifier as the Semaphore proof");
    });

    it("the submission reveals neither the identity, the secret, the randomness nor the plaintext vote", () => {
      const text = JSON.stringify(alice.submission);
      for (const secretThing of [voters[BLR][0].commitment, voters[BLR][0].secretScalar, voters[BLR][0].privateKey?.toString?.() ?? "", ...alice.internals.r.slice(0, 3)]) {
        if (String(secretThing).length > 8) assert.ok(!text.includes(String(secretThing)), "leaked a private value");
      }
      assert.deepEqual(Object.keys(alice.submission).sort(), ["ciphertexts", "constituency", "semaphore", "validity"]);
      assert.equal(alice.submission.ciphertexts.length, 3, "only the kc real slots are sent");
      assert.ok(!("choice" in alice.submission) && !("vote" in alice.submission));
    });

    it("the ballot box accepts it and consumes the nullifier", async () => {
      const res = await accept(alice);
      assert.equal(res.nullifier, alice.submission.semaphore.nullifier);
      assert.equal(box.used.has(BigInt(res.nullifier)), true);
    });
  });

  describe("an election: votes A, B, A (+ other constituencies), tallied homomorphically", () => {
    it("Bob votes B and Carol votes A in Bengaluru", async () => {
      await accept(await honest(BLR, 1, 1));
      await accept(await honest(BLR, 2, 0));
      assert.equal(box.ledger.filter((l) => l.constituency === BLR).length, 3);
    });

    it("decrypting ONLY the aggregate gives A=2, B=1, C=0", () => {
      assert.deepEqual(box.decryptTotals(BLR, secret), [2n, 1n, 0n]);
    });

    it("other constituencies are independent, including a 16-candidate ballot (kc=16, vote in the LAST slot)", async () => {
      await accept(await honest(MUM, 0, 3));
      await accept(await honest(DEL, 0, 15));
      assert.deepEqual(box.decryptTotals(MUM, secret), [0n, 0n, 0n, 1n]);
      assert.deepEqual(box.decryptTotals(DEL, secret), [...Array(15).fill(0n), 1n]);
      assert.deepEqual(box.decryptTotals(BLR, secret), [2n, 1n, 0n], "unchanged by the other constituencies");
      assert.deepEqual(box.decryptTotals(CHE, secret), [0n, 0n, 0n], "no ballots: the neutral aggregate decrypts to zeros");
    });

    it("a wrong key cannot read the aggregate", () => {
      assert.throws(() => box.decryptTotals(BLR, generateTestKeyPair().secret), /outside the search bound, or wrong key/);
    });
  });

  describe("NEGATIVE: membership", () => {
    it("a non-member identity cannot produce a proof for the real group", async () => {
      const outsider = fakeVoter("outsider");
      await assert.rejects(proveMembership({ identity: outsider, group: groups[BLR], message: 1n, scope: electionScope(ctx) }));
    });

    it("a non-member who builds a perfectly valid ballot against a group of their own is rejected (wrong group root)", async () => {
      const outsider = fakeVoter("outsider");
      const ownGroup = makeGroup([outsider, ...[1, 2, 3, 4].map((n) => fakeVoter(`someone-${n}`))]);
      const out = await castBallot({ identity: outsider, group: ownGroup, ctx, constituency: BLR, kc: 3, choice: 0, H });
      assert.equal(await verifyMembership(out.submission.semaphore), true, "the Semaphore proof itself is valid - for the wrong group");
      const before = state();
      rejected(await box.submit(wire(out.submission)), "NOT_A_MEMBER");
      assert.deepEqual(state(), before);
    });

    it("patching the group root of that proof to the real root breaks the proof itself", async () => {
      const outsider = fakeVoter("outsider");
      const ownGroup = makeGroup([outsider, ...[1, 2, 3, 4].map((n) => fakeVoter(`someone-${n}`))]);
      const out = await castBallot({ identity: outsider, group: ownGroup, ctx, constituency: BLR, kc: 3, choice: 0, H });
      const forged = wire(out.submission);
      forged.semaphore.merkleTreeRoot = groups[BLR].root.toString();
      rejected(await box.submit(forged), "BAD_MEMBERSHIP_PROOF");
    });

    it("a member of another constituency cannot vote here, and a ballot cannot be moved to another constituency", async () => {
      const chennai = await honest(CHE, 3, 2); // Frank, built but not submitted yet
      const relabelled = wire(chennai.submission);
      relabelled.constituency = BLR; // same kc=3, but a different group and a different constituency id inside the ballot hash
      rejected(await box.submit(relabelled), "NOT_A_MEMBER");
      const other = new BallotBox({ ctx: { ...ctx, electionId: ctx.electionId ^ (1n << 100n) }, publicKey: H, constituencies: { [CHE]: { kc: 3, group: groups[CHE] } } });
      rejected(await other.submit(chennai.submission), "WRONG_SCOPE"); // a ballot of another election (same groups) is not accepted either
      const otherChain = new BallotBox({ ctx: { ...ctx, chainId: 1n }, publicKey: H, constituencies: { [CHE]: { kc: 3, group: groups[CHE] } } });
      rejected(await otherChain.submit(chennai.submission), "WRONG_SCOPE");
    });
  });

  describe("the context is bound through the keccak message (it is not a circuit input any more)", () => {
    it("a Semaphore proof signed over the hash of another chain / contract / election / constituency is rejected even with the right scope and group; the right hash is accepted", async () => {
      const voter = voters[CHE][4];
      const ballot = prepareBallot({ identity: voter, ctx, constituency: CHE, kc: 3, choice: 0, H });
      const validity = await proveValidity(validityCircuitInput({ kc: 3, H, nullifier: ballot.nullifier, ciphertexts: ballot.ciphertexts, m: ballot.m, r: ballot.r }));
      const submissionFor = async (hash) =>
        wire({ constituency: CHE, ciphertexts: wireCiphertexts(ballot.ciphertexts, 3), semaphore: await proveMembership({ identity: voter, group: groups[CHE], message: hash, scope: ballot.scope }), validity: { proof: validity.proof } });
      const variants = {
        "other chain": ballotHash({ ...ctx, chainId: 1n }, ballot.constituencyId, ballot.ciphertexts),
        "other contract": ballotHash({ ...ctx, contractAddress: ctx.contractAddress + 1n }, ballot.constituencyId, ballot.ciphertexts),
        "other election (only the lowest bit differs)": ballotHash({ ...ctx, electionId: ctx.electionId ^ 1n }, ballot.constituencyId, ballot.ciphertexts),
        "other constituency": ballotHash(ctx, constituencyIdValue(BLR), ballot.ciphertexts),
      };
      const fresh = new BallotBox({ ctx, publicKey: H, constituencies: { [CHE]: { kc: 3, group: groups[CHE] } } });
      for (const [name, hash] of Object.entries(variants)) {
        const res = await fresh.submit(await submissionFor(hash));
        assert.equal(res.accepted, false, name);
        assert.equal(res.reason, "BALLOT_NOT_BOUND", name);
      }
      assert.equal(fresh.ledger.length, 0);
      assert.equal((await fresh.submit(await submissionFor(ballot.hash))).accepted, true, "control: the correct keccak ballot hash is accepted");
    });

    it("a ballot relabelled to another constituency that has the SAME group fails only because the constituency id is inside the hash", async () => {
      const aliasBox = new BallotBox({ ctx, publicKey: H, constituencies: { [CHE]: { kc: 3, group: groups[CHE] }, "XX-ALIAS": { kc: 3, group: groups[CHE] } } });
      const b = await honest(CHE, 4, 1);
      const relabelled = wire(b.submission);
      relabelled.constituency = "XX-ALIAS";
      rejected(await aliasBox.submit(relabelled), "BALLOT_NOT_BOUND");
      assert.equal((await aliasBox.submit(b.submission)).accepted, true, "control: under its own constituency it is accepted");
    });
  });

  describe("Semaphore depth: every proof must use the declared depth", () => {
    it("a depth-3 proof is accepted by a box declared at depth 3, refused by the depth-20 box, and a depth-20 proof is refused by the depth-3 box", async () => {
      const small = await castBallot({ identity: voters[CHE][4], group: groups[CHE], ctx, constituency: CHE, kc: 3, choice: 2, H, depth: 3 });
      const smallSubmission = wire(small.submission);
      assert.equal(smallSubmission.semaphore.merkleTreeDepth, 3);
      const box3 = new BallotBox({ ctx, publicKey: H, constituencies: { [CHE]: { kc: 3, group: groups[CHE] } }, semaphoreDepth: 3 });
      const before = state();
      rejected(await box.submit(smallSubmission), "WRONG_DEPTH");
      assert.deepEqual(state(), before);
      assert.equal((await box3.submit(smallSubmission)).accepted, true);
      const big = await honest(CHE, 4, 2);
      assert.equal(big.submission.semaphore.merkleTreeDepth, SEMAPHORE_DEPTH);
      rejected(await box3.submit(big.submission), "WRONG_DEPTH");
    });

    it("a ballot box refuses a group that needs more than the declared depth", () => {
      assert.throws(() => new BallotBox({ ctx, publicKey: H, constituencies: { [CHE]: { kc: 3, group: groups[CHE] } }, semaphoreDepth: 2 }), /exceeds the declared depth/);
    });
  });

  describe("NEGATIVE: nullifier reuse", () => {
    it("a second ballot by Alice (different choice, fresh randomness, valid proofs) is rejected: same nullifier", async () => {
      const again = await honest(BLR, 0, 2);
      assert.equal(again.submission.semaphore.nullifier, (await box.ledger[0]).nullifier.toString(), "same identity + same election scope = same nullifier");
      const before = state();
      rejected(await box.submit(again.submission), "NULLIFIER_USED");
      assert.deepEqual(state(), before);
      assert.deepEqual(box.decryptTotals(BLR, secret), [2n, 1n, 0n]);
    });

    it("submitting the very same accepted submission again is rejected", async () => {
      const first = box.ledger[0];
      assert.ok(first);
      const sameAgain = await honest(MUM, 0, 3); // MUM voter 0 already voted; this is a fresh rebuild of the same vote
      const before = state();
      rejected(await box.submit(sameAgain.submission), "NULLIFIER_USED");
      assert.deepEqual(state(), before);
    });

    it("the same nullifier submitted twice AT THE SAME TIME: exactly one is accepted", async () => {
      const b = await honest(MUM, 1, 0);
      const results = await Promise.all([box.submit(b.submission), box.submit(wire(b.submission)), box.submit(wire(b.submission))]);
      assert.equal(results.filter((r) => r.accepted).length, 1);
      assert.deepEqual(results.filter((r) => !r.accepted).map((r) => r.reason), ["NULLIFIER_USED", "NULLIFIER_USED"]);
      assert.deepEqual(box.decryptTotals(MUM, secret), [1n, 0n, 0n, 1n]);
    });
  });

  describe("NEGATIVE: invalid ballots cannot be proven, and borrowed proofs do not help", () => {
    let dave, daveX;
    before(async () => {
      dave = voters[CHE][0];
      daveX = await honest(CHE, 0, 0); // a valid ballot of Dave (not submitted yet): the best proof he has
    });

    const invalid = [
      ["two-hot [1,1,0]", vec([0, 1])],
      ["zero-hot [0,0,0]", vec([])],
      ["value 5 in a slot", vec([], { 0: 5n })],
    ];
    for (const [name, m] of invalid) {
      it(`${name}: the prover cannot produce a validity proof`, async () => {
        const forged = prepareBallot({ identity: dave, ctx, constituency: CHE, kc: 3, H, m });
        await assert.rejects(proveValidity(validityCircuitInput({ kc: 3, H, nullifier: forged.nullifier, ciphertexts: forged.ciphertexts, m: forged.m, r: forged.r })), /Assert Failed/);
      });

      it(`${name}: Dave's valid Semaphore proof + the validity proof of his OTHER (valid) ballot is rejected`, async () => {
        const forged = prepareBallot({ identity: dave, ctx, constituency: CHE, kc: 3, H, m });
        const semaphore = await proveMembership({ identity: dave, group: groups[CHE], message: forged.hash, scope: forged.scope }); // he is a member: this part is genuine
        const sub = wire({ constituency: CHE, ciphertexts: wireCiphertexts(forged.ciphertexts, 3), semaphore, validity: daveX.submission.validity });
        const before = state();
        rejected(await box.submit(sub), "BAD_VALIDITY_PROOF");
        assert.deepEqual(state(), before);
      });
    }

    it("a vote in a padded slot cannot even be expressed: extra ciphertexts are refused, and so are too few", async () => {
      const sub = wire(daveX.submission);
      sub.ciphertexts.push(sub.ciphertexts[0]);
      rejected(await box.submit(sub), "WRONG_CANDIDATE_COUNT");
      const fewer = wire(daveX.submission);
      fewer.ciphertexts.pop();
      rejected(await box.submit(fewer), "WRONG_CANDIDATE_COUNT");
    });

    it("failed attempts did not burn Dave's nullifier: his valid ballot is then accepted", async () => {
      assert.equal(box.used.has(BigInt(daveX.submission.semaphore.nullifier)), false);
      await accept(daveX);
    });
  });

  describe("NEGATIVE: tampering with an otherwise valid ballot", () => {
    let eve;
    before(async () => {
      eve = await honest(CHE, 1, 1);
    });

    it("a modified ciphertext (C2 + G in one slot) no longer matches the Semaphore message", async () => {
      const mod = wire(eve.submission);
      const c2 = add([BigInt(mod.ciphertexts[0].c2[0]), BigInt(mod.ciphertexts[0].c2[1])], G);
      mod.ciphertexts[0].c2 = [c2[0].toString(), c2[1].toString()];
      const before = state();
      rejected(await box.submit(mod), "BALLOT_NOT_BOUND");
      assert.deepEqual(state(), before);
    });

    it("...and if the voter re-proves membership for the modified ciphertext, the validity proof no longer verifies", async () => {
      const mod = wire(eve.submission);
      const c2 = add([BigInt(mod.ciphertexts[0].c2[0]), BigInt(mod.ciphertexts[0].c2[1])], G);
      mod.ciphertexts[0].c2 = [c2[0].toString(), c2[1].toString()];
      const real = mod.ciphertexts.map((c) => ({ c1: c.c1.map(BigInt), c2: c.c2.map(BigInt) }));
      const hash = ballotHash(ctx, constituencyIdValue(CHE), padCiphertexts(real));
      mod.semaphore = await proveMembership({ identity: voters[CHE][1], group: groups[CHE], message: hash, scope: electionScope(ctx) });
      rejected(await box.submit(mod), "BAD_VALIDITY_PROOF");
    });

    it("proof-level: every change to the public statement makes the validity proof fail (wrong key, wrong kc, changed ciphertext, changed nullifier)", async () => {
      const proof = eve.submission.validity.proof;
      assert.equal(await verifyValidity(proof, statementOf(eve)), true, "control: the real statement verifies");
      const i = eve.internals;
      const bump = (idx) => {
        const s = statementOf(eve);
        s[idx] = (BigInt(s[idx]) + 1n).toString();
        return s;
      };
      const mutations = {
        "wrong encryption public key H'": statementOf(eve, { H: H2 }),
        "kc 3 -> 4": statementOf(eve, { kc: 4 }),
        "kc 3 -> 2": statementOf(eve, { kc: 2 }),
        "kc 3 -> 16": statementOf(eve, { kc: 16 }),
        "changed nullifier": statementOf(eve, { nullifier: i.nullifier + 1n }),
        "nullifier + 1 (signal 0)": bump(0),
        "C1.x slot 0 changed": bump(4),
        "C1.y slot 1 changed": bump(4 + 4 + 1),
        "C2.x slot 2 changed": bump(4 + 8 + 2),
        "C2.y slot 0 changed": bump(4 + 3),
        "padded slot 3 C1.x changed": bump(4 + 12),
        "padded slot 15 C2.y changed": bump(4 + 60 + 3),
      };
      for (const [name, statement] of Object.entries(mutations)) assert.equal(await verifyValidity(proof, statement), false, name);
    });

    it("EXHAUSTIVE: changing any ONE of the 68 public signals invalidates the proof, so no public input is left unconstrained", async () => {
      const proof = eve.submission.validity.proof;
      const base = statementOf(eve);
      assert.equal(base.length, 68, "[nullifier, kc, H.x, H.y, 64 coordinates]; the circuit has no public output");
      for (let i = 0; i < base.length; i++) {
        const plusOne = [...base];
        plusOne[i] = (BigInt(base[i]) + 1n).toString();
        assert.equal(await verifyValidity(proof, plusOne), false, `public signal #${i} + 1`);
        const other = [...base];
        other[i] = base[i] === "0" ? "1" : "0";
        assert.equal(await verifyValidity(proof, other), false, `public signal #${i} replaced`);
      }
    });

    it("proof-level: replacing the proof by a different valid ballot's proof fails", async () => {
      const otherProof = (await honest(BLR, 3, 1)).submission.validity.proof; // BLR voter 4 builds a valid ballot (not submitted)
      assert.equal(await verifyValidity(otherProof, statementOf(eve)), false);
    });

    it("a wrong election public key: a box configured with H' rejects a ballot encrypted and proven for H", async () => {
      const other = new BallotBox({ ctx, publicKey: H2, constituencies: { [CHE]: { kc: 3, group: groups[CHE] } } });
      rejected(await other.submit(eve.submission), "BAD_VALIDITY_PROOF");
      assert.throws(() => new BallotBox({ ctx, publicKey: [0n, 1n], constituencies: {} }), /invalid election public key/);
    });

    it("a ballot encrypted under the WRONG key by the voter is rejected by a box that holds the real key", async () => {
      const wrongKey = await castBallot({ identity: voters[CHE][4], group: groups[CHE], ctx, constituency: CHE, kc: 3, choice: 0, H: H2 });
      rejected(await box.submit(wire(wrongKey.submission)), "BAD_VALIDITY_PROOF");
      assert.equal(box.used.has(BigInt(wrongKey.submission.semaphore.nullifier)), false);
    });

    it("changing the nullifier of a Semaphore proof breaks it", async () => {
      const mod = wire(eve.submission);
      mod.semaphore.nullifier = (BigInt(mod.semaphore.nullifier) + 1n).toString();
      rejected(await box.submit(mod), "BAD_MEMBERSHIP_PROOF");
    });

    it("after all that, Eve's untouched ballot is still accepted", async () => {
      await accept(eve);
    });
  });

  describe("NEGATIVE: a copied ciphertext + validity proof under another nullifier", () => {
    it("Mallory copies Frank's published ciphertexts and validity proof and attaches her own (valid) Semaphore proof: rejected", async () => {
      const frank = await honest(CHE, 3, 2);
      await accept(frank);
      const mallory = voters[CHE][2];
      const semaphore = await proveMembership({ identity: mallory, group: groups[CHE], message: BigInt(frank.submission.semaphore.message), scope: electionScope(ctx) });
      assert.equal(await verifyMembership(semaphore), true, "Mallory's Semaphore proof is genuine");
      assert.notEqual(semaphore.nullifier, frank.submission.semaphore.nullifier);
      const copy = wire({ constituency: CHE, ciphertexts: frank.submission.ciphertexts, semaphore, validity: frank.submission.validity });
      const before = state();
      rejected(await box.submit(copy), "BAD_VALIDITY_PROOF");
      assert.deepEqual(state(), before);
      // at the proof level: Frank's validity proof verifies for Frank's nullifier only
      assert.equal(await verifyValidity(frank.submission.validity.proof, statementOf(frank)), true);
      assert.equal(await verifyValidity(frank.submission.validity.proof, statementOf(frank, { nullifier: BigInt(semaphore.nullifier) })), false);
    });

    it("...and re-using Frank's own Semaphore proof is just a duplicate of his nullifier", async () => {
      const frank = box.ledger.at(-1);
      assert.equal(frank.constituency, CHE);
      const copyOfNothing = await honest(CHE, 3, 0); // Frank trying to vote again
      rejected(await box.submit(copyOfNothing.submission), "NULLIFIER_USED");
    });

    it("Mallory is not harmed: she can still cast her own honest ballot afterwards", async () => {
      await accept(await honest(CHE, 2, 0));
    });
  });

  describe("NEGATIVE: malformed proofs and submissions never crash the box and never consume a nullifier", () => {
    it("malformed validity proofs, Semaphore proofs and garbage submissions are all rejected", async (t) => {
      const grace = await honest(CHE, 4, 2);
      const mutate = (fn) => {
        const s = wire(grace.submission);
        fn(s);
        return s;
      };
      const bad = {
        "validity proof is {}": mutate((s) => (s.validity.proof = {})),
        "validity proof is a string": mutate((s) => (s.validity = { proof: "proof" })),
        "validity proof missing": mutate((s) => delete s.validity),
        "validity proof is null": mutate((s) => (s.validity.proof = null)),
        "validity pi_a truncated": mutate((s) => (s.validity.proof.pi_a = s.validity.proof.pi_a.slice(0, 1))),
        "validity pi_a not numeric": mutate((s) => (s.validity.proof.pi_a = ["x", "y", "1"])),
        "validity pi_a off the curve": mutate((s) => (s.validity.proof.pi_a[0] = (BigInt(s.validity.proof.pi_a[0]) + 1n).toString())),
        "validity pi_b swapped halves": mutate((s) => (s.validity.proof.pi_b = [s.validity.proof.pi_b[1], s.validity.proof.pi_b[0], s.validity.proof.pi_b[2]])),
        "validity pi_c = pi_a": mutate((s) => (s.validity.proof.pi_c = s.validity.proof.pi_a)),
        "validity wrong protocol": mutate((s) => (s.validity.proof.protocol = "plonk")),
        "validity wrong curve": mutate((s) => (s.validity.proof.curve = "bls12381")),
        "validity extra field": mutate((s) => (s.validity.proof.extra = "1")),
        "validity pi_a z != 1 (projective re-encoding of the same point)": mutate((s) => (s.validity.proof.pi_a[2] = "2")),
        "validity pi_a as hex strings": mutate((s) => (s.validity.proof.pi_a = s.validity.proof.pi_a.map((v) => "0x" + BigInt(v).toString(16)))),
        "validity pi_a with a leading zero": mutate((s) => (s.validity.proof.pi_a[0] = "0" + s.validity.proof.pi_a[0])),
        "validity pi_a coordinate >= base field": mutate((s) => (s.validity.proof.pi_a[0] = (BigInt(s.validity.proof.pi_a[0]) + 21888242871839275222246405745257275088696311157297823662689037894645226208583n).toString())),
        "validity coordinates huge": mutate((s) => (s.validity.proof.pi_c = ["9".repeat(300), "9".repeat(300), "1"])),
        "validity all zeros": mutate((s) => (s.validity.proof = { pi_a: ["0", "0", "1"], pi_b: [["0", "0"], ["0", "0"], ["1", "0"]], pi_c: ["0", "0", "1"], protocol: "groth16", curve: "bn128" })),
        "semaphore points empty": mutate((s) => (s.semaphore.points = [])),
        "semaphore 7 points": mutate((s) => (s.semaphore.points = s.semaphore.points.slice(0, 7))),
        "semaphore points not numeric": mutate((s) => (s.semaphore.points = s.semaphore.points.map(() => "zz"))),
        "semaphore points all zero": mutate((s) => (s.semaphore.points = s.semaphore.points.map(() => "0"))),
        "semaphore one point +1": mutate((s) => (s.semaphore.points[0] = (BigInt(s.semaphore.points[0]) + 1n).toString())),
        "semaphore points reversed": mutate((s) => s.semaphore.points.reverse()),
        "semaphore points missing": mutate((s) => delete s.semaphore.points),
        "semaphore depth wrong": mutate((s) => (s.semaphore.merkleTreeDepth = 5)),
        "semaphore message not a number": mutate((s) => (s.semaphore.message = "hello")),
        "semaphore nullifier negative": mutate((s) => (s.semaphore.nullifier = "-5")),
        "semaphore scope as number": mutate((s) => (s.semaphore.scope = 12345)),
        "ciphertext coordinate hex": mutate((s) => (s.ciphertexts[0].c1[0] = "0x1234")),
        "ciphertext coordinate float": mutate((s) => (s.ciphertexts[0].c1[0] = "1.5")),
        "ciphertext coordinate >= p": mutate((s) => (s.ciphertexts[0].c1[0] = (2n ** 254n).toString())),
        "ciphertext point off the curve": mutate((s) => (s.ciphertexts[1].c2[1] = (BigInt(s.ciphertexts[1].c2[1]) + 1n).toString())),
        "ciphertext c2 missing": mutate((s) => delete s.ciphertexts[2].c2),
        "ciphertexts not an array": mutate((s) => (s.ciphertexts = "abc")),
        "submission with an extra field": mutate((s) => (s.note = "hi")),
        "semaphore with an extra field": mutate((s) => (s.semaphore.extra = 1)),
        "ciphertext with an extra field": mutate((s) => (s.ciphertexts[0].extra = 1)),
        "unknown constituency": mutate((s) => (s.constituency = "XX-NOPE")),
        "constituency is a number": mutate((s) => (s.constituency = 7)),
        "whole submission null": null,
        "whole submission undefined": undefined,
        "whole submission is a string": "submit me",
        "whole submission is a number": 42,
        "whole submission is an array": [],
        "whole submission is {}": {},
      };
      const before = state();
      const reasons = {};
      for (const [name, sub] of Object.entries(bad)) {
        const res = await box.submit(sub);
        assert.equal(res.accepted, false, name);
        reasons[name] = res.reason;
        const allowed = /^validity/.test(name) ? ["MALFORMED", "BAD_VALIDITY_PROOF"]
          : /^semaphore/.test(name) ? ["MALFORMED", "BAD_MEMBERSHIP_PROOF", "NOT_A_MEMBER", "WRONG_DEPTH"]
          : /^ciphertext/.test(name) ? ["MALFORMED", "WRONG_CANDIDATE_COUNT"]
          : ["MALFORMED", "UNKNOWN_CONSTITUENCY"];
        assert.ok(allowed.includes(res.reason), `${name}: rejected, but for an unexpected reason ${res.reason}`);
      }
      t.diagnostic(`rejection reasons: ${JSON.stringify(reasons)}`);
      assert.deepEqual(state(), before, "no state change at all");
      await accept(grace); // the untouched ballot still goes through: nothing above consumed Grace's nullifier
    });
  });

  describe("final state", () => {
    it("every accepted ballot is on the ledger once; per-constituency aggregates decrypt to the expected totals", () => {
      // BLR: Alice A, Bob B, Carol A.  MUM: voter0 D, voter1 A.  DEL: voter0 candidate 16.  CHE: Dave A, Eve B, Frank C, Mallory A, Grace C.
      assert.equal(box.ledger.length, 3 + 2 + 1 + 5);
      assert.equal(new Set(box.ledger.map((l) => l.nullifier)).size, box.ledger.length, "no nullifier twice");
      assert.deepEqual(box.decryptTotals(BLR, secret), [2n, 1n, 0n]);
      assert.deepEqual(box.decryptTotals(MUM, secret), [1n, 0n, 0n, 1n]);
      assert.deepEqual(box.decryptTotals(DEL, secret), [...Array(15).fill(0n), 1n]);
      assert.deepEqual(box.decryptTotals(CHE, secret), [2n, 1n, 2n]);
      const dlog = makeDiscreteLog(64n);
      let totalBallots = 0n;
      for (const c of Object.keys(CONSTITUENCIES)) for (const ct of box.aggregate(c)) totalBallots += dlog(decryptToPoint(secret, ct));
      assert.equal(totalBallots, BigInt(box.ledger.length), "sum of all candidate totals == number of accepted ballots (one vote per ballot, enforced by the validity proofs)");
    });
  });
});
