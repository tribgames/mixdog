import { type ComponentProps, lazy, type RefObject, Suspense, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { BranchChip } from './BranchChip';
import { Composer, OrchestrationModeSelect, WorkflowSelect } from './Composer';
import { useSessionRouteChoices } from './model-controls';
import { ComposerContextChips } from './composer-context-chips';
import { ProjectContextSelector } from './composer-support';
import { ComposerDock } from './ComposerDock';
import type { ConversationProps } from './conversation-pane-props';
import { useComposerUserMessages } from './conversation-pane-user-messages';
import type { RecordValue, Snapshot, TranscriptItem } from './desktop-types';
import type { ConversationIsland } from './use-conversation-island';
import type { ConversationSubmission } from './use-conversation-submission';
import { useSessionInfoDisplay } from './pane-side-dock-hooks';
import { draftRailOwner, sessionRailHost, useSessionRailSlot } from './session-rail-layout';
import type { DraftRailContext } from './session-rail-info';
import { useSurfaceActive } from './surface-activity';

// The panel's categories load with the first panel shown, as the island's Goal does.
const SessionRail = lazy(() => import('./SessionRail'));

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
  | 'draftWorkflow'
  | 'onDraftWorkflow'
  | 'draftOrchestrationMode'
  | 'onDraftOrchestrationMode'
  | 'draftModelSelection'
  | 'onDraftModelSelection'
  | 'onRoutePreferenceApplied'
  | 'contextIndicator'
  | 'usageReadout'
  | 'goalIsland'
  | 'onOpenSessionDiff'
  | 'onOpenAgentSession'
  | 'onClearToNewTask'
  | 'onInheritSession'
  | 'onMoveSessionToProject'
  | 'onAddProject'
  | 'paneLeafId'
> & {
  draftMode: boolean;
  draftId: string;
  /** Agent mode: no coding chrome (branch, files, PR, workspace chips) and
   *  the one-line messenger composer. */
  agentMode?: boolean;
  reviewActive: boolean;
  dropTargetRef: RefObject<HTMLElement | null>;
  routeProject: string;
  island: ConversationIsland;
  submission: Pick<
    ConversationSubmission,
    'goalSubmissionId' | 'reviewItems' | 'steerItems' | 'pendingPromptIds' | 'holdSlashCommand' | 'actions'
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

/** What the New Task context bar's pickers act on: project, workflow,
 *  delegation and branch. The session panel's draft Info rows take the same. */
function conversationDraftContext({
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
  draftWorkflow,
  onDraftWorkflow,
  draftOrchestrationMode,
  onDraftOrchestrationMode,
  submission: { actions },
}: ConversationComposerDockProps): DraftRailContext {
  const routeBusy = !draftMode && Boolean(routeSnapshot.busy || routeSnapshot.commandBusy);
  return {
    project: {
      projects,
      activePath: activeProjectPath,
      activeLabel: activeProjectLabel,
      disabled: transitioning || Boolean(snapshot.busy),
      onClear: onClearProject,
      onSelect: onSelectProject,
    },
    workflow: {
      workflow: (draftWorkflow || (routeSnapshot.workflow as RecordValue | null)) ?? null,
      disabled: transitioning || routeBusy,
      invokeResult: actions.composerInvokeResult,
      applySnapshot: actions.composerApplySnapshot,
      onDraftChange: onDraftWorkflow,
    },
    delegation: {
      mode: draftOrchestrationMode ?? (draftMode ? null : routeSnapshot.orchestrationMode),
      disabled: transitioning || routeBusy,
      invokeResult: actions.composerInvokeResult,
      applySnapshot: actions.composerApplySnapshot,
      onDraftChange: onDraftOrchestrationMode,
    },
    // Branch/worktree is picked in a New Task's context bar only.
    branch: {
      sessionId: draftMode ? '' : String(routeSnapshot.sessionId || ''),
      draftId,
      projectPath: draftMode ? activeProjectPath : routeProject,
      disabled: transitioning || routeBusy,
      refreshKey: [
        Boolean(routeSnapshot.busy),
        Boolean(routeSnapshot.commandBusy),
        routeSnapshot.workspace?.revision ?? '',
        routeSnapshot.workspace?.cwd ?? '',
      ].join(':'),
    },
  };
}

/** The New Task context bar: project, workflow, delegation and branch. */
function conversationContextBar(context: DraftRailContext) {
  return (
    <ComposerContextChips
      project={<ProjectContextSelector {...context.project} />}
      workflow={<WorkflowSelect {...context.workflow} />}
      delegation={<OrchestrationModeSelect {...context.delegation} />}
      branch={<BranchChip {...context.branch} />}
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
    agentMode = false,
    reviewActive,
    transitioning,
    composerFocusRequest,
    activeProjectPath,
    showProjectSelector,
    draftModelSelection,
    onDraftModelSelection,
    onRoutePreferenceApplied,
    contextIndicator,
    usageReadout,
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
  const { wrapSubmit } = island;
  const submit = useMemo(() => wrapSubmit(actions.composerSubmit), [wrapSubmit, actions.composerSubmit]);
  const sessionChoices = useSessionRouteChoices({
    sessionId: draftMode || agentMode ? '' : String(routeSnapshot.sessionId || ''),
    workflow: (routeSnapshot.workflow as RecordValue | null) ?? null,
    mode: routeSnapshot.orchestrationMode,
    pendingWorkflow: routeSnapshot.pendingWorkflowSwitch === true,
    pendingMode: routeSnapshot.pendingOrchestrationModeSwitch === true,
    disabled: transitioning || Boolean(routeSnapshot.commandBusy),
    invokeResult: actions.composerInvokeResult,
    applySnapshot: actions.composerApplySnapshot,
  });
  const modelAside = contextIndicator;
  const route = {
    provider: String(draftModelSelection?.provider || routeSnapshot.provider || ''),
    model: String(draftModelSelection?.model || routeSnapshot.model || ''),
    effort: String(draftModelSelection?.effort ?? routeSnapshot.effort ?? ''),
    fast: draftModelSelection?.fast ?? Boolean(routeSnapshot.fast),
    fastCapable: Boolean(routeSnapshot.fastCapable),
    autoEffort: draftModelSelection?.autoEffort ?? routeSnapshot.autoEffort,
    modelParameters:
      draftModelSelection?.modelParameters || (routeSnapshot.modelParameters as Record<string, string> | undefined),
    // A draft's route carries its own model's context (or none): the
    // snapshot's belongs to whatever model the engine last ran.
    contextPercent: draftModelSelection
      ? draftModelSelection.contextPercent
      : Number(routeSnapshot.contextPercent) || undefined,
    contextTokens: draftModelSelection ? draftModelSelection.contextTokens : routeContextTokens(routeSnapshot),
  };
  const routeSessionId = draftMode ? '' : String(routeSnapshot.sessionId || '');
  const reviewSessionId = draftMode ? '' : String(sessionAddress || routeSnapshot.sessionId || '');
  const pendingInput = !draftMode && submission.steerItems.length > 0;
  const reviewBusy = Boolean(snapshot.busy || routeSnapshot.commandBusy);
  // The pane's session panel draws the session the pane shows, from its
  // on-screen conversation only (sessionRailHost); it takes that
  // conversation's island and the controls under its composer.
  const railSlot = useSessionRailSlot(props.paneLeafId ?? '');
  const onScreen = useSurfaceActive();
  // A New Task's panel carries the pickers of its context bar instead.
  const contextPickers = showProjectSelector && !agentMode;
  const draftContext = contextPickers ? conversationDraftContext(props) : null;
  const railHost = sessionRailHost(railSlot, {
    sessionId: draftMode ? (contextPickers ? draftRailOwner(draftId) : '') : reviewSessionId,
    onScreen,
  });
  const railShown = Boolean(railHost);
  // Settings → Session info: Hidden draws neither the panel nor the island.
  const islandOff = useSessionInfoDisplay() === 'none';
  return (
    <>
      {railHost &&
        createPortal(
          <Suspense fallback={null}>
            <SessionRail
              sessionId={draftMode ? '' : String(snapshot.sessionId || '')}
              reviewSessionId={reviewSessionId}
              workspace={routeSnapshot.workspace ?? null}
              projectPath={activeProjectPath}
              projectLabel={props.activeProjectLabel}
              routeProject={routeProject}
              projects={props.projects}
              agentMode={agentMode}
              goalSubmissionId={submission.goalSubmissionId}
              reviewItems={submission.reviewItems}
              reviewActive={reviewActive}
              reviewBusy={reviewBusy}
              pendingInput={pendingInput}
              model={{
                ...route,
                sessionId: routeSessionId,
                modelDisabled: transitioning,
                tuningDisabled: Boolean(routeSnapshot.commandBusy) || transitioning,
                invokeResult: actions.composerInvokeResult,
                applySnapshot: actions.composerApplySnapshot,
                onOpenSettings: actions.composerOnOpenSettings,
                onRoutePreferenceApplied,
              }}
              sessionChoices={sessionChoices}
              onOpenSessionDiff={onOpenSessionDiff}
              onOpenAgentSession={onOpenAgentSession}
              onMoveSessionToProject={props.onMoveSessionToProject}
              onAddProject={props.onAddProject}
              onOpenCommandSurface={actions.composerOnOpenCommandSurface}
              draft={draftMode && draftContext ? draftContext : undefined}
            />
          </Suspense>,
          railHost
        )}
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
      workspace={draftMode ? null : (routeSnapshot.workspace ?? null)}
      pendingInput={pendingInput}
      showProjectSelector={showProjectSelector && !agentMode}
      agentMode={agentMode}
      reviewItems={submission.reviewItems}
      reviewActive={reviewActive}
      reviewBusy={reviewBusy}
      reviewSessionId={reviewSessionId}
      reviewCwd={routeProject}
      islandHidden={railShown || islandOff}
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
        sessionId={routeSessionId}
        hasConversation={props.hasConversation}
        promptHistoryList={routeSnapshot.promptHistoryList}
        {...route}
        bare={railShown}
        draftMode={draftMode}
        onDraftModelSelection={onDraftModelSelection}
        onRoutePreferenceApplied={onRoutePreferenceApplied}
        modelAside={modelAside}
        sessionChoices={sessionChoices}
        // Before the first message the pickers stand in for the readout.
        contextBar={
          draftContext && !railShown ? (
            <div className="composer-model-line-context">{conversationContextBar(draftContext)}</div>
          ) : undefined
        }
        usageReadout={draftMode ? undefined : usageReadout}
        agentMode={agentMode}
        steerItems={submission.steerItems}
        pendingSubmissionIds={submission.pendingPromptIds}
        onQueuedRestored={actions.composerQueuedRestored}
        onSlashHeld={submission.holdSlashCommand}
        promptRestore={draftMode ? null : (routeSnapshot.promptRestore ?? null)}
        userMessages={userMessages}
        submit={submit}
        placeholderOverride={island.answerHint}
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
    </>
  );
}
