import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { itemPlacesById, type PendingPromptItem } from './conversation-prompt-items';
import { noteTurnRowsReveal } from './conversation-turn-index';
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
import { isRowVisuallyStreaming, isVisibleTranscriptItem, subscribeRowStreaming } from './transcript-row';
import { transcriptRowNamespace } from './transcript-virtual-cache';
import type { TurnChangesRef } from './turn-changes-model';

const NO_PLACES: readonly number[] = [];

const attemptOf = (item: TranscriptItem | null | undefined): string =>
  typeof item?.attemptId === 'string' ? item.attemptId : '';

const turnIdOf = (item: TranscriptItem | null | undefined): string =>
  typeof item?.turnId === 'string' ? item.turnId : '';

const checkpointOf = (item: TranscriptItem | null | undefined): string =>
  typeof item?.checkpointId === 'string' ? item.checkpointId : '';

const itemKey = (item: TranscriptItem | null | undefined): unknown => (item ? (item.id ?? item) : null);

const OTHER_ROW = Symbol('other-row');

const rowReplyToken = (item: TranscriptItem | null | undefined): string | symbol =>
  item?.kind === 'assistant' && item.id != null ? String(item.id) : OTHER_ROW;

function noteRowSource(
  map: Map<string, string | symbol> | null,
  key: string,
  token: string | symbol
): Map<string, string | symbol> | null {
  if (!key) return map;
  const target = map ?? new Map<string, string | symbol>();
  const prev = target.get(key);
  if (prev === undefined) target.set(key, token);
  else if (prev !== token) target.set(key, OTHER_ROW);
  return target;
}

function hasOtherRowWithKey(
  map: ReadonlyMap<string, string | symbol> | null,
  key: string,
  namedReplyId: string
): boolean {
  if (!key || !map) return false;
  const source = map.get(key);
  if (source === undefined) return false;
  return !namedReplyId || source !== namedReplyId;
}

function isNamedReplyOfEnd(end: TranscriptItem, other: TranscriptItem | null | undefined): boolean {
  return (
    end.kind === 'turndone' &&
    end.finalAssistantId != null &&
    other?.kind === 'assistant' &&
    other.id != null &&
    String(end.finalAssistantId) === String(other.id)
  );
}

function itemsHaveDistinctTurn(end: TranscriptItem, other: TranscriptItem | null | undefined): boolean {
  if (!other || isNamedReplyOfEnd(end, other)) return false;
  const endAttempt = attemptOf(end);
  const otherAttempt = attemptOf(other);
  if (endAttempt && otherAttempt) return endAttempt !== otherAttempt;
  const endTurn = turnIdOf(end);
  const otherTurn = turnIdOf(other);
  if (endTurn && otherTurn) return endTurn !== otherTurn;
  const endCp = checkpointOf(end);
  const otherCp = checkpointOf(other);
  if (endCp && otherCp) return endCp !== otherCp;
  return false;
}

function hasDistinctTurnAfter(
  items: readonly TranscriptItem[],
  endIndex: number,
  end: TranscriptItem | null,
  liveItem: TranscriptItem | null
): boolean {
  if (!end || endIndex < 0) return false;
  if (itemsHaveDistinctTurn(end, liveItem)) return true;
  for (let index = endIndex + 1; index < items.length; index += 1) {
    if (itemsHaveDistinctTurn(end, items[index])) return true;
  }
  return false;
}

interface SessionTranscriptLifecycle {
  readonly hydrated: boolean;
  readonly idleEnd: unknown;
  readonly shownCheckpoints: ReadonlySet<string>;
  readonly knownEnds: ReadonlySet<unknown>;
  readonly activeEnds: ReadonlySet<unknown>;
}

const EMPTY_SET: ReadonlySet<never> = new Set();
const EMPTY_LIFECYCLE: SessionTranscriptLifecycle = {
  hydrated: false,
  idleEnd: null,
  shownCheckpoints: EMPTY_SET,
  knownEnds: EMPTY_SET,
  activeEnds: EMPTY_SET,
};
const MAX_SESSION_LIFECYCLES = 256;
const sessionLifecycles = new Map<string, SessionTranscriptLifecycle>();
const sessionLifecycleIdentities = new Map<string, string>();

