import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  useConversationComposerActions,
  collapseSelectionOnPress,
  conversationKeyDownCapture,
  JumpToLatestButton,
  transcriptRowNode,
} from './conversation-support';
import { useConversationPaneComposerActions } from './conversation-pane-composer-actions';
import { useConversationPaintHandoff } from './conversation-pane-paint-handoff';
import { useComposerUserMessages } from './conversation-pane-user-messages';

// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import type {
  DesktopModelSelection,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSubmitOptions,
  DesktopWorkflowState,
  DesktopOrchestrationMode,
  SessionSnapshot,
} from '../shared/contract';
import { t } from './i18n';
import { approvalInstanceKey } from './renderer-logic.mjs';
import { useConversationQueue } from './use-conversation-queue';
import { useStreamingTail, useTranscriptRows } from './use-conversation-rows';
import { useConversationFollowEffects } from './use-conversation-follow-effects';
import { useConversationOptimisticPromptRelease } from './use-conversation-optimistic-prompts';
import { useConversationTranscriptIdentity } from './use-conversation-transcript-identity';
import type { CommandSurface as CommandSurfaceName, SettingsSection } from './slash-commands';

import { sessionUsesMultipleDevices } from '../shared/session-devices';
import { TranscriptDevicesContext } from './transcript-row';
import { useRetiredApproval } from './use-retired-approval';
import { ApprovalCard } from './ApprovalCard';
import { Composer, WorkflowSelect, OrchestrationModeSelect } from './Composer';
import { ProjectContextSelector } from './composer-support';
import { BrandTile } from './WorkspaceEmptyState';
import { EMPTY_TRANSCRIPT_ITEMS, type RecordValue, type Snapshot, type TranscriptItem } from './desktop-types';
import { ComposerDock } from './ComposerDock';
import { TranscriptList } from './TranscriptList';
import type { TranscriptAssistantRowProps } from './TranscriptAssistantRow';
import {
  MarkdownOpenFileContext,
  MarkdownOpenFolderContext,
  MarkdownProjectContext,
  MarkdownSessionContext,
} from './MarkdownLink';
import { turnPromptText, turnSampledOutput, type TranscriptRowModel } from './transcript-rows';
import { TRANSCRIPT_HISTORY_TOP_PX, useTranscriptHistory, useTranscriptHistoryFill } from './use-transcript-history';
import { commandShowsActivity } from './transcript-status';
import { useTranscriptFollow } from './use-transcript-follow';
import { useTranscriptReveal } from './use-transcript-reveal';
import { useComposerDockHeight } from './use-composer-dock-height';
import { promptWaitsBehindActiveTurn, settledUserRowCount, type PendingPromptItem } from './conversation-prompt-items';

