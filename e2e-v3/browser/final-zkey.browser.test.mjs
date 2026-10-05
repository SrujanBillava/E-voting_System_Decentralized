// ONE FOCUSED BROWSER PROOF with the FINAL Groth16 key. No identity service, no relayer, no database: a real Chrome loads the kiosk's own ballot code under the kiosk's strict CSP,
// the kiosk's hash-checked loader fetches the bundled artifacts from its own origin, the browser makes the witness and the Groth16 + Semaphore proofs, and the proof is then
// accepted by the REAL generated Solidity verifier through VoteChainV3's normal submitBallot path on a real chain.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Contract, keccak256, toUtf8Bytes } from "ethers";
import { freePort } from "../../identity-v3/test/helpers/node.js";
import { CLOSE_GRACE, ELECTION_ID, newWorld } from "../../identity-v3/test/helpers/world.js";
import { toRelayPackage } from "../../kiosk-v3/src/core/index.ts";
import { padCiphertexts, validityPublicSignals } from "../../kiosk-v3/src/crypto/privacy.ts";
import { runCeremony } from "../../trustee-v3/testing/ceremony.ts";
import { buildHarness, KIOSK_DIR, launchChrome, newVoterContext, serveKiosk } from "../lib/browser.mjs";
import { startRpcProxy } from "../lib/rpc-proxy.mjs";
import { CANDIDATES, ROOT } from "../lib/stack.mjs";

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "privacy-v3", "spec", "final-ceremony.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const CODE = "KA-BLR";

