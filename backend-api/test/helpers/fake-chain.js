import { ZeroAddress, parseEther } from "ethers";
import { BALLOT_AUTHORIZATION_TYPEHASH, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION, buildBallotAuthorization, buildDomain, hashBallotAuthorization } from "../../src/chain/eip712.js";
import { constituencyIdOf } from "../../src/chain/ids.js";
import { hardhatAccount } from "./env.js";

/**
 * An in-memory stand-in for a healthy Voting deployment, shaped like what ethers returns
 * (bigint for uint256, checksummed addresses, tuples as arrays). Every field lives in `state`, so a test
 * changes exactly one thing and sees which preflight check notices.
 *
 * The provider and contract are STRICT: touching anything that is not a plain read throws, and every
 * touched member is recorded in `touched`, so tests can also prove that nothing writes.
 */
export const FAKE_CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
export const FAKE_ELECTION_ID = "0x" + "11".repeat(32);

export function fakeWorld(patch = {}) {
  const state = {
    chainId: 31337n,
    blockNumber: 12,
    code: "0x6080604052",
    balance: parseEther("5"),
    electionId: FAKE_ELECTION_ID,
    phase: 0n,
    owner: hardhatAccount(0).address,
    pendingOwner: ZeroAddress,
    authoritySigner: hardhatAccount(1).address,
    relayer: hardhatAccount(2).address,
    totalBallots: 0n,
    constituencies: [
      { code: "KA-BLR", name: "Bengaluru", candidates: ["Asha", "Bharat", "Chitra"] },
      { code: "DL-DEL", name: "Delhi", candidates: ["Devika", "Eshan"] },
    ],
    domain: { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: 31337n, verifyingContract: FAKE_CONTRACT_ADDRESS },
    typehash: BALLOT_AUTHORIZATION_TYPEHASH,
    digestOverride: undefined,
    constituencyCountOverride: undefined, // a value, or an array: successive calls return successive entries (the last one repeats)
    candidateCountOverride: undefined,
    constituencyIdOverrides: {}, // code -> id the "contract" claims
    candidateConstituencyOverrides: {}, // candidate id -> constituency id the "contract" claims
    failing: new Set(), // contract member names that reject
    ...patch,
  };

  const touched = { provider: new Set(), contract: new Set(), rpcMethods: new Set() };
  const idOf = (c) => state.constituencyIdOverrides[c.code] ?? constituencyIdOf(c.code);
  const flatCandidates = () => state.constituencies.flatMap((c) => c.candidates.map((name) => ({ name, constituency: c })));
  const byId = (id) => {
    const c = state.constituencies.find((x) => idOf(x) === id);
    if (!c) throw Object.assign(new Error("unknown constituency"), { code: "CALL_EXCEPTION" });
    return c;
  };
  const nextOf = (override, actual) => {
    if (Array.isArray(override)) return override.length > 1 ? override.shift() : override[0];
    return override ?? actual;
  };
  const page = (list, offset, limit) => list.slice(Number(offset), Number(offset) + Number(limit));

  const members = {
    ELECTION_ID: () => state.electionId,
    BALLOT_AUTHORIZATION_TYPEHASH: () => state.typehash,
    phase: () => state.phase,
    owner: () => state.owner,
    pendingOwner: () => state.pendingOwner,
    authoritySigner: () => state.authoritySigner,
    relayer: () => state.relayer,
    totalBallots: () => state.totalBallots,
    constituencyCount: () => BigInt(nextOf(state.constituencyCountOverride, state.constituencies.length)),
    candidateCount: () => BigInt(nextOf(state.candidateCountOverride, flatCandidates().length)),
    getConstituencyIds: (offset, limit) => page(state.constituencies.map(idOf), offset, limit),
    getConstituency: (id) => {
      const c = byId(id);
      return [c.code, c.name];
    },
    candidateCountOf: (id) => BigInt(byId(id).candidates.length),
    getCandidateIdsByConstituency: (id, offset, limit) => {
      const wanted = byId(id);
      const ids = flatCandidates().flatMap((c, i) => (c.constituency === wanted ? [BigInt(i + 1)] : []));
      return page(ids, offset, limit);
    },
    getCandidate: (candidateId) => {
      const candidate = flatCandidates()[Number(candidateId) - 1];
      if (!candidate) throw Object.assign(new Error("unknown candidate"), { code: "CALL_EXCEPTION" });
      return [candidate.name, state.candidateConstituencyOverrides[Number(candidateId)] ?? idOf(candidate.constituency)];
    },
    eip712Domain: () => ({ fields: "0x0f", ...state.domain, salt: "0x" + "00".repeat(32), extensions: [] }),
    hashAuthorization: (constituencyId, nullifier, candidateId, relayer, deadline) => {
      if (state.digestOverride) return state.digestOverride;
      const message = buildBallotAuthorization({ electionId: state.electionId.toLowerCase(), constituencyId, nullifier, candidateId, relayer, deadline });
      return hashBallotAuthorization(buildDomain({ chainId: state.domain.chainId, verifyingContract: state.domain.verifyingContract }), message);
    },
  };

  const strict = (name, implementations, record) =>
    new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property === "symbol" || property === "then") return undefined;
          record.add(String(property));
          const implementation = implementations[property];
          if (!implementation) throw new Error(`${name}.${String(property)} is not a plain read this fake allows`);
          return async (...args) => {
            if (state.failing.has(String(property))) throw Object.assign(new Error(`${property} failed`), { code: "CALL_EXCEPTION" });
            return implementation(...args);
          };
        },
      },
    );

  const provider = strict(
    "provider",
    {
      getBlockNumber: () => state.blockNumber,
      getCode: () => state.code,
      getBalance: () => state.balance,
      send: (method) => {
        touched.rpcMethods.add(method);
        if (method !== "eth_chainId") throw new Error(`rpc method ${method} is not allowed`);
        return "0x" + state.chainId.toString(16);
      },
    },
    touched.provider,
  );
  const contract = strict("contract", members, touched.contract);

  const signers = { addresses: { owner: hardhatAccount(0).address, authority: hardhatAccount(1).address, relayer: hardhatAccount(2).address } };
  const deployment = { chainId: 31337, contractAddress: FAKE_CONTRACT_ADDRESS, electionId: FAKE_ELECTION_ID };
  const mongo = { ping: async () => {} };

  return { state, touched, provider, contract, signers, deployment, mongo };
}
