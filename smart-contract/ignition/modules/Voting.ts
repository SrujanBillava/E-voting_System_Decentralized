import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { ELECTION_ID, constituencies, constituencyIdOf } from "../data/election.js";

/**
 * Deploys Voting V2 and seeds constituencies and candidates from ignition/data/election.ts.
 * It does NOT open the election: the deployment ends in the Setup phase.
 *
 * Local development identities are three DIFFERENT Hardhat accounts:
 *   account 0 = owner (also the deployer), account 1 = authority signer, account 2 = relayer.
 */
export default buildModule("VotingModule", (m) => {
  const owner = m.getAccount(0);
  const authority = m.getAccount(1);
  const relayer = m.getAccount(2);

  const voting = m.contract("Voting", [owner, ELECTION_ID, authority, relayer]);

  // Candidate ids are assigned by call order, so every seeding call waits for the previous one.
  let previous: ReturnType<typeof m.call> | undefined;
  const seed = (id: string, fn: "addConstituency" | "addCandidate", args: string[]) => {
    previous = m.call(voting, fn, args, { id, after: previous ? [previous] : [] });
  };

  for (const c of constituencies) {
    // Ignition future ids allow only alphanumerics and underscores.
    const key = c.code.replace(/[^A-Za-z0-9]/g, "_");
    seed(`addConstituency_${key}`, "addConstituency", [c.code, c.name]);
    c.candidates.forEach((name, i) => {
      seed(`addCandidate_${key}_${i + 1}`, "addCandidate", [constituencyIdOf(c.code), name]);
    });
  }

  return { voting };
});
