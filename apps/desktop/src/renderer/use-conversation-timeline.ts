import { useCallback, useLayoutEffect } from 'react';
import type { PendingPromptItem } from './conversation-prompt-items';
import type { Snapshot } from './desktop-types';
import { commandShowsActivity } from './transcript-status';
import { useConversationFollowEffects } from './use-conversation-follow-effects';
import { useTranscriptRows } from './use-conversation-rows';
import type { ConversationTranscriptSource } from './use-conversation-transcript-source';
import type { ConversationViewport } from './use-conversation-viewport';
import { useTranscriptHistoryFill } from './use-transcript-history';
import { useTranscriptReveal } from './use-transcript-reveal';

/** The virtual timeline for one pane: its rows, the entry reveal, the
 *  history fill of a short first window, and follow re-arming. */
export function useConversationTimeline({
  view,
  source,
  sessionKey,
  draftMode,
  snapshot,
  pendingItems,
  optimisticActivityStartedAt,
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
  >;
  sessionKey: string;
  draftMode: boolean;
  snapshot: Snapshot;
  pendingItems: PendingPromptItem[];
  optimisticActivityStartedAt: number;
  onEntryRevealed?: (sessionKey: string) => void;
  onTranscriptHiddenChange?: (hidden: boolean) => void;
}) {
  const { viewport, content, conversation, follow, scrollToEndRef } = view;
  const { settledItems, settledRowItems, requestEarlierTranscript } = source;
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
    liveItem,
    busy: snapshot.busy,
    commandBusy: snapshot.commandBusy,
    commandActivityVisible: commandShowsActivity(snapshot),
    optimisticActivityStartedAt,
  });
  const populated = showTimeline && transcriptRows.length > 0;
  const transcriptRevealed = useTranscriptReveal({
    identity,
    enabled: populated,
    draft: draftMode || sessionKey === 'new-task',
    viewport,
    content,
    scope: conversation,
    hasScrollGesture,
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
  const jumpToLatest = useCallback(() => {
    resumeFollow();
  }, [resumeFollow]);
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