describe("the FINAL Groth16 key in a real browser", () => {
  let world, rpc, server, browser, origins, config, constituencyId;

  before(async () => {
    const ceremony = runCeremony();
    world = await newWorld({ constituencies: {}, open: false });
    const H = ceremony.verified.electionPublicKey;
    await (await world.voteChain.setElectionKey(H[0], H[1])).wait();
    await (await world.voteChain.configureTrustees(ceremony.transcript.transcriptHash, world.trustees.map((t) => t.address), ceremony.verified.verificationKeys.map(([x, y]) => [x, y]), H[0], H[1])).wait();
    await (await world.voteChain.addConstituency(CODE, "Bengaluru South", 50)).wait();
    constituencyId = keccak256(toUtf8Bytes(CODE));
    for (const name of CANDIDATES) await (await world.voteChain.addCandidate(constituencyId, name)).wait();
    await (await world.voteChain.openElection()).wait();

    const port = await freePort();
    origins = { kiosk: `http://kiosk.votechain.localhost:${port}` };
    rpc = await startRpcProxy({ target: world.url, allowedOrigin: origins.kiosk });
    const rpcUrl = `http://rpc.votechain.localhost:${rpc.port}`;
    config = { identityBase: rpcUrl, relayBase: rpcUrl, rpcUrl, chainId: 31337, contractAddress: world.address, electionId: ELECTION_ID };
    server = await serveKiosk({ dir: buildHarness({ rpcUrl, outDir: "dist-proof-harness" }), port });
    browser = await launchChrome();
  });
  after(async () => {
    await browser?.close();
    server?.stop();
    rpc?.stop();
    world?.stop();
  });

  const newPage = async () => {
    const v = await newVoterContext(browser, { origins: { ...origins, identity: origins.kiosk, relay: origins.kiosk } }, {});
    const page = await v.context.newPage();
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__violations ??= []).push(`${e.effectiveDirective} <- ${e.blockedURI}`)));
    await page.goto(origins.kiosk + "/");
    await page.waitForFunction(() => Boolean(window.__harness));
    return { v, page };
  };

  it("the kiosk's loader REFUSES a proving key that is not the pinned one (a flipped byte), then accepts the real one on retry", async () => {
    const { v, page } = await newPage();
    const real = fs.readFileSync(path.join(KIOSK_DIR, "public", "artifacts", "ballot_validity_final.zkey"));
    assert.equal(sha256(real), manifest.browser.provingZkeySha256, "the bundled key IS the final ceremony's");
    const tampered = Buffer.from(real);
    tampered[1000] ^= 1;
    await page.route("**/artifacts/ballot_validity_final.zkey", (route) => route.fulfill({ status: 200, contentType: "application/octet-stream", body: tampered }));
    const refused = await page.evaluate(() => window.__harness.loadArtifacts());
    assert.match(refused, /^PROVING_FILES_REJECTED: A proving file does not match this kiosk's pinned fingerprint/);
    await page.unroute("**/artifacts/ballot_validity_final.zkey");
    assert.equal(await page.evaluate(() => window.__harness.loadArtifacts()), "ok");
    await v.context.close();
  });

  it("a browser ballot: pinned artifacts checked, witness and Groth16 + Semaphore proofs made in the browser, accepted by the final Solidity verifier through VoteChainV3, nothing downloaded but the kiosk's own files", async () => {
    const { v, page } = await newPage();
    const commitment = await page.evaluate(() => window.__harness.newIdentity());
    await (await world.voteChain.connect(world.issuer).registerCommitmentBatch(constituencyId, [BigInt(commitment), 987654321987654321n])).wait();
    const { groupId } = await world.voteChain.getConstituency(constituencyId);
    const leaves = (await world.semaphore.queryFilter(world.semaphore.filters.MembersAdded(groupId))).flatMap((l) => [...l.args.identityCommitments]).map(String);
    assert.ok(leaves.includes(commitment));

    const t0 = performance.now();
    const out = await page.evaluate((input) => window.__harness.prove(input), { config, code: CODE, leaves, choice: 1 });
    const wallMs = performance.now() - t0;
    const { record } = out;
    assert.equal(record.validity.proof.protocol, "groth16");
    assert.equal(record.ciphertexts.length, 3);

    // the proof the BROWSER made goes through VoteChainV3's normal path (the final BallotValidityVerifier is called inside submitBallot)
    const pkg = toRelayPackage(record);
    const big = (x) => BigInt(x);
    const membership = { merkleTreeDepth: big(pkg.membership.merkleTreeDepth), merkleTreeRoot: big(pkg.membership.merkleTreeRoot), nullifier: big(pkg.membership.nullifier), points: pkg.membership.points.map(big) };
    const validity = { a: pkg.validity.a.map(big), b: pkg.validity.b.map((r) => r.map(big)), c: pkg.validity.c.map(big) };
    const tx = await world.voteChain.connect(world.relayer).submitBallot(pkg.constituencyId, membership, pkg.coords.map(big), validity);
    const receipt = await tx.wait();
    assert.equal(receipt.status, 1);
    assert.equal(Number(await world.voteChain.totalBallots()), 1);
    assert.equal(await world.voteChain.nullifierUsed(membership.nullifier), true);
    const events = await world.voteChain.queryFilter(world.voteChain.filters.BallotRecorded());
    assert.equal(events.length, 1);
    assert.equal(events[0].args.nullifier, membership.nullifier);
    // and the same validity proof against the deployed final verifier DIRECTLY, with the 68 public signals rebuilt from the package
    const verifier = new Contract(await world.voteChain.validityVerifier(), ["function verifyProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[68] signals) view returns (bool)"], world.provider);
    const pair = (c) => ({ c1: [big(c.c1[0]), big(c.c1[1])], c2: [big(c.c2[0]), big(c.c2[1])] });
    const signals = validityPublicSignals({ kc: record.kc, H: record.H.map(big), nullifier: big(record.nullifier), ciphertexts: padCiphertexts(record.ciphertexts.map(pair)) }).map(big);
    assert.equal(signals.length, 68);
    assert.equal(await verifier.verifyProof(validity.a, validity.b, validity.c, signals), true, "the browser's proof verifies on the final Solidity verifier");
    assert.equal(await verifier.verifyProof(validity.a, validity.b, validity.c, signals.map((x, i) => (i === 1 ? x + 1n : x))), false, "and not for another K_c");

    // ---- no artifact download but the kiosk's own: four files, once each, from the page's own origin, hash-checked by the loader before use
    await v.settled();
    const files = v.traffic.filter((e) => /\.(zkey|wasm)$/.test(e.path));
    assert.deepEqual(files.map((e) => e.path).sort(), ["/artifacts/ballot_validity.wasm", "/artifacts/ballot_validity_final.zkey", "/artifacts/semaphore-20.wasm", "/artifacts/semaphore-20.zkey"]);
    assert.ok(files.every((e) => e.host === new URL(origins.kiosk).host && e.status === 200), "every proving file came from the kiosk's own origin");
    const hosts = new Set(v.traffic.filter((e) => /^https?:/.test(e.url)).map((e) => e.host));
    assert.deepEqual([...hosts].sort(), [new URL(origins.kiosk).host, new URL(config.rpcUrl).host].sort(), "the page talked to itself and the read-only RPC node only");
    for (const m of new Set(rpc.methods)) assert.ok(["eth_chainId", "eth_call", "eth_getLogs", "eth_getBlockByNumber", "eth_getCode", "eth_blockNumber", "net_version"].includes(m), `RPC method ${m} must be a read`);
    assert.deepEqual(await page.evaluate(() => window.__violations ?? []), [], "no CSP violation while proving");
    const served = await (await fetch(`${origins.kiosk.replace("kiosk.votechain.localhost", "127.0.0.1")}/artifacts/ballot_validity_final.zkey`)).arrayBuffer();
    assert.equal(sha256(Buffer.from(served)), manifest.browser.provingZkeySha256);

    const t = out.timings;
    const summary = {
      machine: "development machine, real Chrome 154 (headless), 20 logical cores",
      artifactLoadAndHashCheckMs: Math.round(out.loadMs),
      encryptMs: Math.round(t.encryptMs),
      witnessMs: Math.round(t.validityWitnessMs),
      groth16ProveMs: Math.round(t.validityProveMs),
      semaphoreProveMs: Math.round(t.semaphoreProveMs),
      preparationTotalMs: Math.round(t.totalMs),
      wallClockLoadToPackageMs: Math.round(wallMs),
      finalZkeySha256: manifest.browser.provingZkeySha256,
    };
    fs.writeFileSync(path.join(ROOT, "e2e-v3", "results", "performance-final-zkey-browser.json"), JSON.stringify(summary, null, 2) + "\n");
    console.log("browser proof with the final zkey:", JSON.stringify(summary));
    await v.context.close();
  });
});
