import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { candidates } from "../data/candidates.js";

const VotingModule = buildModule("VotingModule", (m) => {
  const voting = m.contract("Voting");

  candidates.forEach((candidate, index) => {
    m.call(
      voting,
      "addCandidate",
      [candidate.name, candidate.constituency],
      {
        id: `addCandidate${index + 1}`,
      }
    );
  });

  return { voting };
});

export default VotingModule;