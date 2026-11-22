// The session panel's body: the session's state and actions as categories,
// drawn into the pane's panel (SessionRailColumn) from the conversation.
import type { DesktopProjectSummary, DesktopSessionWorkspace } from '../shared/contract';
import { roomIdOfSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { ComposerIslandFlash } from './ComposerIsland';
import { useSessionJobs } from './ComposerIsland';
import { useSessionDiffOpeners, useTurnReviewBar } from './ComposerDock';
import type { TranscriptItem } from './desktop-types';
import { showDesktopToast } from './notifications';
import type { RouteSessionChoice } from './route-editor-panes';
import { SessionGoalHost } from './session-goal-submission';
import { ChangesSection } from './session-rail-changes';
import { useFoldedModelPickerRequest, useSessionRailFolds } from './session-rail-folds';
import { GoalSection, TodoSection } from './session-rail-goal';
import { InfoSection, type RailModelProps } from './session-rail-info';
import { AgentsSection, ShellsSection } from './session-rail-jobs';
import { markSessionRailPress } from './session-rail-layout';
import { WorktreesSection } from './session-rail-worktrees';
import { useSessionGoal } from './SessionGoalIsland';

export type SessionRailProps = {
  /** The pane's session (its lane's header view). */
  sessionId: string;
  /** The session's route address (its Changes and diffs). */
  reviewSessionId: string;
  workspace: DesktopSessionWorkspace | null;
  /** The session's project ('' for a task session) and its name. */
  projectPath: string;
  projectLabel: string;
  /** The folder the session works in (its Changes and branch reads). */
  routeProject: string;
  projects: DesktopProjectSummary[];
  agentMode: boolean;
  /** The panel is a column: its Model row answers requestOpenModelPicker. */
  column: boolean;
  goalSubmissionId: string;
  reviewItems: TranscriptItem[];
  reviewActive: boolean;
  reviewBusy: boolean;
  pendingInput: boolean;
  model: RailModelProps;
  sessionChoices: RouteSessionChoice[];
  onOpenSessionDiff?: () => void;
  onOpenAgentSession?: (sessionId: string, title: string, ownerSessionId: string) => void;
  onMoveSessionToProject?: (sessionId: string, projectPath: string) => Promise<void>;
  onAddProject?: (onAdded?: (projectPath: string) => void) => void;
  onOpenCommandSurface(surface: 'context' | 'stats'): void;
};

const flashToast = (flash: ComposerIslandFlash) => showDesktopToast(flash.text, 'info');

function SessionRailCategories(props: SessionRailProps) {
  const { sessionId, reviewSessionId, workspace, routeProject, agentMode } = props;
  const jobs = useSessionJobs(sessionId);
  const { snapshot } = jobs;
  const folds = useSessionRailFolds(reviewSessionId || sessionId);
  const goal = useSessionGoal(snapshot);
  const TurnReviewBar = useTurnReviewBar();
  const { openChanges, openChangeFile } = useSessionDiffOpeners(reviewSessionId, props.onOpenSessionDiff);
  // No branch or worktree switch while anything of the session still works (the island's rule).
  const locked =
    props.reviewBusy ||
    props.pendingInput ||
    jobs.shellCount > 0 ||
    jobs.agentRows.some((row) => !row.finished);
  const refreshKey = [
    Boolean(snapshot.busy),
    Boolean(snapshot.commandBusy),
    workspace?.revision ?? '',
    workspace?.cwd ?? '',
  ].join(':');
  const gitCwd = workspace?.cwd || routeProject;
  const fold = (category: Parameters<typeof folds.toggle>[0]) => ({
    open: folds.isOpen(category),
    onToggle: () => folds.toggle(category),
  });
  // A group room shows no model (each member runs its own), here as under the composer.
  const answersModelPicker = props.column && props.reviewActive && !roomIdOfSession(reviewSessionId || sessionId);
  useFoldedModelPickerRequest(answersModelPicker, folds.isOpen('info'), () => folds.toggle('info'));
  return (
    <>
      <InfoSection
        {...fold('info')}
        snapshot={snapshot}
        sessionId={reviewSessionId || sessionId}
        workspace={workspace}
        projectPath={props.projectPath}
        projectLabel={props.projectLabel}
        projects={props.projects}
        locked={locked}
        agentMode={agentMode}
        answersModelPickerRequests={answersModelPicker}
        model={props.model}
        sessionChoices={props.sessionChoices}
        onViewChanges={openChanges}
        onFlash={flashToast}
        onMoveSessionToProject={props.onMoveSessionToProject}
        onAddProject={props.onAddProject}
        onOpenCommandSurface={props.onOpenCommandSurface}
      />
      <GoalSection model={goal} {...fold('goal')} />
      <TodoSection model={goal} folds={folds} {...fold('todo')} />
      <AgentsSection
        {...fold('agents')}
        sessionId={sessionId}
        agents={jobs.agentRows}
        shellKeys={jobs.shellKeys}
        onOpenSession={props.onOpenAgentSession}
      />
      <ShellsSection {...fold('shells')} sessionId={sessionId} shells={jobs.jobRows} shellKeys={jobs.shellKeys} />
      {!agentMode && (
        <WorktreesSection
          {...fold('worktrees')}
          sessionId={reviewSessionId || sessionId}
          workspace={workspace}
          projectPath={routeProject}
          locked={locked}
          refreshKey={refreshKey}
          onFlash={flashToast}
        />
      )}
      {!agentMode && TurnReviewBar && (
        <TurnReviewBar
          variant="segment"
          items={props.reviewItems}
          active={props.reviewActive}
          busy={props.reviewBusy}
          sessionId={reviewSessionId}
          cwd={routeProject}
          onOpenChanges={openChanges}
          onOpenChangeFile={openChangeFile}
          renderSegment={(view) => (
            <ChangesSection
              {...fold('changes')}
              view={view}
              cwd={gitCwd}
              onOpenChanges={openChanges}
              onOpenChangeFile={openChangeFile}
            />
          )}
        />
      )}
    </>
  );
}

/** The panel's categories, in order, each absent when it has nothing. */
export default function SessionRail(props: SessionRailProps) {
  return (
    // Its menus portal to the document body: a press in them is still a press in the panel.
    <div className="session-rail-content" onPointerDownCapture={(event) => markSessionRailPress(event.nativeEvent)}>
      <SessionGoalHost submissionId={props.goalSubmissionId}>
        <SessionRailCategories {...props} />
      </SessionGoalHost>
    </div>
  );
}
