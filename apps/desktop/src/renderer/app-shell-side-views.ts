import { useCallback, type MutableRefObject } from 'react';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from './sidebar-view-layout';
import { loadSidebarPanelModule, type SidebarPanelKey } from './app-shell-components';
import { prefetchBrowserPane, prefetchDiffView, prefetchTerminalPane } from './lazy-widgets';
import { preloadUtilityDock } from './app-snapshot-views';
import { paneActiveSelection, type PaneLeaf } from './pane-layout';
import type { useAppSideDocks } from './use-app-side-docks';
import type { useSessionPaneSurfaces } from './use-session-pane-surfaces';
import type { WorkbenchSideViewId, WorkbenchSide, WorkbenchSideViewPlacement } from './workbench-side-view-layout';

interface SideViewRoutingActions {
  sideOf: ReturnType<typeof useAppSideDocks>['workbenchSideLayout']['sideOf'];
  selectDock: ReturnType<typeof useAppSideDocks>['paneSideDocks']['select'];
  activeSideViews: ReturnType<typeof useAppSideDocks>['activeSideViews'];
  setActiveSideViews: ReturnType<typeof useAppSideDocks>['setActiveSideViews'];
  sidebarOpen: boolean;
  applySidebarOpen: (open: boolean) => void;
  closeSidebarPanels: () => void;
  mountSidebarPanel: (panel: SidebarPanelKey) => void;
  trackSidebarPanelModule: (panel: SidebarPanelKey, modulePromise: Promise<unknown>) => void;
  refreshProjects: () => Promise<unknown>;
  paneLeavesRef: MutableRefObject<PaneLeaf[]>;
  focusedLeafIdRef: MutableRefObject<string>;
  browserSurfaces: ReturnType<typeof useSessionPaneSurfaces>['browserSurfaces'];
  pendingBrowserAutoReveal: ReturnType<typeof useSessionPaneSurfaces>['pendingBrowserAutoReveal'];
  setSessionSideSurface: ReturnType<typeof useSessionPaneSurfaces>['setSessionSideSurface'];
  setSessionPanelView: ReturnType<typeof useSessionPaneSurfaces>['setSessionPanelView'];
}

export function useSideViewPrefetch(
  trackSidebarPanelModule: (panel: SidebarPanelKey, modulePromise: Promise<unknown>) => void
) {
  return useCallback(
    (id: WorkbenchSideViewId) => {
      if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
        const panel = id as SidebarPanelKey;
        trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
        return;
      }
      if (id === 'browser') {
        void prefetchBrowserPane().catch(() => {});
        return;
      }
      if (id === 'terminal') {
        void prefetchTerminalPane().catch(() => {});
        return;
      }
      if (id === 'session-diff') {
        void prefetchDiffView().catch(() => {});
        return;
      }
      if (id !== 'sessions') void preloadUtilityDock().catch(() => {});
    },
    [trackSidebarPanelModule]
  );
}

