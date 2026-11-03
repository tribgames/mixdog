import { useCallback, useEffect, useLayoutEffect } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { Snapshot } from './desktop-types';
import { useMobileRemoteSurface } from './mobile-surface';
import { commandShowsActivity } from './transcript-status';
import { useConversationFollowEffects } from './use-conversation-follow-effects';
import { useTranscriptRows } from './use-conversation-rows';
import type { ConversationTranscriptSource } from './use-conversation-transcript-source';
import type { ConversationViewport } from './use-conversation-viewport';
import { useTranscriptHistoryFill } from './use-transcript-history';
import { NOTIFICATION_JUMP_LATEST_EVENT } from './use-push-notification-navigation';
import { useTranscriptReveal } from './use-transcript-reveal';
import { readTranscriptVirtualSnapshot } from './transcript-virtual-cache';

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
    | 'resetTranscriptToLive'
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
  const { settledTurnKeys, transcriptRows } = useTranscriptRows({
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
  // A short first window (down to 8 huge rows) may not fill the pane, and
  // with nothing to scroll the top threshold is never crossed.
  useTranscriptHistoryFill(viewport, requestEarlierTranscript, settledItems.length, transcriptRevealed);
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
  });
  return { settledTurnKeys, transcriptRows, transcriptRevealed, jumpToLatest, shouldAnchorTranscriptBottom };
}

export type ConversationTimeline = ReturnType<typeof useConversationTimeline>;
