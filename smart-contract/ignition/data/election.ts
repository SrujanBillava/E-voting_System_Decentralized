import { id, keccak256, toUtf8Bytes } from "ethers";

/**
 * THE canonical development election: one source of truth for deployment, seeding and
 * verification. The future backend can mirror this structure (or read the generated
 * deployments/local.json, which contains the same data with on-chain ids).
 *
 * DEMO DATA ONLY. These codes are NOT official Indian electoral constituency identifiers.
 */

/** Human-readable election code (kept in deployment metadata). */
export const ELECTION_CODE = "VOTECHAIN-DEMO-ELECTION-2026";

/**
 * On-chain election id: keccak256(utf8(ELECTION_CODE)). Reproducible by any backend with
 *   ethers.keccak256(ethers.toUtf8Bytes("VOTECHAIN-DEMO-ELECTION-2026"))
 */
export const ELECTION_ID: string = id(ELECTION_CODE);

/** On-chain constituency id: keccak256(bytes(code)). Codes are case-sensitive. */
export const constituencyIdOf = (code: string): string => keccak256(toUtf8Bytes(code));

export interface SeedConstituency {
  code: string;
  name: string;
  /** Candidate names in ballot order. On-chain candidate ids are assigned globally, from 1,
   *  in the order they appear here (constituency by constituency). */
  candidates: string[];
}

export const constituencies: SeedConstituency[] = [
  {
    code: "KA-BLR",
    name: "Bengaluru",
    candidates: [
      "Amit Sharma",
      "Rahul Verma",
      "Neha Joshi",
      "Rakesh Gowda",
      "Anjali Rao",
      "Kiran Kumar",
      "Megha Iyer",
    ],
  },
  {
    code: "DL-DEL",
    name: "Delhi",
    candidates: [
      "Rohan Malhotra",
      "Priya Khanna",
      "Nikhil Sood",
      "Deepak Singh",
      "Ajay Mehra",
      "Kavita Arora",
    ],
  },
  {
    code: "MH-MUM",
    name: "Mumbai",
    candidates: [
      "Akash Patil",
      "Sneha Kulkarni",
      "Ritesh Deshmukh",
      "Ayesha Khan",
      "Nitin Sawant",
    ],
  },
];

/** Flat, ordered view with the global candidate ids the contract will assign. */
export const expectedCandidates = constituencies.flatMap((c) => c.candidates.map((name) => ({ constituencyCode: c.code, name })))
  .map((c, i) => ({ id: i + 1, ...c, constituencyId: constituencyIdOf(c.constituencyCode) }));
