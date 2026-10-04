// Gas of the two operations whose cost matters: submitBallot (K_c = 2 / 8 / 16) and registerCommitmentBatch (1 / 16 / 64 / MAX_BATCH commitments).
// Measured on the local in-process network (hardfork and limits are recorded in results/gas.json). The probes are view calls on REAL inputs, so a valid
// proof takes the full verification path. Nothing here is optimised: this is the baseline.
import fs from "node:fs";
import path from "node:path";
import { expect } from "chai";
import { getBytes } from "ethers";
import { addCiphertexts, identityCiphertext } from "../../privacy-v3/src/elgamal.js";
import { fakeVoter } from "../../privacy-v3/testing/fake-voters.js";
import { EPOCH, PROJECT, cid, configure, describeWithProofs, makeBallot, newWorld, register, submit, votersOf } from "./helpers/world.js";

const TX_GAS_CAP = 2n ** 24n; // EIP-7825 (Osaka): a single transaction may not use more than 16,777,216 gas
const results = { network: {}, probes: {}, submitBallot: {}, registerCommitmentBatch: {} };
const n = (x) => Number(x);

/** 21000 + 4 gas per zero byte + 16 per non-zero byte (EIP-2028): what the transaction pays before the EVM executes anything */
const intrinsicGas = (data) => getBytes(data).reduce((g, byte) => g + (byte === 0 ? 4n : 16n), 21000n);

/** The number of Poseidon hashes InternalLeanIMT._insertMany performs when `count` leaves are added to a tree that already holds `size` leaves. */
function insertManyHashes(size, count) {
  let depth = 0;
  while (2 ** depth < size) depth++; // the stored depth of a tree of `size` leaves
  while (2 ** depth < size + count) depth++;
  let levelSize = size + count;
  let nextStart = Math.floor(size / 2);
  let nextSize = Math.floor((levelSize - 1) / 2) + 1;
  let hashes = 0;
  for (let level = 0; level < depth; level++) {
    for (let i = nextStart; i < nextSize; i++) if (i * 2 + 1 < levelSize) hashes++;
    nextStart = Math.floor(nextStart / 2);
    levelSize = nextSize;
    nextSize = Math.floor((nextSize - 1) / 2) + 1;
  }
  return hashes;
}

const table = (title, rows) => {
  console.log(`\n      ${title}`);
  for (const row of rows) console.log(`        ${row}`);
};

