// Semaphore V4 at the FROZEN depth 20, with the pinned local artifacts of @semaphore-protocol/proof 4.14.3 (artifact set 4.13.0).
// Proves: generation and verification work at depth 20 for groups of any natural depth, the nullifier does not depend on the depth, the artifacts are the
// pinned ones, and nothing is ever downloaded at runtime (every network entry point is trapped while proving and verifying).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { after, describe, it } from "node:test";
import { Group } from "@semaphore-protocol/group";
import { Project, maybeGetSnarkArtifacts } from "@zk-kit/artifacts";
import { ROOT, semaphoreArtifacts } from "../src/artifacts.js";
import { ballotHash } from "../src/ballot.js";
import { identityCiphertext } from "../src/elgamal.js";
import { K_MAX, SEMAPHORE_DEPTH, TEST_CONTEXT, constituencyIdValue, electionScope } from "../src/params.js";
import { makeGroup, nullifierOf, proveMembership, verifyMembership } from "../src/semaphore.js";
import { shutdownProver } from "../src/validity.js";
import { fakeVoter } from "../testing/fake-voters.js";
import { SKIP_NO_ARTIFACTS } from "./helpers.mjs";

// Independent copy of the pins in scripts/build-circuit.mjs: artifact set 4.13.0, the one @semaphore-protocol/proof 4.14.3 requests.
const PINNED = {
  "semaphore-3.wasm": "48e15502f710be0a623d573d472edeeaf918fd5eee0b2ca9b407c4e4f20d12f2",
  "semaphore-3.zkey": "c36653c42784df35a01f3d93415af9ad8292a540f8deb134a6a34a01752a89d3",
  "semaphore-20.wasm": "6f71e55586929e520e76027ebe067daac8b41e2f4b8057313a5fd0304e1e44ee",
  "semaphore-20.zkey": "33f9a067a80c7daf90e085449073613a9559a1904dd40aeb6d603afb7988c2cc",
};

