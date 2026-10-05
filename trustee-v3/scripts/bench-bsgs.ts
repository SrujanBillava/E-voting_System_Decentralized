// Benchmark of bounded integer recovery (baby-step giant-step) for the ballot counts the system can reach.
//   node scripts/bench-bsgs.ts                 100, 1,000, 10,000, 100,000, 1,000,000
//   node scripts/bench-bsgs.ts --extended      also 10,000,000 and 100,000,000
// For each bound: the one-off table build, the solve time for the WORST case (t = bound: the most giant steps) and for random t, and a correctness check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BoundedDiscreteLog } from "../src/bsgs.ts";
import { G } from "../src/params.ts";
import { mul } from "../src/point.ts";

const bounds = [100, 1_000, 10_000, 100_000, 1_000_000, ...(process.argv.includes("--extended") ? [10_000_000, 100_000_000] : [])];
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
const fmt = (n: number): string => (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n).toString());

const rows = bounds.map((bound) => {
  const builds: number[] = [];
  let table!: BoundedDiscreteLog;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    table = new BoundedDiscreteLog(bound);
    builds.push(performance.now() - t0);
  }
  const worstPoint = mul(G, BigInt(bound));
  const worst: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    const t = table.solve(worstPoint);
    worst.push(performance.now() - t0);
    if (t !== bound) throw new Error(`BSGS failed for t = bound = ${bound}`);
  }
  const random: number[] = [];
  for (let i = 0; i < 21; i++) {
    const target = Math.floor(Math.random() * (bound + 1));
    const point = mul(G, BigInt(target));
    const t0 = performance.now();
    const t = table.solve(point);
    random.push(performance.now() - t0);
    if (t !== target || !BoundedDiscreteLog.confirm(t, point)) throw new Error(`BSGS failed for t = ${target}`);
  }
  const absent = (() => {
    const t0 = performance.now();
    const t = table.solve(mul(G, BigInt(bound + 1)));
    if (t !== null) throw new Error("a value above the bound must not be found");
    return performance.now() - t0;
  })();
  return { ballotCount: bound, babySteps: table.babySteps, tableBuildMs: median(builds), solveWorstCaseMs: median(worst), solveRandomMs: median(random), solveAboveBoundMs: absent };
});

console.log("ballots      baby steps   table build (ms)   solve worst (ms)   solve random (ms)   above bound (ms)");
for (const r of rows) console.log(`${String(r.ballotCount).padStart(11)}  ${String(r.babySteps).padStart(10)}  ${fmt(r.tableBuildMs).padStart(17)}  ${fmt(r.solveWorstCaseMs).padStart(17)}  ${fmt(r.solveRandomMs).padStart(18)}  ${fmt(r.solveAboveBoundMs).padStart(17)}`);

const out = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "results", "bsgs-benchmark.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ note: "median timings; one BSGS table per bound (cached across slots); pure JavaScript BabyJubJub (@zk-kit/baby-jubjub 1.0.3), single thread", node: process.version, cpu: os.cpus()[0]?.model, rows }, null, 2) + "\n");
console.log(`\nwritten ${path.relative(process.cwd(), out)}`);
