import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  roomIdOfSession,
  roomMemberOfSession,
} from '../../../../src/runtime/agent/orchestrator/session/agent-room.mjs';
import { projectIdentity } from './project-catalog-cache';
import type { DesktopProjectSummary, DesktopSessionSummary } from '../shared/contract';
import { confirmAction } from './app-confirm';
import { t } from './i18n';
import type { NavigationSelection } from './nav-types';
import {
  RECENT_SESSION_INITIAL_ROWS,
  RECENT_SESSION_PAGE_ROWS,
  useHeldDuringUserScroll,
  useSidebarListScroll,
} from './session-sidebar-scroll';
import {
  useCustomOrderSync,
  useProjectFolderState,
  useSessionRowReorder,
  useSidebarBootSurface,
  useSidebarOpenState,
  useSidebarSessionFilter,
} from './session-sidebar-state';
import { useSidebarMenus } from './session-sidebar-menus';
import {
  createRowReorderCache,
  renderSessionRow,
  sessionOrderMenuItems,
  sessionPanelHeader,
  sessionsSurface,
  type SessionRowContext,
  type SidebarSectionContext,
} from './session-sidebar-render';
import { sessionAttentionOf, useSessionAttentionIndex } from './session-attention-index';
import { permanentBotDeleteMessage, sessionLabel } from './session-sidebar-rows';
import {
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  clampSidebarWidth,
  storedSidebarWidth,
  persistSidebarWidth,
  isAutomationRow,
  SidebarPanelHeaderSlot,
  sidebarResizeHandle,
  type SidebarResizeStart,
  groupProjectSessions,
} from './session-sidebar-sections';
import { withOpen, type OpenMap } from './sidebar-open-state';
import type { ForkRowRole } from './session-fork-groups';
import { usePersistedListOrder } from './use-persisted-list-order';
import {
  applySessionOrder,
  readCustomOrders,
  readOrderPrefs,
  writeCustomOrders,
  writeOrderPrefs,
  type CustomSessionOrders,
  type SessionOrderPrefs,
} from './session-order';
import { ScmContextMenu } from './ScmContextMenu';
import type { FavoriteSessionDrop, ProjectSessionGroup, SessionGapDrop } from './session-sidebar-sections';
import { SettingsConfirmDialog } from './settings/capability-controls';
import { useStableEvent } from './use-stable-event';
import { listsAsSession, useSidebarAgents } from './session-sidebar-agents';
import type { AgentContact } from './agent-contacts-model';
import { agentContactMenuItems, agentRoomMenuItems, restoreAgent } from './agent-profile-actions';
import type { SidebarRoomRow } from './session-sidebar-agents';

/** The "work in progress" confirmation: archiving or deleting a busy session
 *  waits for it; `run` is the action the confirm button performs. */
interface BusyPrompt {
  kind: 'archive' | 'delete';
  count: number;
  name: string;
  run(): void;
}
type BusyGuard = (kind: BusyPrompt['kind'], ids: readonly string[], run: () => void, confirmedRun?: () => void) => void;

function busyPromptOptions(prompt: BusyPrompt) {
  const archive = prompt.kind === 'archive';
  const many = prompt.count > 1;
  const name = prompt.name;
  const total = prompt.count;
  let description: string;
  if (archive) {
    description = many
      ? t(
          '{{total}} of these sessions have work in progress. Archiving hides them, but does not stop the running work.',
          {
            total,
          }
        )
      : t('"{{name}}" has work in progress. Archiving hides it, but does not stop the running work.', { name });
  } else {
    description = many
      ? t('{{total}} of these sessions have work in progress. Deleting stops the running work and removes them.', {
          total,
        })
      : t('"{{name}}" has work in progress. Deleting stops the running work and removes the session.', { name });
  }
  return {
    title: t('This session has work in progress'),
    description,
    confirmLabel: archive ? t('Archive') : t('Delete'),
    danger: !archive,
    onConfirm: prompt.run,
  };
}

const NO_PROJECTS: readonly DesktopProjectSummary[] = [];
/** Default top-to-bottom order of the session categories; the user can drag
 *  any heading to reorder them. */
const SIDEBAR_SECTIONS = ['favorites', 'projects', 'automations', 'recent', 'archived'] as const;

/** The sidebar's width: persisted, clamped, and flushed on pagehide mid-drag. */
function useSidebarWidth() {
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const resizeStart = useRef<SidebarResizeStart | null>(null);
  const updateSidebarWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value);
    setSidebarWidth(next);
    persistSidebarWidth(next);
  }, []);
  useEffect(() => {
    const flushPendingWidth = () => {
      const pendingWidth = resizeStart.current?.pendingWidth;
      if (pendingWidth === undefined) return;
      persistSidebarWidth(clampSidebarWidth(pendingWidth));
    };
    window.addEventListener('pagehide', flushPendingWidth);
    return () => window.removeEventListener('pagehide', flushPendingWidth);
  }, []);
  const finishSidebarResize = useCallback(() => {
    const pendingWidth = resizeStart.current?.pendingWidth;
    resizeStart.current = null;
    document.body.classList.remove('session-sidebar-resizing');
    if (pendingWidth !== undefined && pendingWidth !== sidebarWidth) {
      updateSidebarWidth(pendingWidth);
    }
  }, [sidebarWidth, updateSidebarWidth]);
  useEffect(() => () => document.body.classList.remove('session-sidebar-resizing'), []);
  return { sidebarWidth, resizeStart, updateSidebarWidth, finishSidebarResize };
}

