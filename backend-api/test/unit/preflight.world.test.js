import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "ethers";
import { runPreflight } from "../../src/chain/preflight.js";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { hardhatAccount } from "../helpers/env.js";
import { fakeWorld } from "../helpers/fake-chain.js";

// A complete in-memory deployment (see helpers/fake-chain.js): every test breaks exactly ONE thing and
// asserts that exactly the matching check notices. Passing is only meaningful if each failure is detectable.
const run = (world, extra = {}) =>
  runPreflight({ deployment: world.deployment, provider: world.provider, contract: world.contract, signers: world.signers, mongo: world.mongo, ...extra });
const byName = (report, name) => report.checks.find((c) => c.name === name);
const failed = (report) => report.checks.filter((c) => c.status === "fail").map((c) => c.name);
const warned = (report) => report.checks.filter((c) => c.status === "warn").map((c) => c.name);

const ALL_CHECKS = [
  "mongo.connectivity", "rpc.connectivity", "chain.id", "contract.bytecode", "signers.distinct", "contract.electionId", "contract.phase",
  "contract.owner", "contract.authoritySigner", "contract.relayer", "eip712.domain", "eip712.typehash", "eip712.digest", "relayer.balance", "election.config",
];

describe("preflight against a complete fake deployment", () => {
  it("a healthy deployment passes every check (so each failure below is attributable to its one change)", async () => {
    const report = await run(fakeWorld());
    assert.deepEqual(report.checks.map((c) => c.name), ALL_CHECKS);
    assert.deepEqual(report.checks.filter((c) => c.status !== "pass"), []);
    assert.equal(report.ok, true);
    assert.equal(report.status, "pass");
    assert.deepEqual(byName(report, "election.config").details, { constituencyCount: 2, candidateCount: 5, totalBallots: 0 });
    assert.equal(report.snapshot.phase, "Setup");
    assert.equal(report.snapshot.latestBlock, 12);
  });

  it("only plain reads ever reach the provider or the contract (nothing can send a transaction)", async () => {
    const world = fakeWorld();
    await run(world);
    assert.deepEqual([...world.touched.rpcMethods], ["eth_chainId"]);
    const writeLike = /^(send|cast|transfer|broadcast|sign|open|close|add|set|register|vote|approve|renounce|accept|change|remove|revoke)/i;
    for (const name of [...world.touched.provider, ...world.touched.contract]) {
      if (name === "send") continue; // provider.send, restricted to eth_chainId above
      assert.ok(!writeLike.test(name), `preflight touched ${name}`);
    }
  });

  it("addresses are compared as addresses: lower-case or upper-case forms from a node still match", async () => {
    const lower = (a) => a.toLowerCase();
    const report = await run(
      fakeWorld({
        owner: lower(hardhatAccount(0).address),
        authoritySigner: lower(hardhatAccount(1).address),
        relayer: lower(hardhatAccount(2).address),
        domain: { name: "VoteChain", version: "2", chainId: 31337n, verifyingContract: lower("0x5FbDB2315678afecb367f032d93F642f64180aa3") },
      }),
    );
    assert.deepEqual(failed(report), []);
    assert.equal(report.status, "pass");
  });

  it("the election id is compared case-insensitively", async () => {
    const report = await run(fakeWorld({ electionId: "0x" + "AB".repeat(32) }), {
      deployment: { chainId: 31337, contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3", electionId: "0x" + "ab".repeat(32) },
    });
    assert.deepEqual(failed(report), []);
  });

  it("a different election id fails contract.electionId (and, consequently, the digest self-test)", async () => {
    const report = await run(fakeWorld({ electionId: "0x" + "22".repeat(32) }));
    // the digest check also notices: the contract hashes with ITS election id, the backend with the configured one
    assert.deepEqual(failed(report), ["contract.electionId", "eip712.digest"]);
    assert.equal(report.ok, false);
  });

  for (const [role, field, check] of [
    ["owner", "owner", "contract.owner"],
    ["authority", "authoritySigner", "contract.authoritySigner"],
    ["relayer", "relayer", "contract.relayer"],
  ]) {
    it(`a ${role} on chain that is not the configured signer fails exactly ${check}`, async () => {
      const report = await run(fakeWorld({ [field]: hardhatAccount(9).address }));
      assert.deepEqual(failed(report), [check]);
      assert.equal(report.ok, false);
      assert.equal(byName(report, check).details.signer, hardhatAccount(["owner", "authority", "relayer"].indexOf(role)).address);
    });
  }

  it("a pending ownership transfer is a warning, not a failure", async () => {
    const report = await run(fakeWorld({ pendingOwner: hardhatAccount(9).address }));
    assert.deepEqual(failed(report), []);
    assert.deepEqual(warned(report), ["contract.owner"]);
    assert.equal(report.ok, true);
    assert.equal(report.status, "warn");
  });

  it("an owner mismatch is still a failure even when a transfer is pending", async () => {
    const report = await run(fakeWorld({ owner: hardhatAccount(8).address, pendingOwner: hardhatAccount(9).address }));
    assert.equal(byName(report, "contract.owner").status, "fail");
  });
});

describe("preflight: the EIP-712 protocol checks each notice their own kind of drift", () => {
  it("a different type hash fails exactly eip712.typehash", async () => {
    const report = await run(fakeWorld({ typehash: "0x" + "cd".repeat(32) }));
    assert.deepEqual(failed(report), ["eip712.typehash"]);
    assert.equal(report.ok, false);
  });

  it("a contract that hashes differently fails exactly eip712.digest", async () => {
    const report = await run(fakeWorld({ digestOverride: "0x" + "ee".repeat(32) }));
    assert.deepEqual(failed(report), ["eip712.digest"]);
    assert.equal(byName(report, "eip712.digest").details.contract, "0x" + "ee".repeat(32));
    assert.equal(report.ok, false);
  });

  for (const [what, patch] of [
    ["name", { name: "OtherApp" }],
    ["version", { version: "1" }],
    ["chain id", { chainId: 1n }],
    ["verifying contract", { verifyingContract: hardhatAccount(5).address }],
  ]) {
    it(`a contract domain with a different ${what} fails eip712.domain`, async () => {
      const base = { name: "VoteChain", version: "2", chainId: 31337n, verifyingContract: "0x5FbDB2315678afecb367f032d93F642f64180aa3" };
      const report = await run(fakeWorld({ domain: { ...base, ...patch } }));
      assert.equal(byName(report, "eip712.domain").status, "fail", what);
      assert.equal(report.ok, false);
    });
  }
});

describe("preflight: relayer balance semantics", () => {
  const minimum = parseEther("0.01");
  it("zero fails, below the minimum warns, exactly the minimum and above pass", async () => {
    assert.equal(byName(await run(fakeWorld({ balance: 0n })), "relayer.balance").status, "fail");
    assert.equal(byName(await run(fakeWorld({ balance: 1n })), "relayer.balance").status, "warn");
    assert.equal(byName(await run(fakeWorld({ balance: minimum - 1n })), "relayer.balance").status, "warn");
    assert.equal(byName(await run(fakeWorld({ balance: minimum })), "relayer.balance").status, "pass");
    assert.equal(byName(await run(fakeWorld({ balance: minimum + 1n })), "relayer.balance").status, "pass");
  });

  it("the minimum is 0.01 of the native token unless told otherwise", async () => {
    const world = fakeWorld({ balance: parseEther("0.02") });
    assert.equal(byName(await run(world), "relayer.balance").status, "pass");
    assert.equal(byName(await run(world, { minRelayerBalanceWei: parseEther("0.05") }), "relayer.balance").status, "warn");
    assert.equal(byName(await run(fakeWorld({ balance: parseEther("0.005") })), "relayer.balance").status, "warn");
  });

  it("the balance is that of the RELAYER address", async () => {
    const world = fakeWorld();
    const seen = [];
    const provider = {
      getBlockNumber: () => world.provider.getBlockNumber(),
      getCode: (a) => world.provider.getCode(a),
      send: (...a) => world.provider.send(...a),
      getBalance: async (address) => (seen.push(address), world.provider.getBalance(address)),
    };
    await run(world, { provider });
    assert.deepEqual(seen, [hardhatAccount(2).address]);
  });
});

describe("preflight: the election configuration check", () => {
  it("a constituency count that disagrees with the enumeration fails (the chain changed between two reads)", async () => {
    const report = await run(fakeWorld({ constituencyCountOverride: [3, 2] }));
    assert.equal(byName(report, "election.config").status, "fail");
    assert.match(byName(report, "election.config").message, /constituency count mismatch/);
  });

  it("a candidate count that disagrees with the enumeration fails (the chain changed between two reads)", async () => {
    const report = await run(fakeWorld({ candidateCountOverride: [5, 4] }));
    assert.equal(byName(report, "election.config").status, "fail");
    assert.match(byName(report, "election.config").message, /candidate count mismatch/);
  });

  it("a constituency whose id is not keccak256(code) fails and names the code", async () => {
    const report = await run(fakeWorld({ constituencyIdOverrides: { "DL-DEL": constituencyIdOf("dl-del") } }));
    const check = byName(report, "election.config");
    assert.equal(check.status, "fail");
    assert.match(check.message, /keccak256\(code\) for: DL-DEL/);
  });

  it("a candidate that points at an unknown constituency fails", async () => {
    const report = await run(fakeWorld({ candidateConstituencyOverrides: { 2: constituencyIdOf("NOWHERE") } }));
    const check = byName(report, "election.config");
    assert.equal(check.status, "fail");
    assert.match(check.message, /unknown constituency/);
  });

  it("a constituency without candidates warns during Setup and fails once the election is open", async () => {
    const world = (phase) => fakeWorld({ phase, constituencies: [{ code: "KA-BLR", name: "Bengaluru", candidates: ["Asha"] }, { code: "DL-DEL", name: "Delhi", candidates: [] }] });
    const setup = await run(world(0n));
    assert.equal(byName(setup, "election.config").status, "warn");
    assert.match(byName(setup, "election.config").message, /without candidates: DL-DEL/);
    assert.equal(setup.ok, true);
    for (const phase of [1n, 2n]) {
      const report = await run(world(phase));
      assert.equal(byName(report, "election.config").status, "fail", `phase ${phase}`);
      assert.equal(report.ok, false);
    }
  });

  it("no constituencies at all is a warning (nothing to vote on yet)", async () => {
    const report = await run(fakeWorld({ constituencies: [] }));
    assert.equal(byName(report, "election.config").status, "warn");
    assert.match(byName(report, "election.config").message, /no constituencies/);
  });

  it("the shallow probe does not enumerate", async () => {
    const world = fakeWorld();
    const report = await run(world, { deep: false });
    assert.equal(byName(report, "election.config"), undefined);
    assert.ok(!world.touched.contract.has("getConstituencyIds"));
    assert.ok(!world.touched.contract.has("getCandidate"));
  });
});

describe("preflight: reads that fail", () => {
  it("a contract that reverts on ELECTION_ID() fails the dependent checks without throwing, and says 'not checked' for the enumeration", async () => {
    const report = await run(fakeWorld({ failing: new Set(["ELECTION_ID"]) }));
    assert.equal(report.ok, false);
    assert.equal(byName(report, "contract.electionId").status, "fail");
    assert.equal(byName(report, "contract.owner").status, "fail");
    assert.match(byName(report, "election.config").message, /not checked/);
    assert.equal(report.snapshot, undefined);
  });

  it("a revert in a later read fails only that check", async () => {
    const report = await run(fakeWorld({ failing: new Set(["BALLOT_AUTHORIZATION_TYPEHASH"]) }));
    assert.deepEqual(failed(report), ["eip712.typehash"]);
  });

  it("a revert in hashAuthorization fails eip712.digest", async () => {
    const report = await run(fakeWorld({ failing: new Set(["hashAuthorization"]) }));
    assert.deepEqual(failed(report), ["eip712.digest"]);
  });

  it("a wrong network never lets a contract read happen", async () => {
    const world = fakeWorld({ chainId: 1n });
    const report = await run(world);
    assert.equal(byName(report, "chain.id").status, "fail");
    assert.equal(world.touched.contract.size, 0);
    assert.ok(!world.touched.provider.has("getCode"));
    assert.ok(!world.touched.provider.has("getBalance"));
  });

  it("an address without code stops every contract read", async () => {
    const world = fakeWorld({ code: "0x" });
    const report = await run(world);
    assert.equal(byName(report, "contract.bytecode").status, "fail");
    assert.equal(world.touched.contract.size, 0);
    assert.ok(!world.touched.provider.has("getBalance"));
  });

  it("an unreachable RPC node fails everything that depends on it", async () => {
    const world = fakeWorld({ failing: new Set(["getBlockNumber"]) });
    const report = await run(world);
    assert.equal(byName(report, "rpc.connectivity").status, "fail");
    assert.equal(world.touched.contract.size, 0);
    assert.ok(!world.touched.provider.has("getCode"));
    assert.ok(!world.touched.provider.has("send"));
  });

  it("'ok' is false whenever any check failed, even if it is the only one", async () => {
    for (const patch of [{ balance: 0n }, { typehash: "0x" + "00".repeat(32) }, { code: "0x" }, { owner: hardhatAccount(9).address }]) {
      const report = await run(fakeWorld(patch));
      assert.equal(report.ok, false, JSON.stringify(Object.keys(patch)));
      assert.equal(report.status, "fail");
    }
  });

  it("warnings never turn a report into a failure, and a warning-only report has status 'warn'", async () => {
    const report = await run(fakeWorld({ balance: 1n }));
    assert.equal(report.ok, true);
    assert.equal(report.status, "warn");
  });
});
