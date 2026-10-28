import { useMemo, useRef } from 'react';
import { HandoffQuestionsContext } from './agent-task-line';
import { roomIdOfSession } from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { useAgentChatSession, useDeletedBotSession } from './agent-chat-mode';
import { t } from './i18n';
import { AgentChatIntro } from './agent-chat-header';
import { conversationKeyDownCapture } from './conversation-support';
import { ConversationTranscript } from './conversation-pane-transcript';
import { useConversationPaintHandoff } from './conversation-pane-paint-handoff';

import type { ConversationProps } from './conversation-pane-props';
import { useConversationTimeline } from './use-conversation-timeline';
import { useConversationLinkSurfaces } from './use-conversation-link-surfaces';
import { runningTurnKeyOf } from './turn-preview-model';
import { useConversationApprovals } from './use-conversation-approvals';
import { ConversationComposerDock } from './conversation-pane-composer-dock';
import { useConversationIsland } from './use-conversation-island';
import { useConversationRowRenderer } from './use-conversation-row-renderer';
import { useConversationSubmission } from './use-conversation-submission';
import { useConversationTranscriptSource } from './use-conversation-transcript-source';
import { useConversationViewport } from './use-conversation-viewport';
import { SteerContext, useSteerActions } from './steer-actions';

export function Conversation(props: ConversationProps) {
  const {
    snapshot,
    routeSnapshot,
    transitioning,
    onOpenSettings,
    activeProjectPath,
    draftMode = false,
    draftId = '',
    renderAssistantRow,
    readOnly: readOnlyView = false,
    reviewActive = true,
    surfaceVisible = true,
    warmPaintHandoff = false,
    transcriptPending = false,
    onEntryRevealed,
    onTranscriptHiddenChange,
  } = props;
  // Every effect below runs in the order its hook is called here: viewport,
  // approvals, paint handoff, prompt release (submission), timeline, quota.
  const routeSessionId = String(routeSnapshot.sessionId || '');
  const agentMode = useAgentChatSession(draftMode ? '' : routeSessionId);
  // A deleted bot's chat stays to read: no composer, cards or retries.
  const botDeleted = useDeletedBotSession(draftMode ? '' : routeSessionId);
  const readOnly = readOnlyView || botDeleted;
  const transcriptSessionKey = draftMode ? 'new-task' : String(routeSnapshot.sessionId || 'new-task');
  const view = useConversationViewport({ transcriptSessionKey, transcriptPending });
  // Pane-local session runtime addressing: abort and tool approvals always target the
  // session THIS surface renders, never the globally active route.
  const routeSessionIdRef = useRef('');
  routeSessionIdRef.current = routeSessionId;
  // A read-only view renders no composer dock and a parked one is off
  // screen: their browser approvals float instead.
  const approvals = useConversationApprovals(snapshot, routeSessionIdRef, { docked: !readOnly && surfaceVisible });
  const { suppressDraftSubmitPaintHandoff, visibleWarmPaintHandoff } = useConversationPaintHandoff(
    draftMode,
    warmPaintHandoff
  );
  const source = useConversationTranscriptSource({
    snapshot,
    historySessionId: draftMode ? '' : routeSessionId,
    transcriptSessionKey,
    transcriptPending,
    timelineMounted: view.timelineMounted,
    suppressDraftSubmitPaintHandoff,
    following: view.follow.following,
  });
  // The live rows: a history window the reader scrolled into is the
  // timeline's alone.
  const settledItems = source.liveSettledItems;
  const submission = useConversationSubmission(props, {
    draftMode,
    settledItems,
    transcriptSessionKey,
    promotedOwnDraft: source.promotedOwnDraft,
    routeSessionIdRef,
    armFollow: view.follow.arm,
    suppressDraftSubmitPaintHandoff,
  });
  const { actions, optimisticActivityStartedAt, transcriptPendingPromptItems: pendingItems } = submission;
  // A waiting question is read at action time (the island resolves it below).
  const answerQuestionRef = useRef<((reply: string) => Promise<unknown>) | null>(null);
  const steer = useSteerActions({
    steerItems: submission.steerItems,
    busy: Boolean(snapshot.busy),
    sessionId: draftMode ? '' : routeSessionId,
    invokeResult: actions.composerInvokeResult,
    applySnapshot: actions.composerApplySnapshot,
    abort: actions.composerAbort,
    submit: actions.composerSubmit,
    answerQuestion: answerQuestionRef,
    onTaken: actions.composerQueuedRestored,
  });
  const steerItems = steer.visibleSteerItems;
  const timeline = useConversationTimeline({
    view,
    source,
    sessionKey: transcriptSessionKey,
    draftMode,
    snapshot,
    pendingItems,
    steerItems,
    optimisticActivityStartedAt,
    // A group room's band is its typing slot (use-conversation-row-renderer.ts).
    room: Boolean(roomIdOfSession(routeSessionId)),
    listHeld: props.transcriptListHeld,
    onEntryRevealed,
    onTranscriptHiddenChange,
  });
  const { renderTranscriptRow } = useConversationRowRenderer({
    snapshot,
    disclosureScope: String(routeSnapshot.sessionId || 'new-task'),
    readOnly,
    transitioning,
    renderAssistantRow,
    onOpenSettings,
    settledItems,
    settledTurnKeys: timeline.settledTurnKeys,
    optimisticActivityStartedAt,
    submit: actions.composerSubmit,
    questionCard: readOnly ? null : approvals.questionCard,
    agentMode,
  });
  const links = useConversationLinkSurfaces(props, {
    // Per-turn changed-files cards. A read-only view mounts none: their
    // Undo/Reapply mutate the session.
    turnChangesSessionId: draftMode || readOnly ? '' : routeSessionId,
    turnChangesBusy: Boolean(snapshot.busy || snapshot.commandBusy),
    turnChangesRunning: Boolean(snapshot.busy) && pendingItems.length === 0,
    // With no prompt pending, the last settled item is the running turn's.
    runningTurnKey:
      snapshot.busy && pendingItems.length === 0
        ? runningTurnKeyOf(settledItems, timeline.settledTurnKeys, timeline.settledTurnKeys.at(-1) ?? '')
        : '',
  });
  const island = useConversationIsland({
    approvals,
    draftMode,
    snapshot,
    routeSnapshot,
    settledItems,
    settledTurnKeys: timeline.settledTurnKeys,
    pendingPromptCount: pendingItems.length,
    actions,
  });
  answerQuestionRef.current = island.answerQuestion ?? null;
  const routeProject = String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || '');
  const itemCount = source.liveItemCount + pendingItems.length + steerItems.length;
  // The handed-off sessions' questions, at their hand-off lines.
  const handoffQuestions = snapshot.handoffQuestions;
  const handoffQuestionsContext = useMemo(
    () =>
      readOnly || draftMode || !routeSessionId || !handoffQuestions?.length
        ? null
        : { chatSessionId: routeSessionId, questions: handoffQuestions, agentMode },
    [readOnly, draftMode, routeSessionId, handoffQuestions, agentMode]
  );

  return (
    <SteerContext.Provider value={readOnly ? null : steer.context}>
      <section
        className={`conversation${readOnly ? ' conversation-read-only' : ''}`}
        ref={view.conversation}
        data-chat-mode={agentMode ? 'agent' : undefined}
        data-transcript-entering={timeline.transcriptRevealed ? undefined : 'true'}
        onKeyDownCapture={(event) =>
          conversationKeyDownCapture(event, {
            readOnly,
            viewport: view.viewport,
            onTranscriptKey: view.follow.handleKeyDown,
          })
        }
      >
        <HandoffQuestionsContext.Provider value={handoffQuestionsContext}>
          <ConversationTranscript
            view={view}
            source={source}
            timeline={timeline}
            links={links}
            sessionKey={transcriptSessionKey}
            busy={Boolean(snapshot.busy || snapshot.commandBusy)}
            draftMode={draftMode}
            routeSessionId={routeSessionId}
            activeProjectPath={activeProjectPath}
            transitioning={transitioning}
            pendingPromptCount={pendingItems.length}
            visibleWarmPaintHandoff={visibleWarmPaintHandoff}
            project={routeProject}
            multiDevice={approvals.multiDevice}
            viewerDevice={approvals.viewerDevice}
            renderRow={renderTranscriptRow}
            itemCount={itemCount}
            cover={props.transcriptCover}
            listHeld={props.transcriptListHeld}
            intro={agentMode ? <AgentChatIntro sessionId={routeSessionId} /> : undefined}
            agentMode={agentMode}
          />
        </HandoffQuestionsContext.Provider>
        {/* The dock is the column's in-flow sibling below the viewport: its
          height changes resize the viewport, never the virtual geometry. */}
        {!readOnly && (
          <ConversationComposerDock
            {...props}
            draftMode={draftMode}
            draftId={draftId}
            agentMode={agentMode}
            reviewActive={reviewActive}
            dropTargetRef={view.conversation}
            routeProject={routeProject}
            island={island}
            submission={submission}
            settledItems={settledItems}
            openFile={links.openFile}
            recoveryScope={source.transcriptIdentity.current}
            hasConversation={itemCount > 0 || (Array.isArray(snapshot.queued) && snapshot.queued.length > 0)}
          />
        )}
        {botDeleted && (
          <p className="conversation-deleted-notice" role="status">
            {t('This bot was deleted.')}
          </p>
        )}
      </section>
    </SteerContext.Provider>
  );
}
