import { useMemo } from 'react';
import {
  pendingPromptTranscriptItems,
  steerPromptItems,
  unsettledQueueEntries,
  type PendingPromptItem,
} from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';

const NO_PENDING_PROMPTS: PendingPromptItem[] = [];
const NO_PROMPT_IDS: string[] = [];

/**
 * Every prompt sent from this pane, split by where it shows: a prompt that
 * starts a turn is the transcript's optimistic row; a message sent behind a
 * running turn is a steering bubble at the transcript's end (with the
 * session runtime's own queue, whatever surface typed it) until the model
 * reads it and its durable row lands.
 */
export function useConversationSteering(
  optimisticPrompts: PendingPromptItem[],
  settledItems: TranscriptItem[],
  queued: unknown
) {
  const unsettledSessionQueue = useMemo(() => unsettledQueueEntries(queued, settledItems), [settledItems, queued]);
  const pendingPromptItems = useMemo(
    () => pendingPromptTranscriptItems(optimisticPrompts, settledItems),
    [optimisticPrompts, settledItems]
  );
  // Nothing pending is one shared empty list: a fresh `[]` on every settled
  // change (each session switch) re-rendered the memoised composer.
  const transcriptPendingPromptItems = useMemo(() => {
    const items = pendingPromptItems.filter((item) => !item.queuedBehindTurn);
    return items.length ? items : NO_PENDING_PROMPTS;
  }, [pendingPromptItems]);
  const pendingPromptIds = useMemo(
    () => (transcriptPendingPromptItems.length ? transcriptPendingPromptItems.map((item) => item.id) : NO_PROMPT_IDS),
    [transcriptPendingPromptItems]
  );
  const steerItems = useMemo(() => {
    const items = steerPromptItems(unsettledSessionQueue, pendingPromptItems);
    return items.length ? items : NO_PENDING_PROMPTS;
  }, [pendingPromptItems, unsettledSessionQueue]);
  const optimisticActivityStartedAt = transcriptPendingPromptItems.reduce((earliest, item) => {
    const startedAt = Number(item.submittedAt || 0);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return earliest;
    return earliest > 0 ? Math.min(earliest, startedAt) : startedAt;
  }, 0);
  return { steerItems, optimisticActivityStartedAt, pendingPromptIds, transcriptPendingPromptItems };
}
