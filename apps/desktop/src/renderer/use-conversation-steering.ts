import { useMemo } from 'react';
import {
  pendingPromptTranscriptItems,
  steerPromptItems,
  turnPromptItems,
  unsettledQueueEntries,
  type PendingPromptItem,
} from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';

const NO_PENDING_PROMPTS: PendingPromptItem[] = [];
const NO_PROMPT_IDS: string[] = [];

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
    const items = turnPromptItems(pendingPromptItems, unsettledSessionQueue);
    return items.length ? items : NO_PENDING_PROMPTS;
  }, [pendingPromptItems, unsettledSessionQueue]);
  const pendingPromptIds = useMemo(
    () => (transcriptPendingPromptItems.length ? transcriptPendingPromptItems.map((item) => item.id) : NO_PROMPT_IDS),
    [transcriptPendingPromptItems]
  );
  const steerItems = useMemo(() => {
    const items = steerPromptItems(unsettledSessionQueue, pendingPromptItems);
    return items.length ? items : NO_PENDING_PROMPTS;
  }, [pendingPromptItems, unsettledSessionQueue]);
  // The submit clock runs while the bubble is pending. The core publishes the
  // prompt's row with its turn's start (busy) in one state, so the running
  // turn takes the band over in the commit the bubble leaves.
  const optimisticActivityStartedAt = transcriptPendingPromptItems.reduce((earliest, item) => {
    const startedAt = Number(item.submittedAt || 0);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return earliest;
    return earliest > 0 ? Math.min(earliest, startedAt) : startedAt;
  }, 0);
  return { steerItems, optimisticActivityStartedAt, pendingPromptIds, transcriptPendingPromptItems };
}
