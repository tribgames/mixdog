import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import { transcriptTurnKeys } from './renderer-logic.mjs';
import type { Snapshot } from './desktop-types';
import { useMobileRemoteSurface } from './mobile-surface';
import { commandActivityStartedAt, commandShowsActivity } from './transcript-status';
import { useConversationFollowEffects } from './use-conversation-follow-effects';
import type { TranscriptRowModel } from './transcript-rows';
import { useTranscriptRows } from './use-conversation-rows';
import type { ConversationTranscriptSource } from './use-conversation-transcript-source';
import type { ConversationViewport } from './use-conversation-viewport';
import { useTranscriptHistoryFill } from './use-transcript-history';
import { NOTIFICATION_JUMP_LATEST_EVENT } from './use-push-notification-navigation';
import { useTranscriptReveal } from './use-transcript-reveal';
import { usePaneKey } from './pane-key-context';
import { usePanePresentation } from './pane-presentation';
import {
  pendingReaderPlace,
  readerPlace,
  readerRows,
  rowOfPlace,
  useReaderPlaceVersion,
} from './transcript-list-reader-place';
import { useTranscriptJump } from './transcript-jump';

const idOf = (item: { id?: unknown } | undefined | null): string | undefined =>
  item?.id === undefined || item.id === null ? undefined : String(item.id);
const singleItem = (row: TranscriptRowModel | undefined) => (row && 'item' in row ? row.item : undefined);
const firstItemId = (row: TranscriptRowModel | undefined): string | undefined =>
  idOf(row?._tag === 'ToolActivity' ? row.items[0] : singleItem(row));
const lastItemId = (row: TranscriptRowModel | undefined): string | undefined =>
  idOf(row?._tag === 'ToolActivity' ? row.items.at(-1) : singleItem(row));

/** The ids of the first and last transcript items in the reader's view: the rows the viewport crosses where it is
 *  scrolled to now (the list's own sizes say which; the rows it draws follow a frame later), from the first row downward
 *  and the last row upward to one that shows an item. */
function readerItems(root: HTMLElement, rows: readonly TranscriptRowModel[]): { first: string; last: string } | null {
  const view = readerRows(root);
  if (!view) return null;
  let first: string | undefined;
  for (let index = view.from; index < rows.length && first === undefined; index += 1) first = firstItemId(rows[index]);
  let last: string | undefined;
  for (let index = view.to; index >= 0 && last === undefined; index -= 1) last = lastItemId(rows[index]);
  return first !== undefined && last !== undefined ? { first, last } : null;
}

/** The virtual timeline for one pane: its rows, the entry reveal, the
 *  history fill of a short first window, and follow re-arming. */
