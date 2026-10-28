import { useMemo } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { isRoomTypingItem } from './agent-chat-place';
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
  steerItems,
  liveItem,
  busy,
  commandBusy,
  commandActivityVisible,
  optimisticActivityStartedAt,
  room = false,
}: {
  identity: string;
  sessionKey: string;
  settledItems: TranscriptItem[];
  settledRowItems: TranscriptItem[];
  failedTurnKeys: string[] | undefined;
  precomputedTurnKeys: unknown;
  pendingItems: PendingPromptItem[];
  /** Messages sent while the turn runs that the model has not read yet. */
  steerItems?: PendingPromptItem[];
  liveItem: TranscriptItem | null;
  busy: boolean | undefined;
  commandBusy: boolean | undefined;
  commandActivityVisible: boolean;
  optimisticActivityStartedAt: number;
  /** A group room: its live band is the typing slot. The host appends a
   *  typing row under a fresh id per member turn and drops it between turns;
   *  as a row of its own it came and went at the bottom of the thread, and a
   *  followed room moved up and down by its height at every turn. The band
   *  keeps one key and one height for the whole run and paints the typing
   *  member (use-conversation-row-renderer.ts), so the trailing typing row
   *  opens no row. */
  room?: boolean;
}) {
  const failedTurns = useMemo(() => new Set(failedTurnKeys || []), [failedTurnKeys]);
  const turnKeys = Array.isArray(precomputedTurnKeys) ? (precomputedTurnKeys as string[]) : null;
  const settledTurnKeys = useMemo(
    () => (turnKeys?.length === settledItems.length ? turnKeys : transcriptTurnKeys(settledItems)),
    [turnKeys, settledItems]
  );
  // Only TRAILING typing rows leave: the turn keys stay aligned by index.
  const projectedItems = useMemo(() => {
    if (!room) return settledRowItems;
    let end = settledRowItems.length;
    while (end > 0 && isRoomTypingItem(settledRowItems[end - 1])) end -= 1;
    return end === settledRowItems.length ? settledRowItems : settledRowItems.slice(0, end);
  }, [room, settledRowItems]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft promoting to a session keeps `identity` but must still re-project under the new session key.
  const settledProjection = useMemo(
    () =>
      projectSettledTranscriptRows({
        sessionKey: identity,
        items: projectedItems,
        turnKeys: settledTurnKeys,
        failedTurns,
      }),
    [failedTurns, identity, sessionKey, projectedItems, settledTurnKeys]
  );
  // The busy band reserves its row for the whole turn, through activity that
  // briefly reads null. A turn whose completion already folded into its reply
  // is over, though: that reply's footer took the band's place, and a band
  // kept below it for a lingering busy flag moved the settled reply by the
  // band's height, twice. Visible activity (a wake's spinner, a command) or a
  // waiting prompt still brings the band back.
  const turnSettled =
    settledProjection.endsWithFoldedCompletion && !commandActivityVisible && pendingItems.length === 0;
  const transcriptRows = useMemo(
    () =>
      appendLiveTranscriptRows({
        sessionKey: identity,
        settled: settledProjection,
        pendingItems,
        steerItems,
        liveItem,
        thinking: Boolean(
          (busy && !turnSettled) || (commandBusy && commandActivityVisible) || liveItem || optimisticActivityStartedAt
        ),
        turnRunning: Boolean(busy),
      }),
    [
      identity,
      optimisticActivityStartedAt,
      settledProjection,
      pendingItems,
      steerItems,
      busy,
      turnSettled,
      commandBusy,
      commandActivityVisible,
      liveItem,
    ]
  );
  return { settledTurnKeys, transcriptRows };
}
