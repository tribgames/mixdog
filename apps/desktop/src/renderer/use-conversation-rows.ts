import { useMemo } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { transcriptTurnKeys } from './renderer-logic.mjs';
import { appendLiveTranscriptRows, projectSettledTranscriptRows } from './transcript-rows';

/**
 * Resolves the live streaming tail against the settled items. Settled arrays
 * are immutable by identity, so a same-id replacement is looked up only when
 * that identity or the tail id changes; streamed text then uses an indexed
 * settled+tail view instead of a merged copy.
 */
export function useStreamingTail(streamingTail: TranscriptItem | null | undefined, settledItems: TranscriptItem[]) {
  const streamingTailId = streamingTail?.id;
  const tailSettledIndex = useMemo(() => {
    if (streamingTailId === undefined || streamingTailId === null) return -1;
    return settledItems.findIndex((item) => item?.id === streamingTailId);
  }, [settledItems, streamingTailId]);
  // A tail whose id already settled before the final item is a delayed lane
  // publication. It must not reopen old output or leave a synthetic Thinking
  // row behind after the actual turn has moved on.
  const activeStreamingTail =
    streamingTail && (tailSettledIndex < 0 || tailSettledIndex === settledItems.length - 1) ? streamingTail : null;
  const tailAppended = Boolean(activeStreamingTail) && tailSettledIndex < 0;
  const liveItemCount = settledItems.length + (tailAppended ? 1 : 0);
  // A same-id live item replaces the last settled row in the projection. Its
  // selector-driven renderer still updates independently, but now occupies the
  // same virtual row and measurement path as settled output.
  const tailReplacesLastSettled = Boolean(activeStreamingTail) && tailSettledIndex === settledItems.length - 1;
  const settledRowItems = useMemo(
    () => (tailReplacesLastSettled ? settledItems.slice(0, -1) : settledItems),
    [settledItems, tailReplacesLastSettled]
  );
  return { activeStreamingTail, liveItemCount, settledRowItems };
}

/**
 * ONE projection owns visibility, completion folding, and failed-turn status
 * rows, so the virtual list never carries invisible or zero-height rows. The
 * settled half re-runs only when settled items change; each streaming tick
 * appends the live tail onto the memoized settled rows.
 */
export function useTranscriptRows({
  identity,
  sessionKey,
  settledItems,
  settledRowItems,
  failedTurnKeys,
  precomputedTurnKeys,
  pendingItems,
  liveItem,
  busy,
  commandBusy,
  commandActivityVisible,
  optimisticActivityStartedAt,
}: {
  identity: string;
  sessionKey: string;
  settledItems: TranscriptItem[];
  settledRowItems: TranscriptItem[];
  failedTurnKeys: string[] | undefined;
  precomputedTurnKeys: unknown;
  pendingItems: PendingPromptItem[];
  liveItem: TranscriptItem | null;
  busy: boolean | undefined;
  commandBusy: boolean | undefined;
  commandActivityVisible: boolean;
  optimisticActivityStartedAt: number;
}) {
  const failedTurns = useMemo(() => new Set(failedTurnKeys || []), [failedTurnKeys]);
  const turnKeys = Array.isArray(precomputedTurnKeys) ? (precomputedTurnKeys as string[]) : null;
  const settledTurnKeys = useMemo(
    () => (turnKeys?.length === settledItems.length ? turnKeys : transcriptTurnKeys(settledItems)),
    [turnKeys, settledItems]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft promoting to a session keeps `identity` but must still re-project under the new session key.
  const settledProjection = useMemo(
    () =>
      projectSettledTranscriptRows({
        sessionKey: identity,
        items: settledRowItems,
        turnKeys: settledTurnKeys,
        failedTurns,
      }),
    [failedTurns, identity, sessionKey, settledRowItems, settledTurnKeys]
  );
  const transcriptRows = useMemo(
    () =>
      appendLiveTranscriptRows({
        sessionKey: identity,
        settled: settledProjection,
        pendingItems,
        liveItem,
        thinking: Boolean(busy || (commandBusy && commandActivityVisible) || liveItem || optimisticActivityStartedAt),
      }),
    [
      identity,
      optimisticActivityStartedAt,
      settledProjection,
      pendingItems,
      busy,
      commandBusy,
      commandActivityVisible,
      liveItem,
    ]
  );
  return { settledTurnKeys, transcriptRows };
}
