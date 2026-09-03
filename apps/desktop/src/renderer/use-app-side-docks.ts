import { useCallback, useEffect, useMemo, useState } from "react";
import { useBrowserFeatureInstalled } from "./browser-feature-install";
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
  desktopUtilityDockTabEnabled,
} from "./desktop-feature-config";
import { paneActiveSelection } from "./pane-layout";
import type { UtilityDockTab } from "./UtilityDock";
import {
  DEFAULT_SIDEBAR_VIEW_ORDER,
  type SidebarViewGroup,
} from "./sidebar-view-layout";
import {
  initialActiveWorkbenchSideViews,
  useWorkbenchSideViewLayout,
  type WorkbenchSide,
  type WorkbenchSideViewId,
} from "./workbench-side-view-layout";
import {
  usePaneSideDocks,
  type PaneSideDockDiff,
} from "./pane-side-dock";
import { sessionSideDockEntryForSession } from "./session-side-surface-policy";
import { useStableEvent } from "./use-stable-event";
import type { usePaneWorkspace } from "./pane-workspace-state";
import type { useSessionPaneSurfaces } from "./use-session-pane-surfaces";

interface AppSideDockOptions {
  paneWorkspace: ReturnType<typeof usePaneWorkspace>;
  sessionSurfaces: ReturnType<typeof useSessionPaneSurfaces>;
  applySidebarOpen: (open: boolean) => void;
}

export function useAppSideDocks({
  paneWorkspace,
  sessionSurfaces,
  applySidebarOpen,
}: AppSideDockOptions) {
  const {
    sessionDiffs,
    sessionPanelViews,
    sessionSideSurfaces,
    setSessionDiff,
    setSessionPanelView,
    setSessionSideSurface,
  } = sessionSurfaces;
  const browserFeatureInstalled = useBrowserFeatureInstalled();
  const availableSideViews = useMemo<WorkbenchSideViewId[]>(() => [
    ...(desktopFeatureEnabled("sessions") ? ["sessions" as const] : []),
    ...DEFAULT_SIDEBAR_VIEW_ORDER.filter((panel) =>
      desktopSidebarDestinationEnabled(panel)),
    "studio" as const,
    "session-diff" as const,
    ...(browserFeatureInstalled ? ["browser" as const] : []),
    "terminal" as const,
    ...(["agents", "search", "source-control", "pull-requests"] as const)
      .filter((panel) => desktopUtilityDockTabEnabled(panel)),
  ], [browserFeatureInstalled]);
  const workbenchSideLayout = useWorkbenchSideViewLayout(availableSideViews);
  const sidebarViewGroups = useMemo<readonly SidebarViewGroup[]>(() =>
    [...workbenchSideLayout.layout.left, ...workbenchSideLayout.layout.right]
      .map((group) => (
        group.filter((id) =>
          DEFAULT_SIDEBAR_VIEW_ORDER.includes(
            id as typeof DEFAULT_SIDEBAR_VIEW_ORDER[number],
          )) as SidebarViewGroup
      ))
      .filter((group) => group.length > 0),
  [workbenchSideLayout.layout]);
  const [activeSideViews, setActiveSideViews] = useState<
    Record<WorkbenchSide, WorkbenchSideViewId | null>
  >(() => initialActiveWorkbenchSideViews(workbenchSideLayout.layout));
  const paneSideDocks = usePaneSideDocks({
    leafIds: paneWorkspace.leaves.map((leaf) => leaf.id),
    groups: workbenchSideLayout.layout.right,
  });
  const focusedPaneDockOpen =
    paneSideDocks.entryFor(paneWorkspace.focusedLeafId).open
    && workbenchSideLayout.layout.right.length > 0;
  const [sidebarDiff, setSidebarDiff] = useState<
    { view: WorkbenchSideViewId; diff: PaneSideDockDiff } | null
  >(null);
  const closeSidebarDiff = useCallback(() => setSidebarDiff(null), []);
  useEffect(() => {
    if (sidebarDiff && activeSideViews.left !== sidebarDiff.view) setSidebarDiff(null);
  }, [activeSideViews.left, sidebarDiff]);

  const togglePaneRightRegion = useStableEvent((leafId: string) => {
    const rawEntry = paneSideDocks.entryFor(leafId);
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    const sessionId = selection?.kind === "session" ? selection.id : "";
    const selectedSurface = sessionSideSurfaces.get(sessionId) ?? null;
    const selectedPanelView = sessionPanelViews.get(sessionId) ?? null;
    const displayedEntry = sessionSideDockEntryForSession(
      rawEntry,
      sessionId,
      selectedSurface,
      sessionDiffs.get(sessionId) ?? null,
      selectedPanelView,
    );
    if (displayedEntry.open) {
      if ((displayedEntry.surface === "browser"
        || displayedEntry.surface === "terminal") && sessionId) {
        setSessionSideSurface(sessionId, null);
      }
      if (displayedEntry.diff?.source === "session" && sessionId) {
        setSessionDiff(sessionId, null);
      }
      if (displayedEntry.view === "session-diff"
        && displayedEntry.surface === "" && sessionId) {
        setSessionPanelView(sessionId, null);
      }
      paneSideDocks.setOpen(leafId, false);
      return;
    }
    if (sessionId && selectedSurface === null
      && (rawEntry.surface === "browser" || rawEntry.surface === "terminal")) {
      setSessionSideSurface(sessionId, rawEntry.surface);
      paneSideDocks.setOpen(leafId, true);
      return;
    }
    if (sessionId && selectedPanelView === null && selectedSurface === null
      && rawEntry.surface === "" && rawEntry.view === "session-diff") {
      setSessionPanelView(sessionId, "session-diff");
      paneSideDocks.setOpen(leafId, true);
      return;
    }
    paneSideDocks.toggle(leafId);
  });
  const toggleDock = useStableEvent(() => {
    togglePaneRightRegion(paneWorkspace.focusedLeafId);
  });
  const closePaneRightRegion = useStableEvent((leafId: string) => {
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    const sessionId = selection?.kind === "session" ? selection.id : "";
    const entry = sessionSideDockEntryForSession(
      paneSideDocks.entryFor(leafId),
      sessionId,
      sessionSideSurfaces.get(sessionId) ?? null,
      sessionDiffs.get(sessionId) ?? null,
      sessionPanelViews.get(sessionId) ?? null,
    );
    if ((entry.surface === "browser" || entry.surface === "terminal") && sessionId) {
      setSessionSideSurface(sessionId, null);
    }
    if (entry.diff?.source === "session" && sessionId) {
      setSessionDiff(sessionId, null);
    }
    if (entry.view === "session-diff" && entry.surface === "" && sessionId) {
      setSessionPanelView(sessionId, null);
    }
    paneSideDocks.setOpen(leafId, false);
  });
  const openDockTab = useStableEvent((tab: UtilityDockTab) => {
    if (!desktopUtilityDockTabEnabled(tab)) return;
    if (workbenchSideLayout.sideOf(tab) === "left") {
      setActiveSideViews((current) =>
        current.left === tab ? current : { ...current, left: tab });
      applySidebarOpen(true);
      return;
    }
    paneSideDocks.open(paneWorkspace.focusedLeafId, tab);
  });

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
