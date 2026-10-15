import { useRef } from 'react';
import { conversationKeyDownCapture } from './conversation-support';
import { ConversationTranscript } from './conversation-pane-transcript';
import { useConversationPaintHandoff } from './conversation-pane-paint-handoff';

// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import type { ConversationProps } from './conversation-pane-props';
import { useConversationTimeline } from './use-conversation-timeline';
import { useConversationLinkSurfaces } from './use-conversation-link-surfaces';
import { useConversationApprovals } from './use-conversation-approvals';
import { ConversationComposerDock } from './conversation-pane-composer-dock';
import { useConversationIsland } from './use-conversation-island';
import { useConversationRowRenderer } from './use-conversation-row-renderer';
import { useConversationSubmission } from './use-conversation-submission';
import { useConversationTranscriptSource } from './use-conversation-transcript-source';
import { useConversationViewport } from './use-conversation-viewport';

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
    readOnly = false,
    reviewActive = true,
    warmPaintHandoff = false,
    transcriptPending = false,
    onEntryRevealed,
    onTranscriptHiddenChange,
  } = props;
  // Every effect below runs in the order its hook is called here: viewport,
  // approvals, paint handoff, prompt release (submission), timeline, quota.
  const routeSessionId = String(routeSnapshot.sessionId || '');
  const transcriptSessionKey = draftMode ? 'new-task' : String(routeSnapshot.sessionId || 'new-task');
  const view = useConversationViewport({ transcriptSessionKey, transcriptPending });
  // Pane-local session runtime addressing: abort and tool approvals always target the
  // session THIS surface renders, never the globally active route.
  const routeSessionIdRef = useRef('');
  routeSessionIdRef.current = routeSessionId;
  const approvals = useConversationApprovals(snapshot, routeSessionIdRef);
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
  });
  const { settledItems } = source;
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
  const timeline = useConversationTimeline({
    view,
    source,
    sessionKey: transcriptSessionKey,
    draftMode,
    snapshot,
    pendingItems,
    optimisticActivityStartedAt,
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
  });
  const links = useConversationLinkSurfaces(props, {
    // Per-turn changed-files cards. A read-only view mounts none: their
    // Undo/Reapply mutate the session.
    turnChangesSessionId: draftMode || readOnly ? '' : routeSessionId,
    turnChangesBusy: Boolean(snapshot.busy || snapshot.commandBusy),
    turnChangesRunning: Boolean(snapshot.busy) && pendingItems.length === 0,
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
  const routeProject = String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || '');
  const itemCount = source.liveItemCount + pendingItems.length;

  return (
    <section
      className={`conversation${readOnly ? ' conversation-read-only' : ''}`}
      ref={view.conversation}
      data-transcript-entering={timeline.transcriptRevealed ? undefined : 'true'}
      onKeyDownCapture={(event) =>
        conversationKeyDownCapture(event, {
          readOnly,
          viewport: view.viewport,
          onTranscriptKey: view.follow.handleKeyDown,
        })
      }
    >
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
      />
      {/* The dock is the column's in-flow sibling below the viewport: its
          height changes resize the viewport, never the virtual geometry. */}
      {!readOnly && (
        <ConversationComposerDock
          {...props}
          draftMode={draftMode}
          draftId={draftId}
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
    </section>
  );
}
