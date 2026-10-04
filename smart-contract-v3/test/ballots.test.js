// VoteChainV3: anonymous encrypted ballots with REAL Semaphore (depth 20) and Groth16 validity proofs, the audit replay, and the attack suite.
import { expect } from "chai";
import { ballotHash, validityCircuitInput } from "../../privacy-v3/src/ballot.js";
import { add as jsAdd, addCiphertexts, decryptToPoint, generateTestKeyPair, identityCiphertext, makeDiscreteLog, mul as jsMul } from "../../privacy-v3/src/elgamal.js";
import { FIELD_PRIME as P, G, electionScope } from "../../privacy-v3/src/params.js";
import { makeGroup, proveMembership } from "../../privacy-v3/src/semaphore.js";
import { proveValidity } from "../../privacy-v3/src/validity.js";
import { prepareBallot } from "../../privacy-v3/src/voter.js";
import { CLOSE_GRACE, EPOCH, Phase, cid, clone, configure, coordsOf, ctx, describeWithProofs, makeBallot, membershipOf, newWorld, register, submit, validityOf, votersOf } from "./helpers/world.js";

const BLR = "KA-BLR"; // 3 candidates, 5 registered voters
const MUM = "MH-MUM"; // 4 candidates, 5 registered voters
const CHE = "TN-CHE"; // 3 candidates, 5 registered voters
const EMPTY = "C02"; // 2 candidates, NO registered voter

/** the promise rejects with a message matching `pattern` (the proof generator refusing an invalid witness) */
async function rejectsWith(promise, pattern, label) {
  let error;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error, `${label}: the prover must refuse`).to.not.equal(undefined);
  expect(String(error.message ?? error)).to.match(pattern);
}