function readTranscriptLifecycle(identity: string): SessionTranscriptLifecycle {
  if (!identity) return EMPTY_LIFECYCLE;
  return sessionLifecycles.get(identity) ?? EMPTY_LIFECYCLE;
}

function commitTranscriptLifecycle(identity: string, next: SessionTranscriptLifecycle, sessionKey?: string): void {
  if (!identity) return;
  if (sessionLifecycles.has(identity)) sessionLifecycles.delete(identity);
  sessionLifecycles.set(identity, next);
  if (sessionKey && sessionKey !== identity && sessionKey !== 'new-task') {
    sessionLifecycleIdentities.delete(sessionKey);
    sessionLifecycleIdentities.set(sessionKey, identity);
  }
  while (sessionLifecycles.size > MAX_SESSION_LIFECYCLES) {
    const oldest = sessionLifecycles.keys().next().value;
    if (oldest === undefined) break;
    sessionLifecycles.delete(oldest);
    for (const [key, mapped] of sessionLifecycleIdentities) {
      if (mapped === oldest) sessionLifecycleIdentities.delete(key);
    }
  }
}

export function releaseTranscriptRowLifecycle(sessionId: string): void {
  if (!sessionId) return;
  sessionLifecycles.delete(sessionId);
  const mapped = sessionLifecycleIdentities.get(sessionId);
  if (mapped) {
    sessionLifecycles.delete(mapped);
    sessionLifecycleIdentities.delete(sessionId);
  }
  const namespace = transcriptRowNamespace(sessionId);
  if (namespace && namespace !== sessionId) {
    sessionLifecycles.delete(namespace);
  }
  for (const [key, mappedIdentity] of sessionLifecycleIdentities) {
    if (mappedIdentity === sessionId) sessionLifecycleIdentities.delete(key);
  }
}

export function _transcriptLifecycleStatsForTest(identity: string): {
  knownEnds: number;
  activeEnds: number;
  shownCheckpoints: number;
} {
  const entry = sessionLifecycles.get(identity);
  return {
    knownEnds: entry?.knownEnds.size ?? 0,
    activeEnds: entry?.activeEnds.size ?? 0,
    shownCheckpoints: entry?.shownCheckpoints.size ?? 0,
  };
}

function withSetItem<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (set.has(value)) return set;
  const next = new Set(set);
  next.add(value);
  return next;
}

function withoutSetItem<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!set.has(value)) return set;
  if (set.size === 1) return EMPTY_SET;
  const next = new Set(set);
  next.delete(value);
  return next;
}

function pruneSet<T>(set: ReadonlySet<T>, keep: ReadonlySet<T>): ReadonlySet<T> {
  if (set.size === 0) return set;
  let keptAll = true;
  for (const value of set) {
    if (!keep.has(value)) {
      keptAll = false;
      break;
    }
  }
  if (keptAll) return set;
  if (keep.size === 0) return EMPTY_SET;
  const next = new Set<T>();
  for (const value of set) {
    if (keep.has(value)) next.add(value);
  }
  return next.size === 0 ? EMPTY_SET : next;
}

function isLiveOfEndedTurn(end: TranscriptItem | null, liveItem: TranscriptItem | null): boolean {
  if (end === null || !liveItem) return false;
  if (itemsHaveDistinctTurn(end, liveItem)) return false;
  if (end.finalAssistantId != null) return String(end.finalAssistantId) === String(liveItem.id);
  const endAttempt = attemptOf(end);
  const liveAttempt = attemptOf(liveItem);
  if (endAttempt && liveAttempt) return endAttempt === liveAttempt;
  const endTurn = turnIdOf(end);
  const liveTurn = turnIdOf(liveItem);
  if (endTurn && liveTurn) return endTurn === liveTurn;
  const endCp = checkpointOf(end);
  const liveCp = checkpointOf(liveItem);
  if (endCp && liveCp) return endCp === liveCp;
  return false;
}

function isEndPassedByActivity(
  end: TranscriptItem,
  isClosing: boolean,
  idleEnd: unknown,
  arriving: boolean,
  liveItem: TranscriptItem | null,
  commandActivityStartedAt: number
): boolean {
  if (!arriving) return false;
  const id = itemKey(end);
  if (idleEnd !== null && idleEnd === id) return true;
  const endedAt = Number(end.at) || 0;
  if (commandActivityStartedAt > 0 && endedAt > 0 && commandActivityStartedAt > endedAt) return true;
  return isClosing && Boolean(liveItem) && !isLiveOfEndedTurn(end, liveItem);
}

