import { keccak256 } from "ethers";
import { z } from "zod";
import { AppError } from "../utils/errors.js";
import { parse } from "../utils/validate.js";

/** The BN254 scalar field: every coordinate and the nullifier of a V3 ballot is an element of it (the contract refuses anything else). */
export const FIELD_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** The declared Semaphore proof depth (frozen: 20); the contract refuses any other. */
export const SEMAPHORE_DEPTH = 20n;
export const COORDS_PER_SLOT = 4;
export const K_MAX = 16;

const UINT256_MAX = (1n << 256n) - 1n;
// A number on the wire is a CANONICAL DECIMAL STRING (JSON numbers cannot hold 254 bits): no sign, no leading zero, no hex, within uint256.
const dec = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((s) => BigInt(s) <= UINT256_MAX);

/**
 * THE ANONYMOUS BALLOT PACKAGE: exactly the arguments of VoteChainV3.submitBallot(constituencyId, membership, coords, validity), as decimal strings.
 * Nothing else is accepted: strict objects refuse ANY other key (a voter id, a token, a credential id, an identity-session id, ...) by name.
 * The contract stays authoritative for scope, ballot hash, K_c, H, election id, chain id and contract address; none of them is in the package.
 */
export const BallotPackage = z.strictObject({
  constituencyId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  membership: z.strictObject({ merkleTreeDepth: dec, merkleTreeRoot: dec, nullifier: dec, points: z.array(dec).length(8) }),
  coords: z.array(dec).min(COORDS_PER_SLOT).max(COORDS_PER_SLOT * K_MAX),
  validity: z.strictObject({ a: z.array(dec).length(2), b: z.array(z.array(dec).length(2)).length(2), c: z.array(dec).length(2) }),
});

const refuse = (code, message) => new AppError(422, code, message);

/**
 * Validates the wire package and returns its CANONICAL form: the BigInt arguments, the ABI-encoded call data (the one canonical representation) and its
 * keccak256 (the package hash, which is what "the same package" means for idempotency). Cheap local checks mirror the contract's own, so an obviously
 * malformed package never costs an RPC call; the contract's static simulation remains the real validation.
 */
export function canonicalPackage(body, iface) {
  const wire = parse(BallotPackage, body);
  if (wire.coords.length % COORDS_PER_SLOT !== 0) throw new AppError(400, "VALIDATION_FAILED", "Invalid request: coords");
  const big = (s) => BigInt(s);
  const membership = {
    merkleTreeDepth: big(wire.membership.merkleTreeDepth),
    merkleTreeRoot: big(wire.membership.merkleTreeRoot),
    nullifier: big(wire.membership.nullifier),
    points: wire.membership.points.map(big),
  };
  const coords = wire.coords.map(big);
  const validity = { a: wire.validity.a.map(big), b: wire.validity.b.map((row) => row.map(big)), c: wire.validity.c.map(big) };
  if (membership.merkleTreeDepth !== SEMAPHORE_DEPTH) throw refuse("WRONG_SEMAPHORE_DEPTH", "the Semaphore proof must be declared at depth 20");
  if (membership.nullifier >= FIELD_PRIME) throw refuse("NULLIFIER_OUT_OF_FIELD", "the nullifier is not a field element");
  if (coords.some((c) => c >= FIELD_PRIME)) throw refuse("COORDINATE_OUT_OF_FIELD", "a ciphertext coordinate is not a field element");

  const constituencyId = wire.constituencyId.toLowerCase();
  const args = [constituencyId, membership, coords, validity];
  const calldata = iface.encodeFunctionData("submitBallot", args);
  return { constituencyId, nullifier: membership.nullifier.toString(), coords, args, calldata, packageHash: keccak256(calldata) };
}

/**
 * The arguments back out of stored call data, as PLAIN values (decodeFunctionData returns frozen ethers `Result` objects, which a later call cannot take as arguments).
 */
export function argsOfCalldata(calldata, iface) {
  const [constituencyId, m, coordsResult, v] = iface.decodeFunctionData("submitBallot", calldata);
  const coords = [...coordsResult].map(BigInt);
  const membership = { merkleTreeDepth: BigInt(m.merkleTreeDepth), merkleTreeRoot: BigInt(m.merkleTreeRoot), nullifier: BigInt(m.nullifier), points: [...m.points].map(BigInt) };
  const validity = { a: [...v.a].map(BigInt), b: [...v.b].map((row) => [...row].map(BigInt)), c: [...v.c].map(BigInt) };
  const id = String(constituencyId).toLowerCase();
  return { constituencyId: id, coords, args: [id, membership, coords, validity] };
}