export function useSideViewSelection({
  sideOf,
  selectDock,
  activeSideViews,
  setActiveSideViews,
  sidebarOpen,
  applySidebarOpen,
  closeSidebarPanels,
  mountSidebarPanel,
  trackSidebarPanelModule,
  refreshProjects,
  paneLeavesRef,
  focusedLeafIdRef,
  browserSurfaces,
  pendingBrowserAutoReveal,
  setSessionSideSurface,
  setSessionPanelView,
}: SideViewRoutingActions) {
  return useCallback(
    (id: WorkbenchSideViewId, paneLeafId?: string) => {
      // The browser flows to the right-side branch as the pane dock's own child.
      const side = sideOf(id);
      if (id === 'sessions') {
        closeSidebarPanels();
      } else if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
        const panel = id as SidebarPanelKey;
        mountSidebarPanel(panel);
        trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
        if (panel === 'projects') void refreshProjects().catch(() => undefined);
      }
      if (side === 'right') {
        // A pane strip passes ITS leaf; window-level entry points (commands,
        // rail drops, /settings extensions) land on the focused pane's dock.
        const leafId = paneLeafId ?? focusedLeafIdRef.current;
        const leaf = paneLeavesRef.current.find((candidate) => candidate.id === leafId);
        const selection = leaf ? paneActiveSelection(leaf) : null;
        if (id === 'browser' || id === 'terminal') {
          if (selection?.kind !== 'session') return;
          if (id === 'browser') {
            browserSurfaces.ensure(selection.id);
            pendingBrowserAutoReveal.current.delete(selection.id);
          } else {
            void prefetchTerminalPane().catch(() => {});
          }
          setSessionSideSurface(selection.id, id);
        } else if (selection?.kind === 'session') {
          setSessionSideSurface(selection.id, null);
          // Session Diff selection belongs to this session, just like its browser
          // and terminal; another destination clears that session's selection.
          setSessionPanelView(selection.id, id === 'session-diff' ? 'session-diff' : null);
        }
        selectDock(leafId, id);
        return;
      }
      if (activeSideViews.left === id && sidebarOpen) {
        applySidebarOpen(false);
        return;
      }
      setActiveSideViews((current) => (current.left === id ? current : { ...current, left: id }));
      applySidebarOpen(true);
    },
    [
      activeSideViews,
      applySidebarOpen,
      browserSurfaces,
      closeSidebarPanels,
      focusedLeafIdRef,
      mountSidebarPanel,
      paneLeavesRef,
      pendingBrowserAutoReveal,
      refreshProjects,
      selectDock,
      setSessionPanelView,
      setSessionSideSurface,
      sidebarOpen,
      sideOf,
      trackSidebarPanelModule,
      setActiveSideViews,
    ]
  );
}

export function useSideViewReordering(
  sideOf: ReturnType<typeof useAppSideDocks>['workbenchSideLayout']['sideOf'],
  moveGroup: ReturnType<typeof useAppSideDocks>['workbenchSideLayout']['moveGroup'],
  moveView: ReturnType<typeof useAppSideDocks>['workbenchSideLayout']['moveView'],
  setActiveSideViews: ReturnType<typeof useAppSideDocks>['setActiveSideViews'],
  applySidebarOpen: (open: boolean) => void
) {
  const moveWorkbenchSideGroup = useCallback(
    (
      sourceRoot: WorkbenchSideViewId,
      targetSide: WorkbenchSide,
      targetRoot: WorkbenchSideViewId | null,
      placement: WorkbenchSideViewPlacement
    ) => {
      // The pane-scoped right side is a fixed set (the pure move helpers refuse
      // every cross-right move), so only the left rail actually reorders.
      const sourceSide = sideOf(sourceRoot);
      if (sourceSide === 'right' || targetSide === 'right') return;
      moveGroup(sourceRoot, targetSide, targetRoot, placement);
      const landedRoot = placement.startsWith('inside') && targetRoot ? targetRoot : sourceRoot;
      setActiveSideViews((current) => (current.left === landedRoot ? current : { ...current, left: landedRoot }));
      applySidebarOpen(true);
    },
    [applySidebarOpen, moveGroup, setActiveSideViews, sideOf]
  );

  const moveWorkbenchSideView = useCallback(
    (
      sourceId: WorkbenchSideViewId,
      targetSide: WorkbenchSide,
      targetRoot: WorkbenchSideViewId | null,
      placement: WorkbenchSideViewPlacement
    ) => {
      const sourceSide = sideOf(sourceId);
      if (sourceSide === 'right' || targetSide === 'right') return;
      moveView(sourceId, targetSide, targetRoot, placement);
      const landedView = placement.startsWith('inside') && targetRoot ? targetRoot : sourceId;
      setActiveSideViews((current) => (current.left === landedView ? current : { ...current, left: landedView }));
      applySidebarOpen(true);
    },
    [applySidebarOpen, moveView, setActiveSideViews, sideOf]
  );

  return {
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
  };
}
