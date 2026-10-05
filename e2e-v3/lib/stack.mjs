// THE REAL SYSTEM, started for the end-to-end tests:
//   a Hardhat node (free port) with the official Semaphore stack, the generated validity verifier and VoteChainV3, configured with the REAL key of a REAL trustee ceremony
//   identity-v3 and relay-v3 as two SEPARATE OS processes with two separate databases, keys and ports
//   an auditing JSON-RPC proxy (CORS for the kiosk's origin; records every method the kiosk calls)
// Nothing here is mocked. (Only the physical webcam is ever replaced, by the tests.)
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dumpDb as dumpIdentityDb, closeDb as closeIdentityDb, connectTestDb as connectIdentityDb, resetDb as resetIdentityDb } from "../../identity-v3/test/helpers/db.js";
import { configFor as identityConfigFor, rawEnv as identityRawEnv } from "../../identity-v3/test/helpers/env.js";
import { freePort, spawnService, waitFor } from "../../identity-v3/test/helpers/node.js";
import { CLOSE_GRACE, ELECTION_ID, newWorld } from "../../identity-v3/test/helpers/world.js";
import { dumpDb as dumpRelayDb, closeDb as closeRelayDb, connectTestDb as connectRelayDb, resetDb as resetRelayDb } from "../../relay-v3/test/helpers/db.js";
import { rawEnv as relayRawEnv } from "../../relay-v3/test/helpers/env.js";
import { runCeremony } from "../../trustee-v3/testing/ceremony.ts";
import { startRpcProxy } from "./rpc-proxy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
export const CONSTITUENCY = "KA-BLR";
export const CANDIDATES = ["Candidate A", "Candidate B", "Candidate C"];
const strings = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));

/**
 * @param {{ identityUri: string, relayUri: string, hostnames?: boolean, kioskPort?: number, registeredCap?: number }} options
 *   hostnames: true uses id./relay./kiosk.votechain.localhost (for the browser); false uses 127.0.0.1
 */
export async function startStack({ identityUri, relayUri, hostnames = false, kioskPort, registeredCap = 50, extraConstituencies = [] }) {
  // databases first, ONE connection each in this process: collections are emptied, never dropped (a local mongod 8.2.6 aborts when createIndexes races dropDatabase)
  await connectIdentityDb();
  await connectRelayDb(relayUri);
  await resetIdentityDb();
  await resetRelayDb();

  const ceremony = runCeremony(); // dealer-less 2-of-3 DKG, three trustees
  const world = await newWorld({ constituencies: {}, open: false });
  const H = ceremony.verified.electionPublicKey;
  await (await world.voteChain.setElectionKey(H[0], H[1])).wait();
  await (await world.voteChain.configureTrustees(ceremony.transcript.transcriptHash, world.trustees.map((t) => t.address), ceremony.verified.verificationKeys.map(([x, y]) => [x, y]), H[0], H[1])).wait();
  await (await world.voteChain.addConstituency(CONSTITUENCY, "Bengaluru South", registeredCap)).wait();
  const constituencyId = (await import("ethers")).keccak256((await import("ethers")).toUtf8Bytes(CONSTITUENCY));
  for (const name of CANDIDATES) await (await world.voteChain.addCandidate(constituencyId, name)).wait();
  const { keccak256, toUtf8Bytes } = await import("ethers");
  for (const { code, name } of extraConstituencies) {
    await (await world.voteChain.addConstituency(code, name, registeredCap)).wait();
    for (const candidate of CANDIDATES) await (await world.voteChain.addCandidate(keccak256(toUtf8Bytes(code)), `${code} ${candidate}`)).wait();
  }
  await (await world.voteChain.openElection()).wait();

  const ports = { identity: await freePort(), relay: await freePort(), kiosk: kioskPort ?? (await freePort()) };
  const host = (name) => (hostnames ? `${name}.votechain.localhost` : "127.0.0.1");
  const origins = { kiosk: `http://${host("kiosk")}:${ports.kiosk}`, identity: `http://${host("id")}:${ports.identity}`, relay: `http://${host("relay")}:${ports.relay}` };
  const rpc = await startRpcProxy({ target: world.url, allowedOrigin: origins.kiosk });
  const rpcUrl = `http://${host("rpc")}:${rpc.port}`;

  const faceKey = randomBytes(32).toString("hex");
  const idEnv = { IDENTITY_MONGODB_URI: identityUri, FACE_TEMPLATE_ENCRYPTION_KEY: faceKey };
  const identityConfig = identityConfigFor(world, idEnv);
  const identityProc = spawnService(path.join(ROOT, "identity-v3"), strings({ ...identityRawEnv(world, idEnv), PORT: ports.identity, CORS_ORIGINS: origins.kiosk, BATCH_INTERVAL_MS: 300, LOG_LEVEL: "info", LOGIN_RATE_LIMIT_MAX: 1000, FACE_RATE_LIMIT_MAX: 1000 }));
  const relayProc = spawnService(path.join(ROOT, "relay-v3"), strings({ ...relayRawEnv(world, { RELAY_MONGODB_URI: relayUri }), PORT: ports.relay, CORS_ORIGINS: origins.kiosk, LOG_LEVEL: "info", RELAY_GLOBAL_LIMIT_PER_MINUTE: 100000 }));
  const up = (url) => waitFor(async () => (await fetch(url)).ok, { timeoutMs: 60_000 });
  try {
    await Promise.all([up(`http://127.0.0.1:${ports.identity}/api/v3/health`), up(`http://127.0.0.1:${ports.relay}/v1/health`)]);
  } catch (err) {
    identityProc.stop();
    relayProc.stop();
    throw new Error(`the services did not start:\n--- identity\n${identityProc.output()}\n--- relay\n${relayProc.output()}\n${err}`);
  }

  const stack = {
    world,
    ceremony,
    ports,
    origins,
    rpc,
    identityProc,
    relayProc,
    identityConfig,
    constituency: { code: CONSTITUENCY, id: constituencyId },
    electionId: ELECTION_ID,
    /** the kiosk's pinned configuration (what the production build bakes in) */
    kioskConfig: {
      identityBase: `${origins.identity}/api/v3/voter`,
      relayBase: `${origins.relay}/v1`,
      rpcUrl,
      chainId: 31337,
      contractAddress: world.address,
      electionId: ELECTION_ID,
      pollMs: 150,
      issuanceTimeoutMs: 90_000,
      confirmTimeoutMs: 30_000,
    },
    dumpIdentityDb,
    dumpRelayDb,
    logs: () => ({ identity: identityProc.output(), relay: relayProc.output() }),
    CLOSE_GRACE,
    async stop() {
      identityProc.stop();
      relayProc.stop();
      await Promise.all([identityProc.exited, relayProc.exited]);
      rpc.stop();
      world.stop();
      await closeIdentityDb();
      await closeRelayDb();
    },
  };
  return stack;
}
