// END TO END, on a real Hardhat chain with REAL Semaphore + Groth16 ballots and a REAL dealer-less key ceremony (trustee-v3):
//   Setup -> trustee transcript pinned -> Open -> ballots -> Closed -> aggregate rebuilt from the BallotRecorded log and compared with the contract ->
//   partial decryptions anchored on-chain -> Chaum-Pedersen proofs verified OFF-chain -> 2-of-3 combination -> BSGS -> two matching endorsements -> final results.
// Every trustee pair is exercised: 1+3 (Bengaluru, [7,4,2]), 2+3 (Mumbai, after a dissenting endorsement), 1+2 (Chennai, a single ballot).
import { expect } from "chai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KDF_TESTING_ONLY, writeShareFile } from "../../trustee-v3/src/storage.ts";
import { SUBGROUP_ORDER, auditConstituency, bundleFromPartial, bundleHash, resultsHash, padTotals, verifyChainAggregate } from "../../trustee-v3/src/index.ts";
import * as chain from "../../trustee-v3/chain/index.ts";
import { runCeremony } from "../../trustee-v3/testing/ceremony.ts";
import { assertNoLeak, captureRandomness, captureRandomnessAsync, logOf, scalarsOf } from "../../trustee-v3/testing/spy.ts";
import { PROJECT, Phase, CLOSE_GRACE, cid, configure, ctx, describeWithProofs, makeBallot, newWorld, register, submit, trusteeConfigFromCeremony, votersOf } from "./helpers/world.js";

const BLR = "KA-BLR"; // 3 candidates, 13 ballots: [7, 4, 2]            trustees 1 + 3
const MUM = "MH-MUM"; // 4 candidates, 3 ballots: [0, 1, 0, 2]           trustees 2 + 3, after a dissenting endorsement by trustee 1
const CHE = "TN-CHE"; // 3 candidates, exactly ONE ballot: [0, 1, 0]     trustees 1 + 2, plus a hostile publication by trustee 3
const C02 = "C02"; //   2 candidates, one ballot (gas, K_c = 2)
const C08 = "C08"; //   8 candidates, one ballot (gas, K_c = 8; and the accepted two-malicious-trustees limitation)
const C16 = "C16"; //  16 candidates, one ballot (gas, K_c = 16 = K_MAX)
const EMPTY = "BATCH"; // 2 candidates, no ballot at all
const PLAN = {
  [BLR]: [...Array(7).fill(0), ...Array(4).fill(1), ...Array(2).fill(2)],
  [MUM]: [3, 3, 1],
  [CHE]: [1],
  [C02]: [1],
  [C08]: [5],
  [C16]: [11],
};
const KC = { [BLR]: 3, [MUM]: 4, [CHE]: 3, [C02]: 2, [C08]: 8, [C16]: 16, [EMPTY]: 2 };
const truth = (code) => {
  const totals = Array(KC[code]).fill(0);
  for (const choice of PLAN[code] ?? []) totals[choice]++;
  return totals;
};
const pad16 = (totals) => [...totals.map(BigInt), ...Array(16 - totals.length).fill(0n)];
const gas = { publish: {}, endorseFirst: {}, endorseSecond: {} };

