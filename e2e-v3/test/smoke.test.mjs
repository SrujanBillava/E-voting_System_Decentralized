import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createVoter } from "../../identity-v3/test/helpers/journey.js";
import { shutdownProver } from "../../privacy-v3/src/validity.js";
import { nodeKiosk, testFace } from "../lib/node-kiosk.mjs";
import { startStack } from "../lib/stack.mjs";

const identityUri = process.env.MONGODB_TEST_URI;
const relayUri = process.env.MONGODB_RELAY_TEST_URI;
const skip = identityUri && relayUri ? false : "set MONGODB_TEST_URI and MONGODB_RELAY_TEST_URI";

describe("smoke: one voter through the real stack", { skip }, () => {
  let stack;
  before(async () => {
    stack = await startStack({ identityUri, relayUri });
  });
  after(async () => {
    await shutdownProver(); // the snarkjs worker threads would otherwise keep the test process alive
    await stack?.stop();
  });
  it("login -> face -> credential -> public group -> ballot -> relay -> chain -> receipt", async () => {
    const voter = await createVoter(stack.identityConfig, { n: 1 });
    const { kiosk, storage } = nodeKiosk(stack);
    await kiosk.login(voter.email, voter.password);
    await kiosk.verifyFace(testFace(1));
    const began = await kiosk.beginCredential();
    assert.equal(began.constituency.code, "KA-BLR");
    await stack.world.nextEpoch();
    assert.equal(await kiosk.awaitCredential(), "ISSUED");
    const open = await kiosk.openBallot();
    assert.equal(open.params.kc, 3);
    const t = performance.now();
    const outcome = await kiosk.castVote({ choice: 1, open });
    console.log("cast in", Math.round(performance.now() - t), "ms", JSON.stringify(kiosk.lastTimings));
    assert.equal(outcome.kind, "RECORDED");
    console.log(JSON.stringify(outcome.receipt, null, 1), JSON.stringify(storage.dump()).slice(0, 300));
  });
});
