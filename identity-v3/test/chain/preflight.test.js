import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Wallet, getAddress } from "ethers";
import { runPreflight } from "../../src/chain/preflight.js";
import { composeIdentity } from "../../src/compose.js";
import { createMemoryLogger } from "../../src/utils/logger.js";
import { configFor } from "../helpers/env.js";
import { contractsCompiled, newWorld } from "../helpers/world.js";

const skip = contractsCompiled ? false : "compile ../smart-contract-v3 first (npm run compile)";

describe("identity-v3 startup preflight: the right contract, the right role, four distinct roles", { skip }, () => {
  let world; // an OPEN election: its issuer is the real issuer account
  let setup; // an election still in SETUP, in which the issuer can still be chosen
  const memory = createMemoryLogger();
  const compose = (w, config) => composeIdentity({ config, logger: memory.logger, provider: w.provider, bcryptCost: 4 });

  before(async () => {
    world = await newWorld();
    setup = await newWorld({ open: false });
  });
  after(() => {
    world?.stop();
    setup?.stop();
  });

  it("accepts the real issuer and reports its address", async () => {
    const config = configFor(world);
    const facts = await runPreflight(compose(world, config).chain, config);
    assert.equal(facts.issuer, world.issuer.address);
    assert.equal(facts.maxBatch, 128);
    assert.ok(facts.balance > 0n);
  });

  it("refuses a key that is NOT the contract's issuer (including the relayer's and a random one)", async () => {
    for (const wallet of [world.relayer, Wallet.createRandom()]) {
      const config = configFor(world, { ISSUER_PRIVATE_KEY: wallet.privateKey });
      await assert.rejects(runPreflight(compose(world, config).chain, config), (err) => err.code === "ISSUER_MISMATCH");
    }
  });

  it("refuses an issuer key that is ALSO the contract owner or a pinned trustee (four distinct roles)", async () => {
    await (await setup.voteChain.setIssuer(setup.owner.address)).wait();
    const asOwner = configFor(setup, { ISSUER_PRIVATE_KEY: setup.owner.privateKey });
    await assert.rejects(runPreflight(compose(setup, asOwner).chain, asOwner), (err) => err.code === "ROLE_CONFLICT" && /owner/.test(err.message));
    await (await setup.voteChain.setIssuer(setup.trustees[0].address)).wait();
    const asTrustee = configFor(setup, { ISSUER_PRIVATE_KEY: setup.trustees[0].privateKey });
    await assert.rejects(runPreflight(compose(setup, asTrustee).chain, asTrustee), (err) => err.code === "ROLE_CONFLICT" && /trustee/.test(err.message));
  });

  it("refuses another chain, a missing contract, another election id", async () => {
    const wrongChain = configFor(world, { CHAIN_ID: "1" });
    await assert.rejects(runPreflight(compose(world, wrongChain).chain, wrongChain), (err) => err.code === "CHAIN_ID_MISMATCH");
    const wrongAddress = configFor(world, { VOTECHAIN_V3_ADDRESS: getAddress("0x00000000000000000000000000000000000000aa") });
    await assert.rejects(runPreflight(compose(world, wrongAddress).chain, wrongAddress), (err) => err.code === "NO_CONTRACT");
    const wrongElection = configFor(world, { ELECTION_ID: "0x" + "11".repeat(32) });
    await assert.rejects(runPreflight(compose(world, wrongElection).chain, wrongElection), (err) => err.code === "ELECTION_ID_MISMATCH");
  });
});
