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

export function shouldPreserveComposerDraftOnScopeChange(
  previousScope: string,
  nextScope: string,
): boolean {
  return previousScope.startsWith("new-task:")
    && nextScope.startsWith("new-task:");
}

export function composerDraftAfterScopeChange({
  currentDraft,
  liveDomDraft,
  preserveDraft,
  typingLive,
}: {
  currentDraft: string;
  liveDomDraft: string;
  preserveDraft: boolean;
  typingLive: boolean;
}): string {
  const candidate = typingLive ? liveDomDraft : currentDraft;
  return (preserveDraft || typingLive) && candidate.trim() ? candidate : "";
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
