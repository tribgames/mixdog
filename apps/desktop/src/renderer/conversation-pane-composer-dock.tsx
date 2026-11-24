import { type ComponentProps, type RefObject, useContext, useMemo } from 'react';
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
import { PaneHandOverContext, sessionRailPlace, useSessionRailSlot } from './session-rail-layout';
import { useSurfaceActive } from './surface-activity';
import { deferredModule, useDeferredModule } from './deferred-module';

// The panel's categories load with the first panel offered; until they have,
// the composer keeps the island and the controls the panel would take.
const sessionRailModule = deferredModule(() => import('./SessionRail'));

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
  // The pane's session panel draws the session or draft the pane shows, from
  // its on-screen conversation only (sessionRailPlace); it takes that
  // conversation's island and the controls under its composer.
  const railSlot = useSessionRailSlot(props.paneLeafId ?? '');
  const onScreen = useSurfaceActive();
  const handOver = useContext(PaneHandOverContext);
  const SessionRail = useDeferredModule(sessionRailModule, { load: Boolean(railSlot.element) })?.default;
  const railPlace = SessionRail
    ? sessionRailPlace(railSlot, {
        sessionId: draftMode ? '' : reviewSessionId,
        draftId: draftMode ? draftId : '',
        onScreen,
        handOver,
      })
    : { host: null, taken: false };
  const railHost = railPlace.host;
  const contextControls = Boolean(showProjectSelector) && !agentMode;
  const railShown = railPlace.taken;
  return (
    <>
      {SessionRail &&
        railHost &&
        createPortal(
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
              onDraftModelSelection: draftMode ? onDraftModelSelection : undefined,
              onRoutePreferenceApplied,
            }}
            sessionChoices={sessionChoices}
            onOpenSessionDiff={onOpenSessionDiff}
            onOpenAgentSession={onOpenAgentSession}
            onMoveSessionToProject={props.onMoveSessionToProject}
            onAddProject={props.onAddProject}
            onOpenCommandSurface={actions.composerOnOpenCommandSurface}
            draft={
              draftMode
                ? {
                    draftId,
                    contextControls,
                    projectDisabled: transitioning || Boolean(snapshot.busy),
                    routeDisabled: transitioning,
                    workflow: props.draftWorkflow ?? null,
                    orchestrationMode: props.draftOrchestrationMode ?? null,
                    onClearProject: props.onClearProject,
                    onSelectProject: props.onSelectProject,
                    onWorkflow: props.onDraftWorkflow,
                    onOrchestrationMode: props.onDraftOrchestrationMode,
                  }
                : undefined
            }
          />,
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
        islandHidden={railShown}
      >
        <Composer
          onOpenFile={props.openFile}
          turnBusy={Boolean(snapshot.busy)}
          commandBusy={!draftMode && Boolean(routeSnapshot.commandBusy)}
          transitioning={transitioning}
          focusRequest={composerFocusRequest}
          historyScope={draftMode ? `new-task:${activeProjectPath || 'local'}` : routeScope}
          // The pane's session from its first frame: until its lane is read the route
          // falls back to a scope every such pane shares.
          identityScope={draftMode ? `draft:${draftId || 'default'}` : sessionAddress || routeScope}
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
          // Before the first message the pickers stand in for the readout; the panel's Info rows, while it shows.
          contextBar={
            contextControls && !railShown ? (
              <div className="composer-model-line-context">{conversationContextBar(props)}</div>
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
