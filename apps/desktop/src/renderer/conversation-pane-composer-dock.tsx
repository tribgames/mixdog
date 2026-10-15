import type { ComponentProps, RefObject } from 'react';
import { BranchChip } from './BranchChip';
import { Composer, OrchestrationModeSelect, WorkflowSelect } from './Composer';
import { ComposerContextChips } from './composer-context-chips';
import { ProjectContextSelector } from './composer-support';
import { ComposerDock } from './ComposerDock';
import type { ConversationProps } from './conversation-pane-props';
import { useComposerUserMessages } from './conversation-pane-user-messages';
import type { RecordValue, Snapshot, TranscriptItem } from './desktop-types';
import { t } from './i18n';
import type { ConversationIsland } from './use-conversation-island';
import type { ConversationSubmission } from './use-conversation-submission';

export type ConversationComposerDockProps = Pick<
  ConversationProps,
  | 'snapshot'
  | 'routeSnapshot'
  | 'sessionAddress'
  | 'transitioning'
  | 'composerFocusRequest'
  | 'projects'
  | 'showProjectSelector'
  | 'activeProjectPath'
  | 'activeProjectLabel'
  | 'onClearProject'
  | 'onSelectProject'
  | 'onResumeSession'
  | 'draftWorkflow'
  | 'onDraftWorkflow'
  | 'draftOrchestrationMode'
  | 'onDraftOrchestrationMode'
  | 'draftModelSelection'
  | 'onDraftModelSelection'
  | 'onRoutePreferenceApplied'
  | 'contextIndicator'
  | 'goalIsland'
  | 'onOpenSessionDiff'
  | 'onOpenAgentSession'
  | 'onClearToNewTask'
  | 'onInheritSession'
> & {
  draftMode: boolean;
  draftId: string;
  reviewActive: boolean;
  dropTargetRef: RefObject<HTMLElement | null>;
  routeProject: string;
  island: ConversationIsland;
  submission: Pick<
    ConversationSubmission,
    'goalSubmissionId' | 'reviewItems' | 'composerQueued' | 'pendingPromptIds' | 'actions'
  >;
  settledItems: TranscriptItem[];
  openFile: ComponentProps<typeof Composer>['onOpenFile'];
  recoveryScope: string;
  hasConversation: boolean;
};

/** A route's own context size, when it reports one. */
function routeContextTokens(routeSnapshot: Snapshot): number | undefined {
  const tokens = Number(routeSnapshot.contextTokens);
  return tokens > 0 ? tokens : undefined;
}

/** The New Task context bar: project, workflow, delegation and branch. */
function conversationContextBar({
  snapshot,
  routeSnapshot,
  draftMode,
  draftId,
  transitioning,
  routeProject,
  projects,
  activeProjectPath,
  activeProjectLabel,
  onClearProject,
  onSelectProject,
  onResumeSession,
  draftWorkflow,
  onDraftWorkflow,
  draftOrchestrationMode,
  onDraftOrchestrationMode,
  submission: { actions },
}: ConversationComposerDockProps) {
  const routeBusy = !draftMode && Boolean(routeSnapshot.busy || routeSnapshot.commandBusy);
  // Branch/worktree is picked in a New Task's context bar only.
  const branchChip = (
    <BranchChip
      sessionId={draftMode ? '' : String(routeSnapshot.sessionId || '')}
      draftId={draftId}
      projectPath={draftMode ? activeProjectPath : routeProject}
      disabled={transitioning || routeBusy}
      refreshKey={[
        Boolean(routeSnapshot.busy),
        Boolean(routeSnapshot.commandBusy),
        routeSnapshot.workspace?.revision ?? '',
        routeSnapshot.workspace?.cwd ?? '',
      ].join(':')}
      onOpenSession={onResumeSession}
    />
  );
  return (
    <ComposerContextChips
      project={
        <ProjectContextSelector
          projects={projects}
          activePath={activeProjectPath}
          activeLabel={activeProjectLabel}
          disabled={transitioning || Boolean(snapshot.busy)}
          onClear={onClearProject}
          onSelect={onSelectProject}
        />
      }
      workflow={
        <WorkflowSelect
          workflow={(draftWorkflow || (routeSnapshot.workflow as RecordValue | null)) ?? null}
          disabled={transitioning || routeBusy}
          invokeResult={actions.composerInvokeResult}
          applySnapshot={actions.composerApplySnapshot}
          onDraftChange={onDraftWorkflow}
        />
      }
      delegation={
        <OrchestrationModeSelect
          mode={draftOrchestrationMode ?? (draftMode ? null : routeSnapshot.orchestrationMode)}
          disabled={transitioning || routeBusy}
          invokeResult={actions.composerInvokeResult}
          applySnapshot={actions.composerApplySnapshot}
          onDraftChange={onDraftOrchestrationMode}
        />
      }
      branch={branchChip}
    />
  );
}

/** The dock below the viewport: the island, the context bar, the review bar
 *  and the composer. */
