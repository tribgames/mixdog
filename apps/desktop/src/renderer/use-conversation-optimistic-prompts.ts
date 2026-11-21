import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';

/** Drops optimistic prompt cards: on navigation away from the session, and
 *  once each card's own durable row is in the settled transcript. That row is
 *  the one carrying the card's submission id, for a send that started a turn
 *  and for one a running turn took from the queue alike; where a row lies,
 *  how many user rows there are and what the queue holds release nothing
 *  (another surface's message lands in the same places). The core publishes
 *  the row with its turn's start, so the running turn holds the working band
 *  from the same state on. */
export function useConversationOptimisticPromptRelease({
  transcriptSessionKey,
  promotedOwnDraft,
  settledItems,
  optimisticPrompts,
  setOptimisticPrompts,
}: {
  transcriptSessionKey: string;
  promotedOwnDraft: { current: boolean };
  settledItems: readonly TranscriptItem[];
  optimisticPrompts: readonly PendingPromptItem[];
  setOptimisticPrompts: Dispatch<SetStateAction<PendingPromptItem[]>>;
}) {
  const previousTranscriptSessionKey = useRef(transcriptSessionKey);
  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    if (promotedOwnDraft.current) {
      promotedOwnDraft.current = false;
      return;
    }
    setOptimisticPrompts([]);
  }, [promotedOwnDraft, setOptimisticPrompts, transcriptSessionKey]);
  useEffect(() => {
    if (optimisticPrompts.length === 0) return;
    const settled = new Set<string>();
    for (const item of settledItems) if (item?.id !== undefined && item.id !== null) settled.add(String(item.id));
    if (!optimisticPrompts.some((item) => settled.has(String(item.id)))) return;
    // Out for good: a window that later drops the row does not bring the card back.
    setOptimisticPrompts((current) => {
      const kept = current.filter((item) => !settled.has(String(item.id)));
      return kept.length === current.length ? current : kept;
    });
  }, [optimisticPrompts, setOptimisticPrompts, settledItems]);
}
