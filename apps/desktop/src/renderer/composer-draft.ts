import type { ComposerAttachment } from "./composer-support";

let submissionSequence = 0;
let recoverySequence = 0;

export type ComposerSubmissionRecovery = {
  id: string;
  scope: string;
  text: string;
  attachments: ComposerAttachment[];
};

type StoredComposerSubmissionRecovery = ComposerSubmissionRecovery & {
  rejected: boolean;
  sequence: number;
};

const composerSubmissionRecoveries = new Map<string, StoredComposerSubmissionRecovery>();

export function retainComposerSubmissionRecovery(
  recovery: ComposerSubmissionRecovery,
): void {
  composerSubmissionRecoveries.set(recovery.id, {
    ...recovery,
    attachments: [...recovery.attachments],
    rejected: false,
    sequence: ++recoverySequence,
  });
}

export function rejectComposerSubmissionRecovery(id: string): void {
  const recovery = composerSubmissionRecoveries.get(id);
  if (recovery) recovery.rejected = true;
}

export function resolveComposerSubmissionRecovery(id: string): void {
  composerSubmissionRecoveries.delete(id);
}

export function takeRejectedComposerSubmissionRecoveries(
  scope: string,
): ComposerSubmissionRecovery[] {
  const recoveries = [...composerSubmissionRecoveries.values()]
    .filter((recovery) => recovery.rejected && recovery.scope === scope)
    .sort((left, right) => left.sequence - right.sequence);
  for (const recovery of recoveries) composerSubmissionRecoveries.delete(recovery.id);
  return recoveries.map(({ id, scope: recoveryScope, text, attachments }) => ({
    id,
    scope: recoveryScope,
    text,
    attachments: [...attachments],
  }));
}

/** A composer identity that belongs to a freshly opened New Task pane.
 *  Pressing New task mints a distinct draft identity, and a fresh draft
 *  ALWAYS opens clean — carrying the previous pane's text and attachments
 *  into it was a reported bug. */
export function composerScopeOpensFreshDraft(nextScope: string): boolean {
  return nextScope.startsWith("draft:");
}

/** In-flight text per composer identity. Switching tabs swaps the identity
 *  scope on ONE mounted composer, so the text typed in a tab is parked here
 *  and handed back when that tab is shown again (user: 다른 탭 갔다와도
 *  타이핑하던 글자 남아있게). Empty text drops the entry. */
const composerDraftsByScope = new Map<string, string>();

export function stashComposerDraft(scope: string, text: string): void {
  if (text.trim()) composerDraftsByScope.set(scope, text);
  else composerDraftsByScope.delete(scope);
}

export function stashedComposerDraft(scope: string): string {
  return composerDraftsByScope.get(scope) ?? "";
}

export function composerDraftAfterScopeChange({
  currentDraft,
  liveDomDraft,
  freshDraft,
  typingLive,
  stashedDraft = "",
}: {
  currentDraft: string;
  liveDomDraft: string;
  freshDraft: boolean;
  typingLive: boolean;
  /** Text the target tab parked when the user left it; it wins because the
   *  user is RETURNING to that tab, not opening a new one. */
  stashedDraft?: string;
}): string {
  if (stashedDraft.trim()) return stashedDraft;
  if (freshDraft) return "";
  const candidate = typingLive ? liveDomDraft : currentDraft;
  return typingLive && candidate.trim() ? candidate : "";
}

export function nextComposerSubmissionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `desktop-submit-${uuid || `${Date.now()}-${++submissionSequence}`}`;
}

export function submissionRetryKey(
  text: string,
  attachments: readonly ComposerAttachment[],
): string {
  return JSON.stringify([
    text,
    attachments.map((attachment) => String(attachment.id)),
  ]);
}

export function insertComposerToken(
  current: string,
  rawStart: number | undefined,
  rawEnd: number | undefined,
  token: string,
): { next: string; caret: number } {
  const start = Math.max(0, Math.min(rawStart ?? current.length, current.length));
  const end = Math.max(start, Math.min(rawEnd ?? start, current.length));
  const before = current.slice(0, start);
  const after = current.slice(end);
  const leading = before && !/\s$/.test(before) ? " " : "";
  const trailing = " ";
  const inserted = `${leading}${token}${trailing}`;
  return {
    next: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}
