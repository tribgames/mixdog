import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';

/** Drops optimistic prompt cards: on navigation away from the session, and
 *  once each card's own durable row is in the settled transcript. */
export function useConversationOptimisticPromptRelease({
  transcriptSessionKey,
  promotedOwnDraft,
  settledItems,
  setOptimisticPrompts,
}: {
  transcriptSessionKey: string;
  promotedOwnDraft: { current: boolean };
  settledItems: readonly TranscriptItem[];
  setOptimisticPrompts: Dispatch<SetStateAction<PendingPromptItem[]>>;
}) {
  const previousTranscriptSessionKey = useRef(transcriptSessionKey);
  useEffect(() => {
    if (previousTranscriptSessionKey.current === transcriptSessionKey) return;
    previousTranscriptSessionKey.current = transcriptSessionKey;
    // A promotion is not a navigation: the in-flight prompt stays visible
    // until its own settled row lands (released by id), instead of blinking
    // out of the thread for the publication interval after the first submit.
    if (promotedOwnDraft.current) {
      promotedOwnDraft.current = false;
      return;
    }
    setOptimisticPrompts([]);
  }, [promotedOwnDraft, setOptimisticPrompts, transcriptSessionKey]);
  useEffect(() => {
    // Neither host acknowledgement nor queue publication is settlement: the
    // optimistic card is dropped from state only once its own durable row is
    // in the transcript.
    const acknowledged = new Set(
      settledItems
        .map((item) => item?.id)
        .filter((id) => id !== undefined && id !== null)
        .map(String)
    );
    if (acknowledged.size === 0) return;
    setOptimisticPrompts((current) => {
      const next = current.filter((item) => !acknowledged.has(String(item.id)));
      return next.length === current.length ? current : next;
    });
  }, [setOptimisticPrompts, settledItems]);
}
