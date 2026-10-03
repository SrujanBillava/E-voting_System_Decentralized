import { TypedDataEncoder, getAddress, id, isHexString, verifyTypedData } from "ethers";

/**
 * THE canonical backend definition of the BallotAuthorization protocol.
 * Nothing else in the backend may restate the type, the domain name or the version.
 * It must stay identical to Voting.sol; tests and the startup preflight compare it with the
 * deployed contract and with the generated ABI export.
 */

export const EIP712_DOMAIN_NAME = "VoteChain";
export const EIP712_DOMAIN_VERSION = "2";

export const BALLOT_AUTHORIZATION_TYPE_STRING =
  "BallotAuthorization(bytes32 electionId,bytes32 constituencyId,bytes32 nullifier,uint256 candidateId,address relayer,uint256 deadline)";

export const BALLOT_AUTHORIZATION_TYPES = Object.freeze({
  BallotAuthorization: Object.freeze([
    Object.freeze({ name: "electionId", type: "bytes32" }),
    Object.freeze({ name: "constituencyId", type: "bytes32" }),
    Object.freeze({ name: "nullifier", type: "bytes32" }),
    Object.freeze({ name: "candidateId", type: "uint256" }),
    Object.freeze({ name: "relayer", type: "address" }),
    Object.freeze({ name: "deadline", type: "uint256" }),
  ]),
});

/** keccak256 of the type string; equals Voting.BALLOT_AUTHORIZATION_TYPEHASH(). */
export const BALLOT_AUTHORIZATION_TYPEHASH = id(BALLOT_AUTHORIZATION_TYPE_STRING);

const UINT256_MAX = (1n << 256n) - 1n;

const isBytes32 = (v) => typeof v === "string" && isHexString(v, 32);

/**
 * Strict unsigned-integer input: a bigint, a safe-integer number, or a plain decimal string.
 * (BigInt() alone would also accept `true`, `[7]`, " 12 " and "0x10", i.e. inputs nobody meant.)
 */
function toUint(name, value, { min = 0n } = {}) {
  let n;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) n = BigInt(value);
  else throw new TypeError(`${name} must be an integer`);
  if (n < min || n > UINT256_MAX) throw new RangeError(`${name} is out of range`);
  return n;
}

/** EIP-712 domain for a deployed Voting contract. */
export function buildDomain({ chainId, verifyingContract }) {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: toUint("chainId", chainId, { min: 1n }),
    verifyingContract: getAddress(verifyingContract),
  };
}

/**
 * Validate and normalise a BallotAuthorization message.
 * candidateId must be >= 1 (0 is never a valid candidate); deadline is a unix timestamp in seconds.
 */
export function buildBallotAuthorization({ electionId, constituencyId, nullifier, candidateId, relayer, deadline }) {
  if (!isBytes32(electionId)) throw new TypeError("electionId must be a bytes32 hex string");
  if (!isBytes32(constituencyId)) throw new TypeError("constituencyId must be a bytes32 hex string");
  if (!isBytes32(nullifier)) throw new TypeError("nullifier must be a bytes32 hex string");
  if (BigInt(nullifier) === 0n) throw new RangeError("nullifier must not be zero");
  return {
    electionId: electionId.toLowerCase(),
    constituencyId: constituencyId.toLowerCase(),
    nullifier: nullifier.toLowerCase(),
    candidateId: toUint("candidateId", candidateId, { min: 1n }),
    relayer: getAddress(relayer),
    deadline: toUint("deadline", deadline, { min: 1n }),
  };
}

const DOMAIN_FIELDS = ["chainId", "name", "verifyingContract", "version"];

/**
 * ethers silently drops every domain field that is missing, which would make a signature valid on
 * any chain or contract. Signing and hashing therefore insist on the complete four-field domain.
 */
function assertCompleteDomain(domain) {
  if (domain === null || typeof domain !== "object" || Object.keys(domain).sort().join() !== DOMAIN_FIELDS.join()) {
    throw new TypeError(`domain must have exactly the fields ${DOMAIN_FIELDS.join(", ")}`);
  }
  toUint("domain.chainId", domain.chainId, { min: 1n }); // ethers would accept 0; no real chain has it
  if (typeof domain.name !== "string" || typeof domain.version !== "string") throw new TypeError("domain name and version must be strings");
}

/** The EIP-712 digest; equals Voting.hashAuthorization(...) for the same relayer. The message is validated first. */
export function hashBallotAuthorization(domain, message) {
  assertCompleteDomain(domain);
  return TypedDataEncoder.hash(domain, BALLOT_AUTHORIZATION_TYPES, buildBallotAuthorization(message));
}

/**
 * Sign with the authority signer (an ethers Signer). Returns a 65-byte 0x signature.
 * Only the protocol's own domain (name "VoteChain", version "2") may be signed, and the message is validated first.
 */
export async function signBallotAuthorization(authoritySigner, domain, message) {
  assertCompleteDomain(domain);
  if (domain.name !== EIP712_DOMAIN_NAME || domain.version !== EIP712_DOMAIN_VERSION) {
    throw new TypeError("refusing to sign under a domain that is not the VoteChain protocol domain");
  }
  return authoritySigner.signTypedData(domain, BALLOT_AUTHORIZATION_TYPES, buildBallotAuthorization(message));
}

/** Address that produced `signature` over `message` under `domain`. */
export function recoverBallotAuthorizationSigner(domain, message, signature) {
  assertCompleteDomain(domain);
  return verifyTypedData(domain, BALLOT_AUTHORIZATION_TYPES, buildBallotAuthorization(message), signature);
}

/** Self-check used by tests and the preflight: the constants must agree with each other. */
export function encodedTypeString() {
  return TypedDataEncoder.from(BALLOT_AUTHORIZATION_TYPES).encodeType("BallotAuthorization");
}