export function ConversationComposerDock(props: ConversationComposerDockProps) {
  const {
    snapshot,
    routeSnapshot,
    sessionAddress,
    draftMode,
    draftId,
    reviewActive,
    transitioning,
    composerFocusRequest,
    activeProjectPath,
    showProjectSelector,
    draftModelSelection,
    onDraftModelSelection,
    onRoutePreferenceApplied,
    contextIndicator,
    goalIsland,
    onOpenSessionDiff,
    onOpenAgentSession,
    onClearToNewTask,
    onInheritSession,
    dropTargetRef,
    routeProject,
    island,
    submission,
  } = props;
  const routeScope = String(routeSnapshot.sessionId || routeProject || 'new-task');
  const { actions } = submission;
  const userMessages = useComposerUserMessages(props.settledItems);
  // A message sent while a question waits closes that question, then goes out
  // as a new request the agent reads after it.
  const { dismissQuestion } = island;
  const submit: typeof actions.composerSubmit = dismissQuestion
    ? async (content, options) => {
        await dismissQuestion();
        return actions.composerSubmit(content, options);
      }
    : actions.composerSubmit;
  return (
    <ComposerDock
      sessionId={draftMode ? '' : String(snapshot.sessionId || '')}
      goalIsland={goalIsland}
      goalSubmissionId={submission.goalSubmissionId}
      approval={island.approval}
      islandFlash={island.islandFlash}
      quotaCard={island.quotaCard}
      quotaResume={island.quotaResume}
      onOpenSessionDiff={onOpenSessionDiff}
      onOpenAgentSession={onOpenAgentSession}
      showProjectSelector={showProjectSelector}
      contextBar={conversationContextBar(props)}
      reviewItems={submission.reviewItems}
      reviewActive={reviewActive}
      reviewBusy={Boolean(snapshot.busy || routeSnapshot.commandBusy)}
      reviewSessionId={draftMode ? '' : String(sessionAddress || routeSnapshot.sessionId || '')}
      reviewCwd={routeProject}
    >
      <Composer
        onOpenFile={props.openFile}
        turnBusy={Boolean(snapshot.busy)}
        commandBusy={!draftMode && Boolean(routeSnapshot.commandBusy)}
        transitioning={transitioning}
        focusRequest={composerFocusRequest}
        historyScope={draftMode ? `new-task:${activeProjectPath || 'local'}` : routeScope}
        identityScope={draftMode ? `draft:${draftId || 'default'}` : routeScope}
        recoveryScope={props.recoveryScope}
        projectScope={draftMode ? activeProjectPath : routeProject}
        sessionId={draftMode ? '' : String(routeSnapshot.sessionId || '')}
        hasConversation={props.hasConversation}
        promptHistoryList={routeSnapshot.promptHistoryList}
        provider={String(draftModelSelection?.provider || routeSnapshot.provider || '')}
        model={String(draftModelSelection?.model || routeSnapshot.model || '')}
        effort={String(draftModelSelection?.effort ?? routeSnapshot.effort ?? '')}
        fast={draftModelSelection?.fast ?? Boolean(routeSnapshot.fast)}
        fastCapable={Boolean(routeSnapshot.fastCapable)}
        autoEffort={draftModelSelection?.autoEffort ?? routeSnapshot.autoEffort}
        modelParameters={
          draftModelSelection?.modelParameters || (routeSnapshot.modelParameters as Record<string, string> | undefined)
        }
        contextPercent={draftModelSelection?.contextPercent ?? (Number(routeSnapshot.contextPercent) || undefined)}
        contextTokens={draftModelSelection ? draftModelSelection.contextTokens : routeContextTokens(routeSnapshot)}
        draftMode={draftMode}
        onDraftModelSelection={onDraftModelSelection}
        onRoutePreferenceApplied={onRoutePreferenceApplied}
        modelAside={contextIndicator}
        queued={submission.composerQueued}
        hiddenQueueIds={submission.pendingPromptIds}
        pendingSubmissionIds={submission.pendingPromptIds}
        onQueuedRestored={actions.composerQueuedRestored}
        promptRestore={draftMode ? null : (routeSnapshot.promptRestore ?? null)}
        userMessages={userMessages}
        submit={submit}
        placeholderOverride={dismissQuestion ? t('Sending closes the question') : undefined}
        abort={actions.composerAbort}
        invokeResult={actions.composerInvokeResult}
        applySnapshot={actions.composerApplySnapshot}
        onNewTask={actions.composerOnNewTask}
        onClearToNewTask={onClearToNewTask ? actions.composerOnClearToNewTask : undefined}
        onResumeSession={actions.composerOnResumeSession}
        onOpenSessions={actions.composerOnOpenSessions}
        onOpenProjects={actions.composerOnOpenProjects}
        onOpenSettings={actions.composerOnOpenSettings}
        onOpenCommandSurface={actions.composerOnOpenCommandSurface}
        onInherit={onInheritSession ? actions.composerOnInherit : undefined}
        paneActive={reviewActive}
        dropTargetRef={dropTargetRef}
      />
    </ComposerDock>
  );
}
