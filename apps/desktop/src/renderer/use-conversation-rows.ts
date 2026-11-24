import { useMemo, useRef } from 'react';
import { itemPlacesById, type PendingPromptItem } from './conversation-prompt-items';
import type { TranscriptItem } from './desktop-types';
import { isRoomTypingItem } from './agent-chat-place';
import { carriedLast, keptFrom, noteCarried, sharedPrefix } from './list-carry';
import { transcriptTurnKeys, turnKeysTakenOver } from './renderer-logic.mjs';
import {
  appendLiveTranscriptRows,
  closesReply,
  closingEnd,
  createSettledProjector,
  type TranscriptRowModel,
} from './transcript-rows';

const NO_PLACES: readonly number[] = [];

const attemptOf = (item: TranscriptItem | null | undefined): string =>
  typeof item?.attemptId === 'string' ? item.attemptId : '';

/** Where, in `items`, the ends are that their own turn passed: the core names a turn's attempt on its end and on every
 *  row of the turn (`attemptId`), so an end followed by a row of the same attempt (settled, or the reply arriving) did
 *  not end the turn. Read back to the last prompt: the turns before it are over. Ascending. */
function passedEnds(items: readonly TranscriptItem[], liveItem: TranscriptItem | null): readonly number[] {
  let places: number[] | null = null;
  let after: Set<string> | null = null;
  const live = attemptOf(liveItem);
  if (live) after = new Set([live]);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'user' && !item.steered) break;
    const attempt = attemptOf(item);
    if (!attempt) continue;
    if (item?.kind !== 'turndone') {
      after ??= new Set();
      after.add(attempt);
    } else if (closesReply(item) && after?.has(attempt)) {
      places ??= [];
      places.unshift(index);
    }
  }
  return places ?? NO_PLACES;
}

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

/** Whether the first `count` items close with a turn's end that names a reply (`finalAssistantId`) its turn has not
 *  settled: an end can be written before its reply is. */
function endAwaitsReply(items: readonly TranscriptItem[], count: number): boolean {
  const end = items[count - 1];
  if (end?.kind !== 'turndone' || end.finalAssistantId == null) return false;
  const named = String(end.finalAssistantId);
  for (let at = count - 2; at >= 0; at -= 1) {
    const item = items[at];
    if (item?.kind === 'turndone' || item?.kind === 'user') return true;
    if (item?.kind === 'assistant' && String(item.id) === named) return false;
  }
  return true;
}

