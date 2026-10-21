import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowserFeatureInstalled } from './browser-feature-install';
import { isSshConnectionWindow } from './desktop-connection';
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
  desktopUtilityDockTabEnabled,
} from './desktop-feature-config';
import { OPEN_DOCK_TAB_EVENT, SET_DOCK_OPEN_EVENT, type OpenDockTabDetail } from './open-dock-tab-event';
import { paneActiveSelection } from './pane-layout';
import type { UtilityDockTab } from './UtilityDock';
import { DEFAULT_SIDEBAR_VIEW_ORDER, type SidebarViewGroup } from './sidebar-view-layout';
import {
  initialActiveWorkbenchSideViews,
  useWorkbenchSideViewLayout,
  type WorkbenchSide,
  type WorkbenchSideViewId,
} from './workbench-side-view-layout';
import { usePaneSideDocks, type PaneSideDockDiff } from './pane-side-dock';
import {
  isSessionSidePanelView,
  sessionSideDockEntryForSession,
  terminalSessionsToRestore,
} from './session-side-surface-policy';
import { useStableEvent } from './use-stable-event';
import { allowVisualizeReveal, suppressVisualizeReveal } from './visualize-store';
import type { usePaneWorkspace } from './pane-workspace-state';
import type { useSessionPaneSurfaces } from './use-session-pane-surfaces';

interface AppSideDockOptions {
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  sessionSurfaces: ReturnType<typeof useSessionPaneSurfaces>;
  applySidebarOpen: (open: boolean) => void;
}

