import { Identity, constituencyIdOf } from "../crypto/privacy.ts";
import { assertRecordIntact, buildBallot, expectedOf, refreshMembership, toRelayPackage, type PrepareStep, type PrepareTimings } from "./ballot.ts";
import { createChainReader, type ChainReader, type ElectionResult } from "./chain.ts";
import { KioskError } from "./errors.ts";
import { verifyPublicGroup, type VerifiedGroup } from "./group.ts";
import { AnonymousGuard, createIdentityClient, createRelayClient, type FaceChallenge, type FetchLike, type IdentityClient, type RelayBallotStatus, type RelayClient } from "./http.ts";
import { buildReceipt, assertReceiptSafe } from "./receipt.ts";
import { createSessionStore, type SessionStore } from "./session.ts";
import type { BallotRecord, ElectionParams, FlowRecord, KioskConfig, Receipt, RecordedEvidence, StorageLike } from "./types.ts";

/** What a (real or test) camera pipeline provides: a face descriptor for a challenge. The camera UI has its own loop and talks to the identity client directly. */
export interface FaceProvider {
  descriptor(challenge: FaceChallenge): Promise<{ descriptor: number[]; liveness?: { passed: boolean } }>;
}

export type BootView = "login" | "face" | "eligibility" | "waiting" | "ballot" | "submit" | "receipt" | "credential-lost";
export type SubmitOutcome = { kind: "RECORDED"; receipt: Receipt } | { kind: "PENDING"; reason: "RELAY" | "CONFIRMATION" };
export interface OpenBallot {
  params: ElectionParams;
  verified: VerifiedGroup;
}

const FATAL_RELAY: Record<string, string> = {
  NULLIFIER_CONFLICT: "A different ballot was already sent with this voting credential. Please ask a polling official.",
  ELECTION_CLOSED: "The election closed before your ballot was recorded.",
  ELECTION_NOT_OPEN: "The election is not open.",
  INVALID_VALIDITY_PROOF: "The network refused the ballot proof. Nothing was recorded.",
  WRONG_COORDINATE_COUNT: "The network refused the ballot because it does not fit this constituency.",
  UNKNOWN_CONSTITUENCY: "The network does not know this constituency.",
};
const RETRYABLE_RELAY = new Set(["CHAIN_UNAVAILABLE", "RATE_LIMITED", "INTERNAL_ERROR"]);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * THE KIOSK ENGINE. One object per voter session, framework-free: the React UI and the Node end-to-end harness drive exactly this code.
 *
 *  IDENTITY SIDE   login -> face -> eligibility -> local Semaphore identity -> public commitment -> wait for the epoch cohort -> CREDENTIAL_ISSUED. Then the guard LOCKS:
 *                  the identity client can never be used again by this page session.
 *  ANONYMOUS SIDE  public group (credentials omitted) -> verify OWN commitment + root locally -> encrypt + prove locally -> immutable package -> relayer (credentials
 *                  omitted) -> confirm BallotRecorded on-chain -> safe receipt -> wipe secrets.
 *
 * Trusted-endpoint model: this code SEES the voter's identity (login) and, later, the plaintext choice. The privacy claim is not "the kiosk cannot know the vote"; it is that
 * no single SERVER-SIDE component knows both who the voter is and what they chose.
 */
