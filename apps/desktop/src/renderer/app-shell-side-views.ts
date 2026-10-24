import { useCallback, useLayoutEffect, useRef, type MutableRefObject } from 'react';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from './sidebar-view-layout';
import { loadSidebarPanelModule, type SidebarPanelKey } from './app-shell-components';
import { prefetchBrowserPane, prefetchDiffView, prefetchTerminalPane } from './lazy-widgets';
import { loadShellProfiles } from './terminal-shell-profiles';
import { sessionDiffPaneModule, visualizePaneModule } from './first-screen-deferred';
import { preloadUtilityDock } from './app-snapshot-views';
import { loadSidebarReferences, WORKFLOW_REFERENCE_KEYS } from './sidebar-reference-cache';
import { paneActiveSelection, type PaneLeaf } from './pane-layout';
import { isSessionSidePanelView } from './session-side-surface-policy';
import { allowVisualizeReveal } from './visualize-store';
import { subscribeDrawerDismiss } from './drawer-intent';
import { isMobileRemoteSurface } from './mobile-surface';
import { type OpenRequestModule, useModuleOpenRequest } from './use-module-open-request';
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
  /** The committed panes and focus: each navigation among them (a pane's
   *  selection, a pane added or removed, focus moving) drops a pending open. */
  paneLeaves: readonly PaneLeaf[];
  focusedLeafId: string;
  browserSurfaces: ReturnType<typeof useSessionPaneSurfaces>['browserSurfaces'];
  pendingBrowserAutoReveal: ReturnType<typeof useSessionPaneSurfaces>['pendingBrowserAutoReveal'];
  setSessionSideSurface: ReturnType<typeof useSessionPaneSurfaces>['setSessionSideSurface'];
  setSessionPanelView: ReturnType<typeof useSessionPaneSurfaces>['setSessionPanelView'];
  /** What a Visualize open waits for: its chunk, on the phone (the default). */
  visualizeOpenGate?: { module: OpenRequestModule; waits(): boolean };
}

const VISUALIZE_OPEN_GATE = { module: visualizePaneModule, waits: isMobileRemoteSurface };

export function useSideViewPrefetch(
  trackSidebarPanelModule: (panel: SidebarPanelKey, modulePromise: Promise<unknown>) => void
) {
  return useCallback(
    (id: WorkbenchSideViewId) => {
      if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
        const panel = id as SidebarPanelKey;
        trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
        if (panel === 'workflows') void loadSidebarReferences(window.mixdogDesktop, WORKFLOW_REFERENCE_KEYS);
        return;
      }
      if (id === 'browser') {
        void prefetchBrowserPane().catch(() => {});
        return;
      }
      if (id === 'terminal') {
        // The pane chunk and the shell list: a terminal opened next paints
        // directly (SessionTerminalTabs) with its tab named and its ⋯ ready.
        void prefetchTerminalPane().catch(() => {});
        void loadShellProfiles();
        return;
      }
      if (id === 'visualize') {
        // Its chunk stays out of the idle lane; the toggle's hover or touch-down
        // loads it, so the sheet opens with its body.
        void visualizePaneModule.load().catch(() => {});
        return;
      }
      if (id === 'ports') return;
      if (id === 'session-diff') {
        void prefetchDiffView().catch(() => {});
        void sessionDiffPaneModule.load().catch(() => {});
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
  paneLeaves,
  focusedLeafId,
  browserSurfaces,
  pendingBrowserAutoReveal,
  setSessionSideSurface,
  setSessionPanelView,
  visualizeOpenGate = VISUALIZE_OPEN_GATE,
}: SideViewRoutingActions) {
  const selectNow = useCallback(
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
          // Opening the visualize view by hand lets agent opens reveal it again.
          if (id === 'visualize') allowVisualizeReveal(selection.id);
          setSessionSideSurface(selection.id, null);
          // Session Diff selection belongs to this session, just like its browser
          // and terminal; another destination clears that session's selection.
          setSessionPanelView(selection.id, isSessionSidePanelView(id) ? id : null);
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
  // The phone sheet slides in with its body: a Visualize open waits for its
  // chunk (the toggle's touch-down started it), so the sheet never slides
  // empty. Desktop docks open at once. The wait drops when the user moves
  // on first: a drawer dismissal, another side view, or a pane navigation.
  const { request: requestVisualizeOpen, cancel: cancelVisualizeOpen } = useModuleOpenRequest({
    ...visualizeOpenGate,
    subscribeDismiss: subscribeDrawerDismiss,
  });
  // Every committed navigation drops it, at that navigation: a pane showing
  // something else (even one that comes back before the chunk is in), a pane
  // added or removed, or focus moving to another pane.
  const navigation = paneNavigationKey(paneLeaves, focusedLeafId);
  const committedNavigation = useRef(navigation);
  useLayoutEffect(() => {
    if (committedNavigation.current === navigation) return;
    committedNavigation.current = navigation;
    cancelVisualizeOpen();
  }, [cancelVisualizeOpen, navigation]);
  return useCallback(
    (id: WorkbenchSideViewId, paneLeafId?: string) => {
      if (id !== 'visualize') {
        cancelVisualizeOpen();
        selectNow(id, paneLeafId);
        return;
      }
      const leafId = paneLeafId ?? focusedLeafIdRef.current;
      requestVisualizeOpen(() => selectNow(id, leafId));
    },
    [cancelVisualizeOpen, focusedLeafIdRef, requestVisualizeOpen, selectNow]
  );
}

/** What a navigation changes: the focused pane and what each pane shows. */
function paneNavigationKey(leaves: readonly PaneLeaf[], focusedLeafId: string): string {
  return JSON.stringify([focusedLeafId, leaves.map((leaf) => [leaf.id, leaf.activeKey])]);
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
