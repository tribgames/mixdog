import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import { commitForkGroupOrder, visibleForkRootIds } from './session-fork-groups';
import {
  listOrderId,
  splitListOrderId,
  syncCustomOrders,
  type CustomSessionOrders,
  type SessionOrderPrefs,
} from './session-order';
import { RECENT_SESSION_PAGE_ROWS } from './session-sidebar-scroll';
import {
  groupAutomationSessions,
  PROJECT_SESSION_PAGE_ROWS,
  type ProjectSessionGroup,
} from './session-sidebar-sections';
import {
  AUTOMATION_OPEN_KEY,
  FORK_OPEN_KEY,
  PROJECT_OPEN_KEY,
  SECTION_OPEN_DEFAULTS,
  SECTION_OPEN_KEY,
  closedKeys,
  isOpen,
  readOpenMap,
  readProjectOpenMap,
  toggleOpen,
  writeOpenMap,
  type OpenMap,
  type OpenStateStorage,
} from './sidebar-open-state';
import { usePersistedListOrder } from './use-persisted-list-order';

/** Whether the session lists include agent sessions (persisted; Lead
 *  sessions only by default). */
export function useSidebarSessionFilter() {
  const key = 'mixdog:session-sidebar-show-agents';
  const [showAgents, setShowAgents] = useState(() => {
    try {
      return window.localStorage.getItem(key) === 'true';
    } catch {
      return false;
    }
  });
  const updateShowAgents = useCallback((value: boolean) => {
    setShowAgents(value);
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      /* The current view still changes when persistence is unavailable. */
    }
  }, []);
  return { showAgents, updateShowAgents };
}

/** Open/collapsed map persisted under `storageKey`; updates write through. */
function usePersistedOpenMap(
  storageKey: string,
  read: (storage: OpenStateStorage, storageKey: string) => OpenMap
): [OpenMap, (update: (current: OpenMap) => OpenMap) => void] {
  const [map, setMap] = useState<OpenMap>(() => read(window.localStorage, storageKey));
  const update = useCallback(
    (change: (current: OpenMap) => OpenMap) => {
      setMap((current) => {
        const next = change(current);
        if (next !== current) writeOpenMap(window.localStorage, storageKey, next);
        return next;
      });
    },
    [storageKey]
  );
  return [map, update];
}

/** Open/collapsed state of the session categories and of the automation
 *  groups (grouped here from the activity-ordered rows). */
export function useSidebarOpenState(allRows: DesktopSessionSummary[]) {
  // Open/collapsed choices persist; an absent entry falls back to its default
  // (everything open except Archived).
  const [sectionOpen, updateSectionOpen] = usePersistedOpenMap(SECTION_OPEN_KEY, readOpenMap);
  const sectionIsOpen = (id: string) => isOpen(sectionOpen, id, SECTION_OPEN_DEFAULTS[id] ?? true);
  const toggleSection = (id: string) =>
    updateSectionOpen((current) => toggleOpen(current, id, SECTION_OPEN_DEFAULTS[id] ?? true));
  const agentsOpen = sectionIsOpen('agents');
  const favoritesOpen = sectionIsOpen('favorites');
  const recentOpen = sectionIsOpen('recent');
  const projectsOpen = sectionIsOpen('projects');
  const automationsOpen = sectionIsOpen('automations');
  const archivedOpen = sectionIsOpen('archived');
  // allRows is activity-desc, which is the order the grouped runs keep.
  const automationGroups = useMemo(() => groupAutomationSessions(allRows), [allRows]);
  // Only explicit choices are stored, so every automation group — including one
  // that appears after a fresh fire — renders expanded by default (user
  // decision: opening the app on a collapsed list buried the runs behind an
  // extra click).
  const [automationOpen, updateAutomationOpen] = usePersistedOpenMap(AUTOMATION_OPEN_KEY, readOpenMap);
  const collapsedAutomations = useMemo(() => closedKeys(automationOpen), [automationOpen]);
  const toggleAutomationGroup = useCallback(
    (key: string) => updateAutomationOpen((current) => toggleOpen(current, key)),
    [updateAutomationOpen]
  );
  const [forkOpen, updateForkOpen] = usePersistedOpenMap(FORK_OPEN_KEY, readOpenMap);
  const toggleFork = useCallback(
    (sessionId: string) => updateForkOpen((current) => toggleOpen(current, sessionId)),
    [updateForkOpen]
  );
  return {
    forkOpen,
    toggleFork,
    agentsOpen,
    favoritesOpen,
    recentOpen,
    projectsOpen,
    automationsOpen,
    archivedOpen,
    toggleSection,
    automationGroups,
    collapsedAutomations,
    toggleAutomationGroup,
  };
}