function derivePreLifecycle(
  prev: SessionTranscriptLifecycle,
  settledRowItems: readonly TranscriptItem[],
  pendingCount: number,
  busy: boolean | undefined,
  commandBusy: boolean | undefined,
  arriving: boolean,
  liveItem: TranscriptItem | null,
  commandActivityStartedAt: number
): SessionTranscriptLifecycle {
  // Keep persisted lifecycle intact across empty hydrating frames (e.g. tab switch before snapshot loads).
  if (settledRowItems.length === 0) return prev;
  const tailEnds = new Set<unknown>();
  const tailCheckpoints = new Set<string>();
  for (let index = settledRowItems.length - 1; index >= 0; index -= 1) {
    const item = settledRowItems[index];
    if (item?.kind === 'turndone') {
      tailEnds.add(itemKey(item));
      if (typeof item.checkpointId === 'string' && item.checkpointId) tailCheckpoints.add(item.checkpointId);
    } else if (item?.kind === 'user') {
      const cp = item.checkpointId ?? item.id;
      if (cp !== undefined && cp !== null && cp !== '') tailCheckpoints.add(String(cp));
      if (!item.steered && isVisibleTranscriptItem(item)) break;
    }
  }
  let hydrated = prev.hydrated;
  let knownEnds = pruneSet(prev.knownEnds, tailEnds);
  let activeEnds = pruneSet(prev.activeEnds, tailEnds);
  const shownCheckpoints = pruneSet(prev.shownCheckpoints, tailCheckpoints);
  let knownCloned = knownEnds !== prev.knownEnds && knownEnds !== EMPTY_SET;
  let activeCloned = activeEnds !== prev.activeEnds && activeEnds !== EMPTY_SET;
  const addKnown = (id: unknown) => {
    if (knownEnds.has(id)) return;
    if (!knownCloned) {
      knownEnds = new Set(knownEnds);
      knownCloned = true;
    }
    (knownEnds as Set<unknown>).add(id);
  };
  const addActive = (id: unknown) => {
    if (activeEnds.has(id)) return;
    if (!activeCloned) {
      activeEnds = new Set(activeEnds);
      activeCloned = true;
    }
    (activeEnds as Set<unknown>).add(id);
  };
  const deleteActive = (id: unknown) => {
    if (!activeEnds.has(id)) return;
    if (!activeCloned) {
      activeEnds = new Set(activeEnds);
      activeCloned = true;
    }
    (activeEnds as Set<unknown>).delete(id);
  };
  const rawClosing = pendingCount === 0 ? closingEnd(settledRowItems) : -1;
  if (!busy && !commandBusy) {
    if (activeEnds.size > 0) {
      activeEnds = EMPTY_SET;
      activeCloned = true;
    }
    for (let index = settledRowItems.length - 1; index >= 0; index -= 1) {
      const item = settledRowItems[index];
      if (item?.kind === 'turndone') addKnown(itemKey(item));
      else if (item?.kind === 'user' && !item.steered && isVisibleTranscriptItem(item)) break;
    }
    hydrated = true;
  } else if (!hydrated) {
    hydrated = true;
    for (let index = settledRowItems.length - 1; index >= 0; index -= 1) {
      const item = settledRowItems[index];
      if (item?.kind === 'turndone') {
        const id = itemKey(item);
        addKnown(id);
        if (
          index === rawClosing &&
          !isEndPassedByActivity(item, true, prev.idleEnd, arriving, liveItem, commandActivityStartedAt)
        ) {
          addActive(id);
        }
      } else if (item?.kind === 'user' && !item.steered && isVisibleTranscriptItem(item)) {
        break;
      }
    }
  } else if (arriving) {
    for (let index = settledRowItems.length - 1; index >= 0; index -= 1) {
      const item = settledRowItems[index];
      if (item?.kind === 'turndone') {
        const id = itemKey(item);
        const passed =
          isEndPassedByActivity(
            item,
            index === rawClosing,
            prev.idleEnd,
            arriving,
            liveItem,
            commandActivityStartedAt
          ) || hasDistinctTurnAfter(settledRowItems, index, item, liveItem);
        if (!knownEnds.has(id)) {
          addKnown(id);
          if (!passed) addActive(id);
        } else if (passed) {
          deleteActive(id);
        }
      } else if (item?.kind === 'user' && !item.steered && isVisibleTranscriptItem(item)) {
        break;
      }
    }
  }
  if (
    hydrated === prev.hydrated &&
    knownEnds === prev.knownEnds &&
    activeEnds === prev.activeEnds &&
    shownCheckpoints === prev.shownCheckpoints
  ) {
    return prev;
  }
  return { ...prev, hydrated, knownEnds, activeEnds, shownCheckpoints };
}

