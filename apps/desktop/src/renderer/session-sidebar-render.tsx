import { Search, Sparkles, SquarePen } from 'lucide-react';
import type React from 'react';
import { Fragment } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import type { SessionAttention } from '../shared/session-attention';
import { t } from './i18n';
import type { NavigationSelection } from './nav-types';
import { RowOverflowMenu } from './RowOverflowMenu';
import { openSessionSearch } from './session-search';
import { groupForkRows, type ForkRowRole } from './session-fork-groups';
import { isOpen } from './sidebar-open-state';
import { listOrderId, type SessionOrderPrefs } from './session-order';
import { SessionSidebarRow, type SessionRowReorder } from './session-sidebar-rows';
import { loadStudioViewModule } from './studio-loader';
import { RECENT_SESSION_INITIAL_ROWS } from './session-sidebar-scroll';
import type { AgentContact } from './agent-contacts-model';
import type { SidebarRoomRow } from './session-sidebar-agents';
import {
  agentsSection,
  archivedSection,
  automationsSection,
  favoritesSection,
  projectsSection,
  recentSection,
  type FavoriteSessionDrop,
  type ProjectSessionGroup,
  type RenderForkRows,
} from './session-sidebar-sections';
import type { useProjectFolderState, useSidebarOpenState } from './session-sidebar-state';
import type { usePersistedListOrder } from './use-persisted-list-order';
import { VirtualSessionRows, type VirtualRowItem } from './session-sidebar-virtual-rows';

const prefetchStudioIntent = () => {
  void loadStudioViewModule().catch(() => undefined);
};

type ListOrder = ReturnType<typeof usePersistedListOrder>;
type ProjectsSectionProps = Parameters<typeof projectsSection>[0];

/** The inline rename and delete-confirmation state every row shares. */
interface SessionRowEditor {
  editingRowKey: string;
  sessionTitleDraft: string;
  setSessionTitleDraft(draft: string): void;
  sessionTitleInvalid: boolean;
  confirmingSessionId: string;
  setConfirmingSessionId: React.Dispatch<React.SetStateAction<string>>;
  deletingSessionId: string;
  setDeletingSessionId: React.Dispatch<React.SetStateAction<string>>;
  openSessionEditor(session: DesktopSessionSummary, rowKey: string): void;
  closeSessionEditor(): void;
  commitSessionEditor(session: DesktopSessionSummary, fromBlur?: boolean): void;
}

