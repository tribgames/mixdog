// The session panel's body: the session's state and actions as categories,
// each a section of its own in the order the user arranged, drawn into the
// pane's panel (SessionRailCard) from the conversation.
import { Fragment, type ReactNode, useRef } from 'react';
import type { DesktopProjectSummary, DesktopSessionWorkspace } from '../shared/contract';
import { roomIdOfSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import type { ComposerIslandFlash } from './ComposerIsland';
import { useSessionJobs } from './ComposerIsland';
import { useSessionDiffOpeners, useTurnReviewBar } from './ComposerDock';
import type { TranscriptItem } from './desktop-types';
import { showDesktopToast } from './notifications';
import type { RouteSessionChoice } from './route-editor-panes';
import { useSessionChangesSettled } from './session-changes-store';
import { SessionGoalHost } from './session-goal-submission';
import { ChangesSection, GitSection } from './session-rail-changes';
import {
  SESSION_RAIL_DRAFT_FOLDS,
  type SessionRailCategory,
  useFoldedModelPickerRequest,
  useSessionRailFolds,
  useSessionRailOrder,
} from './session-rail-folds';
import { GoalSection, TodoSection } from './session-rail-goal';
import {
  ContextSection,
  DraftInfoSection,
  type DraftRailInfo,
  InfoSection,
  type RailModelProps,
} from './session-rail-info';
import { AgentsSection, ShellsSection } from './session-rail-jobs';
import { useSessionRailMotion } from './session-rail-motion';
import { OutputsSection } from './session-rail-outputs';
import { sessionRailDragging } from './session-rail-parts';
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
  /** A New Task draft (no session yet): the panel holds its Info alone. */
  draft?: DraftRailInfo;
};

const flashToast = (flash: ComposerIslandFlash) => showDesktopToast(flash.text, 'info');

function SessionRailContent({
  session,
  settling,
  children,
}: {
  session: string;
  settling: boolean;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  useSessionRailMotion(content, session, settling);
  return (
    // A section let go between two sections is still a drop: the order it was dragged to stays.
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop drop target for rail section reordering
    <div
      ref={content}
      className="session-rail-content"
      onDragOver={(event) => {
        if (sessionRailDragging()) event.preventDefault();
      }}
      onDrop={(event) => {
        if (sessionRailDragging()) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}

function SessionRailCategories(props: SessionRailProps) {
  const { sessionId, reviewSessionId, workspace, routeProject, agentMode } = props;
  const activeSessionId = reviewSessionId || sessionId;
  const jobs = useSessionJobs(activeSessionId);
  const { snapshot } = jobs;
  const folds = useSessionRailFolds(activeSessionId);
  const goal = useSessionGoal(snapshot);
  const TurnReviewBar = useTurnReviewBar();
  const { openChanges, openChangeFile } = useSessionDiffOpeners(activeSessionId, props.onOpenSessionDiff);
  // No branch or worktree switch while anything of the session still works (the island's rule).
  const locked =
    props.reviewBusy || props.pendingInput || jobs.shellCount > 0 || jobs.agentRows.some((row) => !row.finished);
  const gitCwd = workspace?.cwd || routeProject;
  const changesEnabled = !agentMode && Boolean(gitCwd) && props.reviewActive;
  const changesSettled = useSessionChangesSettled(gitCwd, activeSessionId, changesEnabled);
  const laneSettled = !activeSessionId || Boolean(snapshot.sessionId);
  const settling = !laneSettled || (changesEnabled && (!TurnReviewBar || !changesSettled));
  const fold = (category: Parameters<typeof folds.toggle>[0]) => ({
    open: folds.isOpen(category),
    onToggle: () => folds.toggle(category),
  });
  // A group room shows no model and no context (each member runs its own), here as under the composer.
  const room = Boolean(roomIdOfSession(activeSessionId));
  // The composer beside the panel is bare: the panel's Model row answers requestOpenModelPicker.
  const answersModelPicker = props.reviewActive && !room;
  useFoldedModelPickerRequest(answersModelPicker, folds.isOpen('info'), () => folds.toggle('info'));
  const order = useSessionRailOrder();
  // Each category absent when it has nothing; drawn in the user's order, so focus follows what is seen.
  const sections: Record<SessionRailCategory, ReactNode> = {
    info: (
      <InfoSection
        {...fold('info')}
        snapshot={snapshot}
        sessionId={activeSessionId}
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
    ),
    context: !room && (
      <ContextSection
        {...fold('context')}
        snapshot={snapshot}
        onViewDetails={() => props.onOpenCommandSurface('context')}
      />
    ),
    goal: <GoalSection model={goal} {...fold('goal')} />,
    todo: <TodoSection model={goal} folds={folds} {...fold('todo')} />,
    agents: (
      <AgentsSection
        {...fold('agents')}
        sessionId={activeSessionId}
        agents={jobs.agentRows}
        poolRows={jobs.poolRows}
        busy={Boolean(snapshot.busy)}
        shellKeys={jobs.shellKeys}
        onOpenSession={props.onOpenAgentSession}
      />
    ),
    shells: (
      <ShellsSection {...fold('shells')} sessionId={activeSessionId} shells={jobs.jobRows} shellKeys={jobs.shellKeys} />
    ),
    outputs: <OutputsSection {...fold('outputs')} sessionId={activeSessionId} />,
    changes: !agentMode && TurnReviewBar && (
      <TurnReviewBar
        variant="segment"
        items={props.reviewItems}
        active={props.reviewActive}
        busy={props.reviewBusy}
        sessionId={activeSessionId}
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
    ),
    git: !agentMode && <GitSection {...fold('git')} sessionId={activeSessionId} cwd={gitCwd} />,
  };
  return (
    <SessionRailContent session={activeSessionId} settling={settling}>
      {order.map((category) => (
        <Fragment key={category}>{sections[category]}</Fragment>
      ))}
    </SessionRailContent>
  );
}

/** A draft's panel: its Info, folded and asking for the model picker as a session's does. */
function DraftRailCategories({ draft, ...props }: SessionRailProps & { draft: DraftRailInfo }) {
  const folds = useSessionRailFolds(SESSION_RAIL_DRAFT_FOLDS);
  useFoldedModelPickerRequest(props.reviewActive, folds.isOpen('info'), () => folds.toggle('info'));
  return (
    <SessionRailContent session={`new:${draft.draftId}`} settling={false}>
      <DraftInfoSection
        open={folds.isOpen('info')}
        onToggle={() => folds.toggle('info')}
        draft={draft}
        projectPath={props.projectPath}
        projectLabel={props.projectLabel}
        projects={props.projects}
        answersModelPickerRequests={props.reviewActive}
        model={props.model}
        onAddProject={props.onAddProject}
      />
    </SessionRailContent>
  );
}

/** The panel's categories, in order, each absent when it has nothing. */
export default function SessionRail(props: SessionRailProps) {
  const { draft } = props;
  return (
    <SessionGoalHost submissionId={props.goalSubmissionId}>
      {draft ? <DraftRailCategories {...props} draft={draft} /> : <SessionRailCategories {...props} />}
    </SessionGoalHost>
  );
}