export function Conversation({
  snapshot,
  routeSnapshot,
  sessionAddress,
  invokeResult,
  submit,
  applySnapshot,
  transitioning,
  composerFocusRequest,
  onNewTask,
  onClearToNewTask,
  onClearProject,
  onResumeSession,
  onOpenSessions,
  onOpenProjects,
  onOpenSettings,
  projects,
  showProjectSelector,
  activeProjectPath,
  activeProjectLabel,
  onSelectProject,
  draftMode = false,
  draftId = '',
  draftModelSelection,
  draftWorkflow,
  draftOrchestrationMode,
  onDraftModelSelection,
  onRoutePreferenceApplied,
  onDraftWorkflow,
  onDraftOrchestrationMode,
  onOpenCommandSurface,
  onInheritSession,
  onOpenFile,
  onOpenFolder,
  renderAssistantRow,
  goalIsland,
  contextIndicator,
  readOnly = false,
  reviewActive = true,
  warmPaintHandoff = false,
  transcriptPending = false,
  onEntryRevealed,
}: {
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  /** Pane ownership resolves to this canonical session address. */
  sessionAddress?: string;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  applySnapshot: (snapshot: SessionSnapshot | null) => void;
  transitioning: boolean;
  composerFocusRequest: number;
  onNewTask: () => void;
  /** Session-pane /clear · /new: close this session's tab and open a New
   *  Task in its place with the session's settings inherited. */
  onClearToNewTask?: (sessionId: string) => void;
  onClearProject: () => void;
  onResumeSession: (id: string) => void;
  onOpenSessions: () => void;
  onOpenProjects: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  projects: DesktopProjectSummary[];
  showProjectSelector: boolean;
  activeProjectPath: string;
  activeProjectLabel: string;
  onSelectProject: (path: string) => void;
  draftMode?: boolean;
  /** Distinct New Task pane identity: pressing New task mints a new one, so
   *  the composer opens clean instead of inheriting the previous draft. */
  draftId?: string;
  draftModelSelection?: DesktopModelSelection | null;
  draftWorkflow?: DesktopWorkflowState | null;
  draftOrchestrationMode?: DesktopOrchestrationMode | null;
  onDraftModelSelection?: (selection: DesktopModelSelection) => void;
  onRoutePreferenceApplied?: (selection: DesktopModelSelection, options?: { modelChoice?: boolean }) => void;
  onDraftWorkflow?: (workflow: DesktopWorkflowState) => void;
  onDraftOrchestrationMode?: (mode: DesktopOrchestrationMode) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
  /** Context card → Inherit session and /inherit, run in place (user: 팝업 안
   *  뜨고 바로 진행되게). The pane holds the source session and its route; the
   *  host creates the heir and opens its tab. */
  onInheritSession?: (sourceSessionId: string, route: DesktopModelSelection) => Promise<void>;
  onOpenFile?: (project: string, rel: string, line?: number, accessToken?: string, column?: number) => void;
  /** Reveals a transcript folder link in the pane's side-dock Files tree. */
  onOpenFolder?: (project: string, rel: string) => void;
  /** Selector-driven rows retain their component identity through settlement. */
  renderAssistantRow?: (props: TranscriptAssistantRowProps) => ReactNode;
  /** Goal capsule routed to the composer unless the pane's visible DIFF owns
   *  it instead. */
  goalIsland?: ReactNode;
  /** Context gauge seated in the composer footer beside the model trigger
   *  on every surface (user: 컨텍스트는 모델 선택기 옆; 모바일도 PC에 맞춰). */
  contextIndicator?: ReactNode;
  /** Transcript-only child-agent view: no submit, retry, approval, review, or
   *  other session runtime-mutating controls are mounted. */
  readOnly?: boolean;
  /** Only the focused, visible session performs background review refreshes. */
  reviewActive?: boolean;
  /** A warm New Task → session commit paints the requested transcript under
   *  the prior watermark for one frame so Chromium uploads its raster before
   *  it becomes visible. Route identity and interaction are already current. */
  warmPaintHandoff?: boolean;
  /** The rich Markdown chunk this session's rows need has not resolved yet.
   *  The timeline stays UNMOUNTED until it has (the surface cover holds the
   *  frame): the timeline mounts once, with the real rows, so the entry
   *  offset is resolved exactly once. */
  transcriptPending?: boolean;
  /** This session's entry settled: rows laid out and every entry-pending
   *  chrome (the review bar's first read) decided. */
  onEntryRevealed?: (sessionKey: string) => void;
}) {
  const conversation = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composerDock = useRef<HTMLDivElement>(null);
  const composerDockHeight = useComposerDockHeight(composerDock, !readOnly);
  const scrollToEndRef = useRef<(behavior?: ScrollBehavior) => void>(() => {});
  // Reader intent must reach the virtual timeline's anchor in the same task it
  // is decided in; React state gets there a render later.
  const setTranscriptAnchorBottomRef = useRef<(bottom: boolean) => void>(() => {});
  // Latched once this identity has painted its timeline. A promotion whose
  // Markdown-readiness flag lags one tick must not unmount measured rows.
  const timelineMounted = useRef(false);
  const transcriptSessionKey = draftMode ? 'new-task' : String(routeSnapshot.sessionId || 'new-task');
  // Auto-scroll + message-gesture split.
  const {
    following,
    showJump,
    hasScrollGesture: hasTranscriptScrollGesture,
    handleScroll: handleTranscriptScroll,
    handleWheel: handleTranscriptWheel,
    handlePointerDown: handleTranscriptPointerDown,
    handlePointerMove: handleTranscriptPointerMove,
    handlePointerUp: handleTranscriptPointerUp,
    handleSelectionAutoScroll: handleTranscriptSelectionAutoScroll,
    handleTouchStart: handleTranscriptTouchStart,
    handleTouchMove: handleTranscriptTouchMove,
    handleTouchEnd: handleTranscriptTouchEnd,
    handleInteraction: handleTranscriptInteraction,
    handleKeyDown: handleTranscriptKeyDown,
    resume: resumeFollow,
    arm: armFollow,
    markProgrammaticScroll: markTranscriptProgrammaticScroll,
  } = useTranscriptFollow({
    viewport,
    content,
    sessionKey: transcriptSessionKey,
    contentMounted: !transcriptPending || timelineMounted.current,
    setAnchorBottomRef: setTranscriptAnchorBottomRef,
    scrollToEndRef,
  });
  const [optimisticPrompts, setOptimisticPrompts] = useState<PendingPromptItem[]>([]);
  const draftModeRef = useRef(draftMode);
  draftModeRef.current = draftMode;
  // Pane-local session runtime addressing: abort and tool approvals always target the
  // session THIS surface renders, never the globally active route.
  const routeSessionIdRef = useRef('');
  routeSessionIdRef.current = String(routeSnapshot.sessionId || '');
  // Approvals this device answered itself, and whether the conversation was
  // used from several devices (only then is a device named).
  const decidedLocally = useRef<Set<string>>(new Set());
  const retiredApproval = useRetiredApproval(snapshot, decidedLocally.current);
  const multiDevice = useMemo(() => sessionUsesMultipleDevices(snapshot.items), [snapshot.items]);
  const { suppressDraftSubmitPaintHandoff, visibleWarmPaintHandoff } = useConversationPaintHandoff(
    draftMode,
    warmPaintHandoff
  );
  const composerActions = useConversationPaneComposerActions({
    actions: {
      submit,
      invokeResult,
      applySnapshot,
      onNewTask,
      onResumeSession,
      onOpenSessions,
      onOpenProjects,
      onOpenSettings,
      onOpenCommandSurface,
      onClearToNewTask,
    },
    sessionAddress,
    routeSnapshot,
    onInheritSession,
  });
  // TUI parity: a prompt only reads as "Queued" when it actually waits behind
  // an active turn. An idle submit — including a draft's first prompt, whose
  // atomic RPC spans session materialization — renders as a normal user row.
  const queuedBehindTurnAtSubmit = useRef(false);
  queuedBehindTurnAtSubmit.current = promptWaitsBehindActiveTurn(draftMode, snapshot);
  const settledItems = Array.isArray(snapshot.items) ? snapshot.items : EMPTY_TRANSCRIPT_ITEMS;
  const composerUserMessages = useComposerUserMessages(settledItems);
  const { activeStreamingTail, liveItemCount, settledRowItems } = useStreamingTail(
    snapshot.streamingTail as TranscriptItem | null | undefined,
    settledItems
  );
  const requestEarlierTranscript = useTranscriptHistory(
    draftMode ? '' : String(routeSnapshot.sessionId || ''),
    settledItems.length,
    typeof snapshot.transcriptHasOlder === 'boolean' ? snapshot.transcriptHasOlder : undefined
  );
  const { transcriptIdentity, promotedOwnDraft, showTranscriptTimeline } = useConversationTranscriptIdentity({
    transcriptSessionKey,
    transcriptPending,
    timelineMounted,
    suppressDraftSubmitPaintHandoff,
  });
  // Submit-time baseline for the id-agnostic release path below.
  const settledUsers = useMemo(() => settledUserRowCount(settledItems), [settledItems]);
  const settledUsersRef = useRef(settledUsers);
  settledUsersRef.current = settledUsers;
  const { composerQueued, optimisticActivityStartedAt, pendingPromptIds, transcriptPendingPromptItems } =
    useConversationQueue(optimisticPrompts, settledItems, snapshot.queued);
  const itemCount = liveItemCount + transcriptPendingPromptItems.length;
  // An idle submit starts the next review scope on its optimistic user row,
  // not one host round-trip later when that row settles. Otherwise the prior
  // turn's review bar/reservation remains fixed above the composer while the
  // next response begins streaming.
  const reviewItems = useMemo(
    () => (transcriptPendingPromptItems.length > 0 ? [...settledItems, ...transcriptPendingPromptItems] : settledItems),
    [settledItems, transcriptPendingPromptItems]
  );
  // Close previous-turn chrome with the optimistic row. The goal owns a
  // separate snapshot lane, so its mask must survive transcript settlement;
  // the island releases it only when its own goal revision changes.
  const goalSubmitScopeRef = useRef(transcriptSessionKey);
  goalSubmitScopeRef.current = transcriptSessionKey;
  const goalSubmission = useRef<{ id: string; scope: string } | null>(null);
  const goalSubmissionId = goalSubmission.current?.scope === transcriptSessionKey ? goalSubmission.current.id : '';
  useConversationOptimisticPromptRelease({
    transcriptSessionKey,
    promotedOwnDraft,
    settledItems,
    setOptimisticPrompts,
  });
  const { settledTurnKeys, transcriptRows } = useTranscriptRows({
    identity: transcriptIdentity.current,
    sessionKey: transcriptSessionKey,
    settledItems,
    settledRowItems,
    failedTurnKeys: snapshot.failedTurnKeys,
    precomputedTurnKeys: snapshot.transcriptTurnKeys,
    pendingItems: transcriptPendingPromptItems,
    liveItem: activeStreamingTail,
    busy: snapshot.busy,
    commandBusy: snapshot.commandBusy,
    commandActivityVisible: commandShowsActivity(snapshot),
    optimisticActivityStartedAt,
  });
  const transcriptRevealed = useTranscriptReveal({
    identity: transcriptIdentity.current,
    enabled: showTranscriptTimeline && transcriptRows.length > 0,
    draft: draftMode || transcriptSessionKey === 'new-task',
    viewport,
    content,
    scope: conversation,
    hasScrollGesture: hasTranscriptScrollGesture,
  });
  useLayoutEffect(() => {
    if (transcriptRevealed) onEntryRevealed?.(transcriptSessionKey);
  }, [onEntryRevealed, transcriptRevealed, transcriptSessionKey]);
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
    transcriptSessionKey,
    viewport,
  });
  // Submit re-arms follow. The new row is an append, so virtual-core's
  // followOnAppend is the only end write.
  const armFollowOnSubmitRef = useRef(armFollow);
  armFollowOnSubmitRef.current = armFollow;
  const {
    composerAbort,
    composerApplySnapshot,
    composerInvokeResult,
    composerOnClearToNewTask,
    composerOnNewTask,
    composerOnInherit,
    composerOnOpenCommandSurface,
    composerOnOpenProjects,
    composerOnOpenSessions,
    composerOnOpenSettings,
    composerOnResumeSession,
    composerQueuedRestored,
    composerSubmit,
  } = useConversationComposerActions({
    armFollowOnSubmitRef,
    composerActions,
    draftModeRef,
    goalSubmission,
    goalSubmitScopeRef,
    queuedBehindTurnAtSubmit,
    routeSessionIdRef,
    setOptimisticPrompts,
    settledUsersRef,
    suppressDraftSubmitPaintHandoff,
  });

  const disclosureScope = String(routeSnapshot.sessionId || 'new-task');
  const routeProject = String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || '');
  const routeScope = String(routeSnapshot.sessionId || routeProject || 'new-task');
  const retryDisabled = Boolean(snapshot.busy) || transitioning;
  // Session retry: a failed turn that produced no output resubmits its prompt
  // and the runtime rewinds the unanswered copy, so the model sees the prompt
  // once; a turn that already sampled output continues from where it stopped.
  const retryTurn = (turnKey: string) => {
    const text = turnPromptText(settledItems, settledTurnKeys, turnKey);
    if (!text) return;
    const prompt = turnSampledOutput(settledItems, settledTurnKeys, turnKey)
      ? t('Continue from where you left off.')
      : text;
    void composerSubmit(prompt, { retryFailedTurn: true });
  };
  const renderTranscriptRow = (row: TranscriptRowModel) =>
    transcriptRowNode(row, {
      disclosureScope,
      optimisticActivityStartedAt,
      readOnly,
      renderAssistantRow,
      retryDisabled,
      settledItems,
      settledTurnKeys,
      snapshot,
      onRetryTurn: retryTurn,
      onOpenSettings,
    });

  return (
    <section
      className={`conversation${readOnly ? ' conversation-read-only' : ''}`}
      ref={conversation}
      style={{ '--composer-dock-height': `${composerDockHeight}px` } as CSSProperties}
      data-transcript-entering={transcriptRevealed ? undefined : 'true'}
      onKeyDownCapture={(event) =>
        conversationKeyDownCapture(event, { readOnly, viewport, onTranscriptKey: handleTranscriptKeyDown })
      }
    >
      <div className="transcript-shell">
        <div
          className="transcript"
          ref={viewport}
          role="log"
          aria-label={t('Conversation transcript')}
          style={transcriptRevealed ? undefined : { visibility: 'hidden' }}
          data-session-key={transcriptSessionKey}
          data-following={following ? 'true' : 'false'}
          aria-live="polite"
          aria-relevant="additions"
          aria-atomic="false"
          aria-busy={Boolean(snapshot.busy || snapshot.commandBusy)}
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
            handleTranscriptScroll();
            if (event.currentTarget.scrollTop <= TRANSCRIPT_HISTORY_TOP_PX) requestEarlierTranscript();
          }}
          onWheel={handleTranscriptWheel}
          onPointerDown={handleTranscriptPointerDown}
          onPointerMove={handleTranscriptPointerMove}
          onPointerUp={handleTranscriptPointerUp}
          onPointerCancel={handleTranscriptPointerUp}
          onTouchStart={handleTranscriptTouchStart}
          onTouchMove={handleTranscriptTouchMove}
          onTouchEnd={handleTranscriptTouchEnd}
          onTouchCancel={handleTranscriptTouchEnd}
          onClick={handleTranscriptInteraction}
          onKeyDown={handleTranscriptKeyDown}
        >
          <div className="thread">
            {/* An empty draft carries only the centered brand watermark;
              shortcuts live solely on the fully empty
              workspace; secondary surfaces keep the quiet letterpress).
              Sessions and transitions never show it. */}
            {(((draftMode || (!routeSnapshot.sessionId && Boolean(activeProjectPath))) &&
              itemCount === 0 &&
              transcriptPendingPromptItems.length === 0 &&
              !activeStreamingTail &&
              !transitioning) ||
              visibleWarmPaintHandoff) && (
              <div
                className={`thread-welcome thread-welcome-task${
                  visibleWarmPaintHandoff ? ' thread-welcome-paint-handoff' : ''
                }`}
                aria-hidden="true"
              >
                <span className="welcome-logo">
                  <BrandTile crop />
                </span>
              </div>
            )}
            {/* ONE mount per session, always with the real rows: a placeholder
              shell mounted first made the virtual core resolve its end anchor
              against an empty list and again on the 0 -> N row swap — the
              visible up/down bounce on entering a session. */}
            <MarkdownProjectContext.Provider value={routeProject}>
              <MarkdownSessionContext.Provider value={draftMode ? '' : String(routeSnapshot.sessionId || '')}>
                <MarkdownOpenFileContext.Provider value={onOpenFile ?? null}>
                  <MarkdownOpenFolderContext.Provider value={onOpenFolder ?? null}>
                   <TranscriptDevicesContext.Provider value={multiDevice}>
                    {showTranscriptTimeline && (
                      <TranscriptList
                        key={transcriptIdentity.current}
                        sessionKey={transcriptSessionKey}
                        rows={transcriptRows}
                        viewport={viewport}
                        content={content}
                        bottomInset={composerDockHeight}
                        shouldAnchorBottom={shouldAnchorTranscriptBottom}
                        markProgrammaticScroll={markTranscriptProgrammaticScroll}
                        hasScrollGesture={hasTranscriptScrollGesture}
                        onSelectionAutoScroll={handleTranscriptSelectionAutoScroll}
                        setAnchorBottomRef={setTranscriptAnchorBottomRef}
                        scrollToEndRef={scrollToEndRef}
                        renderRow={renderTranscriptRow}
                      />
                    )}
                   </TranscriptDevicesContext.Provider>
                  </MarkdownOpenFolderContext.Provider>
                </MarkdownOpenFileContext.Provider>
              </MarkdownSessionContext.Provider>
            </MarkdownProjectContext.Provider>
          </div>
        </div>
        {itemCount > 0 && <JumpToLatestButton visible={showJump} onJump={jumpToLatest} />}
      </div>
      {/* The measured dock overlays the viewport. Its clearance belongs to
          the same virtual geometry as the rows, not a second scroll writer. */}
      {!readOnly && (
        <ComposerDock
          dockRef={composerDock}
          onOpenFile={onOpenFile}
          goalIsland={goalIsland}
          goalSubmissionId={goalSubmissionId}
          approval={
            snapshot.toolApproval ? (
              <ApprovalCard
                key={approvalInstanceKey(snapshot.toolApproval.id)}
                approval={snapshot.toolApproval}
                elsewhereDevice={
                  multiDevice && snapshot.toolApprovalResult?.id === snapshot.toolApproval.id
                    ? (snapshot.toolApprovalResult?.device ?? '')
                    : ''
                }
                resolve={async (approved) => {
                  const host = window.mixdogDesktop;
                  const sessionId = routeSessionIdRef.current;
                  const approvalId = String(snapshot.toolApproval?.id || '');
                  if (!sessionId) return false;
                  const accepted = await host.resolveToolApprovalForSession(sessionId, approvalId, { approved });
                  if (accepted === true) decidedLocally.current.add(approvalId);
                  return accepted;
                }}
              />
            ) : retiredApproval ? (
              <ApprovalCard
                key={`retired:${approvalInstanceKey(retiredApproval.approval.id)}`}
                approval={retiredApproval.approval}
                outcome={retiredApproval.outcome}
                resolve={async () => true}
              />
            ) : null
          }
          showProjectSelector={showProjectSelector}
          contextBar={
            <>
              <ProjectContextSelector
                projects={projects}
                activePath={activeProjectPath}
                activeLabel={activeProjectLabel}
                disabled={transitioning || Boolean(snapshot.busy)}
                onClear={onClearProject}
                onSelect={onSelectProject}
              />
              <WorkflowSelect
                workflow={(draftWorkflow || (routeSnapshot.workflow as RecordValue | null)) ?? null}
                disabled={transitioning || (!draftMode && Boolean(routeSnapshot.busy || routeSnapshot.commandBusy))}
                invokeResult={composerInvokeResult}
                applySnapshot={composerApplySnapshot}
                onDraftChange={onDraftWorkflow}
              />
              <OrchestrationModeSelect
                mode={draftOrchestrationMode ?? (draftMode ? null : routeSnapshot.orchestrationMode)}
                disabled={transitioning || (!draftMode && Boolean(routeSnapshot.busy || routeSnapshot.commandBusy))}
                invokeResult={composerInvokeResult}
                applySnapshot={composerApplySnapshot}
                onDraftChange={onDraftOrchestrationMode}
              />
            </>
          }
          reviewItems={reviewItems}
          reviewActive={reviewActive}
          reviewBusy={Boolean(snapshot.busy || routeSnapshot.commandBusy)}
          reviewSessionId={draftMode ? '' : String(sessionAddress || routeSnapshot.sessionId || '')}
          reviewCwd={routeProject}
        >
          <Composer
            turnBusy={Boolean(snapshot.busy)}
            commandBusy={!draftMode && Boolean(routeSnapshot.commandBusy)}
            transitioning={transitioning}
            focusRequest={composerFocusRequest}
            historyScope={draftMode ? `new-task:${activeProjectPath || 'local'}` : routeScope}
            identityScope={draftMode ? `draft:${draftId || 'default'}` : routeScope}
            recoveryScope={transcriptIdentity.current}
            projectScope={draftMode ? activeProjectPath : routeProject}
            sessionId={draftMode ? '' : String(routeSnapshot.sessionId || '')}
            hasConversation={itemCount > 0 || (Array.isArray(snapshot.queued) && snapshot.queued.length > 0)}
            promptHistoryList={routeSnapshot.promptHistoryList}
            provider={String(draftModelSelection?.provider || routeSnapshot.provider || '')}
            model={String(draftModelSelection?.model || routeSnapshot.model || '')}
            effort={String(draftModelSelection?.effort ?? routeSnapshot.effort ?? '')}
            fast={draftModelSelection?.fast ?? Boolean(routeSnapshot.fast)}
            fastCapable={Boolean(routeSnapshot.fastCapable)}
            modelParameters={
              draftModelSelection?.modelParameters ||
              (routeSnapshot.modelParameters as Record<string, string> | undefined)
            }
            contextPercent={draftModelSelection?.contextPercent ?? (Number(routeSnapshot.contextPercent) || undefined)}
            draftMode={draftMode}
            onDraftModelSelection={onDraftModelSelection}
            onRoutePreferenceApplied={onRoutePreferenceApplied}
            modelAside={contextIndicator}
            queued={composerQueued}
            hiddenQueueIds={pendingPromptIds}
            pendingSubmissionIds={pendingPromptIds}
            onQueuedRestored={composerQueuedRestored}
            promptRestore={draftMode ? null : (routeSnapshot.promptRestore ?? null)}
            userMessages={composerUserMessages}
            submit={composerSubmit}
            abort={composerAbort}
            invokeResult={composerInvokeResult}
            applySnapshot={composerApplySnapshot}
            onNewTask={composerOnNewTask}
            onClearToNewTask={onClearToNewTask ? composerOnClearToNewTask : undefined}
            onResumeSession={composerOnResumeSession}
            onOpenSessions={composerOnOpenSessions}
            onOpenProjects={composerOnOpenProjects}
            onOpenSettings={composerOnOpenSettings}
            onOpenCommandSurface={composerOnOpenCommandSurface}
            onInherit={onInheritSession ? composerOnInherit : undefined}
            paneActive={reviewActive}
            dropTargetRef={conversation}
          />
        </ComposerDock>
      )}
    </section>
  );
}
