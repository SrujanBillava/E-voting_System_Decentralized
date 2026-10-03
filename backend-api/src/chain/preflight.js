import { getAddress, parseEther } from "ethers";
import { readCandidates, readConstituencies, readElectionState } from "./contract.js";
import {
  BALLOT_AUTHORIZATION_TYPEHASH,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  buildBallotAuthorization,
  buildDomain,
  hashBallotAuthorization,
} from "./eip712.js";
import { exportedEip712 } from "./abi.js";
import { constituencyIdOf } from "./ids.js";
import { readRemoteChainId } from "./provider.js";

export const MIN_RELAYER_BALANCE_WEI = parseEther("0.01");

/** Never put raw provider/driver messages in a check: they can contain URLs or credentials. */
function safeReason(err) {
  return err?.code ? `${err.name ?? "Error"} (${err.code})` : (err?.name ?? "Error");
}

async function run(name, fn) {
  const started = Date.now();
  try {
    const out = (await fn()) ?? {};
    return { name, status: out.status ?? "pass", ...(out.message ? { message: out.message } : {}), ...(out.details ? { details: out.details } : {}), durationMs: Date.now() - started };
  } catch (err) {
    return { name, status: "fail", message: `check failed: ${safeReason(err)}`, durationMs: Date.now() - started };
  }
}

const skipped = (name, because) => ({ name, status: "fail", message: `not checked: ${because}` });

/**
 * Inspect everything the backend depends on. Read-only: it never sends a transaction.
 *
 * @param {object} deps
 * @param {{chainId:number, contractAddress:string, electionId:string}} deps.deployment
 * @param {object} deps.provider  ethers provider
 * @param {object} deps.contract  read-only Voting instance
 * @param {object} deps.signers   from createSigners()
 * @param {{ ping(): Promise<void> }} deps.mongo
 * @param {boolean} [deps.deep=true] also enumerate constituencies/candidates (skipped for the cheap public health probe)
 * @returns {Promise<{ ok: boolean, status: "pass"|"warn"|"fail", checkedAt: string, checks: object[], snapshot?: object }>}
 */
