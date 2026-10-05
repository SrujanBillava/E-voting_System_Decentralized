import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { loadAbi } from "../../src/chain/abi.js";
import { createLogger } from "../../src/utils/logger.js";
import { createRelayRouter } from "../../src/routes/relay.routes.js";
import { AnonymousSubmission } from "../../src/models/AnonymousSubmission.js";
import { findForbiddenNames, findLeaks } from "../helpers/leak.js";
import { ROOT, code, routesOf, sources } from "../helpers/source.js";
import { contractsCompiled } from "../helpers/world.js";

/**
 * Names that only the IDENTITY side may ever use: the relayer's code, models and routes must not contain one. (Whole words: `Interface` is not `face`, the CORS option
 * `credentials: false` is not a credential, and the public Semaphore event field `identityCommitments` is public group data, not an identity-side record.)
 */
const IDENTITY_WORDS = /\bvoter\w*|\buid\b|\bemail\b|biometric|\bface\w*\b|\bsession(Id|Ref|Token)?\b|\bcredentialId\b|\bcredentialIssuance\b|\bjwt\b|\bpassword\b|identity-v3|backend-api|\bcommitmentBatch\b|registerCommitment/i;

describe("PRIVACY BOUNDARY, relayer side (static): nothing here can know a voter", () => {
  it("no relayer source file mentions a voter, uid, email, password, biometric, session, cookie, JWT, credential, commitment, or the issuer's batches; and none imports the identity side or V2", () => {
    const offenders = sources().flatMap(({ file, code: c }) => {
      // the environment validator names the identity-side settings it REFUSES, and the preflight names the issuer role it must differ from: those lines are guards
      const text = c
        .replace(/^const FOREIGN = .*$/m, "") // the environment validator names the identity-side settings it REFUSES
        .replace(/^const SENSITIVE_KEY = .*$/m, "") // the logger names the fields it REDACTS
        .replace(/^.*(decodeURIComponent|userinfo|password).*$/gm, ""); // scrubbing the password of the relayer's OWN Mongo URI from logs
      const hit = text.match(IDENTITY_WORDS);
      return hit ? [`${file}: ${hit[0]}`] : [];
    });
    assert.deepEqual(offenders, []);
  });

  it("the relayer never looks at the caller: no ip, forwarded-for, user agent, referer, header or cookie is read, there is no cookie parser, and `trust proxy` is never set", () => {
    const text = sources().map((s) => s.code).join("\n");
    for (const pattern of [/req\.ip\b/, /req\.ips\b/, /x-forwarded/i, /user-agent/i, /referer|referrer/i, /req\.headers/, /req\.get\(/, /req\.cookies/, /cookie-parser|cookieParser/, /trust proxy/, /req\.hostname|req\.socket|req\.connection/, /remoteAddress/]) assert.ok(!pattern.test(text), String(pattern));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.ok(!/cookie|session|jwt|jsonwebtoken|bcrypt|passport|rate-limit|helmet-csp/i.test(dep), dep);
  });

  it("the ABI subset has NO commitment-issuance or admin function: the relayer cannot even encode one", () => {
    const { contractAbi, semaphoreAbi } = loadAbi();
    const names = [...contractAbi, ...semaphoreAbi].map((f) => f.name);
    assert.deepEqual(findForbiddenNames(names, /registerCommitment|setIssuer|closeIssuance|closeElection|openElection|addConstituency|addCandidate|setElectionKey|configureTrustees|publishPartial|endorse/i), []);
    assert.ok(names.includes("submitBallot"));
  });

  it("the submission model cannot hold anything identity-side: its fields are public-chain material and bookkeeping only", () => {
    const paths = Object.keys(AnonymousSubmission.schema.paths).filter((p) => p !== "__v");
    assert.deepEqual(findForbiddenNames(paths, IDENTITY_WORDS), []);
    assert.deepEqual(paths.sort(), ["_id", "attempts", "ballotIndex", "blockNumber", "calldata", "claimToken", "constituencyId", "failureCode", "lastTxHash", "lockUntil", "nonce", "nullifier", "packageHash", "rawTx", "state", "touchedAt", "txHash"]);
    assert.equal(AnonymousSubmission.schema.path("_id").instance, "String");
    assert.ok(AnonymousSubmission.schema.indexes().some(([keys, options]) => keys.nullifier && options.unique), "the nullifier is the unique anonymous key");
  });

  it("the HTTP surface is EXACTLY this list, and the only inputs are the ballot package, a nullifier and a constituency", () => {
    const router = createRelayRouter({ submitService: {}, groupsService: {} });
    assert.deepEqual(routesOf(router).sort(), ["GET /ballots/:nullifier", "GET /groups/:constituency", "POST /ballots"]);
    const app = fs.readFileSync(path.join(ROOT, "src/app.js"), "utf8");
    assert.match(app, /credentials: false/);
    assert.match(app, /app\.use\("\/v1"/);
    assert.ok(!/app\.use\(cookie|authenticate|requireVoter/i.test(code(app)));
  });

  it("the access log writes the matched route PATTERN (never the nullifier in the path), and the logger turns any identity-named field into [REDACTED]", () => {
    const http = code(fs.readFileSync(path.join(ROOT, "src/middleware/http.js"), "utf8"));
    assert.match(http, /req\.route/);
    assert.ok(!/req\.path|req\.url|req\.originalUrl/.test(http));
    const lines = [];
    const logger = createLogger({ stream: { write: (l) => lines.push(l) } });
    logger.info({ voterId: "VC-ABCDEFGHJK", uid: "u-123456789", email: "a@b.example", session: "sess-123456789", faceDescriptor: [1], credentialId: "c-12345", cookie: "x", nullifier: "424242424242" }, "x");
    const out = JSON.parse(lines.join(""));
    for (const key of ["voterId", "uid", "email", "session", "faceDescriptor", "credentialId", "cookie"]) assert.equal(out[key], "[REDACTED]", key);
    assert.equal(out.nullifier, "424242424242", "the nullifier IS something the relayer may know and log");
  });

  it("the production entry point passes no test hooks, and only the recovery sweep and startup recovery drive stored submissions", () => {
    const server = code(fs.readFileSync(path.join(ROOT, "src/server.js"), "utf8"));
    assert.ok(!/testHooks|SimulatedCrash/.test(server));
    assert.match(server, /submitService\.recover\(\)/);
    assert.match(server, /submitService\.recoverPending\(\)/);
  });
});

describe("the leak scanner itself (a control: it must actually catch a planted forbidden thing)", () => {
  it("catches planted identity words in source, a planted forbidden schema path, and a planted voter value in every spelling", () => {
    assert.ok(code("const voterId = 1;").match(IDENTITY_WORDS));
    assert.ok(!code("const iface = new Interface(abi); const o = { credentials: false };").match(IDENTITY_WORDS), "whole words only");
    assert.ok(code("req.get('user-agent')").match(/user-agent/i));
    assert.deepEqual(findForbiddenNames(["state", "voterRef", "txHash"], IDENTITY_WORDS), ["voterRef"]);
    const planted = "1234567890123456789";
    const hex = BigInt(planted).toString(16);
    for (const text of [`a ${planted} b`, `a 0x${hex} b`, `a ${hex.padStart(64, "0")} b`, `a ${hex.toUpperCase()} b`]) assert.deepEqual(findLeaks(text, [planted]), [planted], text);
    assert.deepEqual(findLeaks("nothing", [planted]), []);
  });

  it("the committed ABI copy is in sync with the compiled contracts (skipped without ../smart-contract-v3 artifacts)", { skip: contractsCompiled ? false : "compile ../smart-contract-v3 first" }, () => {
    assert.match(execFileSync(process.execPath, ["scripts/sync-abi.js", "--check"], { cwd: ROOT, encoding: "utf8" }), /in sync/);
  });

  it("the ABI decodes the errors a rejected ballot raises, the contract's and Semaphore's", () => {
    const abi = loadAbi();
    for (const name of ["WrongPhase", "UnknownConstituency", "WrongCoordinateCount", "InvalidMembershipProof", "InvalidValidityProof", "NullifierAlreadyUsed"]) assert.ok(abi.voteChain.getError(name), name);
    for (const name of ["Semaphore__MerkleTreeRootIsExpired", "Semaphore__MerkleTreeRootIsNotPartOfTheGroup", "Semaphore__GroupHasNoMembers"]) assert.ok(abi.semaphore.getError(name), name);
  });
});
