// REPRODUCTION (not part of the test suite): the batcher meets a small batch whose gas need exceeds its limit and what it does about it, tick after tick.
//   MONGODB_TEST_URI=mongodb://127.0.0.1:27017/<name containing test> node test/chain/stuck-batch.repro.js
import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { composeIdentity, MODELS } from "../../src/compose.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { closeDb, connectTestDb, resetDb } from "../helpers/db.js";
import { configFor } from "../helpers/env.js";
import { newWorld } from "../helpers/world.js";

const { CredentialIssuance, CommitmentBatch } = MODELS;
await connectTestDb();
await resetDb();
const world = await newWorld({ constituencies: { BATCH: { kc: 2, cap: 1000 } } });
try {
  const config = configFor(world);
  const memory = createMemoryLogger({ level: "info", secrets: [] });
  const identity = composeIdentity({ config, logger: memory.logger, provider: world.provider, clock: world.clock, bcryptCost: 4 });
  await identity.chain.init();
  const vc = world.voteChain.connect(world.issuer);
  const rnd = () => BigInt("0x" + randomBytes(31).toString("hex"));
  // grow the group out of band with single commitments, one per epoch, to 31 members
  for (let i = 0; i < 31; i++) {
    await world.nextEpoch();
    await (await vc.registerCommitmentBatch(world.ids.BATCH, [rnd()], { gasLimit: 2_000_000n })).wait();
  }
  const now = await world.clock.nowSeconds();
  const commitments = Array.from({ length: 4 }, () => rnd().toString());
  await CredentialIssuance.insertMany(commitments.map((commitment, i) => ({ _id: `r-${i}`, electionId: world.electionId, voterId: new mongoose.Types.ObjectId(), state: "RESERVED", commitment, constituencyId: world.ids.BATCH, reservedAt: now + i, reservedEpoch: Math.floor(now / 30), failures: 0 })));
  await world.nextEpoch();
  for (let t = 1; t <= 5; t++) {
    const report = await identity.batcher.tick();
    const batch = await CommitmentBatch.findOne({});
    const states = Object.fromEntries((await CredentialIssuance.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
    console.log(`tick ${t}:`, JSON.stringify({ resumed: report.resumed, formed: report.formed.map((f) => ({ status: f.status, outcome: f.outcome })), batchState: batch?.state, records: states }));
    await world.nextEpoch();
  }
  console.log("log messages:", [...new Set(memory.lines.map((l) => JSON.parse(l).msg))]);
} finally {
  world.stop();
  await closeDb();
}
