import { ChevronDown, ChevronRight, type FolderPlus, Plus } from 'lucide-react';
import { MxIcon } from './MxIcon';
import { elementMenuPoint, isContextMenuKey, pointerMenuPoint } from './ScmContextMenu';
import type { usePersistedListOrder } from './use-persisted-list-order';
import React, { useContext } from 'react';
import { createPortal } from 'react-dom';
import { InitialSurface } from './InitialSurface';
import type { DesktopProjectSummary, DesktopSessionSummary } from '../shared/contract';
import { strongestSessionAttention, type SessionAttention } from '../shared/session-attention';
import { SessionRowStatusIcon, SessionRowUnreadDot } from './session-status-mark';
import {
  clampDesktopPanelWidth,
  DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  DESKTOP_SIDEBAR_MIN_WIDTH,
} from '../shared/window-layout';
import { ProgressSpinner } from './ProgressSpinner';
import { t, uiFormatLocale } from './i18n';
import { RowOverflowMenu, rowOverflowHostProps } from './RowOverflowMenu';
import { sessionLabel } from './session-sidebar-rows';
import { projectIdentity, sessionProjectKey } from './project-catalog-cache';
import { isOpen, type OpenMap } from './sidebar-open-state';

const DEFAULT_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_DEFAULT_WIDTH;
export const MIN_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_MIN_WIDTH;
export const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_KEY = 'mixdog:session-sidebar-width';

export function clampSidebarWidth(value: number) {
  return clampDesktopPanelWidth(value, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

export function storedSidebarWidth() {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));

    return Number.isFinite(value) && value > 0 ? clampSidebarWidth(value) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** Width persistence for the next window. Both the settled resize and the
 *  pagehide flush write through here: a storage failure only costs the next
 *  window its restored width, the live resize is already applied. */
export function persistSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // The current window can still resize when persistent storage is unavailable.
  }
}

export type SidebarResizeStart = {
  clientX: number;
  width: number;
  pendingWidth: number;
};

/** Automation runner sessions (schedule/webhook fires) live in their own
 *  Automations section and are excluded from Recent (user decision: fires
 *  must not flood the list). */
export function isAutomationRow(session: DesktopSessionSummary) {
  return session.sourceType === 'schedule' || session.sourceType === 'webhook';
}

type AutomationGroup = { key: string; name: string; runs: DesktopSessionSummary[] };

/** One GROUP per automation name: the newest session is the visible row and
 *  older fires stay reachable behind a per-group "Past runs" toggle (user
 *  decision — fires are full sessions now, so history must not vanish).
 *  Expects activity-desc rows, which is the order the runs keep. */
