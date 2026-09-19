import type React from 'react';
import { useLayoutEffect, useMemo } from 'react';
import { useAppSidebarSurface } from '../use-app-sidebar-surface';
import { useAppMobileBack, useAppMobileInitialClose } from '../app-shell-mobile-back';
import { useSideViewPrefetch, useSideViewSelection, useSideViewReordering } from '../app-shell-side-views';
import { createAppSideViewDescriptors } from '../app-side-view-descriptors';
import type { useAppShellPanels } from '../use-app-shell-panels';
import type { useAppSideDocks } from '../use-app-side-docks';
import type { useSessionPaneSurfaces } from '../use-session-pane-surfaces';
import type { useAppProjectCatalog } from '../use-app-project-catalog';
import type { useDesktopUpdater } from '../use-desktop-updater';
import type { WorkbenchQuickAccessMode } from '../workbench-overlays-loader';
import type { ExtensionsSection } from '../extension-sections';
import type { ProjectsSection } from '../project-sections';
import type { PaneLeaf } from '../pane-layout';
import type { usePaneTabClose } from '../use-pane-tab-close';
import type { useAppTaskLifecycle } from './use-app-task-lifecycle';

export interface UseAppSidebarHubOptions {
  schedulesOpen: boolean;
  webhooksOpen: boolean;
  projectsOpen: boolean;
  sidebarOpen: boolean;
  applySidebarOpen: (open: boolean, motion?: 'animated' | 'instant') => void;
  sidebarViewGroups: ReturnType<typeof useAppSideDocks>['sidebarViewGroups'];
  loadedSidebarPanels: ReturnType<typeof useAppShellPanels>['loadedSidebarPanels'];
  failedSidebarPanels: ReturnType<typeof useAppShellPanels>['failedSidebarPanels'];
  mountedSidebarPanels: ReturnType<typeof useAppShellPanels>['mountedSidebarPanels'];
  sidebarPanes: ReturnType<typeof useAppShellPanels>['sidebarPanes'];
  markSidebarPanelFailed: ReturnType<typeof useAppShellPanels>['markSidebarPanelFailed'];
  retrySidebarPanel: ReturnType<typeof useAppShellPanels>['retrySidebarPanel'];
  closeSidebarPanels: () => void;
  mountSidebarPanel: ReturnType<typeof useAppShellPanels>['mountSidebarPanel'];
  runningAutomationNames: { schedule: Set<string>; webhook: Set<string> };
  projects: ReturnType<typeof useAppProjectCatalog>['projects'];
  projectCatalogReady: boolean;
  selectedProjectPath: string;
  extensionsSection: ExtensionsSection;
  setExtensionsSection: (section: ExtensionsSection) => void;
  projectsSection: ProjectsSection;
  setProjectsSection: (section: ProjectsSection) => void;
  closeSidebarForNavigation: (motion?: 'animated' | 'instant') => void;
  startTask: ReturnType<typeof useAppTaskLifecycle>['startTask'];
  openStudioTab: (leafId?: string) => void;
  openSession: (sessionId: string, force?: boolean, title?: string) => Promise<void>;
  refreshProjects: ReturnType<typeof useAppProjectCatalog>['refreshProjects'];
  renameProject: (oldPath: string, newPath: string) => Promise<void>;
  removeProject: (path: string) => Promise<void>;

  bottomPanel: ReturnType<typeof useAppShellPanels>['bottomPanel'];
  focusedPaneDockOpen: boolean;
  paneSideDocks: ReturnType<typeof useAppSideDocks>['paneSideDocks'];
  focusedLeafIdRef: React.MutableRefObject<string>;
  paneLeavesRef: React.MutableRefObject<PaneLeaf[]>;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  commandSurface: string | null;
  setCommandSurface: ReturnType<typeof useAppShellPanels>['setCommandSurface'];
  setCommandSurfaceSessionId: (id: string) => void;
  onboardingOpen: boolean;
  setOnboardingOpen: (open: boolean) => void;
  quickAccessMode: WorkbenchQuickAccessMode | null;
  setQuickAccessMode: (mode: WorkbenchQuickAccessMode | null) => void;
  pendingUnsavedClose: ReturnType<typeof usePaneTabClose>['pendingUnsavedClose'];
  cancelPendingTabClose: () => void;
  updateDialogOpen: boolean;
  updaterState: ReturnType<typeof useDesktopUpdater>['state'];
  closeDesktopUpdate: () => void;

  trackSidebarPanelModule: (name: string, promise: Promise<unknown>) => void;
  workbenchSideLayout: ReturnType<typeof useAppSideDocks>['workbenchSideLayout'];
  activeSideViews: ReturnType<typeof useAppSideDocks>['activeSideViews'];
  setActiveSideViews: React.Dispatch<React.SetStateAction<ReturnType<typeof useAppSideDocks>['activeSideViews']>>;
  browserSurfaces: ReturnType<typeof useSessionPaneSurfaces>['browserSurfaces'];
  sessionPaneSurfaces: ReturnType<typeof useSessionPaneSurfaces>;
  setSessionSideSurface: ReturnType<typeof useSessionPaneSurfaces>['setSessionSideSurface'];
  setSessionPanelView: ReturnType<typeof useSessionPaneSurfaces>['setSessionPanelView'];
}