describeWithProofs("VoteChainV3 + trustee-v3: threshold tallying end to end", function () {
  let w;
  let run;
  let transcript;
  let key;
  let dkgScalars;
  const drawn = []; // every random draw behind a published partial decryption (the proofs' nonces), recorded for the privacy scan at the end
  const recorded = async (fn) => {
    const captured = await captureRandomnessAsync(fn);
    drawn.push(...captured.draws);
    return captured.result;
  };
  const trusteeContract = (i) => w.vc.connect(w.trustees[i - 1]);
  const publish = (code, i) => recorded(() => chain.publishPartialDecryption({ contract: trusteeContract(i), trustee: run.trustees[i - 1], transcript, constituencyId: cid(code) }));
  const endorse = (code, i) => chain.endorseAuditedResult({ contract: trusteeContract(i), trusteeIndex: i, transcript, constituencyId: cid(code) });
  const audit = (code) => chain.auditFromChain({ contract: w.vc, transcript, constituencyId: cid(code) });
  /** run `body`, expecting a failure with this code from the toolkit */
  const rejectsWith = async (promise, code) => {
    let error;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    expect(error, `expected ${code}`).to.not.equal(undefined);
    expect(error.code ?? String(error), String(error.message)).to.equal(code);
  };
  const rejectsAnyhow = async (promise) => {
    let failed = false;
    try {
      await promise;
    } catch {
      failed = true;
    }
    expect(failed, "the call must fail").to.equal(true);
  };
  /** the 64-word bundle trustee i WOULD publish for a constituency (nothing is sent) */
  const honestBundle = async (code, i) => {
    const pinned = await chain.readPinnedConfiguration(w.vc);
    const verified = verifyChainAggregate({ context: pinned.context, state: await chain.readConstituencyState(w.vc, cid(code)), log: await chain.readBallotLog(w.vc) });
    const partial = await recorded(async () => run.trustees[i - 1].partialDecryptVerified(verified));
    return bundleFromPartial(partial, KC[code]);
  };

  before(async () => {
    const captured = captureRandomness(() => runCeremony()); // the omniscient observer of the ceremony: test only
    run = captured.result;
    dkgScalars = scalarsOf(captured.draws);
    transcript = run.transcript;

    w = await newWorld();
    key = await configure(w, { only: [BLR, MUM, CHE, C02, C08, C16, EMPTY], electionKey: run.verified.electionPublicKey, trusteeConfig: false });
    const cfg = trusteeConfigFromCeremony(w, run);
    gas.configureTrustees = Number((await (await w.vc.configureTrustees(cfg.transcriptHash, cfg.addresses, cfg.keys, key.H[0], key.H[1])).wait()).gasUsed);
    await w.vc.openElection();

    const V = {};
    for (const code of Object.keys(PLAN)) {
      V[code] = votersOf(code, PLAN[code].length);
      await register(w, code, V[code].voters);
    }
    // ballots are cast round-robin across the constituencies, so the election-wide ballot indices interleave
    const next = Object.fromEntries(Object.keys(PLAN).map((code) => [code, 0]));
    while (Object.keys(PLAN).some((code) => next[code] < PLAN[code].length)) {
      for (const code of Object.keys(PLAN)) {
        if (next[code] >= PLAN[code].length) continue;
        const i = next[code]++;
        const ballot = await makeBallot(w, { code, voters: V[code].voters, group: V[code].group, index: i, choice: PLAN[code][i], H: key.H });
        await submit(w, ballot.args);
      }
    }
    await w.vc.closeIssuance();
    await w.networkHelpers.time.increase(CLOSE_GRACE + 1);
  });

  describe("before Closed", () => {
    it("the election is still Open: publication and endorsement are refused, even for the pinned trustees, and no result can be read", async () => {
      expect(await w.vc.phase()).to.equal(Phase.Open);
      await expect(trusteeContract(1).publishPartialDecryption(cid(BLR), 1, Array(64).fill(0n))).to.be.revertedWithCustomError(w.vc, "WrongPhase").withArgs(Phase.Open);
      await expect(trusteeContract(1).endorseResult(cid(BLR), 1, pad16(truth(BLR)))).to.be.revertedWithCustomError(w.vc, "WrongPhase");
      await rejectsWith(publish(BLR, 1), "NOT_CLOSED");
      await expect(w.vc.finalResult(cid(BLR))).to.be.revertedWithCustomError(w.vc, "NotFinalized");
      await w.vc.closeElection();
      expect(await w.vc.phase()).to.equal(Phase.Closed);
    });
  });

  describe("CLOSED: the public log, the pinned configuration and the verified aggregate", () => {
    it("the contract's pinned configuration is the real ceremony's: transcript hash, H, vk_1..vk_3 and the three trustee accounts", async () => {
      const pinned = await chain.readPinnedConfiguration(w.vc);
      expect(pinned.transcriptHash).to.equal(BigInt(transcript.transcriptHash));
      expect([...pinned.electionKey]).to.deep.equal([...run.verified.electionPublicKey]);
      expect(pinned.verificationKeys.map((k) => [...k])).to.deep.equal(run.verified.verificationKeys.map((k) => [...k]));
      expect(pinned.trustees).to.deep.equal(w.trustees.map((t) => t.address));
      expect(pinned.context).to.deep.equal({ chainId: ctx.chainId, contractAddress: ctx.contractAddress, electionId: ctx.electionId });
      expect(pinned.context).to.deep.equal(run.context);
    });

    it("the complete BallotRecorded log has 20 ballots indexed 1..20, and each constituency's aggregate rebuilt from it equals the contract's, slot by slot", async () => {
      const log = await chain.readBallotLog(w.vc);
      expect(log.map((e) => e.ballotIndex)).to.deep.equal(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(await w.vc.totalBallots()).to.equal(20n);
      const pinned = await chain.readPinnedConfiguration(w.vc);
      for (const code of [BLR, MUM, CHE, C02, C08, C16, EMPTY]) {
        const state = await chain.readConstituencyState(w.vc, cid(code));
        const verified = verifyChainAggregate({ context: pinned.context, state, log });
        expect(verified.aggregate.ballotCount, code).to.equal((PLAN[code] ?? []).length);
        expect(verified.logLength).to.equal(20);
      }
    });

    it("before any trustee has published, the audit refuses: it needs 2 valid trustees", async () => {
      await rejectsWith(audit(BLR), "INSUFFICIENT_VALID_PARTIALS");
    });

    it("the contract only ever sees public data: the integrated trustee path refuses an arbitrary aggregate (there is no argument through which one could be passed)", async () => {
      expect(chain.publishPartialDecryption.length).to.equal(1);
      const { VerifiedAggregate, AggregateCiphertext, TEST_CONTEXT } = await import("../../trustee-v3/src/index.ts");
      const arbitrary = AggregateCiphertext.create({ context: TEST_CONTEXT, constituencyId: BigInt(cid(BLR)), ballotCount: 13, slots: Array.from({ length: 3 }, () => ({ A: run.verified.electionPublicKey, B: run.verified.electionPublicKey })) });
      expect(() => run.trustees[0].partialDecryptVerified(arbitrary)).to.throw(/NOT_A_VERIFIED_AGGREGATE/);
      expect(VerifiedAggregate.isVerified(arbitrary)).to.equal(false);
    });
  });

  describe("partial-decryption publication (Bengaluru, 13 ballots)", () => {
    it("only the pinned trustee can publish, only as its own index, and only a well-shaped bundle: strangers, other indices, non-canonical padding, off-curve D, bad proof scalars", async () => {
      const words = await honestBundle(BLR, 1);
      const send = (signer, index, bundle) => w.vc.connect(signer).publishPartialDecryption(cid(BLR), index, bundle);
      await expect(send(w.stranger, 1, words)).to.be.revertedWithCustomError(w.vc, "NotTrustee").withArgs(w.stranger.address, 1n);
      await expect(send(w.owner, 1, words)).to.be.revertedWithCustomError(w.vc, "NotTrustee");
      await expect(send(w.trustee2, 1, words), "trustee 2 publishing as trustee 1").to.be.revertedWithCustomError(w.vc, "NotTrustee").withArgs(w.trustee2.address, 1n);
      await expect(send(w.trustee1, 2, words), "trustee 1 publishing as trustee 2").to.be.revertedWithCustomError(w.vc, "NotTrustee");
      const bad = (change) => words.map((x, i) => change(x, i));
      await expect(send(w.trustee1, 1, bad((x, i) => (i === 4 * 3 + 1 ? 1n : x)))).to.be.revertedWithCustomError(w.vc, "NonCanonicalPadding").withArgs(3);
      await expect(send(w.trustee1, 1, bad((x, i) => (i === 63 ? 1n : x)))).to.be.revertedWithCustomError(w.vc, "NonCanonicalPadding").withArgs(15);
      await expect(send(w.trustee1, 1, bad((x, i) => (i === 1 ? x + 1n : x)))).to.be.revertedWithCustomError(w.vc, "InvalidPartialPoint").withArgs(0);
      await expect(send(w.trustee1, 1, bad((x, i) => (i === 8 ? 21888242871839275222246405745257275088548364400416034343698204186575808495617n : x)))).to.be.revertedWithCustomError(w.vc, "InvalidPartialPoint").withArgs(2);
      await expect(send(w.trustee1, 1, bad((x, i) => (i === 6 ? 0n : x)))).to.be.revertedWithCustomError(w.vc, "InvalidProofScalar").withArgs(1);
      await expect(send(w.trustee1, 1, bad((x, i) => (i === 7 ? SUBGROUP_ORDER : x)))).to.be.revertedWithCustomError(w.vc, "InvalidProofScalar").withArgs(1);
      await expect(send(w.trustee1, 1, bad((x, i) => (i === 3 ? SUBGROUP_ORDER + 1n : x)))).to.be.revertedWithCustomError(w.vc, "InvalidProofScalar").withArgs(0);
      await rejectsAnyhow(send(w.trustee1, 1, words.slice(0, 63))); // 63 words is not even encodable as uint256[64]
      expect(await w.vc.partialBundleHash(cid(BLR), 1), "nothing was stored by any refused attempt").to.equal("0x" + "00".repeat(32));
    });

    it("a bundle built for ANOTHER constituency with another candidate count cannot be published here (the padding rules catch it)", async () => {
      const mumBundle = await honestBundle(MUM, 1); // K_c = 4: four active slots
      await expect(trusteeContract(1).publishPartialDecryption(cid(BLR), 1, mumBundle)).to.be.revertedWithCustomError(w.vc, "NonCanonicalPadding").withArgs(3);
      const bundle = await honestBundle(BLR, 1); // K_c = 3 submitted for K_c = 4
      await expect(trusteeContract(1).publishPartialDecryption(cid(MUM), 1, bundle)).to.be.revertedWithCustomError(w.vc, "InvalidPartialPoint").withArgs(3);
    });

    it("TRUSTEE 1 publishes through the integrated path: the aggregate is rebuilt from the log, the bundle is anchored, and the contract's hash equals the locally computed one", async () => {
      const result = await publish(BLR, 1);
      gas.publish.kc3 = Number(result.receipt.gasUsed);
      expect(await w.vc.partialBundleHash(cid(BLR), 1)).to.equal("0x" + result.bundleHash.toString(16).padStart(64, "0"));
      const publications = await chain.readPartialPublications(w.vc, cid(BLR));
      expect(publications).to.have.length(1);
      expect(publications[0].trusteeIndex).to.equal(1);
      expect(publications[0].candidateCount).to.equal(3);
      expect(publications[0].ballotCount).to.equal(13);
      expect(publications[0].words).to.have.length(12);
      // an independent recomputation of the anchored hash from the emitted words
      const pinned = await chain.readPinnedConfiguration(w.vc);
      const padded = [...publications[0].words, ...Array(52).fill(0n)];
      expect(bundleHash({ context: pinned.context, transcriptHash: pinned.transcriptHash, trusteeIndex: 1, constituencyId: BigInt(cid(BLR)), ballotCount: 13, candidateCount: 3 }, padded)).to.equal(result.bundleHash);
    });

    it("a trustee cannot publish twice for a constituency, and the first publication can never be replaced", async () => {
      const first = await w.vc.partialBundleHash(cid(BLR), 1);
      const other = await honestBundle(BLR, 1); // a perfectly valid fresh partial decryption (fresh proof nonces)
      await expect(trusteeContract(1).publishPartialDecryption(cid(BLR), 1, other)).to.be.revertedWithCustomError(w.vc, "AlreadyPublished").withArgs(cid(BLR), 1n);
      await rejectsWith(publish(BLR, 1), "BUNDLE_HASH_MISMATCH").catch(() => {});
      expect(await w.vc.partialBundleHash(cid(BLR), 1)).to.equal(first);
    });

    it("TRUSTEE 3 publishes from its ENCRYPTED SHARE FILE alone (one trustee, one process): only that file, the public transcript and the chain are loaded", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trustee-v3-test-"));
      try {
        const password = "a-throwaway-password-" + Math.random().toString(36).slice(2);
        const file = path.join(dir, "trustee-3", "share.json");
        writeShareFile(file, run.trustees[2].exportEncryptedShare(password, KDF_TESTING_ONLY));
        const result = await recorded(() => chain.publishFromShareFile({ contract: trusteeContract(3), shareFile: file, password, transcript, constituencyId: cid(BLR), minKdf: KDF_TESTING_ONLY }));
        expect(await w.vc.partialBundleHash(cid(BLR), 3)).to.equal("0x" + result.bundleHash.toString(16).padStart(64, "0"));
        await rejectsWith(chain.publishFromShareFile({ contract: trusteeContract(3), shareFile: file, password: "another-throwaway-password", transcript, constituencyId: cid(BLR), minKdf: KDF_TESTING_ONLY }), "WRONG_PASSWORD_OR_TAMPERED");
        await rejectsWith(chain.publishFromShareFile({ contract: trusteeContract(1), shareFile: file, password, transcript, constituencyId: cid(BLR), minKdf: KDF_TESTING_ONLY }), "NOT_THE_PINNED_ADDRESS");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a trustee refuses to act on a transcript that is not the pinned one (publication needs the pinned transcript)", async () => {
      const other = runCeremony();
      await rejectsWith(chain.publishPartialDecryption({ contract: trusteeContract(2), trustee: run.trustees[1], transcript: other.transcript, constituencyId: cid(BLR) }), "HASH_MISMATCH");
      await rejectsWith(chain.publishPartialDecryption({ contract: trusteeContract(2), trustee: other.trustees[1], transcript, constituencyId: cid(BLR) }), "NOT_THE_PINNED_TRUSTEE");
    });
  });

  describe("the auditor: Chaum-Pedersen proofs verified OFF-chain, 2-of-3 combination, BSGS", () => {
    it("trustees 1 + 3: both proofs verify, the points combine, BSGS recovers [7, 4, 2], the totals add up to the 13 ballots", async () => {
      const result = await audit(BLR);
      expect(result.validTrustees).to.deep.equal([1, 3]);
      expect(result.invalid).to.deep.equal([]);
      expect(result.usedTrustees).to.deep.equal([1, 3]);
      expect(result.totals).to.deep.equal([7, 4, 2]);
      expect(result.aggregate.aggregate.ballotCount).to.equal(13);
      expect(result.resultsHash).to.equal(resultsHash({ context: run.context, transcriptHash: BigInt(transcript.transcriptHash), constituencyId: BigInt(cid(BLR)), ballotCount: 13, candidateCount: 3 }, padTotals([7, 4, 2], 3)));
    });

    it("one published trustee is not enough, and the audit needs no secret at all", async () => {
      const state = await chain.readConstituencyState(w.vc, cid(BLR));
      const [pinned, log, publications, stored] = await Promise.all([chain.readPinnedConfiguration(w.vc), chain.readBallotLog(w.vc), chain.readPartialPublications(w.vc, cid(BLR)), chain.readStoredBundleHashes(w.vc, cid(BLR))]);
      const only = publications.filter((p) => p.trusteeIndex === 3);
      expect(() => auditConstituency({ transcript, pinned, state, log, publications: only, storedBundleHashes: stored })).to.throw(/INSUFFICIENT_VALID_PARTIALS/);
      expect(() => auditConstituency({ transcript, pinned, state, log, publications: [only[0], only[0]], storedBundleHashes: stored })).to.throw(/DUPLICATE_TRUSTEE/);
    });
  });

  describe("endorsement and finalization (Bengaluru)", () => {
    it("results nobody can endorse: padded totals non-zero, a total above the ballot count, totals that do not sum to 13", async () => {
      const send = (totals) => trusteeContract(1).endorseResult(cid(BLR), 1, totals);
      await expect(send([7n, 4n, 2n, 1n, ...Array(12).fill(0n)])).to.be.revertedWithCustomError(w.vc, "PaddedTotalNotZero").withArgs(3);
      await expect(send([7n, 4n, 2n, ...Array(12).fill(0n), 1n])).to.be.revertedWithCustomError(w.vc, "PaddedTotalNotZero").withArgs(15);
      await expect(send(pad16([14, 0, 0]))).to.be.revertedWithCustomError(w.vc, "TotalAboveBallotCount").withArgs(0);
      await expect(send(pad16([0, 0, 99]))).to.be.revertedWithCustomError(w.vc, "TotalAboveBallotCount").withArgs(2);
      await expect(send(pad16([7, 4, 1]))).to.be.revertedWithCustomError(w.vc, "TotalsDoNotSumToBallots").withArgs(12n, 13n);
      await expect(send(pad16([7, 4, 3]))).to.be.revertedWithCustomError(w.vc, "TotalsDoNotSumToBallots").withArgs(14n, 13n);
      await expect(send(pad16([0, 0, 0]))).to.be.revertedWithCustomError(w.vc, "TotalsDoNotSumToBallots").withArgs(0n, 13n);
      expect(await w.vc.endorsementOf(cid(BLR), 1)).to.equal("0x" + "00".repeat(32));
    });

    it("a trustee that has NOT published cannot endorse (trustee 2)", async () => {
      await expect(trusteeContract(2).endorseResult(cid(BLR), 2, pad16(truth(BLR)))).to.be.revertedWithCustomError(w.vc, "NotPublished").withArgs(cid(BLR), 2n);
      await rejectsWith(endorse(BLR, 2), "OWN_PUBLICATION_NOT_VALID");
    });

    it("trustee 1 endorses the audited result: ONE endorsement finalizes nothing, and nothing is readable yet", async () => {
      const result = await endorse(BLR, 1);
      gas.endorseFirst.kc3 = Number(result.receipt.gasUsed);
      expect(result.finalized).to.equal(false);
      expect(await w.vc.isFinalized(cid(BLR))).to.equal(false);
      await expect(w.vc.finalResult(cid(BLR))).to.be.revertedWithCustomError(w.vc, "NotFinalized").withArgs(cid(BLR));
      expect(await w.vc.endorsementOf(cid(BLR), 1)).to.equal("0x" + result.resultsHash.toString(16).padStart(64, "0"));
    });

    it("an endorsement can never be replaced or repeated: a trustee that changes the result, or repeats it, is refused", async () => {
      await expect(trusteeContract(1).endorseResult(cid(BLR), 1, pad16([6, 5, 2]))).to.be.revertedWithCustomError(w.vc, "AlreadyEndorsed").withArgs(cid(BLR), 1n);
      await expect(trusteeContract(1).endorseResult(cid(BLR), 1, pad16(truth(BLR)))).to.be.revertedWithCustomError(w.vc, "AlreadyEndorsed");
      await expect(trusteeContract(3).endorseResult(cid(BLR), 1, pad16(truth(BLR)))).to.be.revertedWithCustomError(w.vc, "NotTrustee");
    });

    it("trustee 3 endorses the SAME result: two distinct trustees agree and the constituency finalizes, immutably, with [7, 4, 2]", async () => {
      const result = await endorse(BLR, 3);
      gas.endorseSecond.kc3 = Number(result.receipt.gasUsed);
      expect(result.finalized).to.equal(true);
      expect(await w.vc.isFinalized(cid(BLR))).to.equal(true);
      const final = await w.vc.finalResult(cid(BLR));
      expect([...final.totals]).to.deep.equal(pad16([7, 4, 2]));
      expect(final.ballotCount).to.equal(13n);
      expect(final.candidateCount).to.equal(3n);
      expect(final.resultsHash).to.equal("0x" + result.resultsHash.toString(16).padStart(64, "0"));
      expect(await w.vc.endorsementOf(cid(BLR), 3)).to.equal(final.resultsHash);
      const events = await w.vc.queryFilter(w.vc.filters.ConstituencyFinalized(cid(BLR)));
      expect(events).to.have.length(1);
      expect([...events[0].args.totals]).to.deep.equal([7n, 4n, 2n]);
      const verified = await chain.readVerifiedFinalResult({ contract: w.vc, transcript, constituencyId: cid(BLR) });
      expect(verified.totals).to.deep.equal([7, 4, 2]);
    });

    it("FINALIZATION IS IMMUTABLE: nobody can endorse again, change the result or finalize another; the stored result does not move", async () => {
      const before = await w.vc.finalResult(cid(BLR));
      for (const [signer, index] of [[w.trustee1, 1], [w.trustee2, 2], [w.trustee3, 3]]) {
        for (const totals of [pad16([7, 4, 2]), pad16([6, 5, 2]), pad16([13, 0, 0])]) await expect(w.vc.connect(signer).endorseResult(cid(BLR), index, totals)).to.be.revertedWithCustomError(w.vc, "AlreadyFinalized").withArgs(cid(BLR));
      }
      const after = await w.vc.finalResult(cid(BLR));
      expect([...after.totals]).to.deep.equal([...before.totals]);
      expect(after.resultsHash).to.equal(before.resultsHash);
      expect(await w.vc.endorsementOf(cid(BLR), 2)).to.equal("0x" + "00".repeat(32));
    });
  });

  describe("every trustee pair: Mumbai (2 + 3 after a dissent) and Chennai (1 + 2, a single ballot)", () => {
    /** the audit of a constituency restricted to each pair of trustees (and to all three), from the real chain */
    const auditEveryPair = async (code) => {
      const state = await chain.readConstituencyState(w.vc, cid(code));
      const [pinned, log, publications, stored] = await Promise.all([chain.readPinnedConfiguration(w.vc), chain.readBallotLog(w.vc), chain.readPartialPublications(w.vc, cid(code)), chain.readStoredBundleHashes(w.vc, cid(code))]);
      expect(publications.map((p) => p.trusteeIndex).sort()).to.deep.equal([1, 2, 3]);
      return [[1, 2], [1, 3], [2, 3], [1, 2, 3]].map((pair) => ({ pair, result: auditConstituency({ transcript, pinned, state, log, publications: publications.filter((p) => pair.includes(p.trusteeIndex)), storedBundleHashes: stored }) }));
    };

    it("Bengaluru, 13 ballots: trustee 2 publishes LATE (the constituency is already finalized); every pair 1+2, 1+3, 2+3 and all three recover the same [7, 4, 2] and the same results hash from the real chain", async () => {
      await publish(BLR, 2);
      const audits = await auditEveryPair(BLR);
      for (const { pair, result } of audits) {
        expect(result.totals, `pair ${pair}`).to.deep.equal([7, 4, 2]);
        expect(result.usedTrustees, `pair ${pair}`).to.have.length(2);
        expect(result.resultsHash).to.equal(audits[0].result.resultsHash);
      }
      expect(audits.slice(0, 3).map((a) => a.result.usedTrustees)).to.deep.equal([[1, 2], [1, 3], [2, 3]]);
      expect((await chain.readVerifiedFinalResult({ contract: w.vc, transcript, constituencyId: cid(BLR) })).totals).to.deep.equal([7, 4, 2]);
    });

    it("Mumbai: all three trustees publish; every pair of them audits to [0, 1, 0, 2]", async () => {
      for (const i of [1, 2, 3]) await publish(MUM, i);
      for (const { pair, result } of await auditEveryPair(MUM)) expect(result.totals, `pair ${pair}`).to.deep.equal(truth(MUM));
    });

    it("Mumbai: trustees DISAGREE: trustee 1 endorses a different (well-formed) result, trustee 2 the audited one: nothing finalizes", async () => {
      await expect(trusteeContract(1).endorseResult(cid(MUM), 1, pad16([3, 0, 0, 0]))).to.emit(w.vc, "ResultEndorsed");
      const second = await endorse(MUM, 2);
      expect(second.finalized).to.equal(false);
      expect(await w.vc.isFinalized(cid(MUM))).to.equal(false);
      await expect(w.vc.finalResult(cid(MUM))).to.be.revertedWithCustomError(w.vc, "NotFinalized");
      expect(await w.vc.endorsementOf(cid(MUM), 1)).to.not.equal(await w.vc.endorsementOf(cid(MUM), 2));
    });

    it("Mumbai: trustee 3 agrees with trustee 2: trustees 2 + 3 finalize [0, 1, 0, 2], and trustee 1's dissent is ignored", async () => {
      const third = await endorse(MUM, 3);
      expect(third.finalized).to.equal(true);
      const final = await w.vc.finalResult(cid(MUM));
      expect([...final.totals]).to.deep.equal(pad16(truth(MUM)));
      expect(final.resultsHash).to.equal(await w.vc.endorsementOf(cid(MUM), 2));
      expect(final.resultsHash).to.not.equal(await w.vc.endorsementOf(cid(MUM), 1));
      expect((await chain.readVerifiedFinalResult({ contract: w.vc, transcript, constituencyId: cid(MUM) })).totals).to.deep.equal([0, 1, 0, 2]);
    });

    it("Chennai holds exactly ONE ballot and is still tallyable: trustee 3 publishes a hostile bundle (Bengaluru's proofs), the auditor names it, and trustees 1 + 2 finalize [0, 1, 0]", async () => {
      await publish(CHE, 1);
      await publish(CHE, 2);
      // trustee 3 re-publishes Bengaluru's perfectly well-formed bundle here: shape-valid, so the contract anchors it, but its proofs are bound to Bengaluru
      const stolen = await honestBundle(BLR, 3);
      await expect(trusteeContract(3).publishPartialDecryption(cid(CHE), 3, stolen)).to.emit(w.vc, "PartialDecryptionPublished");
      const result = await audit(CHE);
      expect(result.invalid.map((i) => [i.trusteeIndex, i.code])).to.deep.equal([[3, "INVALID_PROOF"]]);
      expect(result.validTrustees).to.deep.equal([1, 2]);
      expect(result.totals).to.deep.equal([0, 1, 0]);
      expect(result.aggregate.eventCount).to.equal(1);
      const first = await endorse(CHE, 1);
      expect(first.finalized).to.equal(false);
      const second = await endorse(CHE, 2);
      expect(second.finalized).to.equal(true);
      expect([...(await w.vc.finalResult(cid(CHE))).totals]).to.deep.equal(pad16([0, 1, 0]));
      await expect(trusteeContract(3).endorseResult(cid(CHE), 3, pad16([0, 1, 0]))).to.be.revertedWithCustomError(w.vc, "AlreadyFinalized");
    });

    it("a constituency with no ballots finalizes with zeros and needs no partial decryption", async () => {
      await expect(trusteeContract(1).publishPartialDecryption(cid(EMPTY), 1, Array(64).fill(0n))).to.be.revertedWithCustomError(w.vc, "NothingToDecrypt");
      const audited = await audit(EMPTY);
      expect(audited.totals).to.deep.equal([0, 0]);
      const first = await endorse(EMPTY, 1);
      expect(first.finalized).to.equal(false);
      expect((await endorse(EMPTY, 3)).finalized).to.equal(true);
      expect([...(await w.vc.finalResult(cid(EMPTY))).totals]).to.deep.equal(pad16([0, 0]));
    });
  });

  describe("the ACCEPTED prototype limitation: two malicious trustees can still finalize a false result, and the public auditor catches it", () => {
    it("trustees 1 + 3 publish honest partials but endorse a lie: the contract finalizes it (it cannot verify proofs), the audit recovers the truth and flags the mismatch", async () => {
      const first = await publish(C08, 1);
      gas.publish.kc8 = Number(first.receipt.gasUsed);
      await publish(C08, 3);
      const lie = pad16([1, 0, 0, 0, 0, 0, 0, 0]);
      const one = await (await trusteeContract(1).endorseResult(cid(C08), 1, lie)).wait();
      gas.endorseFirst.kc8 = Number(one.gasUsed);
      const two = await (await trusteeContract(3).endorseResult(cid(C08), 3, lie)).wait();
      gas.endorseSecond.kc8 = Number(two.gasUsed);
      expect(await w.vc.isFinalized(cid(C08))).to.equal(true);
      expect([...(await w.vc.finalResult(cid(C08))).totals]).to.deep.equal(lie);
      const audited = await audit(C08);
      expect(audited.totals).to.deep.equal(truth(C08));
      await rejectsWith(chain.readVerifiedFinalResult({ contract: w.vc, transcript, constituencyId: cid(C08) }), "FINAL_RESULT_MISMATCH");
    });
  });

  describe("gas of the new contract operations", () => {
    it("publication and endorsement for K_c = 2 and K_c = 16 (K_MAX)", async () => {
      const a = await publish(C02, 1);
      gas.publish.kc2 = Number(a.receipt.gasUsed);
      await publish(C02, 2);
      gas.endorseFirst.kc2 = Number((await endorse(C02, 1)).receipt.gasUsed);
      const finalC02 = await endorse(C02, 2);
      gas.endorseSecond.kc2 = Number(finalC02.receipt.gasUsed);
      expect(finalC02.finalized).to.equal(true);
      expect([...(await w.vc.finalResult(cid(C02))).totals]).to.deep.equal(pad16(truth(C02)));

      // K_MAX
      const p1 = await publish(C16, 1);
      await publish(C16, 2);
      gas.publish.kc16 = Number(p1.receipt.gasUsed);
      gas.endorseFirst.kc16 = Number((await endorse(C16, 1)).receipt.gasUsed);
      const finalC16 = await endorse(C16, 2);
      gas.endorseSecond.kc16 = Number(finalC16.receipt.gasUsed);
      expect(finalC16.finalized).to.equal(true);
      const totals = [...(await w.vc.finalResult(cid(C16))).totals];
      expect(totals).to.deep.equal(pad16(truth(C16)));
      expect(totals[11]).to.equal(1n);
    });
  });

  describe("PRIVACY: nothing secret ever reaches the chain", () => {
    it("no transaction input and no log on the whole chain contains any trustee secret: coefficients, shares s_i, the full secret s, or the proofs' nonces, in any spelling", async () => {
      const wire = (p) => [BigInt(p[0]), BigInt(p[1])];
      const K = (i, k) => wire(run.transcript.participants[i - 1].commitments[k]);
      const a = [1, 2, 3].map((i) => [0, 1].map((k) => logOf(K(i, k), dkgScalars)));
      expect(a.flat().every((x) => x !== undefined), "every coefficient was identified among the observed draws").to.equal(true);
      const L = SUBGROUP_ORDER;
      const s = a.reduce((acc, [a0]) => (acc + a0) % L, 0n);
      const f = (i, j) => (a[i - 1][0] + a[i - 1][1] * BigInt(j)) % L;
      const shares = [1, 2, 3].map((j) => [1, 2, 3].reduce((acc, i) => (acc + f(i, j)) % L, 0n));
      const nonces = scalarsOf(drawn);
      const secrets = [...dkgScalars, ...nonces, s, ...shares, ...[1, 2, 3].flatMap((i) => [1, 2, 3].map((j) => f(i, j)))];
      expect(nonces.length, "the proof nonces of every publication of this run were observed").to.be.greaterThan(90);

      const provider = w.ethers.provider;
      const latest = await provider.getBlockNumber();
      const data = [];
      for (let n = 0; n <= latest; n++) {
        const block = await provider.getBlock(n, true);
        for (const tx of block.prefetchedTransactions) data.push(tx.data);
      }
      for (const log of await provider.getLogs({ fromBlock: 0, toBlock: "latest" })) data.push(log.data, ...log.topics);
      const everything = data.join("\n");
      expect(everything.length).to.be.greaterThan(100000);
      // the scan reads the right data: the trustees' public publications ARE in it
      const published = await chain.readPartialPublications(w.vc, cid(BLR));
      expect(everything.toLowerCase()).to.include(published[0].words[0].toString(16).padStart(64, "0"));
      assertNoLeak("the whole chain", everything, secrets);
      // positive control: the scan is not blind. The same text with ONE secret planted in it (a share, the full secret, a nonce) is caught.
      for (const planted of [shares[1], s, nonces[0]]) expect(() => assertNoLeak("control", everything + "\n0x" + planted.toString(16).padStart(64, "0"), secrets)).to.throw(/contains a secret value/);
    });

    it("the chain never decrypts and exposes no individual-ballot API: the ABI has none, and results exist only for finalized constituencies", async () => {
      const names = w.vc.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      expect(names.filter((n) => /decrypt|individual|reveal|secret/i.test(n))).to.deep.equal(["publishPartialDecryption"]);
      for (const code of [BLR, MUM, CHE, C02, C08, C16, EMPTY]) expect(await w.vc.isFinalized(cid(code)), code).to.equal(true);
      await expect(w.vc.finalResult(cid("XX-NONE"))).to.be.revertedWithCustomError(w.vc, "NotFinalized");
    });
  });

  after(() => {
    const artifact = JSON.parse(fs.readFileSync(path.join(PROJECT, "artifacts", "contracts", "VoteChainV3.sol", "VoteChainV3.json"), "utf8"));
    const record = {
      note: "gas of the NEW contract operations, measured on the local Hardhat network (hardfork osaka); published bundles and endorsements are for single-ballot constituencies except K_c = 3 (13 ballots)",
      deployedContractBytes: (artifact.deployedBytecode.length - 2) / 2,
      configureTrustees: gas.configureTrustees,
      publishPartialDecryption: gas.publish,
      endorseResultFirst: gas.endorseFirst,
      endorseResultSecondAndFinalize: gas.endorseSecond,
    };
    fs.mkdirSync(path.join(PROJECT, "results"), { recursive: true });
    fs.writeFileSync(path.join(PROJECT, "results", "gas-tally.json"), JSON.stringify(record, null, 2) + "\n");
  });
});
