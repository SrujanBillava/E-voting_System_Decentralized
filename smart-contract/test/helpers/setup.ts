import { network } from "hardhat";

// One in-process network for the whole suite. Tests isolate state with loadFixture snapshots.
export const { ethers, networkHelpers } = await network.create();

// ---------------------------------------------------------------- constants

/** The ONLY canonical EIP-712 type string. Written out by hand on purpose: tests must not
 *  derive it from the contract they are checking. */
export const TYPE_STRING =
  "BallotAuthorization(bytes32 electionId,bytes32 constituencyId,bytes32 nullifier,uint256 candidateId,address relayer,uint256 deadline)";

export const TYPES = {
  BallotAuthorization: [
    { name: "electionId", type: "bytes32" },
    { name: "constituencyId", type: "bytes32" },
    { name: "nullifier", type: "bytes32" },
    { name: "candidateId", type: "uint256" },
    { name: "relayer", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

export const Phase = { Setup: 0n, Open: 1n, Closed: 2n } as const;

export const ELECTION_ID = ethers.id("GENERAL-ELECTION-2026");

export const CONSTITUENCIES = {
  BLR: { code: "KA-BLR-S", name: "Bengaluru South" },
  DEL: { code: "DL-NDL", name: "New Delhi" },
  MUM: { code: "MH-MUM-N", name: "Mumbai North" },
} as const;

export const cid = (code: string): string => ethers.keccak256(ethers.toUtf8Bytes(code));
export const BLR = cid(CONSTITUENCIES.BLR.code);
export const DEL = cid(CONSTITUENCIES.DEL.code);
export const MUM = cid(CONSTITUENCIES.MUM.code);

/** Deterministic distinct non-zero nullifier. */
export const nullifierOf = (n: number | string): string => ethers.id(`voter-nullifier-${n}`);

// ------------------------------------------------------------------- typing

export interface AuthMessage {
  electionId: string;
  constituencyId: string;
  nullifier: string;
  candidateId: bigint | number;
  relayer: string;
  deadline: bigint | number;
}

export interface Domain {
  name: string;
  version: string;
  chainId: bigint | number;
  verifyingContract: string;
}

// ------------------------------------------------------------------ helpers

export async function domainOf(contract: { getAddress(): Promise<string> }): Promise<Domain> {
  const net = await ethers.provider.getNetwork();
  return {
    name: "VoteChain",
    version: "2",
    chainId: net.chainId,
    verifyingContract: await contract.getAddress(),
  };
}

export async function futureDeadline(secondsAhead = 3600): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest()) + BigInt(secondsAhead);
}

/**
 * Sign a BallotAuthorization. Any field can be overridden to build tampered or mismatched
 * authorizations; `domain` can be overridden to build wrong-chain / wrong-contract ones.
 */
export async function signAuth(
  signer: { signTypedData: (d: Domain, t: typeof TYPES, v: AuthMessage) => Promise<string> },
  domain: Domain,
  message: AuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, TYPES, message);
}
