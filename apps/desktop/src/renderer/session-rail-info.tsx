// The session panel's Info category (project, branch, model, workflow,
// delegation and usage, each row opening the composer's own picker as a popup
// under it) and its Context category.
import { Activity, CalendarClock, Folder, FoldVertical, GitBranch, ListTree, Users, Workflow, X } from 'lucide-react';
import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DesktopOrchestrationMode,
  DesktopProjectSummary,
  DesktopSessionWorkspace,
  DesktopWorkflowState,
} from '../shared/contract';
import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import { ServerAccountBadge, useAgentChatRouteApplied } from './ComposerFooter';
import { ComposerRouteChoices } from './composer-route-choices';
import { ComposerRoutineReadout } from './composer-routine-readout';
import { compactTokens, contextMix, isAgentSession } from './ContextBody';
import { projectContextChoice } from './composer-support';
import { FittedReadout, usageWithCostVariants } from './composer-usage-readout';
import type { Snapshot } from './desktop-types';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { BranchChip } from './BranchChip';
import { ModelSelector, useDraftRouteChoices } from './model-controls';
import { showDesktopToast } from './notifications';
import { OpenSelect } from './OpenSelect';
import { projectIdentity } from './project-catalog-cache';
import { RendererLruCache } from './renderer-lru-cache';
import type { RouteSessionChoice } from './route-editor-panes';
import { openOnArrow, RailPickMark, RailSection } from './session-rail-parts';
import { groupProjectSessions } from './session-sidebar-sections';
import { sessionProjectMove } from './session-project-move';
import { useContextUsage } from './transcript-status';
import { BranchIslandSegment } from './WorktreeIslandSegment';
import type { ComposerIslandFlash } from './ComposerIsland';

export type RailModelProps = Omit<
  ComponentProps<typeof ModelSelector>,
  'answersModelPickerRequests' | 'sheetAlign' | 'sheetPlacement' | 'sessionChoices' | 'triggerRowLabel'
>;

const NEW_PROJECT = '\u0000new-project';

/** The Project row: the composer's project select as a row of the panel (no
 *  project, a project and, where adding is offered, a new one). */
function RailProjectSelect({
  projects,
  projectPath,
  projectLabel,
  disabled = false,
  trailing,
  onClear,
  onSelect,
  onAddProject,
}: {
  projects: DesktopProjectSummary[];
  projectPath: string;
  projectLabel: string;
  disabled?: boolean;
  trailing?: ReactNode;
  onClear(): void;
  onSelect(path: string): void;
  onAddProject?: (onAdded?: (projectPath: string) => void) => void;
}) {
  const choice = projectContextChoice({
    projects,
    activePath: projectPath,
    activeLabel: projectLabel,
    onClear,
    onSelect,
  });
  const options = onAddProject
    ? [...choice.options, { value: NEW_PROJECT, label: t('New project…'), separatorBefore: true }]
    : choice.options;
  return (
    <OpenSelect
      className="session-rail-select"
      menuWidth="anchor"
      ariaLabel={t('Project')}
      tooltip={t('Select project')}
      leading={<Folder size={14} aria-hidden="true" />}
      trailing={trailing}
      value={choice.value}
      displayValue={choice.label || t('No project')}
      disabled={disabled}
      options={options}
      onChange={(next) => (next === NEW_PROJECT ? onAddProject?.(onSelect) : choice.pick(next))}
    />
  );
}