/** Where, in `items`, the ends are that their own turn passed: the core names a turn's attempt on its end and on its
 *  replies (`attemptId`), and tool calls may carry no `attemptId` while the turn is still running, so an end followed
 *  by a row of the same attempt (settled, another end, or the reply arriving) — or by a tool call while active when
 *  that end was observed active without ever idling — did not end the turn. Read back to the last prompt: the turns
 *  before it are over. Ascending. */
function passedEnds(
  items: readonly TranscriptItem[],
  liveItem: TranscriptItem | null,
  active: boolean,
  activeEnds: ReadonlySet<unknown>
): readonly number[] {
  let places: number[] | null = null;
  const liveToken = rowReplyToken(liveItem);
  let afterAttempts = noteRowSource(null, attemptOf(liveItem), liveToken);
  let afterTurnIds = noteRowSource(null, turnIdOf(liveItem), liveToken);
  let segmentItems: TranscriptItem[] | null = liveItem ? [liveItem] : null;
  let seenToolAfter = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'user' && !item.steered) break;
    const attempt = attemptOf(item);
    const turnId = turnIdOf(item);
    if (item?.kind !== 'turndone') {
      if (item?.kind === 'tool') seenToolAfter = true;
      const token = rowReplyToken(item);
      afterAttempts = noteRowSource(afterAttempts, attempt, token);
      afterTurnIds = noteRowSource(afterTurnIds, turnId, token);
      if (item) {
        segmentItems ??= [];
        segmentItems.push(item);
      }
      continue;
    }
    const id = itemKey(item);
    const namedReplyId = item.finalAssistantId != null ? String(item.finalAssistantId) : '';
    const sameAttempt =
      hasOtherRowWithKey(afterAttempts, attempt, namedReplyId) ||
      hasOtherRowWithKey(afterTurnIds, turnId, namedReplyId);
    const distinctTurnAfter = Boolean(segmentItems?.some((after) => itemsHaveDistinctTurn(item, after)));
    const toolContinuation = active && seenToolAfter && activeEnds.has(id) && !distinctTurnAfter;
    if (closesReply(item) && (sameAttempt || toolContinuation)) {
      places ??= [];
      places.unshift(index);
    } else {
      seenToolAfter = false;
      segmentItems = [item];
    }
    afterAttempts = noteRowSource(afterAttempts, attempt, OTHER_ROW);
    afterTurnIds = noteRowSource(afterTurnIds, turnId, OTHER_ROW);
  }
  return places ?? NO_PLACES;
}

/** Row keys of settled assistant parts belonging to the trailing turn, so a
 *  standalone tool-ending `turndone` waits until its turn's replies finish
 *  visually draining paced text. */
function trailingTurnAssistantKeys(rows: readonly TranscriptRowModel[]): string[] {
  const keys: string[] = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row._tag === 'UserMessage' && !row.item.steered) break;
    if (index < rows.length - 1) {
      if (row._tag === 'Error') break;
      if (row._tag === 'AssistantPart' && (Boolean(row.completion) || row.item.kind === 'turndone')) break;
      if (row._tag === 'TurnGap') {
        const next = rows[index + 1];
        if (!(next?._tag === 'UserMessage' && next.item.steered)) break;
      }
    }
    if (row._tag === 'AssistantPart' && row.item.kind === 'assistant') {
      keys.push(row.key);
    }
  }
  return keys;
}