/** Warms the first recent rows during idle time; returns the per-row prefetch request. */
function useSessionPrefetch(
  onPrefetchSession: ((sessionId: string) => Promise<boolean>) | undefined,
  open: boolean,
  sessionsReady: boolean,
  visibleRecentRows: readonly DesktopSessionSummary[]
) {
  const prefetchedSessionIds = useRef(new Set<string>());
  const requestPrefetch = useCallback(
    (sessionId: string) => {
      if (!onPrefetchSession || prefetchedSessionIds.current.has(sessionId)) return;
      prefetchedSessionIds.current.add(sessionId);
      void onPrefetchSession(sessionId)
        .then((ready) => {
          if (!ready) prefetchedSessionIds.current.delete(sessionId);
        })
        .catch(() => {
          prefetchedSessionIds.current.delete(sessionId);
        });
    },
    [onPrefetchSession]
  );
  useEffect(() => {
    if (!open || !sessionsReady || !onPrefetchSession) return undefined;
    // Touch has no hover-intent window. Warm only the first two recent rows
    // during browser idle so the common mobile tap avoids a full relay RTT
    // without flooding the lane cache with large transcripts.
    const sessionIds = visibleRecentRows.slice(0, 2).map((session) => session.id);
    if (sessionIds.length === 0) return undefined;
    const host = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const warm = () => sessionIds.forEach(requestPrefetch);
    const idle = host.requestIdleCallback?.(warm, { timeout: 800 });
    const timer = idle === undefined ? window.setTimeout(warm, 160) : 0;
    return () => {
      if (idle !== undefined) host.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, [onPrefetchSession, open, requestPrefetch, sessionsReady, visibleRecentRows]);
  return requestPrefetch;
}

/** Inline rename and delete-confirmation state of the session rows. */
function useSessionEditor(
  sessions: readonly DesktopSessionSummary[],
  onRenameSession: (sessionId: string, title: string) => Promise<void>
) {
  // One session can render in several lists (a project folder and Recent);
  // the editor belongs to the one row the user started it from.
  const [editingRowKey, setEditingRowKey] = useState('');
  // The edited session itself: a windowed list keeps its row mounted.
  const [editingSessionId, setEditingSessionId] = useState('');
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const [sessionTitleInvalid, setSessionTitleInvalid] = useState(false);
  const [confirmingSessionId, setConfirmingSessionId] = useState('');
  const [deletingSessionId, setDeletingSessionId] = useState('');
  const openSessionEditor = useCallback((session: DesktopSessionSummary, rowKey: string) => {
    setConfirmingSessionId('');
    setEditingRowKey(rowKey);
    setEditingSessionId(session.id);
    setSessionTitleDraft(sessionLabel(session));
    setSessionTitleInvalid(false);
  }, []);
  const closeSessionEditor = useCallback(() => {
    setEditingRowKey('');
    setEditingSessionId('');
    setSessionTitleDraft('');
    setSessionTitleInvalid(false);
  }, []);
  const commitSessionEditor = useCallback(
    (session: DesktopSessionSummary, fromBlur = false) => {
      const title = sessionTitleDraft.trim();
      if (!title) {
        setSessionTitleInvalid(true);
        if (fromBlur) closeSessionEditor();
        return;
      }
      closeSessionEditor();
      if (title === sessionLabel(session)) return;
      void onRenameSession(session.id, title);
    },
    [closeSessionEditor, onRenameSession, sessionTitleDraft]
  );
  useEffect(() => {
    if (confirmingSessionId && !sessions.some((session) => session.id === confirmingSessionId)) {
      setConfirmingSessionId('');
    }
  }, [confirmingSessionId, sessions]);
  return {
    editingRowKey,
    editingSessionId,
    sessionTitleDraft,
    setSessionTitleDraft,
    sessionTitleInvalid,
    confirmingSessionId,
    setConfirmingSessionId,
    deletingSessionId,
    setDeletingSessionId,
    openSessionEditor,
    closeSessionEditor,
    commitSessionEditor,
  };
}

/** Sessions in sidebar order: activity-sorted task rows, split into favorites and
 *  the rest, with the user's list-order preferences applied. */
function useSessionOrdering(
  sessions: readonly DesktopSessionSummary[],
  hasSessionSurface: boolean,
  showAgents: boolean,
  contactHomeIds: ReadonlySet<string> | null
) {
  const allRows = useMemo(
    () =>
      !hasSessionSurface
        ? []
        : sessions
            .filter((session) => showAgents || !session.agentSession)
            // A live contact's home thread is its row on the Agents pane; an
            // archived one, or one whose agent is no contact (anymore), lists here.
            .filter((session) => listsAsSession(session, contactHomeIds))
            // So is a group room (its row sits under the contacts) and,
            // always, a room member's own session.
            .filter((session) => !roomIdOfSession(session.id) || session.archived)
            .filter((session) => !roomMemberOfSession(session.id))
            .filter((session) => session.classification === 'task' || session.classification === 'project')
            .sort((left, right) => {
              const leftActivityAt = Number(left.activityAt) || left.updatedAt;
              const rightActivityAt = Number(right.activityAt) || right.updatedAt;
              return rightActivityAt - leftActivityAt || left.id.localeCompare(right.id);
            }),
    [hasSessionSurface, sessions, showAgents, contactHomeIds]
  );
  const [orderPrefs, setOrderPrefs] = useState(readOrderPrefs);
  const [customOrders, setCustomOrders] = useState(readCustomOrders);
  const activityFavoriteRows = useMemo(
    () => allRows.filter((session) => session.favorite && !session.archived && !isAutomationRow(session)),
    [allRows]
  );
  const activityRows = useMemo(
    () => allRows.filter((session) => !session.archived && !session.favorite && !isAutomationRow(session)),
    [allRows]
  );
  const favoriteRows = useMemo(
    () => applySessionOrder(activityFavoriteRows, orderPrefs.favorites, customOrders.favorites),
    [activityFavoriteRows, orderPrefs.favorites, customOrders.favorites]
  );
  const rows = useMemo(
    () => applySessionOrder(activityRows, orderPrefs.sessions, customOrders.recent),
    [activityRows, orderPrefs.sessions, customOrders.recent]
  );
  const updateOrderPrefs = useCallback((update: Partial<SessionOrderPrefs>) => {
    setOrderPrefs((current) => {
      const next = { ...current, ...update };
      writeOrderPrefs(next);
      return next;
    });
  }, []);
  const updateCustomOrders = useCallback((update: (current: CustomSessionOrders) => CustomSessionOrders) => {
    setCustomOrders((current) => {
      const next = update(current);
      if (next !== current) writeCustomOrders(next);
      return next;
    });
  }, []);
  return {
    allRows,
    orderPrefs,
    customOrders,
    activityFavoriteRows,
    activityRows,
    favoriteRows,
    rows,
    updateOrderPrefs,
    updateCustomOrders,
  };
}

/** Bulk archive/restore/delete over a list of rows; one bulk action at a time. */
function useBulkArchiveActions(
  archivedRows: readonly DesktopSessionSummary[],
  onArchiveSession: (sessionId: string, archived: boolean) => Promise<void>,
  onDeleteSession: (sessionId: string) => Promise<void>,
  guardBusy: BusyGuard
) {
  const [bulkAction, setBulkAction] = useState<'' | 'archive-automations' | 'archive-recent' | 'restore' | 'delete'>(
    ''
  );
  const updateSessionArchives = useCallback(
    async (
      action: 'archive-automations' | 'archive-recent' | 'restore',
      targets: readonly DesktopSessionSummary[],
      archived: boolean
    ) => {
      if (bulkAction || targets.length === 0) return;
      const run = async () => {
        setBulkAction(action);
        try {
          /* Start every row mutation before awaiting any of them. Each row action
         applies its optimistic state synchronously, so React paints one bulk
         transition instead of visibly walking the list item by item. A failed
         row still owns its existing rollback while the rest continue. */
          await Promise.all(
            targets.map(async (session) => {
              try {
                await onArchiveSession(session.id, archived);
              } catch {
                // The row-level action restores failures; continue with the rest.
              }
            })
          );
        } finally {
          setBulkAction('');
        }
      };
      if (archived)
        guardBusy(
          'archive',
          targets.map((session) => session.id),
          () => void run()
        );
      else await run();
    },
    [bulkAction, guardBusy, onArchiveSession]
  );
  const deleteAllArchived = useCallback(async () => {
    if (bulkAction || archivedRows.length === 0) return;
    const run = async () => {
      setBulkAction('delete');
      try {
        for (const session of archivedRows) {
          try {
            await onDeleteSession(session.id);
          } catch {
            // Failed rows stay archived; continue deleting the remaining rows.
          }
        }
      } finally {
        setBulkAction('');
      }
    };
    guardBusy(
      'delete',
      archivedRows.map((session) => session.id),
      () => void run()
    );
  }, [bulkAction, archivedRows, guardBusy, onDeleteSession]);
  return { bulkAction, updateSessionArchives, deleteAllArchived };
}

/** Registered projects as sidebar folders over the session rows: grouping, the
 *  user's folder order, and revealing a selected session's or newly added
 *  project's folder. */
function useProjectGroups({
  allRows,
  projects,
  selection,
  revealedProject,
  orderPrefs,
  customOrders,
  updateProjectOpen,
}: {
  allRows: readonly DesktopSessionSummary[];
  projects: readonly DesktopProjectSummary[];
  selection: NavigationSelection;
  revealedProject: { path: string; nonce: number } | undefined;
  orderPrefs: SessionOrderPrefs;
  customOrders: CustomSessionOrders;
  updateProjectOpen: (update: (current: OpenMap) => OpenMap) => void;
}) {
  // Favorites stay in their project folder: the folder is a classification,
  // not a second Recent.
  const activityProjectGroups = useMemo(
    () =>
      projects.length === 0
        ? []
        : groupProjectSessions(
            projects,
            allRows.filter((session) => !session.archived && !isAutomationRow(session))
          ),
    [allRows, projects]
  );
  // Selecting a session (identity change, not a list refresh) opens its
  // collapsed project folder. The id is remembered once its folder is found, so
  // collapsing that folder again while the session stays selected sticks.
  const selectedSessionId = selection.kind === 'session' ? selection.id : '';
  const revealedSelectionRef = useRef('');
  useEffect(() => {
    if (!selectedSessionId) {
      revealedSelectionRef.current = '';
      return;
    }
    if (revealedSelectionRef.current === selectedSessionId) return;
    const group = activityProjectGroups.find((candidate) =>
      candidate.rows.some((session) => session.id === selectedSessionId)
    );
    if (!group) return;
    revealedSelectionRef.current = selectedSessionId;
    // A session already on screen (e.g. clicked in Recent) needs no reveal;
    // opening a folder above it would shift the row out from under the pointer.
    const shown = [
      ...document.querySelectorAll<HTMLElement>('.session-sidebar-sessions .session-row[data-session-id]'),
    ].some((row) => row.dataset.sessionId === selectedSessionId && row.getClientRects().length > 0);
    if (shown) return;
    updateProjectOpen((current) => withOpen(current, group.key, true));
  }, [activityProjectGroups, selectedSessionId, updateProjectOpen]);
  // A project added from the Projects header menu opens and scrolls into view
  // once its folder exists in the grouping (the catalog refresh lands after the
  // add resolves); each add is handled once.
  const revealedNonceRef = useRef(revealedProject?.nonce ?? 0);
  useEffect(() => {
    if (!revealedProject || revealedNonceRef.current === revealedProject.nonce) return;
    const key = projectIdentity(revealedProject.path);
    if (!activityProjectGroups.some((group) => group.key === key)) return;
    revealedNonceRef.current = revealedProject.nonce;
    updateProjectOpen((current) => withOpen(current, key, true));
    window.requestAnimationFrame(() =>
      document
        .querySelector(`.sidebar-projects [data-project-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    );
  }, [activityProjectGroups, revealedProject, updateProjectOpen]);
  const activityProjectKeys = useMemo(() => activityProjectGroups.map((group) => group.key), [activityProjectGroups]);
  const projectOrder = usePersistedListOrder('mixdog:session-sidebar-project-order', activityProjectKeys, {
    dropAnchor: ':scope > .project-folder',
  });
  const projectGroups = useMemo(() => {
    const byKey = new Map(activityProjectGroups.map((group) => [group.key, group]));
    return projectOrder.orderedIds.flatMap((key) => {
      const group = byKey.get(key);
      return group
        ? [
            {
              ...group,
              rows: applySessionOrder(group.rows, orderPrefs.sessions, customOrders[`project:${key}`]),
            },
          ]
        : [];
    });
  }, [activityProjectGroups, customOrders, orderPrefs.sessions, projectOrder.orderedIds]);
  return { activityProjectGroups, projectOrder, projectGroups };
}

/** Drop key of the Favorites section; project keys are paths, so no clash. */
const FAVORITES_DROP_KEY = ':favorites';

/** Gap between open sections (10-rail-pages.css `.sidebar-recent + .sidebar-recent`). */
const DROP_ZONE_REACH = 20;

/** Key of the drop target nearest the pointer, within the section gap. */
function nearestDropZone(event: React.DragEvent<HTMLElement>): string {
  let best = '';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const zone of event.currentTarget.querySelectorAll<HTMLElement>('[data-session-drop-zone]')) {
    const { top, bottom } = zone.getBoundingClientRect();
    const distance = Math.max(top - event.clientY, event.clientY - bottom, 0);
    if (distance <= DROP_ZONE_REACH && distance < bestDistance) {
      best = zone.dataset.sessionDropZone ?? '';
      bestDistance = distance;
    }
  }
  return best;
}

/** Dragging a session row onto a project folder moves it there; onto
 *  Favorites, it stars it. */
function useSessionFolderDrop(
  activityProjectGroups: readonly ProjectSessionGroup[],
  onMoveSessionToProject: ((sessionId: string, projectPath: string) => Promise<void>) | undefined,
  updateProjectOpen: (update: (current: OpenMap) => OpenMap) => void,
  allRows: readonly DesktopSessionSummary[],
  onFavoriteSession: (sessionId: string, favorite: boolean) => Promise<void>
) {
  // Dragging a session row over a project folder moves it there. Only the
  // folder the session is not already in is a valid target; anything else
  // gets no highlight and no drop.
  const sessionGroupKeys = useMemo(() => {
    const keys = new Map<string, string>();
    for (const group of activityProjectGroups) for (const session of group.rows) keys.set(session.id, group.key);
    return keys;
  }, [activityProjectGroups]);
  const [draggedSessionId, setDraggedSessionId] = useState('');
  const [sessionDropKey, setSessionDropKey] = useState('');
  // The native event a drop target already took, so the scroller above it
  // neither re-handles nor clears it.
  const claimedEvent = useRef<Event | null>(null);
  const moveSession = (sessionId: string, projectPath: string) => {
    void onMoveSessionToProject?.(sessionId, projectPath).catch(() => {});
  };
  const canDropSession = (group: ProjectSessionGroup) =>
    Boolean(onMoveSessionToProject && draggedSessionId) && sessionGroupKeys.get(draggedSessionId) !== group.key;
  const sessionDrop = onMoveSessionToProject && {
    activeKey: sessionDropKey,
    onDragOver: (group: ProjectSessionGroup, event: React.DragEvent<HTMLElement>) => {
      if (!canDropSession(group)) {
        setSessionDropKey('');
        return false;
      }
      event.preventDefault();
      claimedEvent.current = event.nativeEvent;
      event.dataTransfer.dropEffect = 'move';
      setSessionDropKey(group.key);
      return true;
    },
    onDragLeave: (group: ProjectSessionGroup, event: React.DragEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setSessionDropKey((current) => (current === group.key ? '' : current));
    },
    onDrop: (group: ProjectSessionGroup, event: React.DragEvent<HTMLElement>) => {
      if (!canDropSession(group)) return false;
      event.preventDefault();
      claimedEvent.current = event.nativeEvent;
      const sessionId = draggedSessionId;
      setSessionDropKey('');
      setDraggedSessionId('');
      updateProjectOpen((current) => withOpen(current, group.key, true));
      moveSession(sessionId, group.path);
      return true;
    },
  };
  // Favorites takes a dragged session that is not starred yet (and not
  // archived: Favorites hides archived rows); a favorite's own drag keeps
  // reordering the list.
  const favoriteCandidateIds = useMemo(
    () => new Set(allRows.filter((session) => !session.favorite && !session.archived).map((session) => session.id)),
    [allRows]
  );
  const canFavorite = Boolean(draggedSessionId) && favoriteCandidateIds.has(draggedSessionId);
  const favoriteDrop: FavoriteSessionDrop = {
    key: FAVORITES_DROP_KEY,
    available: canFavorite,
    active: sessionDropKey === FAVORITES_DROP_KEY,
    onDragOver: (event) => {
      if (!canFavorite) return false;
      event.preventDefault();
      claimedEvent.current = event.nativeEvent;
      event.dataTransfer.dropEffect = 'move';
      setSessionDropKey(FAVORITES_DROP_KEY);
      return true;
    },
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setSessionDropKey((current) => (current === FAVORITES_DROP_KEY ? '' : current));
    },
    onDrop: (event) => {
      if (!canFavorite) return false;
      event.preventDefault();
      claimedEvent.current = event.nativeEvent;
      const sessionId = draggedSessionId;
      setSessionDropKey('');
      setDraggedSessionId('');
      void onFavoriteSession(sessionId, true).catch(() => {});
      return true;
    },
  };
  // The scroller's side padding and the gaps between sections hold no target
  // element, so a pointer there used to be refused (and the outline dropped).
  // It resolves to the target whose box is nearest, within one section gap;
  // anywhere else the scroller takes no drop and a stale outline goes away
  // (the target's own dragleave is not reliable once the list scrolls under a
  // still pointer).
  const gapDrop: SessionGapDrop = {
    onDragOver: (event) => {
      if (claimedEvent.current === event.nativeEvent) return;
      const zone = event.target === event.currentTarget ? nearestDropZone(event) : '';
      const group = activityProjectGroups.find((entry) => entry.key === zone);
      const taken =
        zone === FAVORITES_DROP_KEY ? favoriteDrop.onDragOver(event) : group && sessionDrop?.onDragOver(group, event);
      if (!taken) setSessionDropKey('');
    },
    // Leaving the sidebar (or the window) mid-drag ends no drop, so the
    // outline of the last gap hit would stay on.
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setSessionDropKey('');
    },
    onDrop: (event) => {
      if (claimedEvent.current === event.nativeEvent) return;
      const zone = event.target === event.currentTarget ? nearestDropZone(event) : '';
      const group = activityProjectGroups.find((entry) => entry.key === zone);
      if (zone === FAVORITES_DROP_KEY) favoriteDrop.onDrop(event);
      else if (group) sessionDrop?.onDrop(group, event);
      setSessionDropKey('');
    },
  };
  return { sessionGroupKeys, moveSession, sessionDrop, favoriteDrop, gapDrop, setDraggedSessionId, setSessionDropKey };
}

interface SessionSidebarProps {
  open: boolean;
  /** Rail destination hosted in the panel area (Projects/Workflows/
   *  Schedules/Webhooks): while active it swaps in for the session list —
   *  the list stays mounted behind a hidden flag (user decision). */
  panelActive?: boolean;
  panelTitle?: string;
  panelTitleDragProps?: React.HTMLAttributes<HTMLSpanElement>;
  children?: React.ReactNode;
  sessions: DesktopSessionSummary[];
  sessionsReady: boolean;
  /** Registered projects: listed as folders in a Projects section above
   *  Recent; with none, the section is absent. */
  projects?: readonly DesktopProjectSummary[];
  /** + on a project section: a new task staged in that project ('' = none). */
  onNewProjectTask?(projectPath: string): void;
  /** Session menu: open beside the focused pane (the drag-to-split result). */
  onOpenSessionInSplit?(sessionId: string, title: string): void;
  /** Session menu: open the session, then its /inherit surface. */
  onInheritSession?(sessionId: string): void;
  /** Project folder menu actions. */
  onRenameProject?(projectPath: string, alias: string): void;
  onRevealProject?(projectPath: string): void;
  onOpenProjectSettings?(projectPath: string): void;
  /** Projects header ⋯ → Add project (opens the shared dialog). `onAdded`
   *  runs once with the path if that dialog ends in an added project. */
  onAddProject?(onAdded?: (projectPath: string) => void): void;
  /** Move a session into a project's sidebar folder ('' = no project).
   *  Membership only: the session's working directory never changes. */
  onMoveSessionToProject?(sessionId: string, projectPath: string): Promise<void>;
  /** Project just added through that dialog: its folder opens and scrolls into view. */
  revealedProject?: { path: string; nonce: number };
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  selection: NavigationSelection;
  onNewTask(): void;
  /** Second fixed launcher row: opens a Studio workspace tab. */
  onNewStudio(): void;
  onPrefetchSession?(sessionId: string): Promise<boolean>;
  onResumeSession(sessionId: string): void;
  /** Opens an agent's chat on the Agents page. */
  onOpenAgent?(sessionId: string, title: string): void;
  onRenameSession(sessionId: string, title: string): Promise<void>;
  /** Archive: the row leaves Recent but the session file stays. */
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  /** Favorite: the row is pinned to the Favorites section above Recent. */
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
  onDeleteSession(sessionId: string): Promise<void>;
}

export const SessionSidebar = React.memo(function SessionSidebar({
  open,
  panelActive = false,
  panelTitle = '',
  panelTitleDragProps,
  children,
  sessions: liveSessions,
  sessionsReady,
  projects = NO_PROJECTS,
  onNewProjectTask,
  onOpenSessionInSplit,
  onInheritSession,
  onRenameProject,
  onRevealProject,
  onOpenProjectSettings,
  onAddProject,
  onMoveSessionToProject,
  revealedProject,
  workingSessionIds,
  unreadSessionIds,
  selection,
  onNewTask,
  onNewStudio,
  onPrefetchSession,
  onResumeSession,
  onOpenAgent,
  onRenameSession,
  onArchiveSession,
  onFavoriteSession,
  onDeleteSession,
}: SessionSidebarProps) {
  // Each rail destination owns its own sidebar shell. Auxiliary destinations
  // must not build duplicate session lists; once a shell has actually shown
  // Sessions, however, retain that list through panel switches and collapse.
  const sessionsMounted = useRef(!panelActive);
  if (!panelActive) sessionsMounted.current = true;
  const hasSessionSurface = sessionsMounted.current;
  const recentScrollerRef = useRef<HTMLDivElement | null>(null);
  // The catalog holds still under a reader's scroll: no re-sort or row move
  // lands until it ends (see useHeldDuringUserScroll).
  const sessions = useHeldDuringUserScroll(recentScrollerRef, liveSessions);
  const editor = useSessionEditor(sessions, onRenameSession);
  const attentionIndex = useSessionAttentionIndex();
  // Busy = the same signals the row status shows: a running turn, a turn
  // waiting on the user, or a session waiting on background work.
  const isBusy = (sessionId: string) =>
    workingSessionIds?.has(sessionId) === true ||
    attentionIndex.needsUser.has(sessionId) ||
    attentionIndex.waiting.has(sessionId);
  const [busyPrompt, setBusyPrompt] = useState<BusyPrompt | null>(null);
  const guardBusy = useStableEvent<Parameters<BusyGuard>, void>((kind, ids, run, confirmedRun = run) => {
    const busyIds = ids.filter(isBusy);
    if (busyIds.length === 0) {
      run();
      return;
    }
    const first = sessions.find((session) => session.id === busyIds[0]);
    setBusyPrompt({ kind, count: busyIds.length, name: first ? sessionLabel(first) : '', run: confirmedRun });
  });
  const archiveSession = useStableEvent((sessionId: string, archived: boolean) => {
    // Restoring a deleted bot's archived chat restores the bot; the host
    // brings its chat back out of 보관됨.
    const row = archived ? undefined : sessions.find((session) => session.id === sessionId);
    if (row?.agentDeleted === true && row.agentHome) {
      return restoreAgent({}, row.agentHome, sessionLabel(row)).then(() => undefined);
    }
    if (!archived || !isBusy(sessionId)) return onArchiveSession(sessionId, archived);
    guardBusy('archive', [sessionId], () => void onArchiveSession(sessionId, true).catch(() => {}));
    return Promise.resolve();
  });
  // Idle: arm the row's inline confirm. Busy: the dialog is the confirmation.
  const requestDelete = useStableEvent((sessionId: string) => {
    // A deleted bot's archived chat goes for good with the bot: asked in plain words.
    const row = sessions.find((session) => session.id === sessionId);
    if (row?.agentDeleted === true) {
      void confirmAction(permanentBotDeleteMessage(sessionLabel(row)), {
        key: `bot-delete-forever:${sessionId}`,
        danger: true,
        confirmLabel: t('Delete'),
      }).then((approved) => {
        if (approved) return onDeleteSession(sessionId).catch(() => {});
      });
      return;
    }
    guardBusy(
      'delete',
      [sessionId],
      () => editor.setConfirmingSessionId(sessionId),
      () => void onDeleteSession(sessionId).catch(() => {})
    );
  });
  const [panelActionSlot, setPanelActionSlot] = useState<HTMLDivElement | null>(null);
  const { sidebarWidth, resizeStart, updateSidebarWidth, finishSidebarResize } = useSidebarWidth();
  const { showAgents, updateShowAgents } = useSidebarSessionFilter();
  const agents = useSidebarAgents(
    sessions,
    unreadSessionIds,
    open && hasSessionSurface,
    onOpenAgent,
    attentionIndex.needsUser
  );
  const {
    allRows,
    orderPrefs,
    customOrders,
    activityFavoriteRows,
    activityRows,
    favoriteRows,
    rows,
    updateOrderPrefs,
    updateCustomOrders,
  } = useSessionOrdering(sessions, hasSessionSurface, showAgents, agents.contactHomeIds);
  const openState = useSidebarOpenState(allRows);
  const archivedRows = useMemo(() => allRows.filter((session) => session.archived), [allRows]);
  const automationRows = useMemo(
    () => openState.automationGroups.flatMap(({ runs }) => runs),
    [openState.automationGroups]
  );
  const [recentRowLimit, setRecentRowLimit] = useState(RECENT_SESSION_INITIAL_ROWS);
  const sectionOrder = usePersistedListOrder('mixdog:session-sidebar-section-order', SIDEBAR_SECTIONS, {
    dropAnchor: ':scope > .sidebar-category-header',
  });
  const folders = useProjectFolderState();
  const { activityProjectGroups, projectOrder, projectGroups } = useProjectGroups({
    allRows,
    projects,
    selection,
    revealedProject,
    orderPrefs,
    customOrders,
    updateProjectOpen: folders.updateProjectOpen,
  });
  const { sessionGroupKeys, moveSession, sessionDrop, favoriteDrop, gapDrop, setDraggedSessionId, setSessionDropKey } =
    useSessionFolderDrop(
      activityProjectGroups,
      onMoveSessionToProject,
      folders.updateProjectOpen,
      allRows,
      onFavoriteSession
    );
  useCustomOrderSync({
    sessionsReady,
    orderPrefs,
    activityFavoriteRows,
    activityRows,
    activityProjectGroups,
    updateCustomOrders,
  });
  const [archivedRowLimit, setArchivedRowLimit] = useState(RECENT_SESSION_INITIAL_ROWS);
  const bulk = useBulkArchiveActions(archivedRows, onArchiveSession, onDeleteSession, guardBusy);
  useEffect(() => {
    if (selection.kind !== 'session') return;
    const selectedIndex = rows.findIndex((session) => session.id === selection.id);
    if (selectedIndex < recentRowLimit) return;
    setRecentRowLimit(selectedIndex + 1);
  }, [recentRowLimit, rows, selection]);
  const revealMoreRecentRows = useCallback(() => {
    setRecentRowLimit((current) => Math.min(rows.length, current + RECENT_SESSION_PAGE_ROWS));
  }, [rows.length]);
  const visibleRecentRows = rows.slice(0, recentRowLimit);
  const sessionReorder = useSessionRowReorder({
    favoriteRows,
    rows,
    visibleRecentRowCount: visibleRecentRows.length,
    projectGroups,
    projectRowLimits: folders.projectRowLimits,
    projectOpen: folders.projectOpen,
    orderPrefs,
    updateOrderPrefs,
    updateCustomOrders,
  });
  const {
    recentSentinelRef,
    hasMoreRecentRows,
    archivedSentinelRef,
    visibleArchivedRows,
    hasMoreArchivedRows,
    handleRecentScroll,
  } = useSidebarListScroll({
    scrollerRef: recentScrollerRef,
    open,
    panelActive,
    selection,
    rows,
    visibleRecentRowCount: visibleRecentRows.length,
    revealMoreRecentRows,
    recentOpen: openState.recentOpen,
    archivedOpen: openState.archivedOpen,
    archivedRows,
    archivedRowLimit,
    setArchivedRowLimit,
    allRows,
    automationsOpen: openState.automationsOpen,
    collapsedAutomations: openState.collapsedAutomations,
    projectOpen: folders.projectOpen,
    projectGroups,
    projectRowLimits: folders.projectRowLimits,
    projectsOpen: openState.projectsOpen,
    sectionOrder,
  });
  useSidebarBootSurface(open, sessionsReady);
  const requestPrefetch = useSessionPrefetch(onPrefetchSession, open, sessionsReady, visibleRecentRows);
  const {
    contextMenu,
    menuOriginId,
    closeContextMenu,
    openSessionMenu,
    openProjectMenu,
    openMenu,
    projectRenameEditor,
  } = useSidebarMenus({
    onResumeSession,
    onOpenSessionInSplit,
    onInheritSession,
    onArchiveSession: archiveSession,
    onFavoriteSession,
    onMoveSessionToProject,
    onAddProject,
    openSessionEditor: editor.openSessionEditor,
    closeSessionEditor: editor.closeSessionEditor,
    requestDelete,
    sessionGroupKeys,
    projectGroups,
    moveSession,
    projectOpen: folders.projectOpen,
    onNewProjectTask,
    onNewTask,
    toggleProject: folders.toggleProject,
    onRevealProject,
    onRenameProject,
    onOpenProjectSettings,
  });
  // A bot row: the 봇 page's own contact menu (프로필 보기, 목록에서 숨기기).
  const openAgentMenu = useStableEvent((contact: AgentContact, point: { x: number; y: number }) =>
    openMenu({
      label: t('Actions for {{title}}', { title: contact.name }),
      ...point,
      items: agentContactMenuItems(
        contact,
        {
          onOpen: (row) => void agents.openAgent(row),
          onProfile: agents.openAgentProfile,
        },
        {},
        'sidebar'
      ),
    })
  );
  // A group room row: the room panel's own actions (agentRoomMenuItems).
  const openRoomMenu = useStableEvent((row: SidebarRoomRow, point: { x: number; y: number }) =>
    openMenu({
      label: t('Actions for {{title}}', { title: row.name }),
      ...point,
      items: agentRoomMenuItems(row.room),
    })
  );
  const attentionOf = (sessionId: string) =>
    sessionAttentionOf(attentionIndex, sessionId, {
      running: workingSessionIds?.has(sessionId) === true,
      unread: unreadSessionIds?.has(sessionId) === true,
    });
  const [rowReorders] = useState(createRowReorderCache);
  const rowContext: SessionRowContext = {
    rowReorders,
    selection,
    workingSessionIds,
    unreadSessionIds,
    attentionOf,
    editor,
    sessionReorder,
    requestPrefetch,
    onResumeSession,
    onDeleteSession,
    requestDelete,
    onArchiveSession: archiveSession,
    onFavoriteSession,
    openSessionMenu,
    onToggleFork: openState.toggleFork,
    setDraggedSessionId,
    setSessionDropKey,
  };
  const renderOrderedRow = (session: DesktopSessionSummary, listKey?: string, rowScope?: string, fork?: ForkRowRole) =>
    renderSessionRow(session, listKey, rowContext, rowScope, fork);
  // Rows a windowed list keeps mounted wherever the reader scrolls: the
  // selected session, an inline rename, a delete in progress and the last
  // session menu's origin (focused and dragged rows are pinned by the list
  // itself).
  const selectedId = selection.kind === 'session' ? selection.id : '';
  const pinnedSessionIds = useMemo(
    () =>
      new Set(
        [
          selectedId,
          editor.editingSessionId,
          editor.confirmingSessionId,
          editor.deletingSessionId,
          menuOriginId,
        ].filter(Boolean)
      ),
    [selectedId, editor.editingSessionId, editor.confirmingSessionId, editor.deletingSessionId, menuOriginId]
  );
  const sectionContext: SidebarSectionContext = {
    agentContacts: agents.contacts,
    agentRooms: agents.rooms,
    onOpenRoom: agents.openRoom,
    selection,
    onOpenAgent: agents.openAgent,
    onOpenAgentMenu: openAgentMenu,
    onOpenRoomMenu: openRoomMenu,
    sectionOrder,
    openState,
    folders,
    favoriteRows,
    rows,
    visibleRecentRows,
    hasMoreRecentRows,
    recentSentinelRef,
    projectGroups,
    projectOrder,
    sessionDrop,
    favoriteDrop,
    gapDrop,
    automationRows,
    archivedRows,
    visibleArchivedRows,
    hasMoreArchivedRows,
    archivedSentinelRef,
    setArchivedRowLimit,
    ...bulk,
    scrollerRef: recentScrollerRef,
    pinnedSessionIds,
    openProjectMenu,
    projectRenameEditor,
    renderOrderedRow,
    sessionsReady,
    workingSessionIds,
    unreadSessionIds,
    attentionOf,
    onAddProject,
    onNewProjectTask,
    onNewTask,
  };
  const displayedSidebarWidth = resizeStart.current?.pendingWidth ?? sidebarWidth;
  return (
    <aside
      id="session-sidebar"
      className={`sidebar session-sidebar ${open ? 'open' : ''}`}
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      aria-hidden={!open}
      aria-label={t('Session manager')}
      style={
        {
          '--session-sidebar-width': `${displayedSidebarWidth}px`,
          '--session-sidebar-min-width': `${MIN_SIDEBAR_WIDTH}px`,
          '--session-sidebar-max-width': `${MAX_SIDEBAR_WIDTH}px`,
          maxWidth: open ? MAX_SIDEBAR_WIDTH : 0,
          /* Full-responsive shell: the open rail yields between its preferred
           width and the 252px floor before the workbench ever scrolls. */
          flexShrink: open ? 1 : 0,
        } as React.CSSProperties
      }
    >
      {sessionPanelHeader({
        panelActive,
        panelTitle,
        panelTitleDragProps,
        setPanelActionSlot,
        orderMenuItems: sessionOrderMenuItems(orderPrefs, updateOrderPrefs, showAgents, updateShowAgents),
      })}
      {hasSessionSurface &&
        sessionsSurface({
          panelActive,
          onNewTask,
          onNewStudio,
          scrollerRef: recentScrollerRef,
          onScroll: handleRecentScroll,
          sectionIds: sectionOrder.orderedIds,
          sectionContext,
        })}
      {/* Rail destinations render here as compact visible lists; their
          editors open as popup dialogs portaled above the workspace. */}
      <div
        className="session-sidebar-scroll session-sidebar-panels session-sidebar-surface"
        data-surface-active={panelActive ? 'true' : 'false'}
        inert={panelActive ? undefined : true}
        aria-hidden={panelActive ? undefined : true}
      >
        <SidebarPanelHeaderSlot.Provider value={panelActionSlot}>{children}</SidebarPanelHeaderSlot.Provider>
      </div>
      <ScmContextMenu state={contextMenu} onClose={closeContextMenu} />
      {busyPrompt && (
        <SettingsConfirmDialog portal options={busyPromptOptions(busyPrompt)} onClose={() => setBusyPrompt(null)} />
      )}
      {sidebarResizeHandle({
        width: displayedSidebarWidth,
        sidebarWidth,
        resizeStart,
        updateSidebarWidth,
        onFinishResize: finishSidebarResize,
      })}
    </aside>
  );
});