export interface SessionRowContext {
  selection: NavigationSelection;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  /** The strongest status of one session (needs you > failed > running > unread). */
  attentionOf(sessionId: string): SessionAttention | '';
  editor: SessionRowEditor;
  sessionReorder: Pick<ListOrder, 'getReorderProps'>;
  requestPrefetch(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  onDeleteSession(sessionId: string): Promise<void>;
  /** Delete entry of a row: the inline confirm, or the busy dialog first. */
  requestDelete(sessionId: string): void;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
  openSessionMenu(session: DesktopSessionSummary, point: { x: number; y: number }, rowKey: string): void;
  onToggleFork(sessionId: string): void;
  setDraggedSessionId(sessionId: string): void;
  setSessionDropKey(key: string): void;
  /** Owned by the sidebar for its lifetime (createRowReorderCache). */
  rowReorders: RowReorderCache;
}

/** Each row's reorder props as last built, and the object the row was given. */
interface RowReorderCache {
  latest: Map<string, Partial<SessionRowReorder> | undefined>;
  shown: Map<string, Partial<SessionRowReorder>>;
}

export function createRowReorderCache(): RowReorderCache {
  return { latest: new Map(), shown: new Map() };
}

const REORDER_HANDLERS = ['onDragStart', 'onDragOver', 'onDrop', 'onDragEnd'] as const;
type ReorderHandler = (event: React.DragEvent<HTMLElement>) => void;

/** Same drag marks and the same handlers present: only closures differ. */
function sameReorderShape(left: Partial<SessionRowReorder>, right: Partial<SessionRowReorder>): boolean {
  const fields = left as Record<string, unknown>;
  const others = right as Record<string, unknown>;
  for (const key of new Set([...Object.keys(fields), ...Object.keys(others)])) {
    const a = fields[key];
    const b = others[key];
    if (typeof a === 'function' || typeof b === 'function') {
      if (typeof a !== typeof b) return false;
    } else if (a !== b) return false;
  }
  return true;
}

/** The row's reorder props with one identity while its drag marks hold. Every
 *  sidebar render builds them with fresh handler closures, so each memoised
 *  row re-rendered on every session switch (all of Recent, twice). The kept
 *  object's handlers call the row's latest props, recorded on every render,
 *  so a drag still reads the current order. */
function stableRowReorder(
  cache: RowReorderCache,
  rowKey: string,
  next: Partial<SessionRowReorder> | undefined
): Partial<SessionRowReorder> | undefined {
  cache.latest.set(rowKey, next);
  if (!next) {
    cache.shown.delete(rowKey);
    return undefined;
  }
  const shown = cache.shown.get(rowKey);
  if (shown && sameReorderShape(shown, next)) return shown;
  const kept: Record<string, unknown> = { ...next };
  for (const name of REORDER_HANDLERS) {
    if (typeof next[name] !== 'function') continue;
    const forward: ReorderHandler = (event) =>
      (cache.latest.get(rowKey)?.[name] as ReorderHandler | undefined)?.(event);
    kept[name] = forward;
  }
  const result = kept as Partial<SessionRowReorder>;
  cache.shown.set(rowKey, result);
  return result;
}

/** Recent, Automations, Archived, Favorites and the project folders all render
 *  the same row with the same rename/confirm wiring; only the session and its
 *  reorder list (none for unordered lists) differ. The row key (list + session)
 *  tells apart the copies of a session shown in more than one list. */
export function renderSessionRow(
  session: DesktopSessionSummary,
  listKey: string | undefined,
  ctx: SessionRowContext,
  rowScope = listKey ?? '',
  fork?: ForkRowRole
) {
  const { editor, selection } = ctx;
  // The row's own reorder drag also tells the folders which session travels.
  const withSessionDrag = (sessionId: string, base: SessionRowReorder): SessionRowReorder => ({
    ...base,
    onDragStart: (event) => {
      base.onDragStart(event);
      ctx.setDraggedSessionId(sessionId);
    },
    onDragEnd: () => {
      base.onDragEnd();
      ctx.setDraggedSessionId('');
      ctx.setSessionDropKey('');
    },
  });
  // A group reorders as one unit through its original: forks are neither drag
  // sources nor drop targets, and the "after" drop line sits under the group's
  // last visible row rather than between the original and its forks.
  const reorderFor = (): Partial<SessionRowReorder> | undefined => {
    if (!listKey) return undefined;
    if (fork?.kind === 'child') {
      const root = ctx.sessionReorder.getReorderProps(listOrderId(listKey, fork.rootId));
      return fork.last && root['data-drop-position'] === 'after' ? { 'data-drop-position': 'after' } : undefined;
    }
    const base = withSessionDrag(session.id, ctx.sessionReorder.getReorderProps(listOrderId(listKey, session.id)));
    return fork?.kind === 'root' && fork.expanded && base['data-drop-position'] === 'after'
      ? { ...base, 'data-drop-position': undefined }
      : base;
  };
  const rowKey = `${rowScope}:${session.id}`;
  return (
    <SessionSidebarRow
      key={session.id}
      session={session}
      reorder={stableRowReorder(ctx.rowReorders, rowKey, reorderFor())}
      active={selection.kind === 'session' && selection.id === session.id}
      working={ctx.workingSessionIds?.has(session.id) === true}
      attention={ctx.attentionOf(session.id)}
      rowKey={rowKey}
      editingRowKey={editor.editingRowKey}
      sessionTitleDraft={editor.sessionTitleDraft}
      sessionTitleInvalid={editor.sessionTitleInvalid}
      confirmingSessionId={editor.confirmingSessionId}
      deletingSessionId={editor.deletingSessionId}
      onTitleDraftChange={editor.setSessionTitleDraft}
      onStartRename={editor.openSessionEditor}
      onCancelRename={editor.closeSessionEditor}
      onCommitRename={editor.commitSessionEditor}
      onPrefetchSession={ctx.requestPrefetch}
      onResumeSession={ctx.onResumeSession}
      onCloseEditor={editor.closeSessionEditor}
      onSetConfirming={editor.setConfirmingSessionId}
      onSetDeleting={editor.setDeletingSessionId}
      onRequestDelete={ctx.requestDelete}
      onDeleteSession={ctx.onDeleteSession}
      onArchiveSession={ctx.onArchiveSession}
      onFavoriteSession={ctx.onFavoriteSession}
      onOpenMenu={ctx.openSessionMenu}
      forkKind={fork?.kind}
      forkExpanded={fork?.kind === 'root' ? fork.expanded : undefined}
      forkNumber={fork?.kind === 'child' ? fork.n : undefined}
      onToggleFork={ctx.onToggleFork}
    />
  );
}

/** `rows` as fork groups: each original with its forks beneath it while the
 *  group is expanded. Rows stay keyed by session, so toggling keeps them mounted. */
function renderForkRows(
  ctx: SidebarSectionContext,
  rows: readonly DesktopSessionSummary[],
  limit: number | undefined,
  listKey?: string,
  rowScope?: string
) {
  return renderSessionItems(ctx, forkRowItems(ctx, rows, limit), listKey, rowScope);
}

/** One rendered row of a session list: the session and its fork role. */
interface SessionRowItem extends VirtualRowItem {
  session: DesktopSessionSummary;
  fork?: ForkRowRole;
}

/** `rows` flattened into the rows they render as fork groups (whole groups,
 *  covering at most `limit` rows): each original, then its forks while expanded. */
function forkRowItems(
  ctx: SidebarSectionContext,
  rows: readonly DesktopSessionSummary[],
  limit: number | undefined
): SessionRowItem[] {
  return groupForkRows(rows, limit).flatMap(({ session, forks }): SessionRowItem[] => {
    const item = (row: DesktopSessionSummary, fork?: ForkRowRole) => ({
      key: row.id,
      sessionId: row.id,
      session: row,
      fork,
    });
    if (forks.length === 0) return [item(session)];
    const expanded = isOpen(ctx.openState.forkOpen, session.id);
    return [
      item(session, { kind: 'root', expanded }),
      ...(expanded
        ? forks.map((fork, index) =>
            item(fork, { kind: 'child', n: index + 1, rootId: session.id, last: index === forks.length - 1 })
          )
        : []),
    ];
  });
}

/** A session list's rows, windowed to the scroller viewport once it is long. */
function renderSessionItems(
  ctx: SidebarSectionContext,
  items: readonly SessionRowItem[],
  listKey?: string,
  rowScope?: string
) {
  return (
    <VirtualSessionRows
      items={items}
      scrollerRef={ctx.scrollerRef}
      pinnedIds={ctx.pinnedSessionIds}
      renderItem={(item) => ctx.renderOrderedRow(item.session, listKey, rowScope, item.fork)}
    />
  );
}

/** The panel title row; other panels portal their primary action into its slot. */
export function sessionPanelHeader({
  panelActive,
  panelTitle,
  panelTitleDragProps,
  setPanelActionSlot,
  orderMenuItems,
}: {
  panelActive: boolean;
  panelTitle: string;
  panelTitleDragProps?: React.HTMLAttributes<HTMLSpanElement>;
  setPanelActionSlot(slot: HTMLDivElement | null): void;
  orderMenuItems: React.ComponentProps<typeof RowOverflowMenu>['items'];
}) {
  // The panel titles itself; every primary navigation control lives on the
  // Activity Rail to the left.
  return (
    <header className="session-panel-header">
      <span {...panelTitleDragProps} className="session-panel-title">
        {panelActive ? t(panelTitle) : t('Sessions')}
      </span>
      {/* Creation belongs to Sessions rather than the Activity Rail: this
            button creates an ordinary task tab and never owns a selected
            navigation state; the New task launcher below owns creation, and
            ⋯ holds the session sort options. Other panels
            portal their own primary action into the same title-row slot. */}
      <div className="session-panel-header-actions" ref={setPanelActionSlot}>
        {!panelActive && (
          <>
            <button
              type="button"
              className="session-panel-action session-search-open"
              aria-label={t('Search sessions')}
              data-tooltip={t('Search sessions')}
              onClick={openSessionSearch}
            >
              <Search size={16} aria-hidden="true" />
            </button>
            <RowOverflowMenu label={t('Session order')} items={orderMenuItems} />
          </>
        )}
      </div>
    </header>
  );
}

/** Sessions surface: a fixed launcher block over the scrolling list.
 *  The launchers live OUTSIDE the scroller on purpose — as a sticky
 *  block inside it they clamped to the scroller's content box, so the
 *  12px top inset showed scrolled rows through (user: 고정이냐? 뭔가
 *  이상한데). The surface flags (active/inert/hidden) move up to this
 *  wrapper so both parts hide together while a rail panel is shown. */
export function sessionsSurface({
  panelActive,
  onNewTask,
  onNewStudio,
  scrollerRef,
  onScroll,
  sectionIds,
  sectionContext,
}: {
  panelActive: boolean;
  onNewTask(): void;
  onNewStudio(): void;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onScroll(): void;
  sectionIds: readonly string[];
  sectionContext: SidebarSectionContext;
}) {
  return (
    <div
      className="session-sidebar-surface session-sidebar-sessions"
      data-surface-active={panelActive ? 'false' : 'true'}
      inert={panelActive ? true : undefined}
      aria-hidden={panelActive ? true : undefined}
    >
      {/* Fixed creation rows share the category type tier with leading
            icons. Both open tabs and stay outside the scrolling lists. */}
      <nav className="session-sidebar-launchers" aria-label={t('New')}>
        <button type="button" className="task-link session-launcher-row" onClick={onNewTask}>
          <SquarePen className="session-launcher-icon" size={16} aria-hidden="true" />
          <span className="session-launcher-label">{t('New task')}</span>
        </button>
        {/* Hover/focus/touch-down is intent: the Studio chunk starts loading
            before the click (a phone has no hover, so touch-down stands in). */}
        <button
          type="button"
          className="task-link session-launcher-row"
          onClick={onNewStudio}
          onPointerEnter={prefetchStudioIntent}
          onPointerDown={prefetchStudioIntent}
          onFocus={prefetchStudioIntent}
        >
          <Sparkles className="session-launcher-icon" size={16} aria-hidden="true" />
          <span className="session-launcher-label">{t('New Studio')}</span>
        </button>
      </nav>
      <div className="session-sidebar-scroll" ref={scrollerRef} onScroll={onScroll}>
        {(sectionContext.agentContacts.length > 0 || sectionContext.agentRooms.length > 0) &&
          agentsSection({
            contacts: sectionContext.agentContacts,
            rooms: sectionContext.agentRooms,
            onOpenRoom: sectionContext.onOpenRoom,
            open: sectionContext.openState.agentsOpen,
            onToggleOpen: () => sectionContext.openState.toggleSection('agents'),
            selectedSessionId: sectionContext.selection.kind === 'session' ? sectionContext.selection.id : '',
            onOpenAgent: sectionContext.onOpenAgent,
            onOpenMenu: sectionContext.onOpenAgentMenu,
            onOpenRoomMenu: sectionContext.onOpenRoomMenu,
            attentionOf: sectionContext.attentionOf,
          })}
        {sectionIds.map((section) => (
          <Fragment key={section}>{renderSidebarSection(section, sectionContext)}</Fragment>
        ))}
      </div>
    </div>
  );
}

/** The Sessions header ⋯ menu: sort mode of the session lists and of Favorites. */
export function sessionOrderMenuItems(
  orderPrefs: SessionOrderPrefs,
  updateOrderPrefs: (update: Partial<SessionOrderPrefs>) => void,
  showAgents: boolean,
  updateShowAgents: (show: boolean) => void
): React.ComponentProps<typeof RowOverflowMenu>['items'] {
  return [
    {
      id: 'sessions-lead-only',
      label: t('Show Lead sessions only'),
      checked: !showAgents,
      onSelect: () => updateShowAgents(false),
    },
    {
      id: 'sessions-all',
      label: t('Show all sessions'),
      checked: showAgents,
      onSelect: () => updateShowAgents(true),
    },
    { id: 'sessions-order-label', label: t('Session order'), disabled: true },
    ...(['recent', 'custom'] as const).map((mode) => ({
      id: `sessions-order-${mode}`,
      label: mode === 'recent' ? t('Recent activity') : t('Custom'),
      checked: orderPrefs.sessions === mode,
      onSelect: () => updateOrderPrefs({ sessions: mode }),
    })),
    { id: 'favorites-order-label', label: t('Favorites order'), disabled: true, separatorBefore: true },
    ...(['recent', 'custom'] as const).map((mode) => ({
      id: `favorites-order-${mode}`,
      label: mode === 'recent' ? t('Recent activity') : t('Custom'),
      checked: orderPrefs.favorites === mode,
      onSelect: () => updateOrderPrefs({ favorites: mode }),
    })),
  ];
}

export interface SidebarSectionContext {
  agentContacts: readonly AgentContact[];
  agentRooms: readonly SidebarRoomRow[];
  onOpenRoom(row: SidebarRoomRow): void;
  selection: NavigationSelection;
  onOpenAgent(contact: AgentContact): void;
  onOpenAgentMenu?(contact: AgentContact, point: { x: number; y: number }): void;
  onOpenRoomMenu?(row: SidebarRoomRow, point: { x: number; y: number }): void;
  sectionOrder: Pick<ListOrder, 'getReorderProps'>;
  openState: ReturnType<typeof useSidebarOpenState>;
  folders: Omit<ReturnType<typeof useProjectFolderState>, 'updateProjectOpen'>;
  favoriteRows: DesktopSessionSummary[];
  rows: DesktopSessionSummary[];
  visibleRecentRows: DesktopSessionSummary[];
  hasMoreRecentRows: boolean;
  recentSentinelRef: React.RefObject<HTMLDivElement | null>;
  projectGroups: ProjectSessionGroup[];
  projectOrder: Pick<ListOrder, 'getReorderProps'>;
  sessionDrop: ProjectsSectionProps['sessionDrop'];
  favoriteDrop: FavoriteSessionDrop;
  automationRows: readonly DesktopSessionSummary[];
  archivedRows: readonly DesktopSessionSummary[];
  visibleArchivedRows: DesktopSessionSummary[];
  hasMoreArchivedRows: boolean;
  archivedSentinelRef: React.RefObject<HTMLDivElement | null>;
  setArchivedRowLimit(limit: number): void;
  bulkAction: string;
  updateSessionArchives(
    action: 'archive-automations' | 'archive-recent' | 'restore',
    targets: readonly DesktopSessionSummary[],
    archived: boolean
  ): Promise<void>;
  deleteAllArchived(): Promise<void>;
  /** The Sessions scroller every list windows against. */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  /** Sessions whose rows stay mounted however far they scroll away. */
  pinnedSessionIds: ReadonlySet<string>;
  openProjectMenu: ProjectsSectionProps['onFolderMenu'];
  projectRenameEditor: ProjectsSectionProps['rename'];
  renderOrderedRow(
    session: DesktopSessionSummary,
    listKey?: string,
    rowScope?: string,
    fork?: ForkRowRole
  ): React.ReactNode;
  sessionsReady: boolean;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  attentionOf(sessionId: string): SessionAttention | '';
  onAddProject?(onAdded?: (projectPath: string) => void): void;
  onNewProjectTask?(projectPath: string): void;
  onNewTask(): void;
}

/** One session category through its section builder; the heading row is its
 *  drag handle for the persisted category order. */
function renderSidebarSection(section: string, ctx: SidebarSectionContext): React.ReactNode {
  const { openState, folders, rows, automationRows, archivedRows, bulkAction } = ctx;
  const { onAddProject, onNewProjectTask, onNewTask, unreadSessionIds } = ctx;
  const headerProps = ctx.sectionOrder.getReorderProps(section);
  const renderUnorderedRows: RenderForkRows = (list, limit) => renderForkRows(ctx, list, limit, undefined, section);
  switch (section) {
    case 'favorites':
      // With no favorites yet the section still appears while a session is
      // dragged, so the first one can be dropped onto it.
      return (
        (ctx.favoriteRows.length > 0 || ctx.favoriteDrop.available) &&
        favoritesSection({
          rows: ctx.favoriteRows,
          sessionDrop: ctx.favoriteDrop,
          open: openState.favoritesOpen,
          onToggleOpen: () => openState.toggleSection('favorites'),
          headerProps,
          renderRows: (list, limit) => renderForkRows(ctx, list, limit, 'favorites'),
        })
      );
    case 'projects':
      return (
        (ctx.projectGroups.length > 0 || Boolean(onAddProject)) &&
        projectsSection({
          onAddProject: onAddProject && (() => onAddProject()),
          sessionDrop: ctx.sessionDrop,
          groups: ctx.projectGroups,
          open: openState.projectsOpen,
          onToggleOpen: () => openState.toggleSection('projects'),
          projectOpen: folders.projectOpen,
          onToggleProject: folders.toggleProject,
          rowLimits: folders.projectRowLimits,
          onShowMore: folders.showMoreProjectRows,
          onNewTask: (projectPath) => (onNewProjectTask ? onNewProjectTask(projectPath) : onNewTask()),
          folderReorderProps: ctx.projectOrder.getReorderProps,
          headerProps,
          attentionOf: ctx.attentionOf,
          renderRows: (list, limit, groupKey) => renderForkRows(ctx, list, limit, `project:${groupKey}`),
          onFolderMenu: ctx.openProjectMenu,
          rename: ctx.projectRenameEditor,
        })
      );
    case 'automations':
      return (
        openState.automationGroups.length > 0 &&
        automationsSection({
          groups: openState.automationGroups,
          open: openState.automationsOpen,
          onToggleOpen: () => openState.toggleSection('automations'),
          hasHeadingDot:
            !openState.automationsOpen && automationRows.some((session) => unreadSessionIds?.has(session.id)),
          archiveAllDisabled: Boolean(bulkAction) || automationRows.length === 0,
          onArchiveAll: () => {
            void ctx.updateSessionArchives('archive-automations', automationRows, true);
          },
          collapsedGroups: openState.collapsedAutomations,
          onToggleGroup: openState.toggleAutomationGroup,
          workingSessionIds: ctx.workingSessionIds,
          unreadSessionIds,
          headerProps,
          renderRuns: (runs) =>
            renderSessionItems(
              ctx,
              runs.map((session) => ({ key: session.id, sessionId: session.id, session })),
              undefined,
              section
            ),
        })
      );
    case 'recent':
      return recentSection({
        sessionsReady: ctx.sessionsReady,
        rowCount: rows.length,
        visibleRows: ctx.visibleRecentRows,
        hasMoreRows: ctx.hasMoreRecentRows,
        sentinelRef: ctx.recentSentinelRef,
        open: openState.recentOpen,
        onToggleOpen: () => openState.toggleSection('recent'),
        hasHeadingDot: !openState.recentOpen && rows.some((session) => unreadSessionIds?.has(session.id)),
        archiveAllDisabled: Boolean(bulkAction) || rows.length === 0,
        onArchiveAll: () => {
          void ctx.updateSessionArchives('archive-recent', rows, true);
        },
        headerProps,
        allRows: rows,
        renderRows: (list, limit) => renderForkRows(ctx, list, limit, 'recent'),
      });
    case 'archived':
      return (
        archivedRows.length > 0 &&
        archivedSection({
          visibleRows: ctx.visibleArchivedRows,
          hasMoreRows: ctx.hasMoreArchivedRows,
          sentinelRef: ctx.archivedSentinelRef,
          open: openState.archivedOpen,
          onToggleOpen: () => {
            ctx.setArchivedRowLimit(RECENT_SESSION_INITIAL_ROWS);
            openState.toggleSection('archived');
          },
          actionsDisabled: Boolean(bulkAction) || archivedRows.length === 0,
          onRestoreAll: () => {
            void ctx.updateSessionArchives('restore', archivedRows, false);
          },
          onDeleteAll: () => {
            void ctx.deleteAllArchived();
          },
          headerProps,
          allRows: archivedRows,
          renderRows: renderUnorderedRows,
        })
      );
  }
}
