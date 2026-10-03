import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveDeployment } from "../../src/chain/deployment.js";
import { ConfigError, loadEnv } from "../../src/config/env.js";
import { validEnv } from "../helpers/env.js";

const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const ELECTION = "0x5dab7172a78a7f3f80152b59447177418d65a32d2be42f9832cc46ca76e2ef40";
const metadata = (patch = {}) => JSON.stringify({ schemaVersion: 1, chainId: 31337, contractAddress: ADDRESS, electionId: ELECTION, electionCode: "X", ...patch });
const unset = { CHAIN_ID: undefined, VOTING_CONTRACT_ADDRESS: undefined, ELECTION_ID: undefined };
const neverRead = () => assert.fail("metadata file must not be read");

describe("deployment resolution", () => {
  it("environment values are authoritative and the file is not even read", () => {
    const d = resolveDeployment(loadEnv(validEnv()), { readFile: neverRead });
    assert.deepEqual({ ...d }, { chainId: 31337, contractAddress: ADDRESS, electionId: ELECTION, source: "environment" });
  });

  it("in development, unset values come from the local deployment metadata", () => {
    const d = resolveDeployment(loadEnv(validEnv(unset)), { readFile: () => metadata() });
    assert.deepEqual({ ...d }, { chainId: 31337, contractAddress: ADDRESS, electionId: ELECTION, source: "local-metadata" });
  });

  it("environment values that agree with the metadata are accepted", () => {
    const d = resolveDeployment(loadEnv(validEnv({ ELECTION_ID: undefined })), { readFile: () => metadata() });
    assert.equal(d.electionId, ELECTION);
  });

  it("an environment that contradicts the metadata fails loudly instead of mixing sources", () => {
    const cases = [
      { patch: { chainId: 1 }, env: { ELECTION_ID: undefined } },
      { patch: { contractAddress: "0x" + "22".repeat(20) }, env: { ELECTION_ID: undefined } },
      { patch: { electionId: "0x" + "33".repeat(32) }, env: { CHAIN_ID: undefined } },
    ];
    for (const { patch, env } of cases) {
      assert.throws(() => resolveDeployment(loadEnv(validEnv(env)), { readFile: () => metadata(patch) }), /contradicts/, JSON.stringify(patch));
    }
  });

  it("a contract address set without an election id, differing from the metadata, is refused", () => {
    const env = loadEnv(validEnv({ ELECTION_ID: undefined, VOTING_CONTRACT_ADDRESS: "0x" + "22".repeat(20) }));
    assert.throws(() => resolveDeployment(env, { readFile: () => metadata() }), /contradicts/);
  });

  it("production never consults a metadata file (loadEnv already requires every coordinate)", () => {
    // loadEnv refuses a production config without them, so resolveDeployment can never fall back
    assert.throws(
      () =>
        loadEnv(
          validEnv({
            NODE_ENV: "production",
            CHAIN_ID: "11155111",
            VOTING_CONTRACT_ADDRESS: undefined,
            ELECTION_ID: undefined,
            CORS_ORIGINS: "https://v.example.org",
            OWNER_PRIVATE_KEY: "0x" + "11".repeat(31) + "01",
            AUTHORITY_PRIVATE_KEY: "0x" + "22".repeat(31) + "02",
            RELAYER_PRIVATE_KEY: "0x" + "33".repeat(31) + "03",
          }),
        ),
      /VOTING_CONTRACT_ADDRESS/,
    );
  });

  it("a missing or invalid metadata file explains what to do, without echoing its content", () => {
    const env = loadEnv(validEnv(unset));
    assert.throws(() => resolveDeployment(env, { readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }), /deploy:local/);
    assert.throws(() => resolveDeployment(env, { readFile: () => "{not json" }), ConfigError);
    assert.throws(() => resolveDeployment(env, { readFile: () => metadata({ schemaVersion: 2 }) }), ConfigError);
    assert.throws(() => resolveDeployment(env, { readFile: () => metadata({ contractAddress: "nope" }) }), ConfigError);
  });
});

