import { useMemo } from 'react';
import {
  pendingPromptTranscriptItems,
  unsettledQueueEntries,
  type PendingPromptItem,
} from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { asRecord } from './text-format';

/**
 * Cross-surface queue parity: ONE queue owns every prompt waiting behind an
 * active turn, whatever typed it. The moment the session runtime publishes a
 * submission in `queued`, the composer's reserved-message list owns its
 * display, so an app-typed prompt stacks in session runtime order beside
 * terminal-typed ones and drains on the next turn loop. The optimistic item
 * stays in state: a prompt that leaves the queue before its durable row lands
 * falls back to the transcript card instead of blinking out.
 *
 * A prompt submitted BEHIND an active turn belongs to the reserved list from
 * its FIRST frame, so its transcript row is withheld and the same prompt is
 * handed to the composer's queue until the runtime publishes its own entry
 * (submit mints the id the runtime reuses for the queue entry).
 */
export function useConversationQueue(
  optimisticPrompts: PendingPromptItem[],
  settledItems: TranscriptItem[],
  queued: unknown
) {
  const unsettledSessionQueue = useMemo(() => unsettledQueueEntries(queued, settledItems), [settledItems, queued]);
  const sessionQueuedIdKey = useMemo(
    () => unsettledSessionQueue.map((entry) => String(asRecord(entry)?.id ?? '')).join('\u0000'),
    [unsettledSessionQueue]
  );
  const sessionQueuedIds = useMemo(
    () => new Set(sessionQueuedIdKey.split('\u0000').filter(Boolean)),
    [sessionQueuedIdKey]
  );
  const pendingPromptItems = useMemo(
    () =>
      pendingPromptTranscriptItems(optimisticPrompts, settledItems).filter(
        (item) => !item.queuedBehindTurn || !sessionQueuedIds.has(String(item.id))
      ),
    [sessionQueuedIds, optimisticPrompts, settledItems]
  );
  const transcriptPendingPromptItems = useMemo(
    () => pendingPromptItems.filter((item) => !item.queuedBehindTurn),
    [pendingPromptItems]
  );
  const localQueuedPrompts = useMemo(
    () => pendingPromptItems.filter((item) => item.queuedBehindTurn),
    [pendingPromptItems]
  );
  const pendingPromptIds = useMemo(
    () => transcriptPendingPromptItems.map((item) => item.id),
    [transcriptPendingPromptItems]
  );
  // The composer's reserved list = the session runtime queue plus the submits
  // it has not published yet; the runtime entry replaces its local twin by id.
  const composerQueued = useMemo(() => {
    const sessionQueue = unsettledSessionQueue;
    if (localQueuedPrompts.length === 0) return sessionQueue;
    const published = new Set(sessionQueue.map((entry) => String(asRecord(entry)?.id ?? '')).filter(Boolean));
    const local = localQueuedPrompts
      .filter((item) => !published.has(String(item.id)))
      .map((item) => ({
        id: item.id,
        displayText: item.text,
        ...(item.images?.length ? { images: item.images } : {}),
      }));
    return local.length === 0 ? sessionQueue : [...sessionQueue, ...local];
  }, [localQueuedPrompts, unsettledSessionQueue]);
  const optimisticActivityStartedAt = pendingPromptItems.reduce((earliest, item) => {
    if (item.queuedBehindTurn) return earliest;
    const startedAt = Number(item.submittedAt || 0);
    if (!Number.isFinite(startedAt) || startedAt <= 0) return earliest;
    return earliest > 0 ? Math.min(earliest, startedAt) : startedAt;
  }, 0);
  return { composerQueued, optimisticActivityStartedAt, pendingPromptIds, transcriptPendingPromptItems };
}
