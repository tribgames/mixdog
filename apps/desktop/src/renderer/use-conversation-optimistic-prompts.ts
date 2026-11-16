import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { PROMPT_TURN_REPORT_WAIT_MS, promptsAwaitingTurn, type PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';

/** Drops optimistic prompt cards: on navigation away from the session, and
 *  once each card's own durable row is in the settled transcript and, for a
 *  prompt that starts a turn, the turn is reported (or the wait for it ran
 *  out): until then the card holds the working band (promptsAwaitingTurn). */
export function useConversationOptimisticPromptRelease({
  transcriptSessionKey,
  promotedOwnDraft,
  optimisticPrompts,
  settledItems,
  busy,
  setOptimisticPrompts,
}: {
  transcriptSessionKey: string;
  promotedOwnDraft: { current: boolean };
  optimisticPrompts: readonly PendingPromptItem[];
  settledItems: readonly TranscriptItem[];
  busy: boolean;
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
    // in the transcript. One awaiting its turn report is marked landed; once
    // it no longer awaits (reported, followed, or its row left again with a
    // clear or rewind) it is retired, never returned to a pending bubble.
    const acknowledged = new Set(
      settledItems
        .map((item) => item?.id)
        .filter((id) => id !== undefined && id !== null)
        .map(String)
    );
    setOptimisticPrompts((current) => {
      const awaiting = new Set(promptsAwaitingTurn(current, settledItems, busy).map((item) => String(item.id)));
      let changed = false;
      const next = current.flatMap((item) => {
        const id = String(item.id);
        if (awaiting.has(id)) {
          if (item.landed) return [item];
          changed = true;
          return [{ ...item, landed: true }];
        }
        if (!item.landed && !acknowledged.has(id)) return [item];
        changed = true;
        return [];
      });
      return changed ? next : current;
    });
  }, [setOptimisticPrompts, settledItems, busy]);
  // The wait for a turn report is bounded from the moment the prompt's row landed.
  const landedAt = useRef(new Map<string, number>());
  useEffect(() => {
    const awaiting = promptsAwaitingTurn(optimisticPrompts, settledItems, busy).map((item) => String(item.id));
    const now = Date.now();
    for (const id of [...landedAt.current.keys()]) if (!awaiting.includes(id)) landedAt.current.delete(id);
    if (awaiting.length === 0) return;
    for (const id of awaiting) if (!landedAt.current.has(id)) landedAt.current.set(id, now);
    const due = Math.min(...awaiting.map((id) => (landedAt.current.get(id) ?? now) + PROMPT_TURN_REPORT_WAIT_MS));
    const timer = setTimeout(
      () =>
        setOptimisticPrompts((current) => {
          const expired = new Set(awaiting.filter((id) => (landedAt.current.get(id) ?? 0) + PROMPT_TURN_REPORT_WAIT_MS <= Date.now()));
          const next = current.filter((item) => !expired.has(String(item.id)));
          return next.length === current.length ? current : next;
        }),
      Math.max(0, due - now)
    );
    return () => clearTimeout(timer);
  }, [optimisticPrompts, setOptimisticPrompts, settledItems, busy]);
}