/** Make every way of opening a network connection from this thread fail loudly, and record the attempt. */
function trapNetwork() {
  const attempts = [];
  const saved = [];
  const patch = (obj, key, label) => {
    saved.push([obj, key, obj[key]]);
    obj[key] = () => {
      attempts.push(label);
      throw new Error(`network access blocked by the test: ${label}`);
    };
  };
  patch(globalThis, "fetch", "fetch");
  for (const [mod, name] of [[http, "http"], [https, "https"]]) {
    patch(mod, "request", `${name}.request`);
    patch(mod, "get", `${name}.get`);
  }
  patch(net, "connect", "net.connect");
  patch(net, "createConnection", "net.createConnection");
  patch(tls, "connect", "tls.connect");
  syncBuiltinESMExports();
  return {
    attempts,
    restore() {
      for (const [obj, key, original] of saved.reverse()) obj[key] = original;
      syncBuiltinESMExports();
    },
  };
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const ctx = TEST_CONTEXT;
const scope = electionScope(ctx);
const voters = [1, 2, 3, 4, 5].map((n) => fakeVoter(`depth20-${n}`));
const group = makeGroup(voters);
const message = ballotHash(ctx, constituencyIdValue("KA-BLR"), Array.from({ length: K_MAX }, identityCiphertext)); // a real 256-bit keccak ballot hash

after(shutdownProver);

describe("Semaphore depth 20 with the pinned local artifacts", { skip: SKIP_NO_ARTIFACTS }, () => {
  it("the artifacts on disk are exactly the pinned Semaphore 4.13.0 files (SHA-256), for depth 3 and depth 20", () => {
    for (const depth of [3, 20]) {
      const a = semaphoreArtifacts(depth);
      assert.equal(sha256(a.wasm), PINNED[`semaphore-${depth}.wasm`], `semaphore-${depth}.wasm`);
      assert.equal(sha256(a.zkey), PINNED[`semaphore-${depth}.zkey`], `semaphore-${depth}.zkey`);
    }
    assert.equal(SEMAPHORE_DEPTH, 20);
  });

  it("membership proof generation and verification work at depth 20 for a 5-member group (natural depth 3), with the full 256-bit keccak message", async () => {
    assert.equal(group.depth, 3);
    const proof = await proveMembership({ identity: voters[2], group, message, scope });
    assert.equal(proof.merkleTreeDepth, 20);
    assert.equal(proof.merkleTreeRoot, group.root.toString(), "the root of the real group, whatever the declared depth");
    assert.equal(proof.message, message.toString());
    assert.ok(message >= 1n << 255n, "the message really is a full-width 256-bit value");
    assert.equal(proof.scope, scope.toString());
    assert.equal(proof.points.length, 8);
    assert.equal(await verifyMembership(proof), true);
  });

  it("the nullifier is unchanged by the depth: depth 3 and depth 20 give the same value, equal to Poseidon(hash(scope), secret)", async () => {
    const at3 = await proveMembership({ identity: voters[0], group, message, scope, depth: 3 });
    const at20 = await proveMembership({ identity: voters[0], group, message, scope, depth: 20 });
    assert.equal(at3.merkleTreeDepth, 3);
    assert.equal(at20.merkleTreeDepth, 20);
    assert.equal(at3.nullifier, at20.nullifier);
    assert.equal(at20.nullifier, nullifierOf(voters[0], scope).toString());
    assert.equal(at3.merkleTreeRoot, at20.merkleTreeRoot);
    assert.equal(await verifyMembership(at3), true);
    assert.equal(await verifyMembership(at20), true);
    // still one nullifier per identity per scope, different across identities and scopes
    assert.notEqual(nullifierOf(voters[1], scope), nullifierOf(voters[0], scope));
    assert.notEqual(nullifierOf(voters[0], scope + 1n), nullifierOf(voters[0], scope));
    const other = await proveMembership({ identity: voters[1], group, message, scope });
    assert.notEqual(other.nullifier, at20.nullifier);
    // the message does not change the nullifier
    const otherMessage = await proveMembership({ identity: voters[0], group, message: message ^ 1n, scope });
    assert.equal(otherMessage.nullifier, at20.nullifier);
  });

  it("a depth-20 proof is bound to its depth, message, scope, root and nullifier: changing any of them breaks verification", async () => {
    const proof = await proveMembership({ identity: voters[3], group, message, scope });
    assert.equal(await verifyMembership(proof), true);
    for (const [name, patch] of Object.entries({
      "depth 20 -> 3": { merkleTreeDepth: 3 },
      "message": { message: (message ^ 1n).toString() },
      "scope": { scope: (scope + 1n).toString() },
      "root": { merkleTreeRoot: (BigInt(proof.merkleTreeRoot) + 1n).toString() },
      "nullifier": { nullifier: (BigInt(proof.nullifier) + 1n).toString() },
    })) assert.equal(await verifyMembership({ ...proof, ...patch }), false, name);
  });

  it("a group much larger than the demo (1,200 members, natural depth 11) proves and verifies at depth 20 against its own root", async () => {
    const members = [...Array.from({ length: 777 }, () => BigInt("0x" + randomBytes(31).toString("hex"))), voters[4].commitment, ...Array.from({ length: 422 }, () => BigInt("0x" + randomBytes(31).toString("hex")))];
    const big = new Group(members);
    assert.equal(big.size, 1200);
    assert.equal(big.depth, 11);
    const proof = await proveMembership({ identity: voters[4], group: big, message, scope });
    assert.equal(proof.merkleTreeDepth, 20);
    assert.equal(proof.merkleTreeRoot, big.root.toString());
    assert.equal(proof.nullifier, nullifierOf(voters[4], scope).toString(), "the same nullifier as in the 5-member group: it depends on identity and scope only");
    assert.equal(await verifyMembership(proof), true);
  });

  it("bad depths are refused before any proof work: out of range, not an integer, or smaller than the group needs", async () => {
    for (const depth of [0, 33, 2.5, -1, "20", NaN]) await assert.rejects(proveMembership({ identity: voters[0], group, message, scope, depth }), RangeError, String(depth));
    await assert.rejects(proveMembership({ identity: voters[0], group, message, scope, depth: 2 }), /exceeds the declared depth/);
  });
});

describe("Semaphore proving and verifying never touch the network", { skip: SKIP_NO_ARTIFACTS }, () => {
  it("the trap is real: the artifact downloader of the Semaphore library is caught by it", async () => {
    const trap = trapNetwork();
    try {
      await assert.rejects(maybeGetSnarkArtifacts(Project.SEMAPHORE, { parameters: [31], version: "4.13.0" }), /network access blocked/);
    } finally {
      trap.restore();
    }
    assert.ok(trap.attempts.includes("fetch"), "the downloader tried fetch and was stopped");
  });

  it("a complete depth-20 proof and verification, plus a depth-3 one, make ZERO network attempts", async () => {
    const trap = trapNetwork();
    let ok20;
    let ok3;
    try {
      const p20 = await proveMembership({ identity: voters[1], group, message, scope });
      ok20 = await verifyMembership(p20);
      const p3 = await proveMembership({ identity: voters[1], group, message, scope, depth: 3 });
      ok3 = await verifyMembership(p3);
    } finally {
      trap.restore();
    }
    assert.deepEqual(trap.attempts, []);
    assert.equal(ok20, true);
    assert.equal(ok3, true);
  });

  it("a depth whose artifacts are not on disk fails with a clear error instead of downloading them", async () => {
    const trap = trapNetwork();
    try {
      await assert.rejects(proveMembership({ identity: voters[0], group, message, scope, depth: 7 }), /missing build artifacts/);
    } finally {
      trap.restore();
    }
    assert.deepEqual(trap.attempts, [], "no download was attempted");
    assert.equal(fs.existsSync(semaphoreArtifacts(7).zkey), false);
  });

  it("src/ has no way to reach the downloader: it never imports @zk-kit/artifacts or calls maybeGetSnarkArtifacts, and always passes explicit artifacts", () => {
    for (const file of fs.readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".js"))) {
      const text = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
      assert.doesNotMatch(text, /maybeGetSnarkArtifacts|@zk-kit\/artifacts/, file);
    }
    assert.match(fs.readFileSync(path.join(ROOT, "src", "semaphore.js"), "utf8"), /generateProof\(identity, group, message, scope, depth, artifacts\)/);
  });
});
