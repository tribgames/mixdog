import type { ComposerAttachment } from "./composer-support";

let submissionSequence = 0;

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