/** Project folders' open state and per-folder visible row counts. */
export function useProjectFolderState() {
  // Explicit folder choices only; a folder without an entry is open.
  const [projectOpen, updateProjectOpen] = usePersistedOpenMap(PROJECT_OPEN_KEY, readProjectOpenMap);
  const [projectRowLimits, setProjectRowLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const toggleProject = useCallback(
    (key: string) => updateProjectOpen((current) => toggleOpen(current, key)),
    [updateProjectOpen]
  );
  const showMoreProjectRows = useCallback((key: string) => {
    setProjectRowLimits((current) =>
      new Map(current).set(key, (current.get(key) ?? PROJECT_SESSION_PAGE_ROWS) + RECENT_SESSION_PAGE_ROWS)
    );
  }, []);
  return { projectOpen, updateProjectOpen, projectRowLimits, toggleProject, showMoreProjectRows };
}

/** A custom list keeps its positions when activity later reorders: persist
 *  sessions the stored order does not know yet (they sit on top). */
export function useCustomOrderSync({
  sessionsReady,
  orderPrefs,
  activityFavoriteRows,
  activityRows,
  activityProjectGroups,
  updateCustomOrders,
}: {
  sessionsReady: boolean;
  orderPrefs: SessionOrderPrefs;
  activityFavoriteRows: readonly DesktopSessionSummary[];
  activityRows: readonly DesktopSessionSummary[];
  activityProjectGroups: readonly ProjectSessionGroup[];
  updateCustomOrders: (update: (current: CustomSessionOrders) => CustomSessionOrders) => void;
}) {
  useEffect(() => {
    if (!sessionsReady) return;
    const lists: { key: string; ids: string[] }[] = [];
    if (orderPrefs.favorites === 'custom') {
      lists.push({ key: 'favorites', ids: activityFavoriteRows.map((session) => session.id) });
    }
    if (orderPrefs.sessions === 'custom') {
      lists.push({ key: 'recent', ids: activityRows.map((session) => session.id) });
      for (const group of activityProjectGroups) {
        lists.push({ key: `project:${group.key}`, ids: group.rows.map((session) => session.id) });
      }
    }
    if (lists.length) updateCustomOrders((current) => syncCustomOrders(current, lists));
  }, [activityFavoriteRows, activityProjectGroups, activityRows, orderPrefs, sessionsReady, updateCustomOrders]);
}

/** Drag-reorder of session rows inside their own list (Favorites, Recent, one
 *  project folder). One hook instance serves every list: ids are list-scoped,
 *  and `accepts` keeps a drop inside the list the drag started in. */
export function useSessionRowReorder({
  favoriteRows,
  rows,
  visibleRecentRowCount,
  projectGroups,
  projectRowLimits,
  projectOpen,
  orderPrefs,
  updateOrderPrefs,
  updateCustomOrders,
}: {
  favoriteRows: readonly DesktopSessionSummary[];
  rows: readonly DesktopSessionSummary[];
  visibleRecentRowCount: number;
  projectGroups: readonly ProjectSessionGroup[];
  projectRowLimits: ReadonlyMap<string, number>;
  projectOpen: OpenMap;
  orderPrefs: SessionOrderPrefs;
  updateOrderPrefs: (update: Partial<SessionOrderPrefs>) => void;
  updateCustomOrders: (update: (current: CustomSessionOrders) => CustomSessionOrders) => void;
}) {
  const orderLists = new Map<string, { rows: readonly DesktopSessionSummary[]; visible: number }>();
  orderLists.set('favorites', { rows: favoriteRows, visible: favoriteRows.length });
  orderLists.set('recent', { rows, visible: visibleRecentRowCount });
  for (const group of projectGroups) {
    const limit = projectRowLimits.get(group.key) ?? PROJECT_SESSION_PAGE_ROWS;
    orderLists.set(`project:${group.key}`, {
      rows: group.rows,
      visible: isOpen(projectOpen, group.key) ? Math.min(limit, group.rows.length) : 0,
    });
  }
  // Reordering is group-aware like rendering: one id per fork group (its
  // original), over the same whole-group head the list renders.
  const visibleOrderIds = [...orderLists].flatMap(([listKey, list]) =>
    visibleForkRootIds(list.rows, list.visible).map((sessionId) => listOrderId(listKey, sessionId))
  );
  return usePersistedListOrder('mixdog:session-sidebar-session-rows', visibleOrderIds, {
    accepts: (sourceId, targetId) => splitListOrderId(sourceId).listKey === splitListOrderId(targetId).listKey,
    onCommit: (next, sourceId) => {
      const { listKey } = splitListOrderId(sourceId);
      const list = orderLists.get(listKey);
      if (!list) return;
      const nextRootIds = next
        .map(splitListOrderId)
        .filter((entry) => entry.listKey === listKey)
        .map((entry) => entry.sessionId);
      const full = commitForkGroupOrder(list.rows, list.visible, nextRootIds);
      updateCustomOrders((current) => ({ ...current, [listKey]: full }));
      // Dragging in an activity-ordered list turns that list's mode to Custom.
      const kind = listKey === 'favorites' ? 'favorites' : 'sessions';
      if (orderPrefs[kind] !== 'custom') updateOrderPrefs({ [kind]: 'custom' });
    },
  });
}

/** Boot-metrics stages of the Recent surface. */
export function useSidebarBootSurface(open: boolean, sessionsReady: boolean) {
  useLayoutEffect(() => {
    if (!open) return;
    beginBootSurface('session-sidebar', 'recent');
    reportBootSurfaceStage('session-sidebar', 'recent', 'module');
    // Cached rows and the explicit loading/empty shell are already usable.
    // Holding the global boot cover for the authoritative catalog round trip
    // made a restored Task pane delay the whole desktop despite having a
    // complete first frame to show.
    reportBootSurfaceReady('session-sidebar', 'recent', 'shell');
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !sessionsReady) return;
    reportBootSurfaceStage('session-sidebar', 'recent', 'data');
  }, [open, sessionsReady]);
}