export function useConversationTimeline({
  view,
  source,
  sessionKey,
  draftMode,
  snapshot,
  pendingItems,
  steerItems,
  optimisticActivityStartedAt,
  room,
  listHeld = false,
  onEntryRevealed,
  onTranscriptHiddenChange,
}: {
  view: Pick<ConversationViewport, 'viewport' | 'content' | 'conversation' | 'follow' | 'scrollToEndRef'>;
  source: Pick<
    ConversationTranscriptSource,
    | 'transcriptIdentity'
    | 'settledItems'
    | 'liveSettledItems'
    | 'settledRowItems'
    | 'activeStreamingTail'
    | 'showTranscriptTimeline'
    | 'requestEarlierTranscript'
    | 'transcriptReaderAt'
    | 'resetTranscriptToLive'
    | 'transcriptHistoryRevision'
  >;
  sessionKey: string;
  draftMode: boolean;
  snapshot: Snapshot;
  pendingItems: PendingPromptItem[];
  /** Messages sent while the turn runs that the model has not read yet. */
  steerItems?: PendingPromptItem[];
  optimisticActivityStartedAt: number;
  /** A group room: the live band is its typing slot (use-conversation-rows.ts). */
  room?: boolean;
  /** The list is not mounted yet (held one frame behind the cover): the
   *  reveal and the entry record start only once it is. */
  listHeld?: boolean;
  onEntryRevealed?: (sessionKey: string) => void;
  onTranscriptHiddenChange?: (hidden: boolean) => void;
}) {
  const { viewport, content, conversation, follow, scrollToEndRef } = view;
  const { settledItems, liveSettledItems, settledRowItems, requestEarlierTranscript, resetTranscriptToLive } = source;
  const identity = source.transcriptIdentity.current;
  const liveItem = source.activeStreamingTail;
  const showTimeline = source.showTranscriptTimeline;
  const { following, hasScrollGesture, resume: resumeFollow, arm: armFollow } = follow;
  // The state's own turn keys are the live rows': a history window, or rows read above the live ones, makes its own.
  const ownTurnKeys = settledItems === liveSettledItems ? snapshot.transcriptTurnKeys : undefined;
  const { settledTurnKeys, transcriptRows, turnPastEnd, pastLastEnd } = useTranscriptRows({
    identity,
    sessionKey,
    settledItems,
    settledRowItems,
    failedTurnKeys: snapshot.failedTurnKeys,
    precomputedTurnKeys: ownTurnKeys,
    pendingItems,
    steerItems,
    liveItem,
    busy: snapshot.busy,
    commandBusy: snapshot.commandBusy,
    commandActivityVisible: commandShowsActivity(snapshot),
    commandActivityStartedAt: commandActivityStartedAt(snapshot),
    optimisticActivityStartedAt,
    room,
  });
  const liveTurnKeys = useMemo(() => {
    if (settledItems === liveSettledItems) return settledTurnKeys;
    const stated = snapshot.transcriptTurnKeys;
    return Array.isArray(stated) && stated.length === liveSettledItems.length
      ? (stated as string[])
      : (transcriptTurnKeys(liveSettledItems) as string[]);
  }, [liveSettledItems, settledItems, settledTurnKeys, snapshot.transcriptTurnKeys]);
  // A reader handed a place off the end (a return, a record opened from outside) is shown no list until the rows
  // hold that place's record: the list mounts once, over the rows its reader is put on. A list already mounted stays.
  const pane = usePaneKey();
  const presentation = usePanePresentation();
  useReaderPlaceVersion();
  const opening = draftMode ? null : pendingReaderPlace(pane, sessionKey);
  const placedRows = !opening || rowOfPlace(transcriptRows, opening) >= 0;
  // A place whose record the history no longer holds is let go (use-transcript-history.ts): its reader is at the end.
  const wasOpening = useRef(false);
  useLayoutEffect(() => {
    const voided = wasOpening.current && !opening && readerPlace(pane, sessionKey) === null;
    wasOpening.current = opening !== null;
    if (voided) armFollow();
  });
  const listMounted = useRef('');
  if (!showTimeline) listMounted.current = '';
  else if (placedRows) listMounted.current = identity;
  const transcriptListShown = showTimeline && !listHeld && listMounted.current === identity;
  const populated = transcriptListShown && transcriptRows.length > 0;
  const phone = useMobileRemoteSurface();
  const readerPlaced = useCallback(() => pendingReaderPlace(pane, sessionKey) === null, [pane, sessionKey]);
  const transcriptRevealed = useTranscriptReveal({
    identity,
    visit: presentation.visit,
    enabled: populated,
    draft: draftMode || sessionKey === 'new-task',
    viewport,
    content,
    scope: conversation,
    hasScrollGesture,
    eager: phone,
    pinned: following,
    placed: readerPlaced,
  });
  // A disabled reveal reads as revealed; only populated rows count as an entry.
  useLayoutEffect(() => {
    if (transcriptRevealed && populated) onEntryRevealed?.(sessionKey);
  }, [onEntryRevealed, populated, transcriptRevealed, sessionKey]);
  useLayoutEffect(() => {
    onTranscriptHiddenChange?.(!transcriptRevealed);
    return () => onTranscriptHiddenChange?.(false);
  }, [onTranscriptHiddenChange, transcriptRevealed]);
  // A positioned transcript pages by where the reader is: the pane says so on every scroll and whenever the window shown
  // changes; the window decides what that view is near.
  const rowsRef = useRef(transcriptRows);
  rowsRef.current = transcriptRows;
  const readerAt = source.transcriptReaderAt;
  /** Tells the window where the reader is: the rows under the viewport as it stands when this is called, which is where a
   *  scroll arrived when its event is heard. */
  const reportReader = useCallback(() => {
    const root = viewport.current;
    const at = root ? readerItems(root, rowsRef.current) : null;
    if (at) readerAt?.(at.first, at.last);
  }, [readerAt, viewport]);
  const revision = source.transcriptHistoryRevision;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window's revision and the rows' count are the triggers
  useEffect(() => {
    if (readerAt && transcriptRevealed) reportReader();
  }, [readerAt, reportReader, revision, transcriptRevealed, transcriptRows.length]);
  // A short first window (down to 8 huge rows) may not fill the pane, and
  // with nothing to scroll the top threshold is never crossed.
  useTranscriptHistoryFill(viewport, requestEarlierTranscript, revision, transcriptRevealed && !readerAt);
  // The latest reply lives on the live tail: a history window gives way.
  const jumpToLatest = useCallback(() => {
    resetTranscriptToLive();
    resumeFollow();
  }, [resetTranscriptToLive, resumeFollow]);
  // A tapped notification for this session lands on its latest reply.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onJump = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionKey) jumpToLatest();
    };
    window.addEventListener(NOTIFICATION_JUMP_LATEST_EVENT, onJump);
    return () => window.removeEventListener(NOTIFICATION_JUMP_LATEST_EVENT, onJump);
  }, [jumpToLatest, sessionKey]);
  const windowGeneration = typeof snapshot.transcriptGeneration === 'number' ? snapshot.transcriptGeneration : 0;
  const shouldAnchorTranscriptBottom = useConversationFollowEffects({
    armFollow,
    following,
    scrollToEndRef,
    settledItems,
    transcriptRows,
    transcriptSessionKey: sessionKey,
    viewport,
    windowGeneration: readerAt ? windowGeneration : undefined,
  });
  // A jump the entry brings opens its place after the entry's arm, so it is called here, after it.
  useTranscriptJump({ sessionId: draftMode || sessionKey === 'new-task' ? '' : sessionKey, leaveTail: follow.pause });
  return {
    /** The turn keys of the rows shown (`source.settledItems`, a history window's while the reader is in one). */
    settledTurnKeys,
    /** The turn keys of the live rows (`source.liveSettledItems`). */
    liveTurnKeys,
    /** What the row renderer reads (useConversationRowRenderer): the rows shown with their own turn keys, and the live
     *  rows. */
    rowItems: { settledItems, settledTurnKeys, liveItems: liveSettledItems },
    /** What runs is past the last turn's end and has settled no row yet (use-conversation-rows.ts). */
    turnPastEnd,
    /** What runs is past the last turn's end, whether or not it has settled rows since. */
    pastLastEnd,
    transcriptRows,
    transcriptRevealed,
    /** The list is mounted: its rows hold the place its reader is put at. */
    transcriptListShown,
    jumpToLatest,
    shouldAnchorTranscriptBottom,
    /** A positioned transcript: tells the window where the reader is; null for a window paged by scroll offsets. */
    reportTranscriptReader: readerAt ? reportReader : null,
  };
}

export type ConversationTimeline = ReturnType<typeof useConversationTimeline>;
