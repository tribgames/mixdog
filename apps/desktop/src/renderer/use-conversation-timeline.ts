import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
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
import { readTranscriptVirtualSnapshot } from './transcript-virtual-cache';

const firstItemId = (row: TranscriptRowModel | undefined): string | undefined => {
  const item = row?._tag === 'ToolActivity' ? row.items[0] : row && 'item' in row ? row.item : undefined;
  return item?.id === undefined || item.id === null ? undefined : String(item.id);
};
const lastItemId = (row: TranscriptRowModel | undefined): string | undefined => {
  const item = row?._tag === 'ToolActivity' ? row.items.at(-1) : row && 'item' in row ? row.item : undefined;
  return item?.id === undefined || item.id === null ? undefined : String(item.id);
};

/** The ids of the first and last transcript items in the reader's view: the rows the list shows there (overscan
 *  excluded), from the first row downward and the last row upward to one that shows an item. */
function readerItems(root: HTMLElement, rows: readonly TranscriptRowModel[]): { first: string; last: string } | null {
  let from = Number.POSITIVE_INFINITY;
  let to = -1;
  for (const node of root.querySelectorAll<HTMLElement>('.transcript-virtual-row:not([data-offscreen])')) {
    const index = Number(node.dataset.index);
    if (index < from) from = index;
    if (index > to) to = index;
  }
  if (to < 0) return null;
  let first: string | undefined;
  for (let index = from; index < rows.length && first === undefined; index += 1) first = firstItemId(rows[index]);
  let last: string | undefined;
  for (let index = to; index >= 0 && last === undefined; index -= 1) last = lastItemId(rows[index]);
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
  const { settledItems, settledRowItems, requestEarlierTranscript, resetTranscriptToLive } = source;
  const identity = source.transcriptIdentity.current;
  const liveItem = source.activeStreamingTail;
  const showTimeline = source.showTranscriptTimeline;
  const { following, hasScrollGesture, resume: resumeFollow, arm: armFollow } = follow;
  const { settledTurnKeys, transcriptRows, turnPastEnd, pastLastEnd } = useTranscriptRows({
    identity,
    sessionKey,
    settledItems,
    settledRowItems,
    failedTurnKeys: snapshot.failedTurnKeys,
    precomputedTurnKeys: snapshot.transcriptTurnKeys,
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
  const populated = showTimeline && !listHeld && transcriptRows.length > 0;
  const phone = useMobileRemoteSurface();
  const transcriptRevealed = useTranscriptReveal({
    identity,
    enabled: populated,
    draft: draftMode || sessionKey === 'new-task',
    viewport,
    content,
    scope: conversation,
    hasScrollGesture,
    eager: phone,
    retainedGeometry: readTranscriptVirtualSnapshot(sessionKey)?.measurements,
    pinned: following,
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
  const shouldAnchorTranscriptBottom = useConversationFollowEffects({
    armFollow,
    following,
    scrollToEndRef,
    settledItems,
    transcriptRows,
    transcriptSessionKey: sessionKey,
    viewport,
    windowGeneration: readerAt
      ? typeof snapshot.transcriptGeneration === 'number'
        ? snapshot.transcriptGeneration
        : 0
      : undefined,
  });
  return {
    settledTurnKeys,
    /** What runs is past the last turn's end and has settled no row yet (use-conversation-rows.ts). */
    turnPastEnd,
    /** What runs is past the last turn's end, whether or not it has settled rows since. */
    pastLastEnd,
    transcriptRows,
    transcriptRevealed,
    jumpToLatest,
    shouldAnchorTranscriptBottom,
    /** A positioned transcript: tells the window where the reader is; null for a window paged by scroll offsets. */
    reportTranscriptReader: readerAt ? reportReader : null,
  };
}

export type ConversationTimeline = ReturnType<typeof useConversationTimeline>;