describe("Gas: registerCommitmentBatch", () => {
  it("1, 16, 64 and MAX_BATCH commitments: gas, per-commitment cost, Poseidon share, and the headroom to the block and transaction limits", async () => {
    const w = await newWorld();
    await configure(w, { only: ["BATCH"] });
    await w.vc.openElection();
    const max = n(await w.vc.MAX_BATCH());
    const block = await w.ethers.provider.getBlock("latest");
    results.network = { hardfork: w.networkConfig.hardfork, blockGasLimit: n(block.gasLimit), perTransactionGasCap: n(TX_GAS_CAP), chainId: n(w.networkConfig.chainId ?? w.networkConfig.networkId) };

    const probe = await w.ethers.deployContract("GasProbe");
    const [coldHash, warmHash] = await probe.poseidonHash.staticCall(await w.poseidon.getAddress(), 1n, 2n);
    results.probes.poseidonT3 = { coldGas: n(coldHash), warmGas: n(warmHash) };

    const sizes = [1, 16, 64, max];
    const pool = Array.from({ length: sizes.reduce((a, b) => a + b, 0) }, (_, i) => fakeVoter(`v3-gas:batch-${i}`));
    const rows = [];
    let treeSize = 0;
    let offset = 0;
    for (const count of sizes) {
      await w.networkHelpers.time.increase(EPOCH);
      const commitments = pool.slice(offset, offset + count).map((v) => v.commitment);
      offset += count;
      const issuer = w.vc.connect(w.issuer);
      // Hardhat's eth_estimateGas (EDR, Osaka) probes a gas limit of about 3x the real usage and rejects it above the 2^24 cap, so for the larger batches the
      // estimate fails although the transaction itself fits comfortably: send with an explicit limit (recorded, not asserted: it is a tooling quirk)
      const autoEstimate = await issuer.registerCommitmentBatch.estimateGas(cid("BATCH"), commitments).then(n, (e) => `fails: ${String(e.message).slice(0, 90)}`);
      const receipt = await (await issuer.registerCommitmentBatch(cid("BATCH"), commitments, { gasLimit: TX_GAS_CAP })).wait();
      const hashes = insertManyHashes(treeSize, count);
      const gasUsed = receipt.gasUsed;
      const row = {
        commitments: count,
        treeSizeBefore: treeSize,
        gasUsed: n(gasUsed),
        gasPerCommitment: Math.round(n(gasUsed) / count),
        poseidonHashes: hashes,
        poseidonGas: hashes * n(warmHash),
        poseidonShare: Number(((hashes * n(warmHash)) / n(gasUsed)).toFixed(3)),
        percentOfTxGasCap: Number(((100 * n(gasUsed)) / n(TX_GAS_CAP)).toFixed(1)),
        percentOfBlockGasLimit: Number(((100 * n(gasUsed)) / n(block.gasLimit)).toFixed(1)),
        hardhatAutoEstimateGas: autoEstimate,
      };
      rows.push(row);
      treeSize += count;
      expect(gasUsed, `a batch of ${count} fits in one transaction`).to.be.lessThan(TX_GAS_CAP);
      expect(gasUsed).to.be.lessThan(block.gasLimit);
    }
    results.registerCommitmentBatch = { constituencyTreeFinalSize: treeSize, maxBatch: max, rows };
    table("registerCommitmentBatch (gas | per commitment | Poseidon hashes (share) | % of the 16.78M per-tx cap)", rows.map((r) => `${String(r.commitments).padStart(4)} commitments (tree had ${String(r.treeSizeBefore).padStart(3)}): ${String(r.gasUsed).padStart(10)} | ${String(r.gasPerCommitment).padStart(7)} | ${String(r.poseidonHashes).padStart(4)} hashes (${(100 * r.poseidonShare).toFixed(0)}%) | ${r.percentOfTxGasCap}%`));
    // the cost per commitment is dominated by what is written and hashed once per commitment, so it is flat-ish and a batch is roughly linear in its size
    expect(rows[3].gasPerCommitment).to.be.lessThan(rows[0].gasPerCommitment);
    expect(treeSize).to.equal(Number((await w.vc.getConstituency(cid("BATCH"))).issued));
  });

  it("the hash-count model matches the tree: a batch into a deeper tree needs more hashes (the estimate for a full depth-20 tree)", () => {
    // exact counts of the algorithm above, no gas involved: the cost of a 64-commitment batch grows only by the path to the root as the tree deepens
    const small = insertManyHashes(0, 64);
    const deep = insertManyHashes(600000, 64);
    results.registerCommitmentBatch.hashCountModel = { batchOf64IntoEmptyTree: small, batchOf64IntoTreeOf600000: deep, batchOf128IntoEmptyTree: insertManyHashes(0, 128), batchOf128IntoTreeOf600000: insertManyHashes(600000, 128), batchOf1IntoTreeOf600000: insertManyHashes(600000, 1) };
    expect(small).to.equal(63);
    expect(deep).to.be.greaterThan(small);
    expect(insertManyHashes(0, 1)).to.equal(0);
    expect(insertManyHashes(1, 1)).to.equal(1);
  });
});

