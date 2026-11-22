// The session panel's Info category (project, branch, model, workflow,
// delegation and usage, each row opening the product's own picker under it)
// and its Context category.
import {
  Activity,
  CalendarClock,
  Folder,
  FoldVertical,
  GitBranch,
  ListTree,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { type ComponentProps, useMemo, useRef, useState } from 'react';
import type { DesktopProjectSummary, DesktopSessionWorkspace } from '../shared/contract';
import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import { ServerAccountBadge, useAgentChatRouteApplied } from './ComposerFooter';
import { ComposerRouteChoices } from './composer-route-choices';
import { ComposerRoutineReadout } from './composer-routine-readout';
import { FittedReadout, usageWithCostVariants } from './composer-usage-readout';
import type { Snapshot } from './desktop-types';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { ModelSelector } from './model-controls';
import { showDesktopToast } from './notifications';
import { projectIdentity } from './project-catalog-cache';
import type { RouteSessionChoice } from './route-editor-panes';
import { ScmContextMenu, type ScmContextMenuState } from './ScmContextMenu';
import { openOnArrow, RailPickMark, RailSection } from './session-rail-parts';
import { projectMoveItems } from './session-sidebar-menus';
import { groupProjectSessions } from './session-sidebar-sections';
import { sessionProjectMove } from './session-project-move';
import { useContextUsage } from './transcript-status';
import { BranchIslandSegment } from './WorktreeIslandSegment';
import type { ComposerIslandFlash } from './ComposerIsland';

export type RailModelProps = Omit<
  ComponentProps<typeof ModelSelector>,
  'answersModelPickerRequests' | 'sheetAlign' | 'sheetPlacement' | 'sessionChoices' | 'triggerRowLabel'
>;

/** The Project row: the session menu's move, always pressable. A move the
 *  core keeps for the end of a turn shows as pending (and can be cancelled);
 *  one it could not carry out says why. */
function ProjectRow({
  sessionId,
  workspace,
  projectPath,
  projectLabel,
  projects,
  onMoveSessionToProject,
  onAddProject,
}: {
  sessionId: string;
  workspace: unknown;
  projectPath: string;
  projectLabel: string;
  projects: DesktopProjectSummary[];
  onMoveSessionToProject?: (sessionId: string, projectPath: string) => Promise<void>;
  onAddProject?: (onAdded?: (projectPath: string) => void) => void;
}) {
  const row = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<ScmContextMenuState | null>(null);
  const groups = useMemo(() => groupProjectSessions(projects, []), [projects]);
  const { pending, failed } = sessionProjectMove(workspace);
  const nameOf = (path: string | null) =>
    path ? (groups.find((group) => group.key === projectIdentity(path))?.name ?? path) : t('No project');
  const move = (id: string, path: string) => {
    void onMoveSessionToProject?.(id, path).catch((reason: unknown) =>
      showDesktopToast(errorMessageText(reason), 'error')
    );
  };
  const items = onMoveSessionToProject
    ? projectMoveItems({
        sessionId,
        groups,
        currentKey: projectIdentity(projectPath),
        moveSession: move,
        onAddProject,
      })
    : [];
  const show = () => {
    const rect = row.current?.getBoundingClientRect();
    setMenu({
      label: t('Move to project'),
      x: (rect?.left ?? 0) + 8,
      y: (rect?.bottom ?? 0) + 2,
      flipY: (rect?.top ?? 0) - 2,
      items,
    });
  };
  const pickable = items.length > 0;
  return (
    <>
      <div className="session-rail-project">
        <button
          ref={row}
          type="button"
          className="session-rail-row session-rail-pick"
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          aria-disabled={!pickable || undefined}
          title={t('Project')}
          onKeyDown={(event) => openOnArrow(event, Boolean(menu), show)}
          onClick={() => {
            if (!pickable) return;
            if (menu) setMenu(null);
            else show();
          }}
        >
          <Folder size={14} className="session-rail-ic" aria-hidden="true" />
          <span className="sr-only">{t('Project')}</span>
          <span className="session-rail-cut">{projectLabel || t('No project')}</span>
          {pending && (
            <span className="session-rail-num session-rail-cut" data-pending="true">
              {t('Moving to {{project}} after this turn', { project: nameOf(pending.projectPath) })}
            </span>
          )}
          <RailPickMark />
        </button>
        {pending && (
          <button
            type="button"
            className="session-rail-icon"
            aria-label={t('Cancel move')}
            title={t('Cancel move')}
            // The session's own project again ('' for a task session) drops the pending move.
            onClick={() => move(sessionId, projectPath)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {failed && !pending && (
        <p className="session-rail-note" data-tone="warning" role="status">
          {failed.message}
        </p>
      )}
      <ScmContextMenu state={menu} onClose={() => setMenu(null)} anchorRef={row} />
    </>
  );
}

/** A Workflow or Delegation row: the route label's own choices, under the row. */
function ChoiceRow({ choice }: { choice: RouteSessionChoice }) {
  const row = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const Icon = choice.id === 'orchestration-mode' ? Users : Workflow;
  return (
    <>
      <button
        ref={row}
        type="button"
        className="session-rail-row session-rail-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-disabled={choice.disabled || undefined}
        title={choice.label}
        onKeyDown={(event) => openOnArrow(event, open, () => !choice.disabled && setOpen(true))}
        onClick={() => {
          if (!choice.disabled) setOpen(!open);
        }}
      >
        <Icon size={14} className="session-rail-ic" aria-hidden="true" />
        <span className="sr-only">{choice.label}</span>
        <span className="session-rail-cut">{choice.valueLabel}</span>
        <RailPickMark />
      </button>
      {open && (
        <ComposerRouteChoices
          anchor={row}
          choices={[choice]}
          side="below"
          align="start"
          onClose={(restoreFocus) => {
            setOpen(false);
            if (restoreFocus) row.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

export function InfoSection({
  open,
  onToggle,
  snapshot,
  sessionId,
  workspace,
  projectPath,
  projectLabel,
  projects,
  locked,
  agentMode,
  answersModelPickerRequests,
  model,
  sessionChoices,
  onViewChanges,
  onFlash,
  onMoveSessionToProject,
  onAddProject,
  onOpenCommandSurface,
}: {
  open: boolean;
  onToggle(): void;
  /** The lane's header view: context and usage. */
  snapshot: Snapshot;
  sessionId: string;
  workspace: DesktopSessionWorkspace | null;
  projectPath: string;
  projectLabel: string;
  projects: DesktopProjectSummary[];
  locked: boolean;
  agentMode: boolean;
  /** Only the column answers requestOpenModelPicker (the composer's pill is gone then). */
  answersModelPickerRequests: boolean;
  model: RailModelProps;
  sessionChoices: RouteSessionChoice[];
  onViewChanges?: () => void;
  onFlash(flash: ComposerIslandFlash): void;
  onMoveSessionToProject?: (sessionId: string, projectPath: string) => Promise<void>;
  onAddProject?: (onAdded?: (projectPath: string) => void) => void;
  onOpenCommandSurface(surface: 'context' | 'stats'): void;
}) {
  const routeApplied = useAgentChatRouteApplied(model.onRoutePreferenceApplied, model.sessionId, agentMode);
  // What the composer's footer shows for this kind of session: a bot's home
  // thread and a group room read their routines instead of coding usage, and
  // a room's members each run their own model (no model, no context).
  const routines = Boolean(agentIdOfHomeSession(sessionId) || roomIdOfSession(sessionId));
  const room = Boolean(roomIdOfSession(sessionId));
  return (
    <RailSection
      category="info"
      title={t('Info')}
      open={open}
      onToggle={onToggle}
      summary={<span className="session-rail-cut">{projectLabel || t('No project')}</span>}
    >
      <ProjectRow
        sessionId={sessionId}
        workspace={workspace}
        projectPath={projectPath}
        projectLabel={projectLabel}
        projects={projects}
        onMoveSessionToProject={onMoveSessionToProject}
        onAddProject={onAddProject}
      />
      {!agentMode && (
        <BranchIslandSegment
          sessionId={sessionId}
          workspace={workspace}
          projectPath={projectPath}
          locked={locked}
          onViewChanges={onViewChanges}
          onFlash={onFlash}
          renderTrigger={(button, view) => (
            <button
              {...button}
              type="button"
              className="session-rail-row session-rail-pick"
              onKeyDown={(event) => openOnArrow(event, button['aria-expanded'], button.onClick)}
            >
              <GitBranch size={14} className="session-rail-ic" aria-hidden="true" />
              <span className="sr-only">{t('Branch')}</span>
              <span className="session-rail-cut">{view.branch}</span>
              <RailPickMark />
            </button>
          )}
        />
      )}
      {!room && (
        <div className="session-rail-model">
          <ModelSelector
            {...model}
            onRoutePreferenceApplied={routeApplied}
            answersModelPickerRequests={answersModelPickerRequests}
            sheetAlign="start"
            sheetPlacement="below"
            triggerRowLabel={t('Model')}
          />
          <ServerAccountBadge />
        </div>
      )}
      {sessionChoices.map((choice) => (
        <ChoiceRow key={choice.id} choice={choice} />
      ))}
      {routines ? (
        <div className="session-rail-row session-rail-usage" title={t('Routines')}>
          <CalendarClock size={14} className="session-rail-ic" aria-hidden="true" />
          <span className="sr-only">{t('Routines')}</span>
          <ComposerRoutineReadout sessionId={sessionId} hidden={!open} />
        </div>
      ) : (
        <button
          type="button"
          className="session-rail-row session-rail-usage"
          title={t('Open usage')}
          onClick={() => onOpenCommandSurface('stats')}
        >
          <Activity size={14} className="session-rail-ic" aria-hidden="true" />
          <span className="sr-only">{t('Usage')}</span>
          <FittedReadout variants={usageWithCostVariants(snapshot)} title={t('Session usage')} />
        </button>
      )}
    </RailSection>
  );
}

/** The Context category: how full the window is, as its figures and a bar,
 *  with the gauge's two actions. Absent before the session has a reading. */
export function ContextSection({
  open,
  onToggle,
  snapshot,
  onViewDetails,
}: {
  open: boolean;
  onToggle(): void;
  snapshot: Snapshot;
  onViewDetails(): void;
}) {
  const usage = useContextUsage(snapshot);
  if (usage.percent === null) return null;
  return (
    <RailSection
      category="context"
      title={t('Context')}
      count={
        <span className="session-rail-context-percent" data-tone={usage.tone || undefined}>
          {`${usage.percent}%`}
        </span>
      }
      meta={usage.text ? <span title={usage.title}>{usage.text}</span> : undefined}
      open={open}
      onToggle={onToggle}
      foot={
        <>
          <button
            type="button"
            className="composer-island-button"
            disabled={usage.compactBusy}
            onClick={() => void usage.compact()}
          >
            <FoldVertical size={14} aria-hidden="true" />
            <span>{t('Compact context')}</span>
          </button>
          <span className="session-rail-ft-end">
            <button type="button" className="composer-island-button" onClick={onViewDetails}>
              <ListTree size={14} aria-hidden="true" />
              <span>{t('View context details')}</span>
            </button>
          </span>
        </>
      }
    >
      <div
        className="session-rail-meter"
        data-tone={usage.tone || undefined}
        role="meter"
        aria-label={t('Context usage')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage.percent}
      >
        <i style={{ width: `${Math.min(100, usage.percent)}%` }} />
      </div>
    </RailSection>
  );
}