export function useAppSideDocks({ paneWorkspace, sessionSurfaces, applySidebarOpen }: AppSideDockOptions) {
  const {
    sessionDiffs,
    sessionPanelViews,
    sessionSideSurfaces,
    setSessionDiff,
    setSessionPanelView,
    setSessionSideSurface,
    dismissBrowserSurface,
  } = sessionSurfaces;
  const browserFeatureInstalled = useBrowserFeatureInstalled();
  // The visualize view always exists: every pane header toggles it in the
  // Changes slot; a coding pane's phone switch lists it once the agent has
  // shown something (pane-side-dock).
  const availableSideViews = useMemo<WorkbenchSideViewId[]>(
    () => [
      ...(desktopFeatureEnabled('sessions') ? ['sessions' as const] : []),
      ...DEFAULT_SIDEBAR_VIEW_ORDER.filter((panel) => desktopSidebarDestinationEnabled(panel)),
      // The Ports panel belongs to server windows.
      ...(isSshConnectionWindow() ? ['ports' as const] : []),
      // Shown only on an agent's home thread (paneRightGroupsFor).
      'routines' as const,
      // Shown only on a group room (paneRightGroupsFor).
      'room' as const,
      'session-diff' as const,
      'visualize' as const,
      ...(browserFeatureInstalled ? ['browser' as const] : []),
      'terminal' as const,
      ...(['agents', 'search', 'source-control', 'pull-requests'] as const).filter((panel) =>
        desktopUtilityDockTabEnabled(panel)
      ),
    ],
    [browserFeatureInstalled]
  );
  const workbenchSideLayout = useWorkbenchSideViewLayout(availableSideViews);
  const sidebarViewGroups = useMemo<readonly SidebarViewGroup[]>(
    () =>
      [...workbenchSideLayout.layout.left, ...workbenchSideLayout.layout.right]
        .map(
          (group) =>
            group.filter((id) =>
              DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as (typeof DEFAULT_SIDEBAR_VIEW_ORDER)[number])
            ) as SidebarViewGroup
        )
        .filter((group) => group.length > 0),
    [workbenchSideLayout.layout]
  );
  const [activeSideViews, setActiveSideViews] = useState<Record<WorkbenchSide, WorkbenchSideViewId | null>>(() =>
    initialActiveWorkbenchSideViews(workbenchSideLayout.layout)
  );
  const paneSideDocks = usePaneSideDocks({
    leafIds: paneWorkspace.leaves.map((leaf) => leaf.id),
    groups: workbenchSideLayout.layout.right,
  });
  // A reload keeps the pane entry (open, terminal) but not the in-memory session
  // surface; give the terminal back to the session each pane starts on, once.
  const restoredTerminals = useRef(false);
  useEffect(() => {
    if (restoredTerminals.current) return;
    restoredTerminals.current = true;
    const owners = paneWorkspace.leaves.map((leaf) => {
      const selection = paneActiveSelection(leaf);
      return { leafId: leaf.id, sessionId: selection?.kind === 'session' ? selection.id : null };
    });
    for (const sessionId of terminalSessionsToRestore(owners, paneSideDocks.entryFor)) {
      setSessionSideSurface(sessionId, 'terminal');
    }
  });
  /** The dock entry the leaf actually shows: the pane's own entry overridden by
   *  its session's browser/terminal/diff/visualize surface. */
  const displayedDockEntry = (leafId: string) => {
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    const sessionId = selection?.kind === 'session' ? selection.id : '';
    return {
      sessionId,
      entry: sessionSideDockEntryForSession(
        paneSideDocks.entryFor(leafId),
        sessionId,
        sessionSideSurfaces.get(sessionId) ?? null,
        sessionDiffs.get(sessionId) ?? null,
        sessionPanelViews.get(sessionId) ?? null
      ),
    };
  };
  // Session-owned surfaces (visualize, browser, terminal, session diff) open
  // the dock without touching the pane entry's own `open`, so the back button
  // must follow what is displayed, not the raw pane entry.
  const focusedPaneDockOpen =
    displayedDockEntry(paneWorkspace.focusedLeafId).entry.open && workbenchSideLayout.layout.right.length > 0;
  const [sidebarDiff, setSidebarDiff] = useState<{ view: WorkbenchSideViewId; diff: PaneSideDockDiff } | null>(null);
  const closeSidebarDiff = useCallback(() => setSidebarDiff(null), []);
  useEffect(() => {
    if (sidebarDiff && activeSideViews.left !== sidebarDiff.view) setSidebarDiff(null);
  }, [activeSideViews.left, sidebarDiff]);

  const dismissDockEntry = (
    leafId: string,
    sessionId: string,
    entry: ReturnType<typeof sessionSideDockEntryForSession>
  ) => {
    if ((entry.surface === 'browser' || entry.surface === 'terminal') && sessionId) {
      if (entry.surface === 'browser') dismissBrowserSurface(sessionId);
      else setSessionSideSurface(sessionId, null);
    }
    if (entry.diff?.source === 'session' && sessionId) {
      setSessionDiff(sessionId, null);
    }
    // Closing the visualize panel is the user's call: a reload or a remote
    // resume leaves it closed (the next agent open or update reveals it).
    if (sessionId && entry.open && entry.surface === '' && entry.view === 'visualize') {
      suppressVisualizeReveal(sessionId);
    }
    // The dock shows ONE child: closing folds the whole unit, so a Session
    // Diff list left under the browser/terminal must not reopen it on close.
    if (sessionId && sessionPanelViews.get(sessionId)) {
      setSessionPanelView(sessionId, null);
    }
    paneSideDocks.setOpen(leafId, false);
  };
  const togglePaneRightRegion = useStableEvent((leafId: string) => {
    const rawEntry = paneSideDocks.entryFor(leafId);
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    const sessionId = selection?.kind === 'session' ? selection.id : '';
    const selectedSurface = sessionSideSurfaces.get(sessionId) ?? null;
    const selectedPanelView = sessionPanelViews.get(sessionId) ?? null;
    const displayedEntry = sessionSideDockEntryForSession(
      rawEntry,
      sessionId,
      selectedSurface,
      sessionDiffs.get(sessionId) ?? null,
      selectedPanelView
    );
    if (displayedEntry.open) {
      dismissDockEntry(leafId, sessionId, displayedEntry);
      return;
    }
    if (sessionId && selectedSurface === null && (rawEntry.surface === 'browser' || rawEntry.surface === 'terminal')) {
      setSessionSideSurface(sessionId, rawEntry.surface);
      paneSideDocks.setOpen(leafId, true);
      return;
    }
    if (
      sessionId &&
      selectedPanelView === null &&
      selectedSurface === null &&
      rawEntry.surface === '' &&
      isSessionSidePanelView(rawEntry.view)
    ) {
      if (rawEntry.view === 'visualize') allowVisualizeReveal(sessionId);
      setSessionPanelView(sessionId, rawEntry.view);
      paneSideDocks.setOpen(leafId, true);
      return;
    }
    paneSideDocks.toggle(leafId);
  });
  const toggleDock = useStableEvent(() => {
    togglePaneRightRegion(paneWorkspace.focusedLeafId);
  });
  const closePaneRightRegion = useStableEvent((leafId: string) => {
    const { sessionId, entry } = displayedDockEntry(leafId);
    dismissDockEntry(leafId, sessionId, entry);
  });
  const openDockTab = useStableEvent((tab: UtilityDockTab) => {
    if (!desktopUtilityDockTabEnabled(tab)) return;
    if (workbenchSideLayout.sideOf(tab) === 'left') {
      setActiveSideViews((current) => (current.left === tab ? current : { ...current, left: tab }));
      applySidebarOpen(true);
      return;
    }
    paneSideDocks.open(paneWorkspace.focusedLeafId, tab);
  });
  useEffect(() => {
    const onOpen = (event: Event) => openDockTab((event as CustomEvent<OpenDockTabDetail>).detail.tab);
    window.addEventListener(OPEN_DOCK_TAB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DOCK_TAB_EVENT, onOpen);
  }, [openDockTab]);
  const setFocusedDockOpen = useStableEvent((open: boolean) => {
    if (open !== focusedPaneDockOpen) toggleDock();
  });
  useEffect(() => {
    const onSet = (event: Event) => setFocusedDockOpen((event as CustomEvent<{ open: boolean }>).detail.open);
    window.addEventListener(SET_DOCK_OPEN_EVENT, onSet);
    return () => window.removeEventListener(SET_DOCK_OPEN_EVENT, onSet);
  }, [setFocusedDockOpen]);

  return {
    workbenchSideLayout,
    sidebarViewGroups,
    activeSideViews,
    setActiveSideViews,
    paneSideDocks,
    focusedPaneDockOpen,
    sidebarDiff,
    setSidebarDiff,
    closeSidebarDiff,
    toggleDock,
    closePaneRightRegion,
    openDockTab,
  };
}
