// Another device cancelled a turn this device started: the host hands the
// prompt back through the session state (`promptRestore`) instead of through
// the canceller's reply. Only the composer whose device minted one of the
// submission ids applies it, and it never replaces a draft that is already there.
import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Snapshot } from './desktop-types';
import { draftWithRestoredPrompt, wasSubmittedHere } from './composer-draft';

const appliedRestores = new Set<string>();
const APPLIED_RESTORE_LIMIT = 64;

/** The draft after applying `restore`, or null when it belongs to another device
 *  or was already applied. */
export function applyPromptRestore(
  restore: Snapshot['promptRestore'],
  currentDraft: string,
  applied: Set<string> = appliedRestores
): string | null {
  if (!restore || !restore.text || applied.has(restore.id)) return null;
  if (!restore.ids.some(wasSubmittedHere)) return null;
  applied.add(restore.id);
  if (applied.size > APPLIED_RESTORE_LIMIT) applied.delete(applied.values().next().value as string);
  return draftWithRestoredPrompt(currentDraft, restore.text);
}

export function useComposerPromptRestore({
  promptRestore,
  setDraft,
  draftRef,
  textarea,
  onQueuedRestored,
}: {
  promptRestore: Snapshot['promptRestore'];
  setDraft: Dispatch<SetStateAction<string>>;
  draftRef: RefObject<string>;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onQueuedRestored?(ids: string[]): void;
}): void {
  useEffect(() => {
    if (!promptRestore) return;
    const next = applyPromptRestore(promptRestore, draftRef.current ?? '');
    if (next === null) return;
    setDraft((current) => {
      const merged = draftWithRestoredPrompt(current, promptRestore.text);
      draftRef.current = merged;
      return merged;
    });
    onQueuedRestored?.(promptRestore.ids);
    window.setTimeout(() => textarea.current?.focus(), 0);
  }, [promptRestore, draftRef, setDraft, textarea, onQueuedRestored]);
}
