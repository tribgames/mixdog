import { type ReactNode, useMemo } from 'react';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { useAgentRoom } from './agent-room-store';
import { MarkdownMentionNamesContext } from './markdown-mentions';
import { collapseSelectionOnPress, JumpToLatestButton } from './conversation-support';
import { t } from './i18n';
import {
  MarkdownOpenFileContext,
  MarkdownOpenFolderContext,
  MarkdownProjectContext,
  MarkdownSessionContext,
} from './MarkdownLink';
import { TranscriptDevicesContext, TranscriptViewerDeviceContext } from './transcript-row';
import type { TranscriptRowModel } from './transcript-rows';
import { TranscriptList } from './TranscriptList';
import { TurnChangesContext, type TurnChangesSurface } from './TurnChangesCard';
import type { ConversationTimeline } from './use-conversation-timeline';
import type { ConversationTranscriptSource } from './use-conversation-transcript-source';
import type { ConversationViewport } from './use-conversation-viewport';
import { transcriptHistoryLead } from './use-transcript-history';
import { BrandTile } from './WorkspaceEmptyState';

type OpenFile = (project: string, rel: string, line?: number, accessToken?: string, column?: number) => void;
type OpenFolder = (project: string, rel: string) => void;

/** An empty draft carries only the centered brand watermark; sessions and
 *  transitions never show it. */
function conversationShowsWelcome({
  draftMode,
  routeSessionId,
  activeProjectPath,
  itemCount,
  pendingPromptCount,
  streaming,
  transitioning,
  visibleWarmPaintHandoff,
}: {
  draftMode: boolean;
  routeSessionId: string;
  activeProjectPath: string;
  itemCount: number;
  pendingPromptCount: number;
  streaming: boolean;
  transitioning: boolean;
  visibleWarmPaintHandoff: boolean;
}): boolean {
  if (visibleWarmPaintHandoff) return true;
  return (
    (draftMode || (!routeSessionId && Boolean(activeProjectPath))) &&
    itemCount === 0 &&
    pendingPromptCount === 0 &&
    !streaming &&
    !transitioning
  );
}

function welcomeWatermark(visibleWarmPaintHandoff: boolean) {
  return (
    <div
      className={`thread-welcome thread-welcome-task${visibleWarmPaintHandoff ? ' thread-welcome-paint-handoff' : ''}`}
      aria-hidden="true"
    >
      <span className="welcome-logo">
        <BrandTile crop />
      </span>
    </div>
  );
}

/** The contexts every transcript row and file link reads. */
function TranscriptRowContexts({
  project,
  sessionId,
  openFile,
  openFolder,
  multiDevice,
  viewerDevice,
  turnChangesSurface,
  children,
}: {
  project: string;
  sessionId: string;
  openFile?: OpenFile;
  openFolder?: OpenFolder;
  multiDevice: boolean;
  viewerDevice: string | null;
  turnChangesSurface: TurnChangesSurface | null;
  children: ReactNode;
}) {
  const room = useAgentRoom(sessionId);
  const inRoom = room !== null;
  const memberNames = room?.memberNames;
  const mentionNames = useMemo(() => (inRoom ? Object.values(memberNames ?? {}) : null), [inRoom, memberNames]);
  return (
    <MarkdownProjectContext.Provider value={project}>
      <MarkdownSessionContext.Provider value={sessionId}>
        <MarkdownMentionNamesContext.Provider value={mentionNames}>
          <MarkdownOpenFileContext.Provider value={openFile ?? null}>
            <MarkdownOpenFolderContext.Provider value={openFolder ?? null}>
              <TranscriptDevicesContext.Provider value={multiDevice}>
                <TranscriptViewerDeviceContext.Provider value={viewerDevice}>
                  <TurnChangesContext.Provider value={turnChangesSurface}>{children}</TurnChangesContext.Provider>
                </TranscriptViewerDeviceContext.Provider>
              </TranscriptDevicesContext.Provider>
            </MarkdownOpenFolderContext.Provider>
          </MarkdownOpenFileContext.Provider>
        </MarkdownMentionNamesContext.Provider>
      </MarkdownSessionContext.Provider>
    </MarkdownProjectContext.Provider>
  );
}

/** The scrollable transcript log: welcome watermark, the virtual timeline and
 *  the jump-to-latest control. */