describeWithProofs("Gas: submitBallot", () => {
  it("K_c = 2, 8 and 16: the first ballot of a constituency, the next ones, and where the gas goes", async () => {
    const w = await newWorld();
    const key = await configure(w, { only: ["C02", "C08", "C16"] });
    await w.vc.openElection();
    const block = await w.ethers.provider.getBlock("latest");
    const probe = await w.ethers.deployContract("GasProbe");
    const scope = await w.vc.scope();
    const signalsOf = (args, kc) => {
      const padded = [...args.coords];
      for (let j = kc; j < 16; j++) padded.push(0n, 1n, 0n, 1n);
      return [args.membership.nullifier, BigInt(kc), BigInt(key.H[0]), BigInt(key.H[1]), ...padded];
    };

    const summary = [];
    for (const [code, kc] of [["C02", 2], ["C08", 8], ["C16", 16]]) {
      const v = votersOf(code, 4);
      await register(w, code, v.voters);
      const groupId = (await w.vc.getConstituency(cid(code))).groupId;
      const ballots = [];
      for (let i = 0; i < 3; i++) ballots.push(await makeBallot(w, { code, voters: v.voters, group: v.group, index: i, choice: i % kc, H: key.H }));

      // the three computational parts, measured in isolation on the THIRD ballot (a valid proof takes the full path); view calls spend no nullifier
      const third = ballots[2].args;
      const hash = await w.vc.ballotHashOf(cid(code), third.coords);
      const semaphoreProof = { merkleTreeDepth: third.membership.merkleTreeDepth, merkleTreeRoot: third.membership.merkleTreeRoot, nullifier: third.membership.nullifier, message: hash, scope, points: third.membership.points };
      const [semGas, semOk] = await probe.semaphoreVerify.staticCall(await w.semaphore.getAddress(), groupId, semaphoreProof);
      const [grothGas, grothOk] = await probe.validityVerify.staticCall(await w.validityVerifier.getAddress(), third.validity.a, third.validity.b, third.validity.c, signalsOf(third, kc));
      const [arithGas] = await probe.aggregationArithmetic.staticCall(third.coords, kc);
      expect(semOk, "the probe verifies a REAL Semaphore proof").to.equal(true);
      expect(grothOk, "the probe verifies a REAL validity proof").to.equal(true);

      const rows = [];
      for (const [i, b] of ballots.entries()) {
        const tx = await submit(w, b.args);
        const receipt = await tx.wait();
        rows.push({ ballot: i + 1, gasUsed: n(receipt.gasUsed), calldataBytes: getBytes(tx.data).length, intrinsicGas: n(intrinsicGas(tx.data)) });
      }
      const steady = rows[2];
      const rest = steady.gasUsed - steady.intrinsicGas - n(semGas) - n(grothGas) - n(arithGas);
      const entry = {
        kc,
        coordinates: 4 * kc,
        ballots: rows,
        firstBallotGas: rows[0].gasUsed,
        steadyStateGas: Math.round((rows[1].gasUsed + rows[2].gasUsed) / 2),
        breakdownOfBallot3: {
          total: steady.gasUsed,
          intrinsicIncludingCalldata: steady.intrinsicGas,
          semaphoreVerifyProof: n(semGas),
          groth16VerifyProof: n(grothGas),
          babyJubJubArithmetic: n(arithGas),
          storageEventHashingAndMemory: rest,
        },
        percentOfTxGasCap: Number(((100 * rows[0].gasUsed) / n(TX_GAS_CAP)).toFixed(1)),
        percentOfBlockGasLimit: Number(((100 * rows[0].gasUsed) / n(block.gasLimit)).toFixed(1)),
      };
      results.submitBallot[kc] = entry;
      summary.push(entry);
      // not only gas: the on-chain aggregate of EVERY slot equals the JS sum of the three ballots (K_c = 16 is K_MAX, all 16 slots active)
      for (let j = 0; j < kc; j++) {
        const sum = ballots.reduce((acc, b) => addCiphertexts(acc, b.internals.ciphertexts[j]), identityCiphertext());
        const a = await w.vc.aggregateOf(cid(code), j);
        expect([a.ax, a.ay, a.bx, a.by], `K_c = ${kc}, slot ${j}`).to.deep.equal([...sum.c1, ...sum.c2]);
      }
      expect(BigInt(rows[0].gasUsed), "the worst case, the first ballot, fits in one transaction").to.be.lessThan(TX_GAS_CAP);
      expect(rest, "the remainder is positive: the probes do not double count").to.be.greaterThan(0);
      expect((await w.vc.getConstituency(cid(code))).ballots).to.equal(3n);
    }

    table("submitBallot (gas of ballot 1 / 2 / 3 | calldata bytes)", summary.map((e) => `K_c = ${String(e.kc).padStart(2)}: ${e.ballots.map((r) => String(r.gasUsed).padStart(9)).join(" / ")} | ${e.ballots[0].calldataBytes} bytes`));
    table("where ballot 3 spends its gas (intrinsic+calldata | Semaphore.verifyProof | Groth16 | BabyJubJub add x 2K_c | storage+event+hash+memory)", summary.map((e) => {
      const b = e.breakdownOfBallot3;
      return `K_c = ${String(e.kc).padStart(2)}: ${String(b.total).padStart(9)} = ${b.intrinsicIncludingCalldata} | ${b.semaphoreVerifyProof} | ${b.groth16VerifyProof} | ${b.babyJubJubArithmetic} | ${b.storageEventHashingAndMemory}`;
    }));

    // cost grows with K_c (aggregation and storage and calldata scale with it; the two verifiers do not)
    const [k2, k8, k16] = summary;
    expect(k8.steadyStateGas).to.be.greaterThan(k2.steadyStateGas);
    expect(k16.steadyStateGas).to.be.greaterThan(k8.steadyStateGas);
    // the fixed part (both verifiers) does not depend on K_c
    expect(Math.abs(k16.breakdownOfBallot3.semaphoreVerifyProof - k2.breakdownOfBallot3.semaphoreVerifyProof)).to.be.lessThan(2000);
    // a constituency's FIRST ballot is the most expensive: it turns the aggregate slots from (0,1) into non-zero storage
    for (const e of summary) expect(e.firstBallotGas).to.be.greaterThan(e.steadyStateGas);
  });

  after(() => {
    const dir = path.join(PROJECT, "results");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "gas.json"), JSON.stringify(results, null, 2) + "\n");
  });
});