describe("deployment resolution: guards that do not depend on loadEnv", () => {
  const production = (chain = {}) => ({ isProduction: true, chain });

  it("production refuses to fall back to a file even when the config object itself lacks coordinates", () => {
    for (const chain of [{}, { chainId: 31337 }, { chainId: 31337, contractAddress: ADDRESS }, { contractAddress: ADDRESS, electionId: ELECTION }]) {
      assert.throws(() => resolveDeployment(production(chain), { readFile: neverRead }), (err) => err instanceof ConfigError && /must all be set in production/.test(err.message), JSON.stringify(chain));
    }
  });

  it("production with all three coordinates uses them and never reads a file", () => {
    const d = resolveDeployment(production({ chainId: 11155111, contractAddress: ADDRESS.toLowerCase(), electionId: ELECTION }), { readFile: neverRead });
    assert.equal(d.source, "environment");
    assert.equal(d.contractAddress, ADDRESS);
  });

  it("an env-supplied address is returned checksummed", () => {
    const d = resolveDeployment({ isProduction: false, chain: { chainId: 31337, contractAddress: ADDRESS.toLowerCase(), electionId: ELECTION } }, { readFile: neverRead });
    assert.equal(d.contractAddress, ADDRESS);
  });

  it("the result is frozen", () => {
    const d = resolveDeployment(loadEnv(validEnv()), { readFile: neverRead });
    assert.ok(Object.isFrozen(d));
  });
});

describe("deployment resolution: metadata details", () => {
  it("the metadata election id is compared and returned case-insensitively (lower-case result)", () => {
    const upper = "0x" + ELECTION.slice(2).toUpperCase();
    const fromMetadata = resolveDeployment(loadEnv(validEnv(unset)), { readFile: () => metadata({ electionId: upper }) });
    assert.equal(fromMetadata.electionId, ELECTION);
    const agreeing = resolveDeployment(loadEnv(validEnv({ CHAIN_ID: undefined, VOTING_CONTRACT_ADDRESS: undefined })), { readFile: () => metadata({ electionId: upper }) });
    assert.equal(agreeing.electionId, ELECTION);
  });

  it("a metadata address in lower case is returned checksummed; a wrongly checksummed one is not trusted", () => {
    assert.equal(resolveDeployment(loadEnv(validEnv(unset)), { readFile: () => metadata({ contractAddress: ADDRESS.toLowerCase() }) }).contractAddress, ADDRESS);
    const wrong = ADDRESS.replace(/[a-fA-F]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    assert.throws(() => resolveDeployment(loadEnv(validEnv(unset)), { readFile: () => metadata({ contractAddress: wrong }) }));
  });

  it("metadata with an impossible chain id or malformed election id is rejected like any other invalid file", () => {
    const env = loadEnv(validEnv(unset));
    for (const patch of [{ chainId: -1 }, { chainId: 0 }, { chainId: 1.5 }, { chainId: "31337" }, { electionId: "0x1234" }, { electionId: "not-hex" }, { contractAddress: "0x123" }, { schemaVersion: "1" }, { schemaVersion: 0 }]) {
      assert.throws(() => resolveDeployment(env, { readFile: () => metadata(patch) }), (err) => err instanceof ConfigError && /invalid content/.test(err.message), JSON.stringify(patch));
    }
  });

  it("every contradiction is reported together, naming the variable but not the values", () => {
    const env = loadEnv(validEnv({ CHAIN_ID: "1", VOTING_CONTRACT_ADDRESS: "0x" + "22".repeat(20), ELECTION_ID: undefined }));
    assert.throws(
      () => resolveDeployment(env, { readFile: () => metadata() }),
      (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /CHAIN_ID=1/);
        assert.match(err.message, /VOTING_CONTRACT_ADDRESS differs/);
        assert.ok(!err.message.includes("22".repeat(20)));
        return true;
      },
    );
    const election = loadEnv(validEnv({ CHAIN_ID: undefined, VOTING_CONTRACT_ADDRESS: undefined, ELECTION_ID: "0x" + "33".repeat(32) }));
    assert.throws(() => resolveDeployment(election, { readFile: () => metadata() }), (err) => /ELECTION_ID differs/.test(err.message) && !err.message.includes("33".repeat(32)));
  });

  it("DEPLOYMENT_METADATA_PATH selects the file that is read (and the default is smart-contract/deployments/local.json)", () => {
    const seen = [];
    const readFile = (p) => (seen.push(p), metadata());
    resolveDeployment(loadEnv(validEnv({ ...unset, DEPLOYMENT_METADATA_PATH: "/some/where/else.json" })), { readFile });
    resolveDeployment(loadEnv(validEnv(unset)), { readFile });
    assert.equal(seen[0], "/some/where/else.json");
    assert.match(seen[1].replaceAll("\\", "/"), /smart-contract\/deployments\/local\.json$/);
  });

  it("an unreadable or invalid file never puts its content or the secrets next to it into the message", () => {
    const env = loadEnv(validEnv(unset));
    assert.throws(
      () => resolveDeployment(env, { readFile: () => '{"schemaVersion":1,"privateKey":"0xdeadbeef-top-secret"}' }),
      (err) => err instanceof ConfigError && !err.message.includes("top-secret"),
    );
  });
});
