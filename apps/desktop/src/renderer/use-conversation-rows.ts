import { useMemo, useRef } from 'react';
import { itemPlacesById, type PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { isRoomTypingItem } from './agent-chat-place';
import { keptFrom, noteCarried, sharedPrefix } from './list-carry';
import { transcriptTurnKeys, turnKeysTakenOver } from './renderer-logic.mjs';
import { appendLiveTranscriptRows, createSettledProjector, type TranscriptRowModel } from './transcript-rows';

export function useStreamingTail(streamingTail: TranscriptItem | null | undefined, settledItems: TranscriptItem[]) {
  const streamingTailId = streamingTail?.id;
  const tailSettledIndex = useMemo(() => {
    if (streamingTailId === undefined || streamingTailId === null) return -1;
    const at = itemPlacesById(settledItems).get(String(streamingTailId)) ?? -1;
    // An id of another type that reads the same is not this row's.
    if (at >= 0 && settledItems[at]?.id !== streamingTailId) {
      return settledItems.findIndex((item) => item?.id === streamingTailId);
    }
    return at;
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
  const rowItems = useRef<{ from: readonly TranscriptItem[]; items: TranscriptItem[] } | null>(null);
  const settledRowItems = useMemo(() => {
    const held = rowItems.current;
    const items = tailReplacesLastSettled ? settledItems.slice(0, -1) : settledItems;
    // The list is the one before with the same rows left in place, less the last where the tail stands for it.
    if (held && items !== settledItems) {
      noteCarried(items, held.items, Math.min(keptFrom(settledItems, held.from), items.length, held.items.length));
    }
    rowItems.current = { from: settledItems, items };
    return items;
  }, [settledItems, tailReplacesLastSettled]);
  return { activeStreamingTail, liveItemCount, settledRowItems };
}

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
  room?: boolean;
}) {
  const failedTurns = useMemo(() => new Set(failedTurnKeys || []), [failedTurnKeys]);
  const turnKeys = Array.isArray(precomputedTurnKeys) ? (precomputedTurnKeys as string[]) : null;
  // The keys this pane made itself (a list the lane's own keys do not cover) are carried on from the list before.
  const ownTurnKeys = useRef<{ items: readonly TranscriptItem[]; keys: string[] } | null>(null);
  const settledTurnKeys = useMemo(() => {
    if (turnKeys?.length === settledItems.length) return turnKeys;
    const held = ownTurnKeys.current;
    const keys = transcriptTurnKeys(
      settledItems,
      held ? { keys: held.keys, kept: keptFrom(settledItems, held.items) } : undefined
    );
    // What is read of the keys (the rows, each turn's first place) is carried on from the keys left in place: a turn's end
    // renames the keys of the items it holds, so only the ones taken over as they were are known to be.
    if (held) noteCarried(keys, held.keys, sharedPrefix(keys, held.keys, turnKeysTakenOver(keys)));
    ownTurnKeys.current = { items: settledItems, keys };
    return keys;
  }, [turnKeys, settledItems]);
  // Only TRAILING typing rows leave: the turn keys stay aligned by index.
  const projectedItems = useMemo(() => {
    if (!room) return settledRowItems;
    let end = settledRowItems.length;
    while (end > 0 && isRoomTypingItem(settledRowItems[end - 1])) end -= 1;
    return end === settledRowItems.length ? settledRowItems : settledRowItems.slice(0, end);
  }, [room, settledRowItems]);
  // The pane's rows are carried on from the ones it made before: a frame's items are read from the first that changed.
  const projector = useRef<ReturnType<typeof createSettledProjector> | null>(null);
  projector.current ??= createSettledProjector();
  const settled = projector.current;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a draft promoting to a session keeps `identity` but must still re-project under the new session key.
  const settledProjection = useMemo(
    () =>
      settled.project({
        sessionKey: identity,
        items: projectedItems,
        turnKeys: settledTurnKeys,
        failedTurns,
      }),
    [failedTurns, identity, sessionKey, projectedItems, settledTurnKeys, settled]
  );
  const turnSettled =
    settledProjection.endsWithFoldedCompletion && !commandActivityVisible && pendingItems.length === 0;
  const shownRows = useRef<readonly TranscriptRowModel[] | undefined>(undefined);
  const transcriptRows = useMemo(
    () => {
      const rows = appendLiveTranscriptRows({
        sessionKey: identity,
        settled: settledProjection,
        pendingItems,
        steerItems,
        liveItem,
        thinking: Boolean(
          (busy && !turnSettled) || (commandBusy && commandActivityVisible) || liveItem || optimisticActivityStartedAt
        ),
        turnRunning: Boolean(busy),
        prior: shownRows.current,
      });
      shownRows.current = rows;
      return rows;
    },
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