export function groupAutomationSessions(activityOrderedRows: DesktopSessionSummary[]): AutomationGroup[] {
  const groups = new Map<string, { name: string; runs: DesktopSessionSummary[] }>();
  for (const session of activityOrderedRows) {
    if (session.archived || !isAutomationRow(session)) continue;
    const key = `${session.sourceType}:${
      String(session.sourceName || '')
        .trim()
        .toLowerCase() || session.id
    }`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { name: String(session.sourceName || sessionLabel(session)), runs: [] };
      groups.set(key, entry);
    }
    // Runs keep activity order and show their fire time as the row label —
    // every run reads the same name.
    entry.runs.push({
      ...session,
      title: new Date(Number(session.activityAt) || session.updatedAt).toLocaleString(uiFormatLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

/** Renders `rows` as fork groups, covering at most `limit` rows (all by default). */
export type RenderForkRows = (rows: readonly DesktopSessionSummary[], limit?: number) => React.ReactNode;

/** Panel-header action slot. Rail destinations (Projects/Workflows/Schedules/
 *  Webhooks) hand their primary action to the panel title row instead of
 *  printing a second page header inside the list (user: 타이틀이 2번). */
export const SidebarPanelHeaderSlot = React.createContext<HTMLElement | null>(null);

export function SidebarPanelAction({
  active = true,
  label,
  icon: Icon,
  className = '',
  disabled,
  onClick,
}: {
  /** Only the VISIBLE panel may own the shared header slot: every rail panel
   *  stays mounted behind [hidden] so its list keeps its scroll and data. */
  active?: boolean;
  label: string;
  icon: typeof FolderPlus;
  className?: string;
  disabled?: boolean;
  onClick(): void;
}) {
  const slot = useContext(SidebarPanelHeaderSlot);
  const button = (
    <button
      type="button"
      className={`session-panel-action ${className}`.trim()}
      aria-label={label}
      data-tooltip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
  // No slot means the pane renders outside the sidebar (standalone hosts and
  // unit tests): keep the action inline so the surface stays complete.
  if (!slot) return button;
  return active ? createPortal(button, slot) : null;
}

/** Automations section: one disclosure per automation name over its runs.
 *  Separate from Recent because a group header is a PURE disclosure (user
 *  decision) — it never renames and never opens a session itself. */
export function automationsSection({
  groups,
  open,
  onToggleOpen,
  hasHeadingDot,
  archiveAllDisabled,
  onArchiveAll,
  collapsedGroups,
  onToggleGroup,
  workingSessionIds,
  unreadSessionIds,
  headerProps,
  renderSessionRow,
}: {
  headerProps?: ReorderProps;
  groups: AutomationGroup[];
  open: boolean;
  onToggleOpen(): void;
  hasHeadingDot: boolean;
  archiveAllDisabled: boolean;
  onArchiveAll(): void;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup(key: string): void;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  renderSessionRow(session: DesktopSessionSummary): React.ReactNode;
}) {
  return (
    <section
      className="sidebar-recent sidebar-automations"
      aria-label={t('Automations')}
      {...reorderTarget(headerProps)}
    >
      <div
        className="sidebar-category-header"
        {...reorderHandle(headerProps)}
        {...(hasHeadingDot ? undefined : rowOverflowHostProps())}
      >
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Automations')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {/* Collapsed sections still have to announce new activity. */}
          {hasHeadingDot && (
            <span className="sidebar-heading-dot" role="status" aria-label={t('Automations have new activity')} />
          )}
        </button>
        {!hasHeadingDot && (
          <RowOverflowMenu
            label={t('Actions')}
            items={[
              {
                id: 'archive-all',
                label: t('Archive all'),
                disabled: archiveAllDisabled,
                onSelect: onArchiveAll,
              },
            ]}
          />
        )}
      </div>
      {open && (
        <nav className="session-list automation-session-list" aria-label={t('Automations')}>
          {groups.map(({ key, name, runs }) => {
            const expanded = !collapsedGroups.has(key);
            const working = runs.some((run) => workingSessionIds?.has(run.id));
            const unread = runs.some((run) => unreadSessionIds?.has(run.id));
            const ExpandGlyph = expanded ? ChevronDown : ChevronRight;
            return (
              <div className="automation-group" key={key}>
                {/* The chevron LEADS in the fixed status cell (one aligned
                    column); the working spinner takes that cell over while a
                    run is live. */}
                <button
                  type="button"
                  className="session-row automation-group-header"
                  aria-expanded={expanded}
                  onClick={() => onToggleGroup(key)}
                >
                  <span className="session-row-status" data-working={working || undefined}>
                    {working ? (
                      <ProgressSpinner
                        size={12}
                        className="session-row-spinner"
                        role="status"
                        aria-label={t('{{name}} is working', { name })}
                      />
                    ) : (
                      <ExpandGlyph size={14} aria-hidden="true" />
                    )}
                  </span>
                  <span className="session-row-copy">
                    <b>{name}</b>
                  </span>
                  {unread && !working && (
                    <span
                      className="session-row-unread-dot"
                      role="status"
                      aria-label={t('{{name}} has new activity', { name })}
                    />
                  )}
                </button>
                {expanded && <div className="automation-group-past">{runs.map(renderSessionRow)}</div>}
              </div>
            );
          })}
        </nav>
      )}
    </section>
  );
}

/** Favorites section: starred, non-archived sessions pinned above Recent. */
export function favoritesSection({
  rows,
  open,
  onToggleOpen,
  headerProps,
  renderRows,
}: {
  rows: DesktopSessionSummary[];
  open: boolean;
  onToggleOpen(): void;
  headerProps?: ReorderProps;
  renderRows: RenderForkRows;
}) {
  return (
    <section className="sidebar-recent sidebar-favorites" aria-label={t('Favorites')} {...reorderTarget(headerProps)}>
      <div className="sidebar-category-header" {...reorderHandle(headerProps)}>
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Favorites')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>
      {open && (
        <nav className="session-list favorite-session-list" aria-label={t('Favorites')}>
          {renderRows(rows)}
        </nav>
      )}
    </section>
  );
}

/** Recent section: the primary session catalog. Owns the invisible end
 *  sentinel that reveals the next page — pagination has NO control of its own
 *  (user decision: no "Show more"). */
export function recentSection({
  sessionsReady,
  rowCount,
  visibleRows,
  hasMoreRows,
  sentinelRef,
  open,
  onToggleOpen,
  hasHeadingDot,
  archiveAllDisabled,
  onArchiveAll,
  headerProps,
  renderRows,
  allRows,
}: {
  headerProps?: ReorderProps;
  sessionsReady: boolean;
  rowCount: number;
  visibleRows: DesktopSessionSummary[];
  hasMoreRows: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggleOpen(): void;
  hasHeadingDot: boolean;
  archiveAllDisabled: boolean;
  onArchiveAll(): void;
  /** Renders the full list's fork groups, covering `visibleRows.length` rows. */
  renderRows: RenderForkRows;
  allRows: readonly DesktopSessionSummary[];
}) {
  return (
    <section className="sidebar-recent" aria-label={t('Recent sessions')} {...reorderTarget(headerProps)}>
      <div
        className="sidebar-category-header"
        {...reorderHandle(headerProps)}
        {...(hasHeadingDot ? undefined : rowOverflowHostProps())}
      >
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Recent')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {hasHeadingDot && (
            <span className="sidebar-heading-dot" role="status" aria-label={t('Recent has new activity')} />
          )}
        </button>
        {!hasHeadingDot && (
          <RowOverflowMenu
            label={t('Actions')}
            items={[
              {
                id: 'archive-all',
                label: t('Archive all'),
                disabled: archiveAllDisabled,
                onSelect: onArchiveAll,
              },
            ]}
          />
        )}
      </div>
      {open && (
        <nav id="recent-session-list" className="session-list recent-session-list" aria-label={t('Recent sessions')}>
          {!sessionsReady && rowCount === 0 ? (
            <InitialSurface />
          ) : (
            sessionsReady && rowCount === 0 && <p className="sidebar-section-empty">{t('No sessions')}</p>
          )}
          {renderRows(allRows, visibleRows.length)}
          {hasMoreRows && (
            <div
              ref={sentinelRef}
              className="session-list-sentinel"
              aria-hidden="true"
              style={{ height: 1, pointerEvents: 'none' }}
            />
          )}
        </nav>
      )}
    </section>
  );
}

/** Sessions a project folder shows when opened; More reveals the next batch. */
export const PROJECT_SESSION_PAGE_ROWS = 5;

/** Drag-reorder props from usePersistedListOrder, spread on a section header
 *  or a project folder row. */
export type ReorderProps = ReturnType<ReturnType<typeof usePersistedListOrder>['getReorderProps']>;

/** The heading/folder row is the grip; the whole section/folder group is the
 *  drop target, so releasing over its rows still reorders. */
function reorderHandle(props?: ReorderProps) {
  return props && { draggable: props.draggable, onDragStart: props.onDragStart, onDragEnd: props.onDragEnd };
}
function reorderTarget(props?: ReorderProps) {
  if (!props) return undefined;
  const { draggable: _grip, onDragStart: _start, onDragEnd: _end, ...target } = props;
  return target;
}

export type ProjectSessionGroup = { key: string; path: string; name: string; rows: DesktopSessionSummary[] };

/** Registered projects as sidebar folders. A session belongs to the project
 *  the user moved it to, else the deepest project containing its projectPath,
 *  worktree project or cwd; other sessions stay in Recent only. Folders come newest-activity first; the user's drag order is
 *  applied on top of that. Expects activity-desc rows. */
export function groupProjectSessions(
  projects: readonly DesktopProjectSummary[],
  activityOrderedRows: readonly DesktopSessionSummary[]
): ProjectSessionGroup[] {
  const byKey = new Map<string, ProjectSessionGroup>();
  for (const project of projects) {
    const key = projectIdentity(project.path);
    if (!key || byKey.has(key)) continue;
    const name = project.alias?.trim() || project.name?.trim() || project.path;
    byKey.set(key, { key, path: project.path, name, rows: [] });
  }
  const keys = [...byKey.keys()];
  for (const session of activityOrderedRows) {
    byKey.get(sessionProjectKey(session, keys))?.rows.push(session);
  }
  const newest = (group: ProjectSessionGroup) =>
    group.rows.length ? Number(group.rows[0].activityAt) || group.rows[0].updatedAt : 0;
  return [...byKey.values()].sort((left, right) => newest(right) - newest(left));
}

interface ProjectsSectionProps {
  /** A session row dragged over a folder moves it into that project. */
  sessionDrop?: {
    /** Key of the folder currently highlighted as the drop target. */
    activeKey: string;
    /** True when the dragged session may drop on this folder (claims the event). */
    onDragOver(group: ProjectSessionGroup, event: React.DragEvent<HTMLElement>): boolean;
    onDragLeave(group: ProjectSessionGroup, event: React.DragEvent<HTMLElement>): void;
    onDrop(group: ProjectSessionGroup, event: React.DragEvent<HTMLElement>): boolean;
  };
  /** Header ⋯ menu: opens the shared add-project dialog. */
  onAddProject?(): void;
  /** Right-click / Menu key on a folder row. */
  onFolderMenu?(group: ProjectSessionGroup, point: { x: number; y: number }): void;
  /** Inline rename of one folder (its project display name). */
  rename?: {
    key: string;
    draft: string;
    onDraft(value: string): void;
    onCommit(group: ProjectSessionGroup): void;
    onCancel(): void;
  } | null;
  groups: ProjectSessionGroup[];
  open: boolean;
  onToggleOpen(): void;
  /** Explicit folder open choices; a folder without an entry is open. */
  projectOpen: OpenMap;
  onToggleProject(key: string): void;
  rowLimits: ReadonlyMap<string, number>;
  onShowMore(key: string): void;
  onNewTask(projectPath: string): void;
  folderReorderProps(key: string): ReorderProps;
  headerProps?: ReorderProps;
  /** The strongest status of one session; a collapsed folder shows its
   *  sessions' strongest. */
  attentionOf(sessionId: string): SessionAttention | '';
  renderRows(rows: readonly DesktopSessionSummary[], limit: number, groupKey: string): React.ReactNode;
}

/** One project folder: its drag/drop target, folder row (with inline rename and
 *  menu), and the opened sessions page. */
function projectFolderGroup(
  group: ProjectSessionGroup,
  {
    projectOpen,
    rowLimits,
    onShowMore,
    onNewTask,
    onToggleProject,
    folderReorderProps,
    attentionOf,
    renderRows,
    onFolderMenu,
    rename,
    sessionDrop,
  }: ProjectsSectionProps
) {
  const expanded = isOpen(projectOpen, group.key);
  const reorder = folderReorderProps(group.key);
  const limit = rowLimits.get(group.key) ?? PROJECT_SESSION_PAGE_ROWS;
  // A collapsed folder speaks for its hidden sessions with their strongest status.
  const attention = expanded ? '' : strongestSessionAttention(group.rows.map((session) => attentionOf(session.id)));
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop target; the keyboard path is the session menu's Move to project
    <div
      className="project-group"
      key={group.key}
      data-project-key={group.key}
      data-session-drop={sessionDrop?.activeKey === group.key ? 'true' : undefined}
      {...reorderTarget(reorder)}
      onDragOver={(event) => {
        if (!sessionDrop?.onDragOver(group, event)) reorder.onDragOver?.(event);
      }}
      onDragLeave={sessionDrop ? (event) => sessionDrop.onDragLeave(group, event) : undefined}
      onDrop={(event) => {
        if (!sessionDrop?.onDrop(group, event)) reorder.onDrop?.(event);
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: right-click is a pointer shortcut; the folder button inside opens the same menu from the keyboard (Menu / Shift+F10). */}
      <div
        className="project-folder"
        {...(rename?.key === group.key ? {} : reorderHandle(reorder))}
        onContextMenu={
          onFolderMenu
            ? (event) => {
                event.preventDefault();
                onFolderMenu(group, pointerMenuPoint(event));
              }
            : undefined
        }
      >
        {rename?.key === group.key && (
          <input
            className="session-title-input project-folder-rename"
            value={rename.draft}
            maxLength={160}
            // biome-ignore lint/a11y/noAutofocus: rename starts from an explicit menu action
            autoFocus
            aria-label={t('Rename')}
            onFocus={(event) => event.currentTarget.select()}
            onInput={(event) => rename.onDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                rename.onCommit(group);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                rename.onCancel();
              }
            }}
            onBlur={() => rename.onCommit(group)}
          />
        )}
        <button
          type="button"
          className="session-row project-folder-toggle"
          aria-expanded={expanded}
          aria-haspopup={onFolderMenu ? 'menu' : undefined}
          data-tooltip={group.path}
          hidden={rename?.key === group.key}
          onClick={() => onToggleProject(group.key)}
          onKeyDown={(event) => {
            if (!onFolderMenu || !isContextMenuKey(event)) return;
            event.preventDefault();
            onFolderMenu(group, elementMenuPoint(event.currentTarget));
          }}
        >
          {/* Same project glyph as the Projects panel and composer chip. */}
          <MxIcon name="folder" className="project-folder-icon" />
          <span className="session-row-copy">
            <b>{group.name}</b>
          </span>
          {attention === 'unread' && <SessionRowUnreadDot name={group.name} />}
          {attention && attention !== 'unread' && (
            <span className="session-row-status">
              <SessionRowStatusIcon status={attention} name={group.name} />
            </span>
          )}
        </button>
        {/* Like a collapsed section heading: the status mark takes the
            trailing slot, so the + yields until the folder opens. */}
        {!attention && (
          <button
            type="button"
            className="row-overflow-trigger project-folder-new"
            aria-label={t('New task')}
            data-tooltip={t('New task')}
            onClick={() => onNewTask(group.path)}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="project-group-sessions">
          {group.rows.length === 0 && <p className="sidebar-section-empty">{t('No sessions')}</p>}
          {renderRows(group.rows, limit, group.key)}
          {group.rows.length > limit && (
            <button type="button" className="session-row project-group-more" onClick={() => onShowMore(group.key)}>
              <span className="session-row-copy">
                <b>{t('More')}</b>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Projects section above Recent: one folder row per registered project. A
 *  folder opens onto its newest sessions; the folder row is the drag handle
 *  for reordering and its hover + starts a task in that project. */
export function projectsSection(props: ProjectsSectionProps) {
  const { groups, open, onToggleOpen, headerProps, onAddProject } = props;
  return (
    <section className="sidebar-recent sidebar-projects" aria-label={t('Projects')} {...reorderTarget(headerProps)}>
      <div
        className="sidebar-category-header"
        {...reorderHandle(headerProps)}
        {...(onAddProject ? rowOverflowHostProps() : {})}
      >
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Projects')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {onAddProject && (
          <RowOverflowMenu
            label={t('Actions')}
            items={[{ id: 'add-project', label: t('Add project'), onSelect: () => onAddProject() }]}
          />
        )}
      </div>
      {open && (
        <nav className="session-list project-session-list" aria-label={t('Projects')}>
          {groups.map((group) => projectFolderGroup(group, props))}
        </nav>
      )}
    </section>
  );
}

/** Archived section: restore and permanent-delete of parked sessions, kept
 *  apart from Recent because those are the only bulk actions that leave or
 *  destroy the catalog. */
export function archivedSection({
  visibleRows,
  hasMoreRows,
  sentinelRef,
  open,
  onToggleOpen,
  actionsDisabled,
  onRestoreAll,
  onDeleteAll,
  headerProps,
  renderRows,
  allRows,
}: {
  headerProps?: ReorderProps;
  allRows: readonly DesktopSessionSummary[];
  visibleRows: DesktopSessionSummary[];
  hasMoreRows: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggleOpen(): void;
  actionsDisabled: boolean;
  onRestoreAll(): void;
  onDeleteAll(): void;
  renderRows: RenderForkRows;
}) {
  return (
    <section
      className="sidebar-recent sidebar-archived"
      aria-label={t('Archived sessions')}
      {...reorderTarget(headerProps)}
    >
      <div className="sidebar-category-header" {...reorderHandle(headerProps)} {...rowOverflowHostProps()}>
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle sidebar-archived-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Archived')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <RowOverflowMenu
          label={t('Actions')}
          items={[
            {
              id: 'restore-all',
              label: t('Restore all'),
              disabled: actionsDisabled,
              onSelect: onRestoreAll,
            },
            {
              id: 'delete-all-archived',
              label: t('Delete all archived sessions'),
              danger: true,
              separatorBefore: true,
              disabled: actionsDisabled,
              children: [
                {
                  id: 'confirm-delete-all-archived',
                  label: t('Confirm delete'),
                  danger: true,
                  onSelect: onDeleteAll,
                },
              ],
            },
          ]}
        />
      </div>
      {open && (
        <nav className="session-list archived-session-list" aria-label={t('Archived sessions')}>
          {renderRows(allRows, visibleRows.length)}
          {hasMoreRows && (
            <div
              ref={sentinelRef}
              className="session-list-sentinel"
              aria-hidden="true"
              style={{ height: 1, pointerEvents: 'none' }}
            />
          )}
        </nav>
      )}
    </section>
  );
}

/** Drag separator for the sidebar width. The live pointer width is written
 *  straight to the element and the ref so a drag never re-renders the session
 *  lists; only the settled width reaches state and storage. */
export function sidebarResizeHandle({
  width,
  sidebarWidth,
  resizeStart,
  updateSidebarWidth,
  onFinishResize,
}: {
  width: number;
  sidebarWidth: number;
  resizeStart: { current: SidebarResizeStart | null };
  updateSidebarWidth(value: number): void;
  onFinishResize(): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: focusable, draggable splitter handle; an hr cannot take focus or children semantics here
    <div
      className="session-sidebar-resize"
      role="separator"
      tabIndex={0}
      aria-label={t('Resize session sidebar')}
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') updateSidebarWidth(sidebarWidth - 16);
        else if (event.key === 'ArrowRight') updateSidebarWidth(sidebarWidth + 16);
        else if (event.key === 'Home') updateSidebarWidth(MIN_SIDEBAR_WIDTH);
        else if (event.key === 'End') updateSidebarWidth(MAX_SIDEBAR_WIDTH);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        resizeStart.current = {
          clientX: event.clientX,
          width: sidebarWidth,
          pendingWidth: sidebarWidth,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        document.body.classList.add('session-sidebar-resizing');
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const start = resizeStart.current;
        if (!start) return;
        const next = clampSidebarWidth(start.width + event.clientX - start.clientX);
        start.pendingWidth = next;
        const sidebar = event.currentTarget.closest<HTMLElement>('.session-sidebar');
        sidebar?.style.setProperty('--session-sidebar-width', `${next}px`);
        event.currentTarget.setAttribute('aria-valuenow', String(next));
        event.currentTarget.setAttribute('aria-valuetext', `${next} pixels`);
      }}
      onPointerUp={onFinishResize}
      onPointerCancel={onFinishResize}
    />
  );
}