export function useAppSidebarHub({
  schedulesOpen,
  webhooksOpen,
  projectsOpen,
  sidebarOpen,
  applySidebarOpen,
  sidebarViewGroups,
  loadedSidebarPanels,
  failedSidebarPanels,
  mountedSidebarPanels,
  sidebarPanes,
  markSidebarPanelFailed,
  retrySidebarPanel,
  closeSidebarPanels,
  mountSidebarPanel,
  runningAutomationNames,
  projects,
  projectCatalogReady,
  selectedProjectPath,
  extensionsSection,
  setExtensionsSection,
  projectsSection,
  setProjectsSection,
  closeSidebarForNavigation,
  startTask,
  openStudioTab,
  openSession,
  refreshProjects,
  renameProject,
  removeProject,
  bottomPanel,
  focusedPaneDockOpen,
  paneSideDocks,
  focusedLeafIdRef,
  paneLeavesRef,
  settingsOpen,
  setSettingsOpen,
  commandSurface,
  setCommandSurface,
  setCommandSurfaceSessionId,
  onboardingOpen,
  setOnboardingOpen,
  quickAccessMode,
  setQuickAccessMode,
  pendingUnsavedClose,
  cancelPendingTabClose,
  updateDialogOpen,
  updaterState,
  closeDesktopUpdate,
  trackSidebarPanelModule,
  workbenchSideLayout,
  activeSideViews,
  setActiveSideViews,
  browserSurfaces,
  sessionPaneSurfaces,
  setSessionSideSurface,
  setSessionPanelView,
}: UseAppSidebarHubOptions) {
  const { sidebarNewTask, sidebarNewStudio, sidebarPanel, sidebarResumeSession, renderSidebarPanel } =
    useAppSidebarSurface({
      schedulesOpen,
      webhooksOpen,
      projectsOpen,
      sidebarOpen,
      viewGroups: sidebarViewGroups,
      loadedSidebarPanels,
      failedSidebarPanels,
      mountedSidebarPanels,
      sidebarPanes,
      markSidebarPanelFailed,
      retrySidebarPanel,
      runningAutomationNames,
      projects,
      projectsReady: projectCatalogReady,
      selectedProjectPath,
      extensionsSection,
      onExtensionsSectionChange: setExtensionsSection,
      projectsSection,
      onProjectsSectionChange: setProjectsSection,
      closeSidebarForNavigation,
      startTask,
      openStudio: openStudioTab,
      openSession,
      refreshProjects,
      renameProject,
      removeProject,
    });

  useAppMobileBack({
    sidebarOpen,
    applySidebarOpen,
    bottomPanelOpen: bottomPanel.open,
    setBottomPanelOpen: bottomPanel.setOpen,
    focusedPaneDockOpen,
    closeFocusedPaneDock: () => {
      paneSideDocks.setOpen(focusedLeafIdRef.current, false);
    },
    settingsOpen,
    setSettingsOpen,
    commandSurface,
    closeCommandSurface: () => {
      setCommandSurface(null);
      setCommandSurfaceSessionId('');
    },
    onboardingOpen,
    setOnboardingOpen,
    quickAccessMode,
    closeQuickAccess: () => setQuickAccessMode(null),
    pendingUnsavedClose: Boolean(pendingUnsavedClose),
    cancelPendingTabClose,
    updateDialogOpen,
    updaterState,
    closeDesktopUpdate,
  });

  useAppMobileInitialClose({
    applySidebarOpen,
    closeFocusedPaneDock: (leafId) => paneSideDocks.setOpen(leafId, false),
    setBottomPanelOpen: bottomPanel.setOpen,
    focusedLeafIdRef,
  });

  const prefetchWorkbenchSideView = useSideViewPrefetch(trackSidebarPanelModule);
  const sideViewDescriptors = useMemo(
    () => createAppSideViewDescriptors(prefetchWorkbenchSideView),
    [prefetchWorkbenchSideView]
  );

  const selectWorkbenchSideView = useSideViewSelection({
    sideOf: workbenchSideLayout.sideOf,
    selectDock: paneSideDocks.select,
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
    pendingBrowserAutoReveal: sessionPaneSurfaces.pendingBrowserAutoReveal,
    setSessionSideSurface,
    setSessionPanelView,
  });

  const { moveWorkbenchSideGroup, moveWorkbenchSideView } = useSideViewReordering(
    workbenchSideLayout.sideOf,
    workbenchSideLayout.moveGroup,
    workbenchSideLayout.moveView,
    setActiveSideViews,
    applySidebarOpen
  );

  useLayoutEffect(() => {
    if (workbenchSideLayout.layout.left.length === 0 && sidebarOpen) {
      applySidebarOpen(false);
    }
  }, [applySidebarOpen, sidebarOpen, workbenchSideLayout.layout.left.length]);

  useLayoutEffect(() => {
    if (!sidebarPanel) return;
    const side = workbenchSideLayout.sideOf(sidebarPanel);
    if (side === 'right') {
      paneSideDocks.open(focusedLeafIdRef.current, sidebarPanel);
      return;
    }
    setActiveSideViews((current) => (current.left === sidebarPanel ? current : { ...current, left: sidebarPanel }));
  }, [paneSideDocks.open, sidebarPanel, workbenchSideLayout.sideOf, setActiveSideViews, focusedLeafIdRef]);

  return {
    sidebarNewTask,
    sidebarNewStudio,
    sidebarPanel,
    sidebarResumeSession,
    renderSidebarPanel,
    sideViewDescriptors,
    selectWorkbenchSideView,
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
  };
}
