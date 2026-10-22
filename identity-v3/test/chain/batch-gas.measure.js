// MEASUREMENT (not part of the test suite): what a credential batch really needs, as the constituency's Merkle tree grows.
// A disposable local election (test/helpers/world.js) is grown by successive batches, one per epoch, sent straight from the issuer account. For every batch it
// records the tree size before, the released v3.0.0 gas limit, the gas limit the current batcher computes, Hardhat's eth_estimateGas, the SMALLEST gas limit
// with which the call succeeds (bisected with eth_call) and the gas the mined transaction used.
//
//   node test/chain/batch-gas.measure.js [--pattern=small|large|mixed] [--batches=170] [--seed=1] [--out=FILE]
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { TX_GAS_CAP, batchGasLimit, selectGasLimit } from "../../src/services/batcher.service.js";
import { newWorld } from "../helpers/world.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const pattern = args.pattern ?? "small";
const batches = Number(args.batches ?? 170);
let seed = Number(args.seed ?? 1);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const releasedLimit = (count) => {
  const l = 150_000n + 100_000n * BigInt(count);
  return l > TX_GAS_CAP ? TX_GAS_CAP : l;
};
const sizeOf = (i) => {
  if (pattern === "small") return 1 + Math.floor(rand() * 6);
  if (pattern === "large") return 128;
  const pool = [1, 2, 3, 4, 5, 6, 16, 32, 64, 128];
  return pool[Math.floor(rand() * pool.length)];
};

const world = await newWorld({ constituencies: { BATCH: { kc: 2, cap: 100_000 } } });
const vc = world.voteChain.connect(world.issuer);
const id = world.ids.BATCH;
const ok = async (commitments, gasLimit) => {
  try {
    await vc.registerCommitmentBatch.staticCall(id, commitments, { gasLimit });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code, revert: err.revert?.name ?? null, data: err.data ?? null, message: String(err.shortMessage ?? err.message).slice(0, 120) };
  }
};
const rows = [];
let size = 0;
try {
  for (let b = 0; b < batches; b++) {
    const count = sizeOf(b);
    const commitments = Array.from({ length: count }, () => BigInt("0x" + randomBytes(31).toString("hex"))).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    await world.nextEpoch();
    const atCap = await ok(commitments, TX_GAS_CAP);
    if (!atCap.ok) throw new Error(`batch ${b} fails even at the cap: ${JSON.stringify(atCap)}`);
    let lo = 21_000n;
    let hi = TX_GAS_CAP;
    while (hi - lo > 64n) {
      const mid = (lo + hi) / 2n;
      if ((await ok(commitments, mid)).ok) hi = mid;
      else lo = mid;
    }
    const released = releasedLimit(count);
    const atReleased = await ok(commitments, released);
    let estimate = null;
    let estimateError = null;
    try {
      estimate = await vc.registerCommitmentBatch.estimateGas(id, commitments);
    } catch (err) {
      estimateError = String(err.shortMessage ?? err.message).slice(0, 140);
    }
    const current = batchGasLimit(count, size);
    // what the fixed batcher would sign for exactly this batch in exactly this state
    const choice = await selectGasLimit({ count, treeSize: size, estimate: () => vc.registerCommitmentBatch.estimateGas(id, commitments), simulate: (gasLimit) => vc.registerCommitmentBatch.staticCall(id, commitments, { gasLimit }) });
    const receipt = await (await vc.registerCommitmentBatch(id, commitments, { gasLimit: hi + hi / 10n > TX_GAS_CAP ? TX_GAS_CAP : hi + hi / 10n })).wait();
    rows.push({ batch: b, count, treeSizeBefore: size, released: Number(released), currentModel: Number(current), needed: Number(hi), estimate: estimate === null ? null : Number(estimate), estimateError,
      gasUsed: Number(receipt.gasUsed), selected: choice.ok ? Number(choice.gasLimit) : null, selectedFrom: choice.ok ? (choice.attempts.length > 1 ? "escalated" : choice.estimate !== null && choice.gasLimit > choice.predicted ? "estimate+25%" : "prediction") : `FAILED:${choice.kind}`, simulations: choice.attempts.length,
      releasedSucceeds: atReleased.ok, releasedFailure: atReleased.ok ? null : { code: atReleased.code, revert: atReleased.revert, data: atReleased.data } });
    size += count;
    if (b % 20 === 0) process.stderr.write(`batch ${b}: count ${count}, size ${size}, needed ${hi}, released ${released} ${atReleased.ok ? "ok" : "FAILS"}\n`);
  }
} finally {
  world.stop();
}
const failing = rows.filter((r) => !r.releasedSucceeds);
const summary = { pattern, batches: rows.length, finalTreeSize: size, releasedFails: failing.length, firstFailure: failing[0] ?? null,
  failuresByCount: Object.fromEntries([...new Set(rows.map((r) => r.count))].sort((a, b) => a - b).map((c) => [c, `${failing.filter((r) => r.count === c).length}/${rows.filter((r) => r.count === c).length}`])),
  modelBelowNeeded: rows.filter((r) => r.currentModel < r.needed).length, estimateFailed: rows.filter((r) => r.estimate === null).length,
  maxNeededOverReleased: Math.max(...rows.map((r) => r.needed / r.released)), maxNeededOverModel: Math.max(...rows.map((r) => r.needed / r.currentModel)),
  maxNeededOverGasUsed: Math.max(...rows.map((r) => r.needed / r.gasUsed)),
  selectionFailed: rows.filter((r) => r.selected === null).length, selectedBelowNeeded: rows.filter((r) => r.selected !== null && r.selected < r.needed).length,
  selectedFrom: rows.reduce((m, r) => ((m[r.selectedFrom] = (m[r.selectedFrom] ?? 0) + 1), m), {}), maxSimulations: Math.max(...rows.map((r) => r.simulations)),
  selectedOverNeeded: { min: Math.min(...rows.map((r) => r.selected / r.needed)), max: Math.max(...rows.map((r) => r.selected / r.needed)) } };
const out = args.out ?? `batch-gas-${pattern}.json`;
fs.writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
