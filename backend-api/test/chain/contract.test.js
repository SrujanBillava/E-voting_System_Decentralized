import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { readCandidates, readConstituencies, readElectionState } from "../../src/chain/contract.js";
import { resolveDeployment } from "../../src/chain/deployment.js";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { readRemoteChainId } from "../../src/chain/provider.js";
import { loadEnv } from "../../src/config/env.js";
import { hardhatAccount, validEnv } from "../helpers/env.js";
import { assertPristineLocalChain, localServices, readLocalMetadata } from "../helpers/chain.js";

// Requires the local chain: smart-contract/ `npm run node` + `npm run deploy:local` (election in Setup).
const KNOWN_IDS = {
  "KA-BLR": "0x75f991e87d3f7b7d5dc6818f5d1573a6d671f3a242e91e03133d7ef3a5e97eeb",
};

describe("chain: reading the deployed Voting V2 contract", () => {
  let s;
  let meta;
  before(async () => {
    meta = readLocalMetadata();
    s = localServices();
    await assertPristineLocalChain(s);
  });
  after(() => s?.destroy());

  it("connects to the configured chain", async () => {
    assert.equal(await readRemoteChainId(s.provider), BigInt(s.deployment.chainId));
    assert.equal(s.deployment.source, "environment");
  });

  it("the contract address has bytecode", async () => {
    assert.notEqual(await s.provider.getCode(s.deployment.contractAddress), "0x");
  });

  it("reads election id, phase Setup, owner, authority and relayer", async () => {
    const state = await readElectionState(s.contract);
    assert.equal(state.electionId, meta.electionId);
    assert.equal(state.electionId, s.deployment.electionId);
    assert.equal(state.phase, "Setup");
    assert.equal(state.phaseIndex, 0);
    assert.equal(state.owner, meta.owner);
    assert.equal(state.authoritySigner, meta.authoritySigner);
    assert.equal(state.relayer, meta.relayer);
    assert.equal(state.pendingOwner, "0x0000000000000000000000000000000000000000");
  });

  it("owner, authority and relayer are three distinct accounts and match the backend signers", async () => {
    const state = await readElectionState(s.contract);
    assert.equal(new Set([state.owner, state.authoritySigner, state.relayer]).size, 3);
    assert.equal(state.owner, s.signers.addresses.owner);
    assert.equal(state.authoritySigner, s.signers.addresses.authority);
    assert.equal(state.relayer, s.signers.addresses.relayer);
    assert.equal(s.signers.addresses.owner, hardhatAccount(0).address);
  });

  it("reads 3 constituencies, 18 candidates, 0 ballots", async () => {
    const state = await readElectionState(s.contract);
    assert.equal(state.constituencyCount, 3);
    assert.equal(state.candidateCount, 18);
    assert.equal(state.totalBallots, 0);
  });

  it("constituency ids on chain are exactly keccak256(code): the contract and the backend agree", async () => {
    const constituencies = await readConstituencies(s.contract);
    assert.deepEqual(constituencies.map((c) => c.code), ["KA-BLR", "DL-DEL", "MH-MUM"]);
    assert.deepEqual(constituencies.map((c) => c.name), ["Bengaluru", "Delhi", "Mumbai"]);
    for (const c of constituencies) {
      assert.equal(c.id, constituencyIdOf(c.code), c.code);
      assert.equal(c.idMatchesCode, true);
    }
    // pinned literals, now verified against a deployed contract
    assert.equal(constituencyIdOf("KA-BLR"), KNOWN_IDS["KA-BLR"]);
    for (const c of constituencies) assert.equal(c.id, meta.constituencies.find((m) => m.code === c.code).id);
  });

  it("candidate ids are grouped per constituency as seeded", async () => {
    const constituencies = await readConstituencies(s.contract);
    const ids = Object.fromEntries(constituencies.map((c) => [c.code, c.candidateIds]));
    assert.deepEqual(ids["KA-BLR"], [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(ids["DL-DEL"], [8, 9, 10, 11, 12, 13]);
    assert.deepEqual(ids["MH-MUM"], [14, 15, 16, 17, 18]);
  });

  it("reads all 18 candidates with names and constituencies matching the deployment metadata", async () => {
    const constituencies = await readConstituencies(s.contract);
    const candidates = await readCandidates(s.contract, constituencies);
    assert.equal(candidates.length, 18);
    assert.deepEqual(
      candidates.map((c) => [c.id, c.name, c.constituencyCode, c.constituencyId]),
      meta.candidates.map((c) => [c.id, c.name, c.constituencyCode, c.constituencyId]),
    );
    assert.ok(candidates.every((c) => c.constituencyCode !== null));
    assert.equal(candidates[0].name, "Amit Sharma");
  });

  it("every constituency has at least one candidate", async () => {
    for (const c of await readConstituencies(s.contract)) assert.ok(c.candidateIds.length > 0, c.code);
  });
});

describe("chain: local deployment convenience", () => {
  let s;
  before(() => {
    s = localServices({ CHAIN_ID: undefined, VOTING_CONTRACT_ADDRESS: undefined, ELECTION_ID: undefined });
  });
  after(() => s?.destroy());

  it("with the coordinates unset, development falls back to smart-contract/deployments/local.json", () => {
    const meta = readLocalMetadata();
    assert.equal(s.deployment.source, "local-metadata");
    assert.equal(s.deployment.contractAddress, meta.contractAddress);
    assert.equal(s.deployment.chainId, meta.chainId);
    assert.equal(s.deployment.electionId, meta.electionId);
  });

  it("explicit environment values win, and production would never read the file", () => {
    const config = loadEnv(validEnv({ CHAIN_ID: "31337", VOTING_CONTRACT_ADDRESS: "0x5FbDB2315678afecb367f032d93F642f64180aa3", ELECTION_ID: "0x" + "11".repeat(32) }));
    assert.equal(resolveDeployment(config, { readFile: () => assert.fail("must not read") }).electionId, "0x" + "11".repeat(32));
  });
});