/** A session's Project row: a pick moves the session. A move the core keeps
 *  for the end of a turn shows as pending (and can be cancelled); one it
 *  could not carry out says why. */
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
  const groups = useMemo(() => groupProjectSessions(projects, []), [projects]);
  const { pending, failed } = sessionProjectMove(workspace);
  if (!onMoveSessionToProject) {
    return (
      <div className="session-rail-row" title={t('Project')}>
        <Folder size={14} className="session-rail-ic" aria-hidden="true" />
        <span className="sr-only">{t('Project')}</span>
        <span className="session-rail-cut">{projectLabel || t('No project')}</span>
      </div>
    );
  }
  const nameOf = (path: string | null) =>
    path ? (groups.find((group) => group.key === projectIdentity(path))?.name ?? path) : t('No project');
  const move = (path: string) => {
    void onMoveSessionToProject(sessionId, path).catch((reason: unknown) =>
      showDesktopToast(errorMessageText(reason), 'error')
    );
  };
  return (
    <>
      <div className="session-rail-project">
        <RailProjectSelect
          projects={projects}
          projectPath={projectPath}
          projectLabel={projectLabel}
          trailing={
            pending && (
              <span className="session-rail-num session-rail-cut" data-pending="true">
                {t('Moving to {{project}} after this turn', { project: nameOf(pending.projectPath) })}
              </span>
            )
          }
          onClear={() => move('')}
          onSelect={move}
          onAddProject={onAddProject}
        />
        {pending && (
          <button
            type="button"
            className="session-rail-icon"
            aria-label={t('Cancel move')}
            title={t('Cancel move')}
            // The session's own project again ('' for a task session) drops the pending move.
            onClick={() => move(projectPath)}
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
          width="anchor"
          onClose={(restoreFocus) => {
            setOpen(false);
            if (restoreFocus) row.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

/** The Model row: the composer's model pill, its sheet opening under the row. */
function RailModelRow({
  model,
  agentMode,
  answersModelPickerRequests,
}: {
  model: RailModelProps;
  agentMode: boolean;
  answersModelPickerRequests: boolean;
}) {
  const routeApplied = useAgentChatRouteApplied(model.onRoutePreferenceApplied, model.sessionId, agentMode);
  return (
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
  );
}

/** What a New Task draft's composer offers beside the model, for its panel. */
export type DraftRailInfo = {
  draftId: string;
  /** The context bar's project, branch, workflow and delegation (absent in agent mode, as under the composer). */
  contextControls: boolean;
  projectDisabled: boolean;
  routeDisabled: boolean;
  workflow: DesktopWorkflowState | null;
  orchestrationMode: DesktopOrchestrationMode | null;
  onClearProject(): void;
  onSelectProject(path: string): void;
  onWorkflow?(workflow: DesktopWorkflowState): void;
  onOrchestrationMode?(mode: DesktopOrchestrationMode): void;
};

/** A New Task draft's Info: what its composer offers (project, branch, model,
 *  workflow and delegation), each row changing the draft's own. */
export function DraftInfoSection({
  open,
  onToggle,
  draft,
  projectPath,
  projectLabel,
  projects,
  answersModelPickerRequests,
  model,
  onAddProject,
}: {
  open: boolean;
  onToggle(): void;
  draft: DraftRailInfo;
  projectPath: string;
  projectLabel: string;
  projects: DesktopProjectSummary[];
  answersModelPickerRequests: boolean;
  model: RailModelProps;
  onAddProject?: (onAdded?: (projectPath: string) => void) => void;
}) {
  const choices = useDraftRouteChoices({
    workflow: draft.workflow,
    mode: draft.orchestrationMode,
    disabled: draft.routeDisabled,
    onWorkflow: draft.onWorkflow,
    onMode: draft.onOrchestrationMode,
  });
  return (
    <RailSection
      category="info"
      title={t('Info')}
      open={open}
      onToggle={onToggle}
      summary={<span className="session-rail-cut">{projectLabel || t('No project')}</span>}
    >
      {draft.contextControls && (
        <>
          <RailProjectSelect
            projectPath={projectPath}
            projectLabel={projectLabel}
            projects={projects}
            disabled={draft.projectDisabled}
            onClear={draft.onClearProject}
            onSelect={draft.onSelectProject}
            onAddProject={onAddProject}
          />
          <BranchChip
            sessionId=""
            draftId={draft.draftId}
            projectPath={projectPath}
            disabled={draft.routeDisabled}
            renderTrigger={(button, view) => (
              <button
                {...button}
                type="button"
                className="session-rail-row session-rail-pick"
                title={t('Branch and worktree')}
                onKeyDown={(event) => openOnArrow(event, button['aria-expanded'], view.open)}
              >
                <GitBranch size={14} className="session-rail-ic" aria-hidden="true" />
                <span className="sr-only">{t('Branch')}</span>
                <span className="session-rail-cut">{view.label}</span>
                <RailPickMark />
              </button>
            )}
          />
        </>
      )}
      <RailModelRow model={model} agentMode={false} answersModelPickerRequests={answersModelPickerRequests} />
      {draft.contextControls && choices.map((choice) => <ChoiceRow key={choice.id} choice={choice} />)}
    </RailSection>
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
  /** The panel answers requestOpenModelPicker (the composer's pill is gone while it shows). */
  answersModelPickerRequests: boolean;
  model: RailModelProps;
  sessionChoices: RouteSessionChoice[];
  onViewChanges?: () => void;
  onFlash(flash: ComposerIslandFlash): void;
  onMoveSessionToProject?: (sessionId: string, projectPath: string) => Promise<void>;
  onAddProject?: (onAdded?: (projectPath: string) => void) => void;
  onOpenCommandSurface(surface: 'context' | 'stats'): void;
}) {
  // What the composer's footer shows for this kind of session: a bot's home
  // thread and a group room read their routines instead of coding usage, and
  // a room's members each run their own model (no model, no context).
  const routines = Boolean(agentIdOfHomeSession(sessionId) || roomIdOfSession(sessionId));
  const room = Boolean(roomIdOfSession(sessionId));
  const usage = usageWithCostVariants(snapshot);
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
        <RailModelRow model={model} agentMode={agentMode} answersModelPickerRequests={answersModelPickerRequests} />
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
        // A session that has not run yet has no usage to read.
        usage.some((items) => items.length > 0) && (
          <button
            type="button"
            className="session-rail-row session-rail-usage"
            title={t('Open usage')}
            onClick={() => onOpenCommandSurface('stats')}
          >
            <Activity size={14} className="session-rail-ic" aria-hidden="true" />
            <span className="sr-only">{t('Usage')}</span>
            <FittedReadout variants={usage} title={t('Session usage')} gap={4} />
          </button>
        )
      )}
    </RailSection>
  );
}

/** The last context status read of each session: a session shown again draws
 *  its rows at once, in the place they had, while the next read is out. */
const contextStatuses = new RendererLruCache<string, unknown>({
  name: 'session-rail-context',
  maxEntries: 64,
  maxChars: 256 * 1024,
  measure: (value, key) => key.length + JSON.stringify(value ?? null).length,
});

/** The session's context status (what its window holds, by kind), read while
 *  the category is open or its head has no reading to show: for the session
 *  shown and again for each `reading` the head shows, so the rows describe
 *  the window the head measures. */
function useContextStatus(sessionId: string, open: boolean, reading: number | null): unknown {
  const [read, setRead] = useState<{ sessionId: string; status: unknown } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading is what asks again
  useEffect(() => {
    if (!open || !sessionId) return undefined;
    let current = true;
    window.mixdogDesktop
      .invokeCapability({ capability: 'contextStatus', sessionId })
      .then((result) => {
        contextStatuses.set(sessionId, result.value);
        if (current) setRead({ sessionId, status: result.value });
      })
      // Without the status the category still shows its figures and one bar.
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [open, sessionId, reading]);
  return read?.sessionId === sessionId ? read.status : (contextStatuses.peek(sessionId) ?? null);
}

/** The Context category: how full the window is, as its figures, a bar of
 *  what it holds and a row for each kind, with the gauge's two actions.
 *  Absent while the session's window size is unknown. */
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
  const sessionId = String(snapshot.sessionId || '');
  const shown = usage.limit > 0;
  const status = useContextStatus(sessionId, (open || usage.used === null) && shown, usage.used);
  if (!shown) return null;
  const mix = status ? contextMix(status, usage.limit, usage.used, isAgentSession(snapshot)) : null;
  // A window with no reading (an agent that reports none; after a compaction, until the next request): the head
  // shows what its kinds are estimated to hold, marked as an estimate, so it and the rows under it agree.
  const estimate = usage.used === null && mix ? mix.held : null;
  const used = usage.used ?? estimate;
  const percent = usage.percent ?? (estimate === null ? null : (estimate / usage.limit) * 100);
  // Largest first: the kind filling the window leads, and the bar's segments stand in the rows' order.
  const held = mix ? [...mix.categories].sort((a, b) => b.tokens - a.tokens) : [];
  const segments = held.filter((category) => category.tokens > 0);
  // MCP tools keep their row with nothing loaded: whether they cost anything is what the row is read for. A reading with
  // no estimates to divide it has no rows: the head and the bar say what is known.
  const parts =
    mix && (mix.categorized > 0 || mix.held === 0)
      ? [
          ...held.filter((category) => category.tokens > 0 || category.key === 'mcp'),
          { key: 'free', label: t('Free space'), tokens: mix.free },
        ]
      : [];
  const share = (tokens: number) => (mix && mix.windowTokens > 0 ? (tokens / mix.windowTokens) * 100 : 0);
  return (
    <RailSection
      category="context"
      title={t('Context')}
      // The window's figures as its rows write them: 19k / 256k · 7.5%.
      meta={
        <span title={estimate === null ? usage.title : t('Estimated usage by category')}>
          {`${used === null ? '—' : `${estimate === null ? '' : '~'}${compactTokens(used)}`} / ${compactTokens(usage.limit)}${percent === null ? '' : ' · '}`}
          {percent !== null && (
            <span className="session-rail-context-percent" data-tone={usage.tone || undefined}>
              {`${percent.toFixed(1)}%`}
            </span>
          )}
        </span>
      }
      open={open}
      onToggle={onToggle}
      foot={
        <>
          {usage.compactApplies && (
            <button
              type="button"
              className="composer-island-button"
              disabled={usage.compactBusy}
              onClick={() => void usage.compact()}
            >
              <FoldVertical size={14} aria-hidden="true" />
              <span>{t('Compact')}</span>
            </button>
          )}
          <span className="session-rail-ft-end">
            <button type="button" className="composer-island-button" onClick={onViewDetails}>
              <ListTree size={14} aria-hidden="true" />
              <span>{t('View context details')}</span>
            </button>
          </span>
        </>
      }
    >
      <div className="session-rail-context">
        <div
          className="session-rail-meter"
          data-tone={usage.tone || undefined}
          role="meter"
          aria-label={t('Context usage')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          {segments.length > 0 ? (
            // What the window holds, a colour for each kind, inside the held share so the slivers' least width comes out
            // of it; the track left over at the end is free space.
            <span
              className="session-rail-meter-held"
              style={{ width: `${share(segments.reduce((sum, category) => sum + category.tokens, 0))}%` }}
            >
              {segments.map((category) => (
                <b key={category.key} data-context-key={category.key} style={{ flexGrow: category.tokens }} />
              ))}
            </span>
          ) : (
            <i style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
          )}
        </div>
        {parts.map((part) => (
          <div
            key={part.key}
            className="session-rail-row session-rail-part"
            data-context-key={part.key}
            data-zero={part.tokens === 0 || undefined}
          >
            <i className="session-rail-swatch" aria-hidden="true" />
            <span className="session-rail-cut">{part.label}</span>
            <span className="session-rail-grow" />
            <span className="session-rail-num">{compactTokens(part.tokens)}</span>
            <span className="session-rail-num session-rail-share">{`${share(part.tokens).toFixed(1)}%`}</span>
          </div>
        ))}
      </div>
    </RailSection>
  );
}