describeWithProofs("VoteChainV3: ballots", () => {
  let w;
  let key;
  let wrongKey;
  let blr;
  let mum;
  let che;
  const prepared = {}; // valid ballots that are NOT submitted yet: the attack tests tamper with them (a refused ballot burns nothing)
  const submitted = {};

  /** every number a rejected ballot must leave alone */
  const stateOf = async () => {
    const out = { total: await w.vc.totalBallots(), constituencies: {} };
    for (const code of [BLR, MUM, CHE]) {
      const c = await w.vc.getConstituency(cid(code));
      const slots = [];
      for (let j = 0; j < Number(c.candidateCount); j++) slots.push((await w.vc.aggregateOf(cid(code), j)).toString());
      out.constituencies[code] = { ballots: c.ballots, slots };
    }
    return out;
  };
  /** the submission is refused with VoteChainV3's custom error `error`, and no counter and no aggregate moved */
  const refusedKeepingState = async (args, error, ...errorArgs) => {
    const before = await stateOf();
    const assertion = expect(submit(w, args)).to.be.revertedWithCustomError(w.vc, error);
    await (errorArgs.length ? assertion.withArgs(...errorArgs) : assertion);
    expect(await stateOf(), "a refused ballot changes no state").to.deep.equal(before);
  };
  /** ... and in addition the nullifier is still unspent: a failed attempt costs the voter nothing */
  const refused = async (args, error, ...errorArgs) => {
    await refusedKeepingState(args, error, ...errorArgs);
    expect(await w.vc.nullifierUsed(args.membership.nullifier), "a refused ballot burns no nullifier").to.equal(false);
  };
  /** the official Semaphore contract refuses (its own custom error bubbles up through VoteChainV3) and nothing changed */
  const refusedBySemaphore = async (args, error) => {
    const before = await stateOf();
    await expect(submit(w, args)).to.be.revertedWithCustomError(w.semaphore, error);
    expect(await stateOf(), "a refused ballot changes no state").to.deep.equal(before);
    expect(await w.vc.nullifierUsed(args.membership.nullifier)).to.equal(false);
  };
  const ballot = (code, v, index, choice, extra = {}) => makeBallot(w, { code, voters: v.voters, group: v.group, index, choice, H: key.H, ...extra });
  /** a GENUINE Semaphore proof (right group, right scope unless told otherwise) by `identity` over `message` */
  const semaphoreProof = (identity, v, message, scope = electionScope(ctx)) => proveMembership({ identity, group: v.group, message, scope });

  before(async () => {
    w = await newWorld();
    key = await configure(w, { only: [BLR, MUM, CHE, EMPTY] });
    wrongKey = generateTestKeyPair();
    await w.vc.openElection();
    blr = votersOf(BLR);
    mum = votersOf(MUM);
    che = votersOf(CHE);
    for (const [code, v] of [[BLR, blr], [MUM, mum], [CHE, che]]) await register(w, code, v.voters);
    for (const [code, v] of [[BLR, blr], [MUM, mum], [CHE, che]]) {
      const groupId = (await w.vc.getConstituency(cid(code))).groupId;
      expect(await w.semaphore.getMerkleTreeRoot(groupId), `${code}: on-chain root == JS group root`).to.equal(BigInt(v.group.root));
    }
    prepared.dave = await ballot(BLR, blr, 3, 0);
    prepared.eve = await ballot(BLR, blr, 4, 1);
    prepared.frank = await ballot(CHE, che, 0, 2);
  });

  describe("one ballot, end to end", () => {
    let receipt;

    it("Alice (member 1 of 5, Bengaluru) votes; an UNRELATED account submits it: the relayer has no special authority", async () => {
      submitted.alice = await ballot(BLR, blr, 0, 0);
      const { args } = submitted.alice;
      expect(args.membership.merkleTreeDepth).to.equal(20n);
      expect(args.coords, "only the 3 ACTIVE slots travel: 12 coordinates").to.have.length(12);
      receipt = await (await submit(w, args, w.stranger)).wait();
      expect(receipt.from).to.equal(w.stranger.address);
      expect(await w.vc.totalBallots()).to.equal(1n);
      expect((await w.vc.getConstituency(cid(BLR))).ballots).to.equal(1n);
      expect(await w.vc.nullifierUsed(args.membership.nullifier)).to.equal(true);
    });

    it("BallotRecorded carries the constituency, nullifier, index, the keccak ballot hash and the encrypted active slots, and nothing about the voter", async () => {
      const { args, internals } = submitted.alice;
      const events = await w.vc.queryFilter(w.vc.filters.BallotRecorded());
      expect(events).to.have.length(1);
      const ev = events[0];
      expect(ev.fragment.inputs.map((i) => i.name)).to.deep.equal(["constituencyId", "nullifier", "ballotIndex", "ballotHash", "coords"]);
      expect(ev.args.constituencyId).to.equal(cid(BLR));
      expect(ev.args.nullifier).to.equal(args.membership.nullifier);
      expect(ev.args.ballotIndex).to.equal(1n);
      expect(ev.args.ballotHash, "== the ballot hash the voter signed").to.equal(internals.hash);
      expect(ev.args.ballotHash, "== the frozen JS keccak hash recomputed from the public data").to.equal(ballotHash(ctx, BigInt(cid(BLR)), internals.ciphertexts));
      expect(ev.args.ballotHash, "== what the contract computes for those coordinates").to.equal(await w.vc.ballotHashOf(cid(BLR), args.coords));
      expect([...ev.args.coords]).to.deep.equal(args.coords);
      const everything = JSON.stringify(receipt.logs.map((l) => [l.topics, l.data])).toLowerCase();
      for (const v of blr.voters) expect(everything, "no identity commitment in any log").to.not.include(v.commitment.toString(16).padStart(64, "0"));
      for (const r of internals.r.slice(0, 3)) expect(everything, "no encryption randomness in any log").to.not.include(r.toString(16).padStart(64, "0"));
    });

    it("the aggregate after ONE ballot is exactly that ballot's ciphertexts (identity + ciphertext = ciphertext)", async () => {
      const { args } = submitted.alice;
      for (let j = 0; j < 3; j++) {
        const a = await w.vc.aggregateOf(cid(BLR), j);
        expect([a.ax, a.ay, a.bx, a.by]).to.deep.equal(args.coords.slice(4 * j, 4 * j + 4));
      }
    });
  });

  describe("an election: A, B, A in Bengaluru and one vote in Mumbai", () => {
    before(async () => {
      await submit(w, (await ballot(BLR, blr, 1, 1)).args, w.relayer); // Bob: B
      await submit(w, (await ballot(BLR, blr, 2, 0)).args, w.attacker); // Carol: A, submitted by yet another account
      await submit(w, (await ballot(MUM, mum, 0, 3)).args, w.relayer); // Mumbai: candidate 3 of 4
    });

    it("counts: 3 ballots in Bengaluru, 1 in Mumbai, none in Chennai, 4 in total", async () => {
      expect((await w.vc.getConstituency(cid(BLR))).ballots).to.equal(3n);
      expect((await w.vc.getConstituency(cid(MUM))).ballots).to.equal(1n);
      expect((await w.vc.getConstituency(cid(CHE))).ballots).to.equal(0n);
      expect(await w.vc.totalBallots()).to.equal(4n);
    });

    it("AUDIT: replaying the emitted encrypted ballots off-chain reproduces the contract's encrypted aggregate, slot by slot", async () => {
      const events = await w.vc.queryFilter(w.vc.filters.BallotRecorded());
      expect(events, "event count == ballot count").to.have.length(Number(await w.vc.totalBallots()));
      expect(events.map((e) => Number(e.args.ballotIndex)), "indices run 1..n").to.deep.equal([1, 2, 3, 4]);
      const replay = {};
      for (const code of [BLR, MUM, CHE]) {
        const kc = Number((await w.vc.getConstituency(cid(code))).candidateCount);
        replay[code] = { kc, sums: Array.from({ length: kc }, identityCiphertext), count: 0 };
      }
      for (const ev of events) {
        const code = [BLR, MUM, CHE].find((c) => cid(c) === ev.args.constituencyId);
        const r = replay[code];
        const coords = [...ev.args.coords];
        expect(coords).to.have.length(r.kc * 4);
        expect(ev.args.ballotHash, "the logged hash is the hash of the logged coordinates").to.equal(await w.vc.ballotHashOf(ev.args.constituencyId, coords));
        for (let j = 0; j < r.kc; j++) r.sums[j] = addCiphertexts(r.sums[j], { c1: [coords[4 * j], coords[4 * j + 1]], c2: [coords[4 * j + 2], coords[4 * j + 3]] });
        r.count++;
      }
      let sumOfCounts = 0n;
      for (const code of [BLR, MUM, CHE]) {
        const { kc, sums, count } = replay[code];
        const c = await w.vc.getConstituency(cid(code));
        expect(c.ballots, `${code}: logged ballots == recorded ballots`).to.equal(BigInt(count));
        sumOfCounts += c.ballots;
        for (let j = 0; j < kc; j++) {
          const a = await w.vc.aggregateOf(cid(code), j);
          expect([a.ax, a.ay], `${code} slot ${j}: A = sum of the logged C1`).to.deep.equal(sums[j].c1);
          expect([a.bx, a.by], `${code} slot ${j}: B = sum of the logged C2`).to.deep.equal(sums[j].c2);
        }
      }
      expect(sumOfCounts, "the constituency ballot counts add up to totalBallots").to.equal(await w.vc.totalBallots());
    });

    it("events can be fetched per constituency (indexed), and a constituency without ballots has none", async () => {
      expect(await w.vc.queryFilter(w.vc.filters.BallotRecorded(cid(BLR)))).to.have.length(3);
      expect(await w.vc.queryFilter(w.vc.filters.BallotRecorded(cid(MUM)))).to.have.length(1);
      expect(await w.vc.queryFilter(w.vc.filters.BallotRecorded(cid(CHE)))).to.have.length(0);
    });

    it("the aggregate decrypts (TEST key, test only: the contract never decrypts) to A=2, B=1, C=0 and to the single Mumbai vote", async () => {
      const dlog = makeDiscreteLog(64n);
      const totals = async (code, kc) => {
        const out = [];
        for (let j = 0; j < kc; j++) {
          const a = await w.vc.aggregateOf(cid(code), j);
          out.push(dlog(decryptToPoint(key.secret, { c1: [a.ax, a.ay], c2: [a.bx, a.by] })));
        }
        return out;
      };
      expect(await totals(BLR, 3)).to.deep.equal([2n, 1n, 0n]);
      expect(await totals(MUM, 4)).to.deep.equal([0n, 0n, 0n, 1n]);
      expect(await totals(CHE, 3), "an untouched constituency still holds the identity aggregate").to.deep.equal([0n, 0n, 0n]);
    });
  });

  describe("NEGATIVE: shape, nullifier and field checks (before any proof is looked at)", () => {
    it("unknown constituency", async () => {
      const a = clone(prepared.dave.args);
      a.constituencyId = cid("XX-NONE");
      await refused(a, "UnknownConstituency", cid("XX-NONE"));
    });

    it("wrong coordinate count: too few, too many, empty, and a ballot made for another constituency's candidate count", async () => {
      for (const coords of [prepared.dave.args.coords.slice(0, 8), [...prepared.dave.args.coords, 0n, 1n, 0n, 1n], prepared.dave.args.coords.slice(0, 11), []]) {
        const a = clone(prepared.dave.args);
        a.coords = coords;
        await refused(a, "WrongCoordinateCount", 12n, BigInt(coords.length));
      }
      const toMumbai = clone(prepared.dave.args); // a kc = 3 ballot sent to the kc = 4 constituency
      toMumbai.constituencyId = cid(MUM);
      await refused(toMumbai, "WrongCoordinateCount", 16n, 12n);
    });

    it("a Semaphore proof must declare depth 20", async () => {
      for (const depth of [0n, 1n, 19n, 21n, 32n]) {
        const a = clone(prepared.dave.args);
        a.membership.merkleTreeDepth = depth;
        await refused(a, "WrongSemaphoreDepth", depth);
      }
    });

    it("a nullifier that is not a field element is refused (it would be a second spelling of a spent one)", async () => {
      const a = clone(prepared.dave.args);
      a.membership.nullifier = prepared.dave.args.membership.nullifier + P;
      await refused(a, "NullifierOutOfField");
    });

    it("a coordinate that is not a field element is refused", async () => {
      for (const i of [0, 5, 11]) {
        const a = clone(prepared.dave.args);
        a.coords[i] += P;
        await refused(a, "CoordinateOutOfField", BigInt(i));
      }
    });

    it("an ACTIVE C1 equal to the identity is refused (it would put the plaintext in the clear)", async () => {
      const a = clone(prepared.dave.args);
      a.coords[4] = 0n;
      a.coords[5] = 1n; // slot 1: C1 = (0, 1)
      await refused(a, "IdentityC1", 1n);
    });

    it("a REUSED NULLIFIER is refused: Alice's identical ballot again, and a brand-new ballot by Alice with fresh randomness and fresh proofs", async () => {
      const { args } = submitted.alice;
      const before = await stateOf();
      await expect(submit(w, args)).to.be.revertedWithCustomError(w.vc, "NullifierAlreadyUsed").withArgs(args.membership.nullifier);
      const again = await ballot(BLR, blr, 0, 2); // Alice again, now for candidate C
      expect(again.args.membership.nullifier, "the nullifier is a function of identity and scope only").to.equal(args.membership.nullifier);
      expect(again.args.coords).to.not.deep.equal(args.coords);
      await expect(submit(w, again.args)).to.be.revertedWithCustomError(w.vc, "NullifierAlreadyUsed").withArgs(args.membership.nullifier);
      expect(await stateOf()).to.deep.equal(before);
    });

    it("the CHECKS RUN IN THE SPECIFIED ORDER: with two defects combined, the EARLIER check is the one that fires (and nothing changes)", async () => {
      const spent = submitted.alice.args.membership.nullifier; // Alice's nullifier is spent
      const dave = () => clone(prepared.dave.args);
      const cases = [
        ["2 constituency exists, before 3 shape", (a) => ((a.constituencyId = cid("XX-NONE")), (a.coords = a.coords.slice(0, 8))), "UnknownConstituency", [cid("XX-NONE")]],
        ["3 shape (count), before 4 nullifier unused", (a) => ((a.coords = a.coords.slice(0, 8)), (a.membership.nullifier = spent)), "WrongCoordinateCount", [12n, 8n]],
        ["3 shape (depth), before 4 nullifier unused", (a) => ((a.membership.merkleTreeDepth = 19n), (a.membership.nullifier = spent)), "WrongSemaphoreDepth", [19n]],
        ["4 nullifier unused, before 5 coordinate range", (a) => ((a.membership.nullifier = spent), (a.coords[0] += P)), "NullifierAlreadyUsed", [spent]],
        ["5 coordinate range, before 6 identity C1", (a) => ((a.coords[4] = 0n), (a.coords[5] = 1n), (a.coords[9] += P)), "CoordinateOutOfField", [9n]],
        ["6 identity C1, before 9 Semaphore proof", (a) => ((a.coords[4] = 0n), (a.coords[5] = 1n), a.membership.points.fill(0n)), "IdentityC1", [1n]],
        ["9 Semaphore proof, before 10 validity proof", (a) => ((a.membership.points[0] += 1n), (a.validity.a[0] += 1n)), "InvalidMembershipProof", []],
      ];
      for (const [name, defect, error, errorArgs] of cases) {
        const a = dave();
        defect(a);
        await refusedKeepingState(a, error, ...errorArgs).catch((e) => {
          throw new Error(`${name}: ${e.message}`);
        });
      }
      expect(await w.vc.nullifierUsed(prepared.dave.args.membership.nullifier)).to.equal(false);
    });

    it("a constituency whose Semaphore group has no member yet: Semaphore itself refuses (the ballot cannot be in any group)", async () => {
      const a = clone(prepared.dave.args);
      a.constituencyId = cid(EMPTY);
      a.coords = a.coords.slice(0, 8); // kc = 2 constituency
      await refusedBySemaphore(a, "Semaphore__GroupHasNoMembers");
    });
  });

  describe("NEGATIVE: the Semaphore membership proof", () => {
    it("a malformed Semaphore proof is refused: modified, zero, reversed, swapped and out-of-range points", async () => {
      const variants = {
        "first point + 1": (m) => (m.points[0] += 1n),
        "last point + 1": (m) => (m.points[7] += 1n),
        "all zero": (m) => m.points.fill(0n),
        "reversed": (m) => m.points.reverse(),
        "B halves swapped": (m) => ([m.points[2], m.points[3]] = [m.points[3], m.points[2]]),
        "a point above 2^255": (m) => (m.points[1] = 1n << 255n),
      };
      for (const [name, tamper] of Object.entries(variants)) {
        const a = clone(prepared.dave.args);
        tamper(a.membership);
        await refused(a, "InvalidMembershipProof").catch((e) => {
          throw new Error(`${name}: ${e.message}`);
        });
      }
    });

    it("a changed nullifier breaks the Semaphore proof", async () => {
      const a = clone(prepared.dave.args);
      a.membership.nullifier += 1n;
      await refused(a, "InvalidMembershipProof");
    });

    it("an unknown group root is refused by Semaphore itself", async () => {
      const a = clone(prepared.dave.args);
      a.membership.merkleTreeRoot += 1n;
      await refusedBySemaphore(a, "Semaphore__MerkleTreeRootIsNotPartOfTheGroup");
    });

    it("the WRONG CONSTITUENCY GROUP: a Bengaluru voter's proof submitted for Chennai (same candidate count), and a Chennai voter's for Bengaluru, are refused", async () => {
      const toChennai = clone(prepared.dave.args);
      toChennai.constituencyId = cid(CHE);
      await refusedBySemaphore(toChennai, "Semaphore__MerkleTreeRootIsNotPartOfTheGroup");
      const toBengaluru = clone(prepared.frank.args);
      toBengaluru.constituencyId = cid(BLR);
      await refusedBySemaphore(toBengaluru, "Semaphore__MerkleTreeRootIsNotPartOfTheGroup");
    });

    it("the WRONG SCOPE: a proof generated for another election's scope (other chain, other contract, other election id, zero) is refused", async () => {
      const d = prepared.dave;
      const scopes = [electionScope({ ...ctx, chainId: 1n }), electionScope({ ...ctx, contractAddress: ctx.contractAddress + 1n }), electionScope({ ...ctx, electionId: ctx.electionId ^ 1n }), 0n, 12345n];
      for (const scope of scopes) {
        const a = clone(d.args);
        a.membership = membershipOf(await semaphoreProof(blr.voters[3], blr, d.internals.hash, scope));
        expect(a.membership.nullifier, "another scope gives another nullifier").to.not.equal(d.args.membership.nullifier);
        await refused(a, "InvalidMembershipProof");
      }
    });

    it("the WRONG BALLOT HASH / message: a proof over another message (another ballot, other chain, other contract, other constituency, zero) is refused", async () => {
      const d = prepared.dave;
      const messages = [
        ballotHash(ctx, BigInt(cid(BLR)), prepared.eve.internals.ciphertexts), // another ballot's hash
        ballotHash({ ...ctx, chainId: 1n }, BigInt(cid(BLR)), d.internals.ciphertexts),
        ballotHash({ ...ctx, contractAddress: ctx.contractAddress + 1n }, BigInt(cid(BLR)), d.internals.ciphertexts),
        ballotHash(ctx, BigInt(cid(CHE)), d.internals.ciphertexts), // the same ciphertexts, hashed for another constituency
        0n,
      ];
      for (const message of messages) {
        const a = clone(d.args);
        a.membership = membershipOf(await semaphoreProof(blr.voters[3], blr, message));
        expect(a.membership.nullifier, "same identity and scope: same nullifier").to.equal(d.args.membership.nullifier);
        await refused(a, "InvalidMembershipProof");
      }
    });

    it("a MODIFIED CIPHERTEXT: changing any active coordinate changes the ballot hash, so the original Semaphore proof no longer matches", async () => {
      for (const i of [0, 1, 2, 3, 6, 11]) {
        const a = clone(prepared.dave.args);
        a.coords[i] = (a.coords[i] + 1n) % P;
        await refused(a, "InvalidMembershipProof");
      }
      const swapped = clone(prepared.dave.args); // swapping two slots is a modification too (and would move votes between candidates)
      for (let k = 0; k < 4; k++) [swapped.coords[k], swapped.coords[4 + k]] = [swapped.coords[4 + k], swapped.coords[k]];
      await refused(swapped, "InvalidMembershipProof");
    });
  });

  describe("NEGATIVE: the Groth16 validity proof", () => {
    it("a malformed validity proof is refused: modified A, B or C, zero proof, B in the other order", async () => {
      const variants = {
        "A + 1": (v) => (v.a[0] += 1n),
        "B + 1": (v) => (v.b[1][1] += 1n),
        "C + 1": (v) => (v.c[1] += 1n),
        "all zero": (v) => {
          v.a.fill(0n);
          v.b.forEach((row) => row.fill(0n));
          v.c.fill(0n);
        },
        "B in snarkjs order": (v) => (v.b = [[v.b[0][1], v.b[0][0]], [v.b[1][1], v.b[1][0]]]),
      };
      for (const [name, tamper] of Object.entries(variants)) {
        const a = clone(prepared.dave.args);
        tamper(a.validity);
        await refused(a, "InvalidValidityProof").catch((e) => {
          throw new Error(`${name}: ${e.message}`);
        });
      }
    });

    it("a MODIFIED CIPHERTEXT whose Semaphore proof is re-made over the new ciphertext (same voter, same nullifier): the validity proof catches it", async () => {
      const d = prepared.dave;
      const modifications = {
        "C2 + G (a valid subgroup point: shifts the plaintext by one)": (c) => ([c[2], c[3]] = jsAdd([c[2], c[3]], G)),
        "C1 doubled (another valid subgroup point)": (c) => ([c[0], c[1]] = jsMul([c[0], c[1]], 2n)),
        "C2.x + 1 (not even on the curve)": (c) => (c[2] += 1n),
      };
      for (const [name, modify] of Object.entries(modifications)) {
        const a = clone(d.args);
        modify(a.coords);
        const hash = await w.vc.ballotHashOf(cid(BLR), a.coords);
        a.membership = membershipOf(await semaphoreProof(blr.voters[3], blr, hash));
        expect(a.membership.nullifier).to.equal(d.args.membership.nullifier);
        await refused(a, "InvalidValidityProof").catch((e) => {
          throw new Error(`${name}: ${e.message}`);
        });
      }
    });

    it("a COPIED validity proof and ciphertext under ANOTHER nullifier: Dave (a member with an unspent nullifier) cannot reuse Eve's ballot", async () => {
      const eve = prepared.eve;
      const a = clone(eve.args);
      a.membership = membershipOf(await semaphoreProof(blr.voters[3], blr, eve.internals.hash)); // a GENUINE Semaphore proof by Dave over Eve's ballot hash
      expect(a.membership.nullifier).to.not.equal(eve.args.membership.nullifier);
      expect(await w.vc.nullifierUsed(a.membership.nullifier)).to.equal(false);
      await refused(a, "InvalidValidityProof"); // Eve's Groth16 proof is bound to Eve's nullifier
    });

    it("the WRONG ENCRYPTION PUBLIC KEY: a ballot encrypted and proven under another key is refused", async () => {
      const bad = await makeBallot(w, { code: BLR, voters: blr.voters, group: blr.group, index: 3, choice: 1, H: wrongKey.publicKey });
      await refused(bad.args, "InvalidValidityProof");
    });

    it("the WRONG K_c: a ballot made for another candidate count is refused, whichever way it is dressed up", async () => {
      // (a) a kc = 2 ballot for the kc = 3 constituency: the wrong number of slots
      const kc2 = await ballot(BLR, blr, 3, 0, { kc: 2 });
      expect(kc2.args.coords).to.have.length(8);
      await refused(kc2.args, "WrongCoordinateCount", 12n, 8n);
      // (b) padded up to 12 coordinates with an identity slot: the identity C1 is refused before any proof is checked
      const dressed = clone(kc2.args);
      dressed.coords = [...dressed.coords, 0n, 1n, 0n, 1n];
      await refused(dressed, "IdentityC1", 2n);
      // (c) a kc = 3 ballot for the kc = 4 constituency
      const kc3ForMumbai = await ballot(MUM, mum, 1, 1, { kc: 3 });
      expect(kc3ForMumbai.args.coords).to.have.length(12);
      await refused(kc3ForMumbai.args, "WrongCoordinateCount", 16n, 12n);
    });

    it("a VOTE IN A PADDED SLOT: a kc = 3 validity proof cannot carry a real vote in slot 3 of the kc = 4 constituency", async () => {
      const voter = mum.voters[2];
      const honest3 = await ballot(MUM, mum, 2, 1, { kc: 3 }); // slot 3 is padding for ITS proof
      const forged = prepareBallot({ identity: voter, ctx, constituency: MUM, kc: 4, choice: 3, H: key.H }); // the vote sits in slot 3
      const a = {
        constituencyId: cid(MUM),
        membership: membershipOf(await semaphoreProof(voter, mum, forged.hash)), // a genuine membership proof for the forged ballot
        coords: coordsOf(forged.ciphertexts, 4),
        validity: honest3.args.validity,
      };
      expect(a.coords).to.have.length(16);
      expect(a.membership.nullifier).to.equal(honest3.args.membership.nullifier);
      await refused(a, "InvalidValidityProof");
    });

    it("INVALID ONE-HOT votes cannot be proven: two-hot, zero-hot and value 5. Even with a genuine Semaphore proof and the Groth16 proof of ANOTHER ballot they are refused", async () => {
      const voter = blr.voters[4]; // Eve's identity: her nullifier is still unspent
      const cases = { "two-hot": [1n, 1n, 0n], "zero-hot": [0n, 0n, 0n], "value 5": [5n, 0n, 0n] };
      for (const [name, head] of Object.entries(cases)) {
        const forced = prepareBallot({ identity: voter, ctx, constituency: BLR, kc: 3, choice: 0, H: key.H, m: [...head, ...Array(13).fill(0n)] });
        await rejectsWith(proveValidity(validityCircuitInput({ kc: 3, H: key.H, nullifier: forced.nullifier, ciphertexts: forced.ciphertexts, m: forced.m, r: forced.r })), /Assert Failed/, name);
        const a = {
          constituencyId: cid(BLR),
          membership: membershipOf(await semaphoreProof(voter, blr, forced.hash)),
          coords: coordsOf(forced.ciphertexts, 3),
          validity: validityOf(prepared.eve.submission.validity.proof),
        };
        await refused(a, "InvalidValidityProof").catch((e) => {
          throw new Error(`${name}: ${e.message}`);
        });
      }
    });
  });

  describe("failed attempts burn nothing", () => {
    it("after all the attacks above, Dave's, Eve's and Frank's genuine ballots are still accepted", async () => {
      await expect(submit(w, prepared.dave.args)).to.emit(w.vc, "BallotRecorded");
      await expect(submit(w, prepared.eve.args)).to.emit(w.vc, "BallotRecorded");
      await expect(submit(w, prepared.frank.args)).to.emit(w.vc, "BallotRecorded");
      expect(await w.vc.totalBallots()).to.equal(7n);
    });

    it("the audit still reproduces every aggregate after those later ballots (replay of all 7 events)", async () => {
      const events = await w.vc.queryFilter(w.vc.filters.BallotRecorded());
      expect(events).to.have.length(7);
      const sums = {};
      for (const ev of events) {
        const code = [BLR, MUM, CHE].find((c) => cid(c) === ev.args.constituencyId);
        const coords = [...ev.args.coords];
        sums[code] ??= Array.from({ length: coords.length / 4 }, identityCiphertext);
        for (let j = 0; j < coords.length / 4; j++) sums[code][j] = addCiphertexts(sums[code][j], { c1: [coords[4 * j], coords[4 * j + 1]], c2: [coords[4 * j + 2], coords[4 * j + 3]] });
      }
      let total = 0n;
      for (const code of [BLR, MUM, CHE]) {
        total += (await w.vc.getConstituency(cid(code))).ballots;
        for (let j = 0; j < sums[code].length; j++) {
          const a = await w.vc.aggregateOf(cid(code), j);
          expect([a.ax, a.ay, a.bx, a.by]).to.deep.equal([...sums[code][j].c1, ...sums[code][j].c2]);
        }
      }
      expect(total).to.equal(7n);
    });

    it("the final tally decrypts to Bengaluru A=3 (Alice, Carol, Dave), B=2 (Bob, Eve), C=0, and Chennai C=1 (Frank)", async () => {
      const dlog = makeDiscreteLog(64n);
      const totals = async (code, kc) => {
        const out = [];
        for (let j = 0; j < kc; j++) {
          const a = await w.vc.aggregateOf(cid(code), j);
          out.push(dlog(decryptToPoint(key.secret, { c1: [a.ax, a.ay], c2: [a.bx, a.by] })));
        }
        return out;
      };
      expect(await totals(BLR, 3)).to.deep.equal([3n, 2n, 0n]);
      expect(await totals(CHE, 3)).to.deep.equal([0n, 0n, 1n]);
    });
  });

  describe("closing", () => {
    it("ballots are still accepted during the grace period; after Close a perfectly valid ballot is refused and the recorded votes stay exactly as they were", async () => {
      const late = await ballot(MUM, mum, 1, 0);
      const stuck = await ballot(MUM, mum, 3, 2);
      await w.vc.closeIssuance();
      await expect(submit(w, late.args), "ballots are still allowed during the grace period").to.emit(w.vc, "BallotRecorded");
      await w.networkHelpers.time.increase(CLOSE_GRACE + 1);
      await w.vc.closeElection();
      expect(await w.vc.phase()).to.equal(Phase.Closed);
      const before = await stateOf();
      await expect(submit(w, stuck.args)).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(Phase.Closed);
      expect(await stateOf()).to.deep.equal(before);
      expect(await w.vc.nullifierUsed(stuck.args.membership.nullifier)).to.equal(false);
    });
  });
});