export function createKiosk(options: { config: KioskConfig; fetch: FetchLike; storage: StorageLike; chain?: ChainReader; sleep?: (ms: number) => Promise<void>; now?: () => number }) {
  const { config } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollMs = config.pollMs ?? 1000;
  const guard = new AnonymousGuard();
  const identityApi: IdentityClient = createIdentityClient({ fetch: options.fetch, base: config.identityBase, guard });
  const relayApi: RelayClient = createRelayClient({ fetch: options.fetch, base: config.relayBase });
  const chain = options.chain ?? createChainReader(config);
  const session: SessionStore = createSessionStore(options.storage);
  let identity: Identity | null = null;
  let timings: PrepareTimings | null = null;

  /** The private identity of this tab, or null. An export that does not rebuild the commitment this tab requested is damaged and counts as lost: it is never used and never replaced. */
  const loadIdentity = (): Identity | null => {
    if (identity) return identity;
    const exported = session.getIdentity();
    if (!exported) return null;
    let loaded: Identity;
    try {
      loaded = Identity.import(exported);
    } catch {
      return null;
    }
    const flow = session.getFlow();
    if (flow && loaded.commitment.toString() !== flow.commitment) return null;
    return (identity = loaded);
  };
  const lockIfIssued = () => {
    if (session.getFlow()?.stage === "CREDENTIAL_ISSUED") guard.lock();
  };
  lockIfIssued(); // a page that reloads AFTER issuance starts in anonymous mode and can never call the identity service

  async function waitRecorded(record: BallotRecord): Promise<RecordedEvidence | null> {
    const stop = now() + (config.confirmTimeoutMs ?? 30_000);
    for (;;) {
      const evidence = await chain.findRecorded(expectedOf(record), record.relay?.txHash);
      if (evidence) return evidence;
      if (now() >= stop) return null;
      await sleep(pollMs);
    }
  }

  function finish(record: BallotRecord, evidence: RecordedEvidence): SubmitOutcome {
    const receipt = buildReceipt({ params: { electionId: "0x" + BigInt(record.ctx.electionId).toString(16).padStart(64, "0"), constituency: record.constituency, ctx: { chainId: BigInt(record.ctx.chainId), contractAddress: BigInt(record.ctx.contractAddress), electionId: BigInt(record.ctx.electionId) } }, evidence });
    assertReceiptSafe(receipt, { nullifier: record.nullifier, root: record.membership.merkleTreeRoot });
    session.setReceipt(receipt);
    session.wipeVotingSecrets(); // the private identity, the anonymous package and the flow record all go
    identity = null;
    return { kind: "RECORDED", receipt };
  }

  const kiosk = {
    config,
    guard,
    identityApi,
    relayApi,
    chain,
    session,
    get lastTimings() {
      return timings;
    },

    // ---------------------------------------------------------------------------------------------------------- where to resume

    /**
     * Decides the first screen after a page load, from this tab's sessionStorage and (only BEFORE a credential exists) the identity session. A tab that holds an issued
     * credential or an anonymous package never contacts the identity service again. If the identity service says a credential exists but this tab lost its private identity,
     * the kiosk FAILS CLOSED: it never requests another one.
     */
    async boot(): Promise<BootView> {
      if (session.getReceipt()) return "receipt";
      const flow = session.getFlow();
      if (session.getBallot()) return "submit";
      if (flow) {
        if (!loadIdentity()) return "credential-lost";
        return flow.stage === "CREDENTIAL_ISSUED" ? "ballot" : "waiting";
      }
      try {
        const status = await identityApi.status();
        switch (status.stage) {
          case "AUTHENTICATED":
            return "face";
          case "FACE_VERIFIED":
          case "ELIGIBLE":
            return "eligibility";
          default:
            return "credential-lost"; // COMMITMENT_PENDING / CREDENTIAL_ISSUED with nothing local: the private identity is gone
        }
      } catch (err) {
        if (err instanceof KioskError && (err.status === 401 || err.code === "UNAUTHENTICATED" || err.code === "SESSION_EXPIRED")) return "login";
        if (err instanceof KioskError && (err.code === "ISSUANCE_CLOSED" || err.code === "ELECTION_CLOSED" || err.code === "ELECTION_NOT_OPEN")) return "login";
        throw err;
      }
    },

    // ---------------------------------------------------------------------------------------------------------- identity side

    login: (identifier: string, password: string) => identityApi.login(identifier, password),

    /** Non-UI face step (tests, the harness): status -> challenge -> descriptor -> verify, until verified, locked or out of rounds. */
    async verifyFace(provider: FaceProvider, rounds = 4): Promise<void> {
      const status = await identityApi.faceStatus();
      if (status.verified) return;
      if (!status.enrolled) throw new KioskError("FACE_NOT_ENROLLED", "No face is enrolled for this voter. Please ask a polling official.");
      if (status.locked) throw new KioskError("FACE_LOCKED", "Face verification is locked. Please ask a polling official.");
      for (let i = 0; i < rounds; i++) {
        const challenge = await identityApi.faceChallenge();
        const { descriptor, liveness } = await provider.descriptor(challenge);
        const result = await identityApi.faceVerify({ challenge: challenge.challenge, descriptor, ...(liveness ? { liveness } : {}) });
        if (result.verified) return;
        if (result.locked) throw new KioskError("FACE_LOCKED", "Face verification is locked. Please ask a polling official.");
      }
      throw new KioskError("FACE_FAILED", "The face could not be verified.");
    },

    /**
     * ELIGIBLE -> credential request. The Semaphore identity is created HERE, locally, once (a retry in the same tab reuses it from sessionStorage); the identity service
     * receives ONLY its public commitment. Idempotent and safe to call again after a network error.
     */
    async beginCredential(): Promise<{ constituency: { code: string; id: string } }> {
      const eligible = await identityApi.eligibility();
      const code = eligible.constituency.code;
      const constituency = { code, id: constituencyIdOf(code) };
      const existing = session.getFlow();
      if (existing && existing.constituency.code !== code) throw new KioskError("CONSTITUENCY_CHANGED", "Your constituency does not match this session. Please ask a polling official.");
      let id = loadIdentity();
      if (!id) {
        if (existing) throw new KioskError("CREDENTIAL_LOST", "The voting credential of this session is no longer available.");
        id = new Identity();
        session.setIdentity(id.export());
        identity = id;
      }
      const flow: FlowRecord = { v: 1, stage: "CREDENTIAL_REQUESTED", constituency, commitment: id.commitment.toString() };
      session.setFlow(flow);
      await identityApi.requestCredential(flow.commitment);
      return { constituency };
    },

    /**
     * Waits for the epoch cohort that carries the commitment. On CREDENTIAL_ISSUED the identity session is over (the service deleted it and cleared the cookie): the guard locks
     * for good and the kiosk is anonymous from here. Returns "PENDING" if the wait timed out (the voter may simply wait again).
     */
    async awaitCredential(onTick?: () => void): Promise<"ISSUED" | "PENDING"> {
      const flow = session.getFlow();
      if (!flow || flow.stage !== "CREDENTIAL_REQUESTED") throw new KioskError("NO_CREDENTIAL_REQUEST", "No credential request is in progress.");
      const stop = now() + (config.issuanceTimeoutMs ?? 120_000);
      const issued = () => {
        session.setFlow({ ...flow, stage: "CREDENTIAL_ISSUED" });
        guard.lock();
        return "ISSUED" as const;
      };
      // The identity session ENDS the moment the credential is delivered. If the delivery was lost (a dropped response) or the session expired, polling finds no session (401). From then
      // on the identity service is not asked anything more: the PUBLIC chain is the truth about whether this commitment landed in the group.
      let sessionGone = false;
      for (;;) {
        if (!sessionGone) {
          let polled;
          try {
            polled = await identityApi.pollCredential();
          } catch (err) {
            // the page was reloaded between "request sent" and "request recorded": the SAME commitment is simply requested again (the service is idempotent for it)
            if (err instanceof KioskError && err.code === "STAGE_REQUIRED") {
              await identityApi.requestCredential(flow.commitment);
              continue;
            }
            if (err instanceof KioskError && err.code === "CREDENTIAL_CANCELLED") {
              session.wipeAll(); // nothing was issued: the voter starts again from the login
              identity = null;
            }
            if (!(err instanceof KioskError && (err.status === 401 || err.code === "UNAUTHENTICATED" || err.code === "SESSION_EXPIRED"))) throw err;
            sessionGone = true;
            continue;
          }
          if (polled.state === "CREDENTIAL_ISSUED") {
            if (polled.constituency.id.toLowerCase() !== flow.constituency.id.toLowerCase() || polled.constituency.code !== flow.constituency.code) throw new KioskError("CONSTITUENCY_CHANGED", "The credential is for another constituency. Please ask a polling official.");
            return issued();
          }
        } else {
          const params = await chain.pinElection(flow.constituency.code);
          if (await chain.hasMember(params.groupId, BigInt(flow.commitment))) return issued();
        }
        onTick?.();
        if (now() >= stop) return "PENDING";
        await sleep(pollMs);
      }
    },

    // ---------------------------------------------------------------------------------------------------------- anonymous side

    /**
     * Pins the public election parameters from the contract and verifies, locally, that the voter's own commitment is in the public group and that the rebuilt root is the
     * contract's. Retries briefly if a new cohort landed between the two reads.
     */
    async openBallot(): Promise<OpenBallot> {
      const flow = session.getFlow();
      if (!flow || flow.stage !== "CREDENTIAL_ISSUED") throw new KioskError("NO_CREDENTIAL", "There is no issued credential in this session.");
      if (!loadIdentity()) throw new KioskError("CREDENTIAL_LOST", "The voting credential of this session is no longer available.");
      const params = await chain.pinElection(flow.constituency.code);
      let last: unknown;
      for (let i = 0; i < 4; i++) {
        try {
          return { params, verified: await verifyPublicGroup({ relay: relayApi, chain, params, commitment: BigInt(flow.commitment) }) };
        } catch (err) {
          last = err;
          if (!(err instanceof KioskError && err.retryable)) throw err;
          await sleep(pollMs);
        }
      }
      throw last;
    },

    /** Encrypts and proves LOCALLY, stores the immutable package, then submits it. `choice` is the 0-based candidate index; it is never stored or sent. */
    async castVote(input: { choice: number; open: OpenBallot; onStep?: (step: PrepareStep) => void; onProgress?: (state: string) => void }): Promise<SubmitOutcome> {
      const id = loadIdentity();
      if (!id) throw new KioskError("CREDENTIAL_LOST", "The voting credential of this session is no longer available.");
      if (session.getBallot()) throw new KioskError("BALLOT_EXISTS", "A ballot has already been prepared in this session. It will be resent, not recreated.");
      const built = await buildBallot({ identity: id, params: input.open.params, choice: input.choice, group: input.open.verified.group, chain, ...(input.onStep ? { onStep: input.onStep } : {}) });
      timings = built.timings;
      session.setBallot(built.record);
      return kiosk.submit(input.onProgress);
    },

    /**
     * Sends the STORED package and confirms it on-chain. Safe to call as often as needed (after a refresh, an outage, a timeout): the package is never rebuilt, the relayer
     * is idempotent per nullifier, and the chain is asked first. Only the Semaphore membership proof is ever regenerated, and only when its root is no longer the contract's.
     */
    async submit(onProgress?: (state: string) => void): Promise<SubmitOutcome> {
      let record = session.getBallot();
      if (!record) throw new KioskError("NO_BALLOT", "There is no prepared ballot in this session.");
      assertRecordIntact(record);

      const recorded = await chain.findRecorded(expectedOf(record), record.relay?.txHash);
      if (recorded) return finish(record, recorded);

      let refreshes = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        const reply = await relayApi.postBallot(toRelayPackage(record));
        if (reply.ok) {
          record = { ...record, relay: { state: reply.data.state, ...(reply.data.txHash ? { txHash: reply.data.txHash } : {}) } };
          session.setBallot(record);
          onProgress?.(reply.data.state);
          if (reply.data.state === "FAILED") {
            if (["EVENT_MISSING", "TX_REVERTED"].includes(reply.data.failureCode ?? "")) continue; // an identical request makes the relayer try the SAME ballot again
            throw new KioskError(reply.data.failureCode ?? "RELAY_FAILED", "The relayer could not record the ballot.", { retryable: false });
          }
          const stop = now() + (config.confirmTimeoutMs ?? 30_000);
          let state: RelayBallotStatus["state"] = reply.data.state;
          let txHash = reply.data.txHash;
          while (state !== "CONFIRMED") {
            if (now() >= stop) return { kind: "PENDING", reason: "RELAY" };
            await sleep(pollMs);
            const status = await relayApi.getBallot(record.nullifier);
            if (!status.ok) {
              if (status.status >= 500) continue;
              throw new KioskError(status.code, "The relayer could not report the ballot status.", { retryable: false });
            }
            state = status.data.state;
            txHash = status.data.txHash ?? txHash;
            onProgress?.(state);
            if (state === "FAILED") break;
          }
          if (txHash) {
            record = { ...record, relay: { state, txHash } };
            session.setBallot(record);
          }
          if (state === "FAILED") continue;
          const evidence = await waitRecorded(record);
          return evidence ? finish(record, evidence) : { kind: "PENDING", reason: "CONFIRMATION" };
        }

        // ---- the relayer refused
        if (reply.code === "INVALID_MEMBERSHIP_PROOF") {
          // Root expiry looks exactly like this. Ask the CHAIN: if the proof's root is still the contract's current root there is nothing to refresh and the proof is simply
          // invalid; otherwise only the membership proof is regenerated for the same ballot, against a verified current root.
          const flow = session.getFlow();
          const id = loadIdentity();
          if (!flow || !id) throw new KioskError("CREDENTIAL_LOST", "The voting credential of this session is no longer available.");
          const params = await chain.pinElection(record.constituency.code);
          const current = await chain.currentRoot(params.groupId);
          if (current.root.toString() === record.membership.merkleTreeRoot || refreshes >= 3) throw new KioskError("PROOF_REJECTED", "The network refused the membership proof. Nothing was recorded.");
          refreshes++;
          const verified = await verifyPublicGroup({ relay: relayApi, chain, params, commitment: BigInt(flow.commitment) });
          record = await refreshMembership({ identity: id, record, group: verified.group, depth: params.depth });
          session.setBallot(record);
          continue;
        }
        if (reply.code === "NULLIFIER_ALREADY_USED") {
          const evidence = await chain.findRecorded(expectedOf(record), record.relay?.txHash); // throws CONFIRMATION_MISMATCH if it is a different ballot
          if (evidence) return finish(record, evidence);
          throw new KioskError("NULLIFIER_USED", "This voting credential was already used.");
        }
        if (reply.code in FATAL_RELAY) throw new KioskError(reply.code, FATAL_RELAY[reply.code]!, { retryable: false, status: reply.status });
        if (RETRYABLE_RELAY.has(reply.code) || reply.status >= 500) throw new KioskError(reply.code, "The relayer is busy or unavailable. Your ballot is safe; please try again.", { retryable: true, status: reply.status });
        throw new KioskError(reply.code, "The relayer refused the ballot. Nothing was recorded.", { retryable: false, status: reply.status });
      }
      return { kind: "PENDING", reason: "RELAY" };
    },

    /** The PUBLIC result of a constituency: finalized totals, or { finalized: false }. Needs no identity and shows nothing before finalization. */
    results: (constituencyCode: string): Promise<ElectionResult> => chain.readResult(constituencyCode),

    /** Leave the kiosk: wipe everything this tab holds (before a credential exists; afterwards an unfinished vote is NOT recoverable by design). */
    leave(): void {
      session.wipeAll();
      identity = null;
    },
  };
  return kiosk;
}
export type Kiosk = ReturnType<typeof createKiosk>;