export async function runPreflight({ deployment, provider, contract, signers, mongo, deep = true, minRelayerBalanceWei = MIN_RELAYER_BALANCE_WEI }) {
  const checks = [];
  const add = async (name, fn) => {
    const result = await run(name, fn);
    checks.push(result);
    return result;
  };

  await add("mongo.connectivity", async () => {
    await mongo.ping();
  });

  let latestBlock;
  const rpc = await add("rpc.connectivity", async () => {
    latestBlock = await provider.getBlockNumber();
    return { details: { latestBlock } };
  });

  let chainOk = false;
  if (rpc.status === "pass") {
    const chain = await add("chain.id", async () => {
      const actual = await readRemoteChainId(provider);
      const expected = BigInt(deployment.chainId);
      return actual === expected
        ? { details: { chainId: Number(actual) } }
        : { status: "fail", message: "connected node reports a different chain id than configured", details: { expected: Number(expected), actual: Number(actual) } };
    });
    chainOk = chain.status === "pass";
  } else {
    checks.push(skipped("chain.id", "RPC unreachable"));
  }

  let codeOk = false;
  if (chainOk) {
    const code = await add("contract.bytecode", async () => {
      const bytecode = await provider.getCode(deployment.contractAddress);
      return bytecode !== "0x"
        ? { details: { contractAddress: deployment.contractAddress, bytecodeBytes: (bytecode.length - 2) / 2 } }
        : { status: "fail", message: "no contract code at the configured address", details: { contractAddress: deployment.contractAddress } };
    });
    codeOk = code.status === "pass";
  } else {
    checks.push(skipped("contract.bytecode", "chain id not verified"));
  }

  // The three signer identities must differ regardless of the chain.
  await add("signers.distinct", async () => {
    const { owner, authority, relayer } = signers.addresses;
    return new Set([owner, authority, relayer]).size === 3
      ? { details: { owner, authority, relayer } }
      : { status: "fail", message: "owner, authority and relayer signers are not three distinct accounts" };
  });

  let state;
  const contractChecks = [
    "contract.electionId",
    "contract.phase",
    "contract.owner",
    "contract.authoritySigner",
    "contract.relayer",
    "eip712.domain",
    "eip712.typehash",
    "eip712.digest",
    "relayer.balance",
  ];

  if (codeOk) {
    await add("contract.electionId", async () => {
      state = await readElectionState(contract);
      return state.electionId.toLowerCase() === deployment.electionId.toLowerCase()
        ? { details: { electionId: state.electionId } }
        : { status: "fail", message: "contract election id differs from the configured election id", details: { expected: deployment.electionId, actual: state.electionId } };
    });

    await add("contract.phase", async () => ({ details: { phase: state.phase } }));

    const matches = (label, onChain, local) =>
      getAddress(onChain) === getAddress(local)
        ? { details: { address: getAddress(local) } }
        : { status: "fail", message: `${label} signer address does not match the contract`, details: { contract: getAddress(onChain), signer: getAddress(local) } };

    await add("contract.owner", async () => {
      const result = matches("owner", state.owner, signers.addresses.owner);
      const pending = state.pendingOwner !== "0x0000000000000000000000000000000000000000";
      return pending && !result.status ? { ...result, status: "warn", message: "an ownership transfer is pending" } : result;
    });
    await add("contract.authoritySigner", async () => matches("authority", state.authoritySigner, signers.addresses.authority));
    await add("contract.relayer", async () => matches("relayer", state.relayer, signers.addresses.relayer));

    const domain = buildDomain({ chainId: deployment.chainId, verifyingContract: deployment.contractAddress });

    await add("eip712.domain", async () => {
      const d = await contract.eip712Domain();
      const same =
        d.name === EIP712_DOMAIN_NAME &&
        d.version === EIP712_DOMAIN_VERSION &&
        d.chainId === BigInt(deployment.chainId) &&
        getAddress(d.verifyingContract) === getAddress(deployment.contractAddress) &&
        d.name === exportedEip712.domainName &&
        d.version === exportedEip712.domainVersion;
      return same ? { details: { name: d.name, version: d.version } } : { status: "fail", message: "contract EIP-712 domain differs from the backend definition" };
    });

    await add("eip712.typehash", async () => {
      const onChain = await contract.BALLOT_AUTHORIZATION_TYPEHASH();
      return onChain === BALLOT_AUTHORIZATION_TYPEHASH
        ? { details: { typehash: onChain } }
        : { status: "fail", message: "contract BALLOT_AUTHORIZATION_TYPEHASH differs from the backend type string", details: { contract: onChain, backend: BALLOT_AUTHORIZATION_TYPEHASH } };
    });

    // End-to-end protocol self-test with a fixed sample: the contract (Solidity) and this module
    // (ethers) must compute the identical EIP-712 digest. Read-only: hashAuthorization is a view.
    await add("eip712.digest", async () => {
      const message = buildBallotAuthorization({
        electionId: deployment.electionId,
        constituencyId: constituencyIdOf("PREFLIGHT-SAMPLE"),
        nullifier: "0x" + "ab".repeat(32),
        candidateId: 1n,
        relayer: signers.addresses.relayer,
        deadline: 4102444800n,
      });
      const local = hashBallotAuthorization(domain, message);
      const remote = await contract.hashAuthorization(message.constituencyId, message.nullifier, message.candidateId, message.relayer, message.deadline);
      return local === remote ? { details: { digest: local } } : { status: "fail", message: "backend and contract compute different EIP-712 digests", details: { backend: local, contract: remote } };
    });

    await add("relayer.balance", async () => {
      const balance = await provider.getBalance(signers.addresses.relayer);
      const details = { relayer: signers.addresses.relayer, balanceWei: balance.toString() };
      if (balance === 0n) return { status: "fail", message: "relayer has no funds to pay for gas", details };
      if (balance < minRelayerBalanceWei) return { status: "warn", message: "relayer balance is low", details };
      return { details };
    });
  } else {
    for (const name of contractChecks) checks.push(skipped(name, "contract not reachable at the configured chain and address"));
  }

  let snapshot;
  if (deep) {
    if (codeOk && state) {
      let constituencies = [];
      await add("election.config", async () => {
        constituencies = await readConstituencies(contract);
        const candidates = await readCandidates(contract, constituencies);
        const details = { constituencyCount: constituencies.length, candidateCount: candidates.length, totalBallots: state.totalBallots };
        const problems = [];
        if (constituencies.length !== state.constituencyCount) problems.push("constituency count mismatch");
        if (candidates.length !== state.candidateCount) problems.push("candidate count mismatch");
        const badIds = constituencies.filter((c) => !c.idMatchesCode).map((c) => c.code);
        if (badIds.length > 0) problems.push(`constituency id != keccak256(code) for: ${badIds.join(", ")}`);
        if (candidates.some((c) => c.constituencyCode === null)) problems.push("a candidate references an unknown constituency");
        if (problems.length > 0) return { status: "fail", message: problems.join("; "), details };
        if (constituencies.length === 0) return { status: "warn", message: "no constituencies configured yet", details };
        const empty = constituencies.filter((c) => c.candidateIds.length === 0).map((c) => c.code);
        if (empty.length > 0) return { status: state.phase === "Setup" ? "warn" : "fail", message: `constituencies without candidates: ${empty.join(", ")}`, details };
        return { details };
      });
    } else {
      checks.push(skipped("election.config", "contract not reachable at the configured chain and address"));
    }
  }

  if (state) {
    snapshot = {
      chainId: deployment.chainId,
      contractAddress: deployment.contractAddress,
      latestBlock,
      electionId: state.electionId,
      phase: state.phase,
      owner: state.owner,
      authoritySigner: state.authoritySigner,
      relayer: state.relayer,
      constituencyCount: state.constituencyCount,
      candidateCount: state.candidateCount,
      totalBallots: state.totalBallots,
    };
  }

  const failed = checks.some((c) => c.status === "fail");
  const warned = checks.some((c) => c.status === "warn");
  return {
    ok: !failed,
    status: failed ? "fail" : warned ? "warn" : "pass",
    checkedAt: new Date().toISOString(),
    checks,
    ...(snapshot ? { snapshot } : {}),
  };
}
