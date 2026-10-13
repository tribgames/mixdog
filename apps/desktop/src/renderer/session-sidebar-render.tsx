import { Search, Sparkles, SquarePen } from 'lucide-react';
import type React from 'react';
import { Fragment } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { t } from './i18n';
import type { NavigationSelection } from './nav-types';
import { RowOverflowMenu } from './RowOverflowMenu';
import { openSessionSearch } from './session-search';
import { listOrderId, type SessionOrderPrefs } from './session-order';
import { SessionSidebarRow, type SessionRowReorder } from './session-sidebar-rows';
import { RECENT_SESSION_INITIAL_ROWS } from './session-sidebar-scroll';
import {
  archivedSection,
  automationsSection,
  favoritesSection,
  projectsSection,
  recentSection,
  type ProjectSessionGroup,
} from './session-sidebar-sections';
import type { useProjectFolderState, useSidebarOpenState } from './session-sidebar-state';
import type { usePersistedListOrder } from './use-persisted-list-order';

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
  editor: SessionRowEditor;
  sessionReorder: Pick<ListOrder, 'getReorderProps'>;
  requestPrefetch(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  onDeleteSession(sessionId: string): Promise<void>;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
  openSessionMenu(session: DesktopSessionSummary, point: { x: number; y: number }, rowKey: string): void;
  setDraggedSessionId(sessionId: string): void;
  setSessionDropKey(key: string): void;
}

/** Recent, Automations, Archived, Favorites and the project folders all render
 *  the same row with the same rename/confirm wiring; only the session and its
 *  reorder list (none for unordered lists) differ. The row key (list + session)
 *  tells apart the copies of a session shown in more than one list. */
export function renderSessionRow(
  session: DesktopSessionSummary,
  listKey: string | undefined,
  ctx: SessionRowContext,
  rowScope = listKey ?? ''
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
  return (
    <SessionSidebarRow
      key={session.id}
      session={session}
      reorder={
        listKey
          ? withSessionDrag(session.id, ctx.sessionReorder.getReorderProps(listOrderId(listKey, session.id)))
          : undefined
      }
      active={selection.kind === 'session' && selection.id === session.id}
      working={ctx.workingSessionIds?.has(session.id) === true}
      unread={ctx.unreadSessionIds?.has(session.id) === true}
      rowKey={`${rowScope}:${session.id}`}
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
      onDeleteSession={ctx.onDeleteSession}
      onArchiveSession={ctx.onArchiveSession}
      onFavoriteSession={ctx.onFavoriteSession}
      onOpenMenu={ctx.openSessionMenu}
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
        <button type="button" className="task-link session-launcher-row" onClick={onNewStudio}>
          <Sparkles className="session-launcher-icon" size={16} aria-hidden="true" />
          <span className="session-launcher-label">{t('New Studio')}</span>
        </button>
      </nav>
      <div className="session-sidebar-scroll" ref={scrollerRef} onScroll={onScroll}>
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
  updateOrderPrefs: (update: Partial<SessionOrderPrefs>) => void
): React.ComponentProps<typeof RowOverflowMenu>['items'] {
  return [
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
  openProjectMenu: ProjectsSectionProps['onFolderMenu'];
  projectRenameEditor: ProjectsSectionProps['rename'];
  renderOrderedRow(session: DesktopSessionSummary, listKey?: string, rowScope?: string): React.ReactNode;
  sessionsReady: boolean;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  onAddProject?(onAdded?: (projectPath: string) => void): void;
  onNewProjectTask?(projectPath: string): void;
  onNewTask(): void;
}

/** One session category through its section builder; the heading row is its
 *  drag handle for the persisted category order. */
export function renderSidebarSection(section: string, ctx: SidebarSectionContext): React.ReactNode {
  const { openState, folders, rows, automationRows, archivedRows, bulkAction, renderOrderedRow } = ctx;
  const { onAddProject, onNewProjectTask, onNewTask, unreadSessionIds } = ctx;
  const headerProps = ctx.sectionOrder.getReorderProps(section);
  const renderUnorderedRow = (session: DesktopSessionSummary) => renderOrderedRow(session, undefined, section);
  switch (section) {
    case 'favorites':
      return (
        ctx.favoriteRows.length > 0 &&
        favoritesSection({
          rows: ctx.favoriteRows,
          open: openState.favoritesOpen,
          onToggleOpen: () => openState.toggleSection('favorites'),
          headerProps,
          renderSessionRow: (session) => renderOrderedRow(session, 'favorites'),
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
          unreadSessionIds,
          renderSessionRow: (session, groupKey) => renderOrderedRow(session, `project:${groupKey}`),
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
          renderSessionRow: renderUnorderedRow,
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
        renderSessionRow: (session) => renderOrderedRow(session, 'recent'),
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
          renderSessionRow: renderUnorderedRow,
        })
      );
  }
}
