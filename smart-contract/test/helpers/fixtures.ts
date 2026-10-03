import {
  BLR,
  CONSTITUENCIES,
  DEL,
  ELECTION_ID,
  MUM,
  domainOf,
  ethers,
  futureDeadline,
  networkHelpers,
  signAuth,
  type AuthMessage,
  type Domain,
} from "./setup.js";

/**
 * Standard test world.
 *
 *  KA-BLR-S : candidates 1, 2, 3
 *  DL-NDL   : candidates 4, 5
 *  MH-MUM-N : candidate  6
 */
export const CANDIDATES = {
  BLR: [1n, 2n, 3n],
  DEL: [4n, 5n],
  MUM: [6n],
} as const;

export async function deployFixture() {
  const [owner, authority, relayer, attacker, other, newOwner, authority2, relayer2] =
    await ethers.getSigners();

  const voting = await ethers.deployContract("Voting", [
    owner.address,
    ELECTION_ID,
    authority.address,
    relayer.address,
  ]);

  return {
    voting,
    owner,
    authority,
    relayer,
    attacker,
    other,
    newOwner,
    authority2,
    relayer2,
    domain: await domainOf(voting),
  };
}

export async function configuredFixture() {
  const ctx = await deployFixture();
  const { voting } = ctx;

  await voting.addConstituency(CONSTITUENCIES.BLR.code, CONSTITUENCIES.BLR.name);
  await voting.addConstituency(CONSTITUENCIES.DEL.code, CONSTITUENCIES.DEL.name);
  await voting.addConstituency(CONSTITUENCIES.MUM.code, CONSTITUENCIES.MUM.name);

  await voting.addCandidate(BLR, "Asha Rao"); // 1
  await voting.addCandidate(BLR, "Vikram Shetty"); // 2
  await voting.addCandidate(BLR, "Meera Nair"); // 3
  await voting.addCandidate(DEL, "Karan Malhotra"); // 4
  await voting.addCandidate(DEL, "Pooja Verma"); // 5
  await voting.addCandidate(MUM, "Sanjay Kulkarni"); // 6

  return ctx;
}

export async function openFixture() {
  const ctx = await configuredFixture();
  await ctx.voting.openElection();
  return ctx;
}

export async function closedFixture() {
  const ctx = await openFixture();
  await ctx.voting.closeElection();
  return ctx;
}

export type World = Awaited<ReturnType<typeof openFixture>>;

export interface BallotInput {
  constituencyId: string;
  nullifier: string;
  candidateId: bigint;
  deadline?: bigint;
  /** Who signs. Default: the world's authority. */
  signer?: { signTypedData: (d: Domain, t: never, v: AuthMessage) => Promise<string> };
  /** Relayer address placed inside the signed message. Default: the world's relayer. */
  signedRelayer?: string;
  /** Domain used for signing. Default: this world's real domain. */
  domain?: Domain;
  /** Override individual signed fields (to build tampered authorizations). */
  signedOverrides?: Partial<AuthMessage>;
}

export interface Ballot {
  constituencyId: string;
  nullifier: string;
  candidateId: bigint;
  deadline: bigint;
  signature: string;
}

/** Build the call arguments plus an authority signature for them. */
export async function makeBallot(world: World, input: BallotInput): Promise<Ballot> {
  const deadline = input.deadline ?? (await futureDeadline());
  const message: AuthMessage = {
    electionId: ELECTION_ID,
    constituencyId: input.constituencyId,
    nullifier: input.nullifier,
    candidateId: input.candidateId,
    relayer: input.signedRelayer ?? world.relayer.address,
    deadline,
    ...input.signedOverrides,
  };
  const signer = (input.signer ?? world.authority) as unknown as Parameters<typeof signAuth>[0];
  const signature = await signAuth(signer, input.domain ?? world.domain, message);
  return {
    constituencyId: input.constituencyId,
    nullifier: input.nullifier,
    candidateId: input.candidateId,
    deadline,
    signature,
  };
}

/** Submit a ballot as `caller` (default: the world's relayer). Returns the pending tx. */
export function castBallot(world: World, ballot: Ballot, caller?: { address: string }) {
  const signer = (caller ?? world.relayer) as typeof world.relayer;
  return world.voting
    .connect(signer)
    .castVote(ballot.constituencyId, ballot.nullifier, ballot.candidateId, ballot.deadline, ballot.signature);
}

/** Convenience: sign and cast in one go. */
export async function vote(world: World, input: BallotInput, caller?: { address: string }) {
  return castBallot(world, await makeBallot(world, input), caller);
}

export { networkHelpers };
