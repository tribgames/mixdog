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
import { type ComponentProps, useEffect, useMemo, useRef, useState } from 'react';
import type { DesktopProjectSummary, DesktopSessionWorkspace } from '../shared/contract';
import { agentIdOfHomeSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-home.mjs';
import { roomIdOfSession } from '../shared/core-src/runtime/agent/orchestrator/session/agent-room.mjs';
import { ServerAccountBadge, useAgentChatRouteApplied } from './ComposerFooter';
import { ComposerRouteChoices } from './composer-route-choices';
import { ComposerRoutineReadout } from './composer-routine-readout';
import { compactTokens, contextMix } from './ContextBody';
import { FittedReadout, usageWithCostVariants } from './composer-usage-readout';
import type { Snapshot } from './desktop-types';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import { ModelSelector } from './model-controls';
import { showDesktopToast } from './notifications';
import { projectIdentity } from './project-catalog-cache';
import { RendererLruCache } from './renderer-lru-cache';
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
  const routeApplied = useAgentChatRouteApplied(model.onRoutePreferenceApplied, model.sessionId, agentMode);
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
            <FittedReadout variants={usage} title={t('Session usage')} />
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
 *  the category is open: for the session shown and again for each `reading`
 *  the head shows, so the rows describe the window the head measures. */
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
  // A window not measured yet (after a compaction, until the next request) still shows, its head awaiting the reading.
  const shown = usage.limit > 0;
  const status = useContextStatus(sessionId, open && shown, usage.used);
  if (!shown) return null;
  const mix = status ? contextMix(status, usage.limit) : null;
  // MCP tools keep their row with nothing loaded: whether they cost anything is what the row is read for.
  const parts = mix
    ? [
        ...mix.categories.filter((category) => category.tokens > 0 || category.key === 'mcp'),
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
        <span title={usage.title}>
          {usage.limit > 0 &&
            `${usage.used === null ? '—' : compactTokens(usage.used)} / ${compactTokens(usage.limit)}${usage.percent === null ? '' : ' · '}`}
          {usage.percent !== null && (
            <span className="session-rail-context-percent" data-tone={usage.tone || undefined}>
              {`${usage.percent.toFixed(1)}%`}
            </span>
          )}
        </span>
      }
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
            <span>{t('Compact')}</span>
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
      <div className="session-rail-context">
        <div
          className="session-rail-meter"
          data-tone={usage.tone || undefined}
          role="meter"
          aria-label={t('Context usage')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usage.percent ?? undefined}
        >
          {mix ? (
            // What the window holds, a colour for each kind; the track left over is free space.
            mix.categories
              .filter((category) => category.tokens > 0)
              .map((category) => (
                <b key={category.key} data-context-key={category.key} style={{ width: `${share(category.tokens)}%` }} />
              ))
          ) : (
            <i style={{ width: `${Math.min(100, usage.percent ?? 0)}%` }} />
          )}
        </div>
        {parts.map((part) => (
          <div key={part.key} className="session-rail-row session-rail-part" data-context-key={part.key}>
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
