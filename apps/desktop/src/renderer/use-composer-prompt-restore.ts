// Another device cancelled a turn this device started: the host hands the
// prompt back through the session state (`promptRestore`) instead of through
// the canceller's reply. Only the composer whose device minted one of the
// submission ids applies it, and it never replaces a draft that is already there.
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Snapshot } from './desktop-types';
import { appliedPromptRestores, draftWithRestoredPrompt, wasSubmittedHere } from './composer-draft';

type AppliedRestores = typeof appliedPromptRestores;

/** The draft after applying the session state's offer `restore` in session `sessionId`'s composer, or null when it belongs
 *  to another device or was already applied (`appliedPromptRestores`: as this session's offer, or from a Stop reply). An
 *  offer skipped because its reply was applied becomes the remembered offer, so a later reply cannot forget it. */
export function applyPromptRestore(
  restore: Snapshot['promptRestore'],
  currentDraft: string,
  sessionId: string,
  applied: AppliedRestores = appliedPromptRestores
): string | null {
  if (!restore?.text) return null;
  const seen = applied.get(sessionId) ?? {};
  if (seen.offer === restore.id) return null;
  if (seen.reply === restore.id) {
    applied.set(sessionId, { ...seen, offer: restore.id });
    return null;
  }
  if (!restore.ids.some(wasSubmittedHere)) return null;
  applied.set(sessionId, { ...seen, offer: restore.id });
  return draftWithRestoredPrompt(currentDraft, restore.text);
}

/** A Stop reply's hand-back `id` in session `sessionId`: true when it was already applied (as the state's offer or a reply);
 *  otherwise it becomes the session's remembered reply (the offer is kept) and false is answered. */
export function replyRestoreApplied(id: string, sessionId: string, applied: AppliedRestores = appliedPromptRestores): boolean {
  const seen = applied.get(sessionId) ?? {};
  if (seen.offer === id || seen.reply === id) return true;
  applied.set(sessionId, { ...seen, reply: id });
  return false;
}

export function useComposerPromptRestore({
  promptRestore,
  sessionId,
  setDraft,
  draftRef,
  textarea,
  onQueuedRestored,
}: {
  promptRestore: Snapshot['promptRestore'];
  sessionId: string;
  setDraft: Dispatch<SetStateAction<string>>;
  draftRef: RefObject<string>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onQueuedRestored?(ids: string[]): void;
}): void {
  useEffect(() => {
    if (!promptRestore) return;
    const next = applyPromptRestore(promptRestore, draftRef.current ?? '', sessionId);
    if (next === null) return;
    setDraft((current) => {
      const merged = draftWithRestoredPrompt(current, promptRestore.text);
      draftRef.current = merged;
      return merged;
    });
    onQueuedRestored?.(promptRestore.ids);
    window.setTimeout(() => textarea.current?.focus(), 0);
  }, [promptRestore, sessionId, draftRef, setDraft, textarea, onQueuedRestored]);
}
