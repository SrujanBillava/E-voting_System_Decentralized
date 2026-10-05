import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Interface } from "ethers";
import { loadAbi } from "../../src/chain/abi.js";
import { createVoterRouter } from "../../src/routes/voter.routes.js";
import { configFor } from "../helpers/env.js";
import { findForbiddenNames, findLeaks } from "../helpers/leak.js";
import { ROOT, code, routesOf, sources } from "../helpers/source.js";
import { contractsCompiled } from "../helpers/world.js";

/** words that only the ANONYMOUS side may ever use: the identity service's code, ABI, models and routes must not contain one */
const BALLOT_WORDS = /nullifier|ciphertext|cipher|submitBallot|BallotRecorded|candidate|validityProof|coords|ballotHash|ballotIndex|castVote/i;

describe("PRIVACY BOUNDARY, identity side (static): nothing here can touch a ballot", () => {
  it("no identity source file mentions a nullifier, a ciphertext, coordinates, a validity proof, a candidate or a ballot call/event", () => {
    // (the environment validator names V2's NULLIFIER_* secrets in its list of settings that are REFUSED: that line is the guard, not a use)
    const offenders = sources().flatMap(({ file, code: c }) => {
      const text = c.replace(/^const FOREIGN = .*$/m, "");
      return text.match(BALLOT_WORDS) ? [`${file}: ${text.match(BALLOT_WORDS)[0]}`] : [];
    });
    assert.deepEqual(offenders, []);
  });

  it("the identity ABI subset has no ballot function, event or error, and no Semaphore PROOF machinery; the package depends on no proof or ballot library", () => {
    const { contractAbi, semaphoreAbi } = loadAbi();
    const names = [...contractAbi, ...semaphoreAbi].map((f) => f.name);
    assert.deepEqual(findForbiddenNames(names, BALLOT_WORDS), []);
    assert.deepEqual(findForbiddenNames(names, /verifyProof|validateProof|castVote|aggregate|decrypt|publish|endorse|final/i), []);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.ok(!/semaphore|snarkjs|circom|privacy-v3|trustee/i.test(dep), dep);
    assert.ok(!/privacy-v3|trustee-v3|relay-v3/.test(sources().map((s) => s.code).join("\n")), "no source imports the anonymous side");
  });

  it("the HTTP surface is EXACTLY this list: login, face, eligibility, credential. No ballot, receipt, cast, result or vote route exists", () => {
    const router = createVoterRouter({ authService: {}, faceService: {}, credentialService: {}, config: configFor(null) });
    assert.deepEqual(routesOf(router).sort(), [
      "GET /credential",
      "GET /face/status",
      "GET /status",
      "POST /auth/login",
      "POST /auth/logout",
      "POST /credential",
      "POST /eligibility/check",
      "POST /face/challenge",
      "POST /face/verify",
    ]);
    const app = fs.readFileSync(path.join(ROOT, "src/app.js"), "utf8");
    assert.match(app, /"\/api\/v3\/voter"/);
    assert.ok(!/ballot|receipt|cast|result|submit/i.test(code(app)));
  });

  it("the service never reads a voter's private Semaphore identity: no route, schema or log accepts one (the only credential input is the public commitment)", () => {
    const routes = fs.readFileSync(path.join(ROOT, "src/routes/voter.routes.js"), "utf8");
    assert.match(routes, /CredentialRequest = z\.strictObject\(\{ commitment:/);
    assert.ok(!/secretScalar|privateKey|trapdoor|secret/i.test(code(routes)));
  });

  it("the issuance service holds NO other chain key: ISSUER_PRIVATE_KEY is the only private-key setting the code ever reads", () => {
    const text = sources().map((x) => x.code.replace(/^const FOREIGN = .*$/m, "")).join("\n");
    assert.deepEqual([...new Set([...text.matchAll(/[A-Z][A-Z_]*PRIVATE_KEY/g)].map((m) => m[0]))], ["ISSUER_PRIVATE_KEY"]);
    assert.ok(!/RELAYER|AUTHORITY_|TRUSTEE_/.test(text));
  });

  it("the production entry point passes no test hooks, and the batch timer is the only caller of the batcher", () => {
    const server = code(fs.readFileSync(path.join(ROOT, "src/server.js"), "utf8"));
    assert.ok(!/testHooks|SimulatedCrash/.test(server));
    assert.match(server, /batcher\.recover\(\)/);
    assert.match(server, /batcher\.tick\(\)/);
  });
});

describe("the leak scanner itself (a control: it must actually catch a planted forbidden thing)", () => {
  it("catches a planted forbidden NAME in source, a planted forbidden schema path and a planted forbidden VALUE in every spelling", () => {
    const planted = "const x = { nullifier: 1 };";
    assert.ok(code(planted).match(BALLOT_WORDS), "a planted source token is found");
    assert.deepEqual(findForbiddenNames(["state", "ciphertextCoords", "voterId"], BALLOT_WORDS), ["ciphertextCoords"]);
    const nullifier = "12345678901234567890";
    const hex = BigInt(nullifier).toString(16);
    for (const text of [`x ${nullifier} y`, `x 0x${hex} y`, `x ${hex.padStart(64, "0")} y`, `x ${hex.toUpperCase()} y`]) assert.deepEqual(findLeaks(text, [nullifier]), [nullifier], text);
    assert.deepEqual(findLeaks("nothing here", [nullifier]), []);
    assert.deepEqual(findLeaks("short 12 value", ["12"]), [], "values shorter than 8 characters are ignored (they would match anything)");
  });

  it("the committed ABI copy is in sync with the compiled contracts (skipped without ../smart-contract-v3 artifacts)", { skip: contractsCompiled ? false : "compile ../smart-contract-v3 first" }, () => {
    const out = execFileSync(process.execPath, ["scripts/sync-abi.js", "--check"], { cwd: ROOT, encoding: "utf8" });
    assert.match(out, /in sync/);
  });

  it("the ABI loads as ethers interfaces and decodes the revert errors the batcher acts on", () => {
    const abi = loadAbi();
    assert.ok(abi.voteChain instanceof Interface);
    for (const name of ["BatchAlreadyThisEpoch", "BatchTooLarge", "DuplicateCommitment", "EmptyBatch", "InvalidCommitment", "IssuanceNotOpen", "IssuedCapExceeded", "NotIssuer", "UnknownConstituency", "WrongPhase"]) assert.ok(abi.voteChain.getError(name), name);
  });
});