describeWithProofs("VoteChainV3: Semaphore root window", () => {
  it("a proof made against a superseded group root is accepted within the 1 hour window and refused after it; the current root never expires", async () => {
    const w = await newWorld();
    const key = await configure(w, { only: [EMPTY] });
    await w.vc.openElection();
    const { voters } = votersOf(EMPTY);
    const groupOf = (n) => makeGroup(voters.slice(0, n));
    const groupId = (await w.vc.getConstituency(cid(EMPTY))).groupId;
    const cast = (n, index, choice) => makeBallot(w, { code: EMPTY, voters, group: groupOf(n), index, choice, H: key.H });

    await register(w, EMPTY, voters.slice(0, 4));
    expect(await w.semaphore.getMerkleTreeRoot(groupId)).to.equal(BigInt(groupOf(4).root));
    const old1 = await cast(4, 0, 0);
    const old2 = await cast(4, 1, 1);
    expect(old1.args.membership.merkleTreeRoot).to.equal(BigInt(groupOf(4).root));

    await w.networkHelpers.time.increase(EPOCH);
    await register(w, EMPTY, [voters[4]]); // the group grows: the 4-member root is now superseded
    expect(await w.semaphore.getMerkleTreeRoot(groupId)).to.equal(BigInt(groupOf(5).root));

    await expect(submit(w, old1.args), "a superseded root, inside the window").to.emit(w.vc, "BallotRecorded");
    await w.networkHelpers.time.increase(3600);
    await expect(submit(w, old2.args), "the same superseded root, after the window").to.be.revertedWithCustomError(w.semaphore, "Semaphore__MerkleTreeRootIsExpired");
    expect(await w.vc.nullifierUsed(old2.args.membership.nullifier), "an expired-root attempt burns nothing").to.equal(false);

    const fresh = await cast(5, 1, 0); // the same voter, proving against the CURRENT root
    await expect(submit(w, fresh.args)).to.emit(w.vc, "BallotRecorded");
    expect(await w.vc.totalBallots()).to.equal(2n);
  });
});