/** Where a transcript's last turn's end is, carried on from the list a frame made it from. */
const lastTurnEnd = carriedLast<TranscriptItem>((item) => item?.kind === 'turndone');

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
  commandActivityStartedAt = 0,
  optimisticActivityStartedAt,
  room = false,
}: {
  /** When the visible activity began (ms; transcript-status.tsx commandActivityStartedAt); 0: not known. */
  commandActivityStartedAt?: number;
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
  // Only TRAILING items leave, so the turn keys stay aligned by index: a room's typing rows, and a turn's end written
  // before the reply it names has settled. Until that reply is among the items (while it can still arrive) the end is
  // not shown at all: every row stands as it did before the end was written, and the end lands with its reply.
  const arriving = Boolean(busy || commandBusy || liveItem);
  // An end its own turn passed (`passedEnds`) is not shown: the turn runs, so its rows stand under the turn keys they have
  // without it (an end renames its turn, and closes it for the rows after).
  const liveAttempt = attemptOf(liveItem);
  // biome-ignore lint/correctness/useExhaustiveDependencies: of the reply arriving, only the attempt it names is read.
  const shown = useMemo(() => {
    const passed = passedEnds(settledRowItems, liveItem);
    if (passed.length === 0) return { items: settledRowItems, turnKeys: settledTurnKeys };
    const left = new Set(passed);
    const items = settledRowItems.filter((_, index) => !left.has(index));
    return { items, turnKeys: transcriptTurnKeys(items) as string[] };
  }, [settledRowItems, settledTurnKeys, liveAttempt]);
  const projectedItems = useMemo(() => {
    let end = shown.items.length;
    if (room) while (end > 0 && isRoomTypingItem(shown.items[end - 1])) end -= 1;
    if (arriving && endAwaitsReply(shown.items, end)) end -= 1;
    return end === shown.items.length ? shown.items : shown.items.slice(0, end);
  }, [room, shown, arriving]);
  const projectedTurnKeys = shown.turnKeys;
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
        turnKeys: projectedTurnKeys,
        failedTurns,
      }),
    [failedTurns, identity, sessionKey, projectedItems, projectedTurnKeys, settled]
  );
  // The settled rows close with a turn's end (`turndone`: finished, failed or stopped; `closingEnd`) and no prompt waits
  // after it. A status line a running turn leaves (`statusdone`: a compaction checked or skipped) ends none.
  const endIndex = pendingItems.length === 0 ? closingEnd(projectedItems) : -1;
  const end = endIndex >= 0 ? (projectedItems[endIndex] as TranscriptItem) : null;
  const endId = end ? (end.id ?? end) : null;
  // The end last shown with the session idle: work reported after that is another turn's.
  const idleEnd = useRef<unknown>(null);
  if (!busy && !commandBusy) idleEnd.current = endId;
  // Activity that began before the end was recorded is the ended turn's own, still winding down; activity that began
  // after it is another turn's. An activity or an end that names no time says neither.
  const endedAt = Number(end?.at) || 0;
  const timed = commandActivityStartedAt > 0 && endedAt > 0;
  const activityOfEndedTurn = timed && commandActivityStartedAt <= endedAt;
  // A reply still arriving when the end is written is the ended turn's own when the end names it (`finalAssistantId`; an
  // end that names none, when the reply began no later than it): the end can settle before its reply does.
  const liveOfEndedTurn =
    end !== null &&
    Boolean(liveItem) &&
    (end.finalAssistantId != null
      ? String(end.finalAssistantId) === String(liveItem?.id)
      : !(endedAt > 0 && Number(liveItem?.at ?? liveItem?.startedAt) > endedAt));
  // What runs now is past that end and has settled no row yet: the end was shown idle, the activity began after it, or
  // another reply is arriving after it (a wake with no prompt streams before anything of it settles).
  const turnPastEnd =
    end !== null &&
    Boolean(busy || commandBusy || liveItem) &&
    !liveOfEndedTurn &&
    (idleEnd.current === endId || (timed && !activityOfEndedTurn) || Boolean(liveItem));
  // The transcript's last turn end is passed by what runs, or by rows settled after it that are not its own reply (a wake
  // with no prompt: its rows are a turn of their own). The items themselves say so: a pane mounted mid-wake reads the same.
  const pastLastEnd = turnPastEnd || lastTurnEnd(projectedItems) !== endIndex;
  // A finished turn's footer stands where its band was, also while its own activity is still reported.
  const turnSettled =
    end !== null && settledProjection.endsWithFoldedCompletion && (!commandActivityVisible || activityOfEndedTurn);
  // A reply arriving says work goes on while the session runs, or while the end written for it names it and it has not
  // landed. Left behind by a turn that was stopped, with the session idle, it says nothing.
  const namingEnd = end ?? shown.items[projectedItems.length];
  const replyArriving =
    Boolean(liveItem) &&
    (Boolean(busy || commandBusy) ||
      (namingEnd?.kind === 'turndone' &&
        namingEnd.finalAssistantId != null &&
        String(namingEnd.finalAssistantId) === String(liveItem?.id)));
  const thinking = Boolean(
    (busy && !turnSettled) ||
      (commandBusy && commandActivityVisible) ||
      replyArriving ||
      optimisticActivityStartedAt ||
      // A message sent now, while the core lists it in the queue: the turn it opens is on its way, between the end of
      // the one it stopped and its own start.
      steerItems?.some((item) => item.steer === 'sending')
  );
  const opening = thinking && turnPastEnd;
  const shownRows = useRef<readonly TranscriptRowModel[] | undefined>(undefined);
  const transcriptRows = useMemo(() => {
    const rows = appendLiveTranscriptRows({
      sessionKey: identity,
      settled: settledProjection,
      pendingItems,
      steerItems,
      liveItem,
      thinking,
      opening,
      turnRunning: Boolean(busy),
      prior: shownRows.current,
    });
    shownRows.current = rows;
    return rows;
  }, [identity, settledProjection, pendingItems, steerItems, busy, thinking, opening, liveItem]);
  return { settledTurnKeys, transcriptRows, turnPastEnd, pastLastEnd };
}
