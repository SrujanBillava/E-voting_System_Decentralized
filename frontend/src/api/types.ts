/** Shapes returned by the VoteChain V2 backend (backend-api). The browser never talks to the blockchain. */

export type ElectionPhase = "Setup" | "Open" | "Closed";

export type VoterStage = "AUTHENTICATED" | "FACE_VERIFIED" | "ELIGIBLE" | "AUTH_ISSUED" | "SUBMITTED" | "COMPLETED";

// ------------------------------------------------------------------ public
export interface PublicCandidate {
  candidateId: string;
  name: string;
}
export interface PublicConstituency {
  code: string;
  name: string;
  candidates: PublicCandidate[];
}
export interface PublicElection {
  electionId: string;
  phase: ElectionPhase;
  contractAddress: string;
  chainId: number;
  constituencies: PublicConstituency[];
}

export interface ResultsCandidate {
  candidateId: string;
  name: string;
  votes: string;
}
export interface ResultsConstituency {
  code: string;
  name: string;
  totalVotes: string;
  candidates: ResultsCandidate[];
}
export interface PublicResults {
  electionId: string;
  phase: "Closed";
  totalBallots: string;
  constituencies: ResultsConstituency[];
  notice: string;
}

/** `GET /public/receipts/:txHash`. Deliberately has no candidate field, in any phase. */
export interface PublicReceiptCheck {
  found: true;
  status: "CONFIRMED" | "PENDING" | "CONFIRMING";
  txHash: string;
  blockNumber?: number;
  blockHash?: string;
  ballotIndex?: string;
  electionId?: string;
  contractAddress?: string;
  chainId?: number;
  confirmedAt?: string;
  constituency?: { code: string; name: string };
  confirmations?: number;
  statement?: string;
}

// ------------------------------------------------------------------ voter
export interface SafeVoter {
  voterId: string;
  name: string;
  constituencyCode: string;
  faceEnrolled: boolean;
}
export interface VoterStatus {
  voter: SafeVoter;
  stage: VoterStage;
  stageExpiresAt: string;
  sessionExpiresAt: string;
  electionPhase: ElectionPhase;
}
export interface VoterLoginResult {
  voter: SafeVoter;
  stage: VoterStage;
  stageExpiresAt: string;
}
export interface EligibilityResult {
  eligible: true;
  stage: VoterStage;
  stageExpiresAt: string;
  electionId: string;
  constituency: { code: string; name: string };
}
export interface Ballot {
  electionId: string;
  constituency: { code: string; name: string };
  candidates: PublicCandidate[];
}
export interface AuthorizationResult {
  ticketId: string;
  stage: VoterStage;
  expiresAt: string;
}
export interface CastResult {
  stage: VoterStage;
  state: string;
  txHash: string | null;
}
/** The portable receipt: safe to copy or print. It has no voter, candidate, nullifier or signature. */
export interface PortableReceipt {
  txHash: string;
  blockNumber: number;
  blockHash: string;
  ballotIndex: string;
  contractAddress: string;
  chainId: number;
  electionId: string;
  confirmedAt: string;
  verifyUrl: string;
}
export interface ReceiptConfirmed {
  stage: "COMPLETED";
  state: "CONFIRMED";
  stageExpiresAt: string;
  receipt: PortableReceipt;
  /** For the authenticated voter's own confirmation screen ONLY. Never part of a copied/printed/QR receipt. */
  recordedSelection: { name: string };
}
export interface ReceiptPending {
  stage: VoterStage;
  state: "PENDING";
  txHash: string | null;
}

// ------------------------------------------------------------------ admin
export interface AdminProfile {
  id: string;
  email: string;
  name: string;
  role: string;
}
export interface PreflightSummary {
  ok: boolean;
  status: string;
  checkedAt: string;
  checks: { name: string; status: "pass" | "warn" | "fail" | "skip" | string }[];
}
export interface AdminElection {
  electionId: string;
  phase: ElectionPhase;
  contractAddress: string;
  chainId: number;
  constituencyCount: number;
  candidateCount: number;
  totalBallots: number;
  preflight: PreflightSummary;
  voters?: { registered: number; faceEnrolled: number };
}
export interface AdminVoter {
  id: string;
  voterId: string;
  name: string;
  email: string;
  constituencyCode: string;
  status: "ACTIVE" | "SUSPENDED";
  faceEnrolled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface VoterPage {
  voters: AdminVoter[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
export interface AdminConstituency {
  code: string;
  name: string;
  constituencyId: string;
  candidateCount: number;
}
export interface AdminCandidate {
  candidateId: number;
  name: string;
  constituencyCode: string;
  constituencyId: string;
}