export function ConversationTranscript({
  view,
  source,
  timeline,
  links,
  sessionKey,
  busy,
  draftMode,
  routeSessionId,
  activeProjectPath,
  transitioning,
  pendingPromptCount,
  visibleWarmPaintHandoff,
  project,
  multiDevice,
  viewerDevice,
  renderRow,
  itemCount,
  cover,
  listHeld = false,
  intro,
  agentMode = false,
}: {
  /** The list mounts one frame after the shell (a phone entering a cold
   *  session); the cover stays up until it has. */
  listHeld?: boolean;
  /** An agent chat: its rows learn their estimated heights apart from coding's. */
  agentMode?: boolean;
  /** Agent mode: the contact's profile a chat with no messages yet shows. */
  intro?: ReactNode;
  view: Pick<
    ConversationViewport,
    'viewport' | 'content' | 'follow' | 'setTranscriptAnchorBottomRef' | 'scrollToEndRef'
  >;
  source: Pick<
    ConversationTranscriptSource,
    'requestEarlierTranscript' | 'showTranscriptTimeline' | 'transcriptIdentity' | 'activeStreamingTail'
  >;
  timeline: Pick<
    ConversationTimeline,
    'transcriptRows' | 'transcriptRevealed' | 'jumpToLatest' | 'shouldAnchorTranscriptBottom'
  >;
  links: { openFile?: OpenFile; openFolder?: OpenFolder; turnChangesSurface: TurnChangesSurface | null };
  sessionKey: string;
  busy: boolean;
  draftMode: boolean;
  routeSessionId: string;
  activeProjectPath: string;
  transitioning: boolean;
  pendingPromptCount: number;
  visibleWarmPaintHandoff: boolean;
  project: string;
  multiDevice: boolean;
  viewerDevice: string | null;
  renderRow: (row: TranscriptRowModel, index: number, rows: readonly TranscriptRowModel[]) => ReactNode;
  itemCount: number;
  /** Loading cover over the viewport alone (never the composer dock). */
  cover?: ReactNode;
}) {
  const { viewport, content, follow } = view;
  const { requestEarlierTranscript } = source;
  const revealed = timeline.transcriptRevealed;
  const agentSurface = roomIdOfSession(routeSessionId) ? 'room' : 'agent';
  const showWelcome = conversationShowsWelcome({
    draftMode,
    routeSessionId,
    activeProjectPath,
    itemCount,
    pendingPromptCount,
    streaming: Boolean(source.activeStreamingTail),
    transitioning,
    visibleWarmPaintHandoff,
  });
  return (
    <div className="transcript-shell">
      {/* The top scroll fade (12-transcript.css). A real hidden element, not
        the shell's ::before: its scroll-driven opacity restyles it on every
        scroll frame, and a pseudo-element's restyle made Chromium's
        accessibility tree re-serialize the whole shell — every transcript row
        — each update (~100 ms tasks on a phone while a followed reply grew). */}
      <div className="transcript-scroll-fade" aria-hidden="true" />
      <div
        className="transcript"
        ref={viewport}
        role="log"
        aria-label={t('Conversation transcript')}
        style={revealed ? undefined : { visibility: 'hidden' }}
        data-session-key={sessionKey}
        data-following={follow.following ? 'true' : 'false'}
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
        aria-busy={busy}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scrollable log must take focus for keyboard paging.
        tabIndex={0}
        // The thread is a READING surface: a mouse drag may extend the
        // selection, but it must never pick the text (or a code block, tool
        // output, image chip) up and carry it as a native drag payload
        // (user). Capture refuses the drag for every descendant, so no row
        // needs its own guard.
        onDragStartCapture={(event) => event.preventDefault()}
        onMouseDownCapture={collapseSelectionOnPress}
        onScroll={(event) => {
          follow.handleScroll();
          const element = event.currentTarget;
          if (element.scrollTop <= transcriptHistoryLead(element.clientHeight)) requestEarlierTranscript();
        }}
        onWheel={follow.handleWheel}
        onPointerDown={follow.handlePointerDown}
        onPointerUp={follow.handlePointerUp}
        onPointerCancel={follow.handlePointerUp}
        onTouchStart={follow.handleTouchStart}
        onTouchMove={follow.handleTouchMove}
        onTouchEnd={follow.handleTouchEnd}
        onTouchCancel={follow.handleTouchEnd}
        onClick={follow.handleInteraction}
        onKeyDown={follow.handleKeyDown}
      >
        <div className="thread">
          {/* An empty draft carries only the centered brand watermark;
            shortcuts live solely on the fully empty
            workspace; secondary surfaces keep the quiet letterpress).
            Sessions and transitions never show it. */}
          {showWelcome && welcomeWatermark(visibleWarmPaintHandoff)}
          {intro &&
            itemCount === 0 &&
            pendingPromptCount === 0 &&
            !source.activeStreamingTail &&
            !transitioning &&
            intro}
          {/* ONE mount per session, always with the real rows: a placeholder
            shell mounted first made the virtual core resolve its end anchor
            against an empty list and again on the 0 -> N row swap — the
            visible up/down bounce on entering a session. */}
          <TranscriptRowContexts
            project={project}
            sessionId={draftMode ? '' : routeSessionId}
            openFile={links.openFile}
            openFolder={links.openFolder}
            multiDevice={multiDevice}
            viewerDevice={viewerDevice}
            turnChangesSurface={links.turnChangesSurface}
          >
            {source.showTranscriptTimeline && !listHeld && (
              <TranscriptList
                key={source.transcriptIdentity.current}
                sessionKey={sessionKey}
                rows={timeline.transcriptRows}
                viewport={viewport}
                content={content}
                shouldAnchorBottom={timeline.shouldAnchorTranscriptBottom}
                markProgrammaticScroll={follow.markProgrammaticScroll}
                hasScrollGesture={follow.hasScrollGesture}
                hasTouchScroll={follow.holdsScrollCorrections}
                touchHoldsCorrections={follow.touchHoldsCorrections}
                onSelectionAutoScroll={follow.handleSelectionAutoScroll}
                setAnchorBottomRef={view.setTranscriptAnchorBottomRef}
                scrollToEndRef={view.scrollToEndRef}
                renderRow={renderRow}
                surface={agentMode ? agentSurface : 'coding'}
              />
            )}
          </TranscriptRowContexts>
        </div>
      </div>
      {itemCount > 0 && <JumpToLatestButton visible={follow.showJump} onJump={timeline.jumpToLatest} />}
      {cover}
    </div>
  );
}