function trailingTurnCard(rows: readonly TranscriptRowModel[]): TurnChangesRef | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row._tag === 'UserMessage' && !row.item.steered) return null;
    if ('turnChanges' in row && row.turnChanges?.trailing) return row.turnChanges;
  }
  return null;
}

function hasVisiblePromptAfter(items: readonly TranscriptItem[], from: number): boolean {
  for (let index = from + 1; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind === 'user' && !item.steered && isVisibleTranscriptItem(item)) return true;
  }
  return false;
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
  // Track ends observed while actively running without idling (`activeEnds`) separately from ends already settled
  // before mount/switch-back or seen while idle: mounting mid-wake with `[u1, a1, d1, tool]` must keep `d1` visible.
  // Lifecycle state is derived purely during render from the session's last committed entry and persisted in a layout
  // effect so StrictMode double-renders stay pure and tab switches keep in-flight turn state.
  const prevLifecycle = readTranscriptLifecycle(identity);
  const preLifecycle = derivePreLifecycle(
    prevLifecycle,
    settledRowItems,
    pendingItems.length,
    busy,
    commandBusy,
    arriving,
    liveItem,
    commandActivityStartedAt
  );
  // An end its own turn passed (`passedEnds`) is not shown: the turn runs, so its rows stand under the turn keys they have
  // without it (an end renames its turn, and closes it for the rows after).
  const shown = useMemo(() => {
    const passed = passedEnds(settledRowItems, liveItem, arriving, preLifecycle.activeEnds);
    if (passed.length === 0) return { items: settledRowItems, turnKeys: settledTurnKeys };
    const left = new Set(passed);
    const items = settledRowItems.filter((_, index) => !left.has(index));
    return { items, turnKeys: transcriptTurnKeys(items) as string[] };
  }, [settledRowItems, settledTurnKeys, liveItem, arriving, preLifecycle.activeEnds]);
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
  const endId = itemKey(end);
  const trailingCard = trailingTurnCard(settledProjection.rows);
  // Activity that began before the end was recorded is the ended turn's own, still winding down; activity that began
  // after it is another turn's. An activity or an end that names no time says neither.
  const endedAt = Number(end?.at) || 0;
  const timed = commandActivityStartedAt > 0 && endedAt > 0;
  const activityOfEndedTurn = timed && commandActivityStartedAt <= endedAt;
  // A reply still arriving when the end is written is the ended turn's own only when explicit identity matches
  // (`finalAssistantId`, `attemptId`, `turnId`, or `checkpointId`): the end can settle before its reply does.
  const liveOfEndedTurn = isLiveOfEndedTurn(end, liveItem);
  // A reply arriving says work goes on while the session runs, or while the end written for it names it and it has not
  // landed. Left behind by a turn that was stopped, with the session idle, it says nothing.
  const namingEnd = end ?? shown.items[projectedItems.length];
  const replyArriving =
    Boolean(liveItem) &&
    (Boolean(busy || commandBusy) ||
      (namingEnd?.kind === 'turndone' &&
        namingEnd.finalAssistantId != null &&
        String(namingEnd.finalAssistantId) === String(liveItem?.id)));
  const sessionIdle = !busy && !commandBusy;
  const tentativeIdleEnd = sessionIdle && !replyArriving && settledRowItems.length > 0 ? endId : preLifecycle.idleEnd;
  // What runs now is past that end and has settled no row yet: the end was shown idle, the activity began after it, or
  // another reply is arriving after it (a wake with no prompt streams before anything of it settles).
  const turnPastEnd =
    end !== null &&
    Boolean(busy || commandBusy || liveItem) &&
    !liveOfEndedTurn &&
    (tentativeIdleEnd === endId || (timed && !activityOfEndedTurn) || Boolean(liveItem));
  // Keep the 40px band slot mounted and hold turn-end cards while any assistant row in the trailing turn
  // (including before a standalone tool-ending `turndone`) is still visually draining paced text or
  // awaiting its final off-thread parse.
  const closingAssistantKeysSig =
    pendingItems.length === 0 && !turnPastEnd ? trailingTurnAssistantKeys(settledProjection.rows).join('\u0000') : '';
  const subscribeClosingRow = useCallback(
    (listener: () => void) => {
      if (!closingAssistantKeysSig) return () => {};
      const unsubs = closingAssistantKeysSig.split('\u0000').map((key) => subscribeRowStreaming(key, listener));
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
    [closingAssistantKeysSig]
  );
  const getClosingRowStreaming = useCallback(() => {
    if (!closingAssistantKeysSig) return false;
    return closingAssistantKeysSig.split('\u0000').some((key) => isRowVisuallyStreaming(key));
  }, [closingAssistantKeysSig]);
  const closingRowStreaming = useSyncExternalStore(subscribeClosingRow, getClosingRowStreaming, () => false);
  const turnLoopSettled = sessionIdle && !replyArriving && !closingRowStreaming;
  const nextIdleEnd = turnLoopSettled && settledRowItems.length > 0 ? endId : preLifecycle.idleEnd;
  // The transcript's last turn end is passed by what runs, or by rows settled after it unless that end was observed
  // active in this continuous loop with no visible prompt or distinct turn/attempt after it.
  const lastEndIndex = lastTurnEnd(projectedItems);
  const lastEndItem = lastEndIndex >= 0 ? (projectedItems[lastEndIndex] as TranscriptItem) : null;
  const lastEndId = itemKey(lastEndItem);
  const lastEndPassedByDistinctTurn =
    lastEndIndex >= 0 &&
    lastEndIndex !== endIndex &&
    hasDistinctTurnAfter(projectedItems, lastEndIndex, lastEndItem, liveItem);
  const postActiveEnds =
    turnPastEnd && endId !== null
      ? withoutSetItem(preLifecycle.activeEnds, endId)
      : lastEndPassedByDistinctTurn && lastEndId !== null
        ? withoutSetItem(preLifecycle.activeEnds, lastEndId)
        : preLifecycle.activeEnds;
  const pastLastEnd =
    turnPastEnd ||
    (lastEndIndex !== endIndex &&
      (!postActiveEnds.has(lastEndId) || (lastEndIndex >= 0 && hasVisiblePromptAfter(projectedItems, lastEndIndex))));
  const trailingTurnRunning =
    pendingItems.length === 0 && !pastLastEnd && Boolean(busy || commandBusy || replyArriving || closingRowStreaming);
  const checkpointId = trailingCard?.checkpointId;
  const checkpointRevealed = Boolean(checkpointId && ((turnLoopSettled && settledRowItems.length > 0) || pastLastEnd));
  const nextShownCheckpoints =
    checkpointId && checkpointRevealed
      ? withSetItem(preLifecycle.shownCheckpoints, checkpointId)
      : preLifecycle.shownCheckpoints;
  const trailingCheckpointShown = Boolean(checkpointId && nextShownCheckpoints.has(checkpointId));
  const nextLifecycle: SessionTranscriptLifecycle =
    preLifecycle.idleEnd === nextIdleEnd &&
    preLifecycle.activeEnds === postActiveEnds &&
    preLifecycle.shownCheckpoints === nextShownCheckpoints
      ? preLifecycle
      : {
          ...preLifecycle,
          idleEnd: nextIdleEnd,
          activeEnds: postActiveEnds,
          shownCheckpoints: nextShownCheckpoints,
        };
  useLayoutEffect(() => {
    commitTranscriptLifecycle(identity, nextLifecycle, sessionKey);
  }, [identity, sessionKey, nextLifecycle]);
  // A finished turn's completion (folded footer or standalone tool-ending row) stands where its band was, also while its own activity is still reported.
  const turnSettled =
    end !== null &&
    !turnPastEnd &&
    settledProjection.endsWithCompletion &&
    (!commandActivityVisible || activityOfEndedTurn);
  const thinking = Boolean(
    (busy && !turnSettled) ||
      (commandBusy && commandActivityVisible) ||
      replyArriving ||
      closingRowStreaming ||
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
    noteTurnRowsReveal(rows, { trailingTurnRunning, trailingCheckpointShown });
    shownRows.current = rows;
    return rows;
  }, [
    identity,
    settledProjection,
    pendingItems,
    steerItems,
    busy,
    thinking,
    opening,
    liveItem,
    trailingTurnRunning,
    trailingCheckpointShown,
  ]);
  return { settledTurnKeys, transcriptRows, turnPastEnd, pastLastEnd, trailingTurnRunning, trailingCheckpointShown };
}
