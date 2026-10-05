// TEST / DEMO SUPPORT ONLY. Runs a whole key ceremony between separate Trustee objects in one process. The trustees see nothing but JSON-cloned public
// messages (so no object reference, closure or secret can travel between them), exactly as they would over a network. src/ never imports this file.
import { buildTranscript, confirmCeremony, DEFAULT_PARAMS, type Announcement, type CommitmentMessage, type Confirmation, type DkgParams, type EncryptedShare, type ParsedTranscript, type Transcript } from "../src/ceremony.ts";
import { TEST_CONTEXT, type ElectionContext } from "../src/params.ts";
import { Trustee } from "../src/trustee.ts";

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Optional interference with the messages in transit; `recipient` lets a hook equivocate (send different things to different trustees). */
export interface Tamper {
  announcements?: (messages: Announcement[], recipient: number) => unknown;
  commitments?: (messages: CommitmentMessage[], recipient: number) => unknown;
  shares?: (messages: EncryptedShare[], recipient: number) => unknown;
  transcript?: (transcript: Transcript, recipient: number) => unknown;
}

export interface CeremonyOptions {
  context?: ElectionContext;
  params?: DkgParams;
  minBallots?: number;
  tamper?: Tamper;
}

export interface CeremonyRun {
  context: ElectionContext;
  params: DkgParams;
  trustees: Trustee[];
  announcements: Announcement[];
  commitmentMessages: CommitmentMessage[];
  shareMessages: EncryptedShare[];
  transcript: Transcript;
  confirmations: Confirmation[];
  verified: ParsedTranscript;
}

interface Progress {
  trustees: Trustee[];
  announcements: Announcement[];
  commitmentMessages: CommitmentMessage[];
  shareMessages: EncryptedShare[];
  step: string;
}

function execute(options: CeremonyOptions, progress: Progress): CeremonyRun {
  const context = options.context ?? TEST_CONTEXT;
  const params = options.params ?? DEFAULT_PARAMS;
  const tamper = options.tamper ?? {};
  const trustees = Array.from({ length: params.n }, (_, i) => new Trustee({ index: i + 1, context, params, ...(options.minBallots !== undefined ? { minBallots: options.minBallots } : {}) }));
  progress.trustees = trustees;

  progress.step = "announce";
  const announcements = trustees.map((t) => clone(t.announce()));
  progress.announcements = announcements;
  progress.step = "commit";
  const commitmentMessages = trustees.map((t) => clone(t.commit(clone(tamper.announcements ? tamper.announcements(clone(announcements), t.index) : announcements))));
  progress.commitmentMessages = commitmentMessages;
  progress.step = "deal";
  const dealt = trustees.map((t) => t.deal(clone(tamper.commitments ? tamper.commitments(clone(commitmentMessages), t.index) : commitmentMessages)).map(clone));
  const shareMessages = dealt.flat();
  progress.shareMessages = shareMessages;
  progress.step = "receive";
  for (const t of trustees) {
    const mine = shareMessages.filter((m) => m.to === t.index);
    t.receive(clone(tamper.shares ? tamper.shares(clone(mine), t.index) : mine));
  }
  progress.step = "transcript";
  const transcript = buildTranscript({ context, params, announcements, commitmentMessages });
  progress.step = "finalize";
  const confirmations = trustees.map((t) => clone(t.finalize(clone(tamper.transcript ? tamper.transcript(clone(transcript), t.index) : transcript))));
  progress.step = "confirm";
  const verified = confirmCeremony(transcript, confirmations, { context, params });
  return { context, params, trustees, announcements, commitmentMessages, shareMessages, transcript, confirmations, verified };
}

/** A complete ceremony. Throws the first error (a CeremonyAbort when a trustee refuses). */
export function runCeremony(options: CeremonyOptions = {}): CeremonyRun {
  return execute(options, { trustees: [], announcements: [], commitmentMessages: [], shareMessages: [], step: "start" });
}

export type Attempt = { ok: true; run: CeremonyRun } | { ok: false; error: unknown; step: string; trustees: Trustee[] };

/** Like runCeremony, but returns what happened instead of throwing: the trustees stay available for inspection after an abort. */
export function attemptCeremony(options: CeremonyOptions = {}): Attempt {
  const progress: Progress = { trustees: [], announcements: [], commitmentMessages: [], shareMessages: [], step: "start" };
  try {
    return { ok: true, run: execute(options, progress) };
  } catch (error) {
    return { ok: false, error, step: progress.step, trustees: progress.trustees };
  }
}
