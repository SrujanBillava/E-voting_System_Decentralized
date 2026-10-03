import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { Interface } from "ethers";
import { PHASES, REQUIRED_FUNCTIONS, VOTING_EXPORT_URL, exportedEip712, loadVotingExport, votingAbi, votingInterface } from "../../src/chain/abi.js";

const CONTRACT_EXPORT = new URL("../../../smart-contract/exports/Voting.json", import.meta.url);

describe("abi", () => {
  it("loads the committed export and builds an interface", () => {
    assert.ok(votingAbi.length > 10);
    assert.deepEqual(PHASES, ["Setup", "Open", "Closed"]);
    assert.ok(votingInterface instanceof Interface);
  });

  it("castVote has the exact protocol signature (candidateId before deadline; relayer is not a parameter)", () => {
    const f = votingInterface.getFunction("castVote");
    assert.equal(f.format("full"), "function castVote(bytes32 constituencyId, bytes32 nullifier, uint256 candidateId, uint256 deadline, bytes signature)");
  });

  it("hashAuthorization takes (constituencyId, nullifier, candidateId, relayer, deadline)", () => {
    assert.equal(
      votingInterface.getFunction("hashAuthorization").format("full"),
      "function hashAuthorization(bytes32 constituencyId, bytes32 nullifier, uint256 candidateId, address relayer_, uint256 deadline) view returns (bytes32)",
    );
  });

  it("the backend copy is byte-identical to smart-contract/exports/Voting.json when the monorepo is present", (t) => {
    if (!fs.existsSync(CONTRACT_EXPORT)) return t.skip("smart-contract/ not present (standalone backend checkout)");
    assert.equal(fs.readFileSync(VOTING_EXPORT_URL, "utf8"), fs.readFileSync(CONTRACT_EXPORT, "utf8"), 'out of sync: run "npm run sync:abi"');
  });

  it("refuses an ABI that lacks a function the backend depends on", () => {
    const real = JSON.parse(fs.readFileSync(VOTING_EXPORT_URL, "utf8"));
    const stale = { ...real, abi: real.abi.filter((e) => e.name !== "hashAuthorization") };
    const file = new URL(`file:///${process.env.TMPDIR ?? "/tmp"}/stale-voting-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(stale));
    try {
      assert.throws(() => loadVotingExport(file), /missing required function "hashAuthorization"/);
    } finally {
      fs.rmSync(file);
    }
  });
});

// Writes a (possibly broken) copy of the committed export to a temp file and loads it.
function loadVariant(change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "votechain-abi-"));
  const file = path.join(dir, "Voting.json");
  try {
    const real = JSON.parse(fs.readFileSync(VOTING_EXPORT_URL, "utf8"));
    fs.writeFileSync(file, typeof change === "string" ? change : JSON.stringify(change(structuredClone(real))));
    return loadVotingExport(pathToFileURL(file));
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("abi loader robustness", () => {
  it("an unmodified copy loads, and the result is immutable", () => {
    const loaded = loadVariant((x) => x);
    assert.equal(loaded.contractName, "Voting");
    assert.ok(Object.isFrozen(loaded));
  });

  it("the required-function list covers every member the backend uses (castVote and hashAuthorization included)", () => {
    for (const name of ["ELECTION_ID", "BALLOT_AUTHORIZATION_TYPEHASH", "phase", "owner", "authoritySigner", "relayer", "eip712Domain", "hashAuthorization", "castVote", "nullifierUsed", "getConstituencyIds", "getCandidate"]) {
      assert.ok(REQUIRED_FUNCTIONS.includes(name), `${name} should be required`);
    }
  });

  for (const name of REQUIRED_FUNCTIONS) {
    it(`refuses an ABI without ${name}`, () => {
      assert.throws(() => loadVariant((x) => ({ ...x, abi: x.abi.filter((e) => e.name !== name) })), new RegExp(`missing required function "${name}"`));
    });
  }

  it("refuses structurally wrong exports", () => {
    assert.throws(() => loadVariant((x) => ({ ...x, contractName: "NotVoting" })));
    assert.throws(() => loadVariant((x) => ({ ...x, phases: ["Setup", "Open"] })));
    assert.throws(() => loadVariant((x) => ({ ...x, phases: ["Setup", "Open", "Closed", "Archived"] })));
    assert.throws(() => loadVariant((x) => ({ ...x, eip712: { ...x.eip712, primaryType: "Other" } })));
    assert.throws(() => loadVariant((x) => ({ ...x, eip712: undefined })));
    assert.throws(() => loadVariant((x) => ({ ...x, abi: [] })));
    assert.throws(() => loadVariant((x) => ({ ...x, abi: "nope" })));
    assert.throws(() => loadVariant("{ not json"));
    assert.throws(() => loadVariant("null"));
  });

  it("a missing file fails loudly rather than yielding an empty ABI", () => {
    assert.throws(() => loadVotingExport(pathToFileURL(path.join(os.tmpdir(), "votechain-does-not-exist.json"))), /ENOENT/);
  });

  it("the eip712 section of the real export matches the protocol constants", () => {
    assert.equal(exportedEip712.domainName, "VoteChain");
    assert.equal(exportedEip712.domainVersion, "2");
    assert.equal(exportedEip712.primaryType, "BallotAuthorization");
  });
});

