import { useAppPaneChrome } from '../use-app-pane-chrome';
import { renderPaneDockStripTrailing } from '../app-shell-side-dock';
import { LAST_SESSION_KEY } from './use-app-task-lifecycle';
import { useAppSidebarHub } from './use-app-sidebar-hub';
import { useAppWorkbenchNavigationHub } from './use-app-workbench-navigation-hub';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';
import type { AppSessionLifecycle } from './use-app-session-lifecycle';
import type { AppSessionCommands } from './use-app-session-commands';
import type { AppSelectionContext } from './use-app-selection-context';
import type { AppTabWorkflow } from './use-app-tab-workflow';

/** Pane tab-strip chrome, workbench navigation (shortcuts, quick access, commands) and the sidebar hub. */
export function useAppWorkbenchHubs(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  lifecycle: AppSessionLifecycle,
  commands: AppSessionCommands,
  context: AppSelectionContext,
  tabWorkflow: AppTabWorkflow
) {
  const {
    paneWorkspace,
    shellPanels,
    sideDocks,
    editorState,
    sessionPaneSurfaces,
    focusedPaneSelection,
    activeFileKey,
    quickAccessMode,
    setQuickAccessMode,
  } = shell;
  const { workbenchSideLayout, paneSideDocks, closePaneRightRegion } = sideDocks;
  const { pinTab: pinPaneTab } = paneWorkspace;
  const {
    sessions,
    unreadSessionIds,
    selectionRef,
    viewedSessionRef,
    unreadViewedSessionRef,
    setSelection,
    requestedSessionId,
  } = nav;
  const { tabs, startTask, startProjectlessTask, activateSelection } = lifecycle.taskLifecycle;
  const { startProject, openSettings, renameSession } = commands;
  const { sessionTitle, activeTabKey, toolProjectPath, workbenchWorkspace } = context;
  const {
    openFileTab,
    navigateTab,
    closeTab,
    focusPaneTypingSurface,
    navigateEditorHistory,
    editorNavigationHistory,
    chooseFileTab,
    openTerminalTab,
    openStudioTab,
  } = tabWorkflow;

  const { activatePaneSurface, paneStripFor, stripTitleFor } = useAppPaneChrome({
    tabs,
    sessions,
    paneWorkspace,
    dirtyFileKeys: editorState.dirtyFileKeys,
    workingSessionIds: sessionTitle.workingSessionIds,
    unreadSessionIds,
    selectionRef,
    viewedSessionRef,
    unreadViewedSessionRef,
    setSelection,
    startTask,
    activateSelection,
    openFileTab,
    startProject,
    navigateTab,
    closeTab,
    pinPaneTab,
    renameSession,
    stripTrailing: (leaf) =>
      renderPaneDockStripTrailing(leaf, {
        workbenchSideLayout,
        paneSideDocks,
        sessionSurfaces: sessionPaneSurfaces,
        sideViewDescriptors,
        selectWorkbenchSideView,
        closePaneRightRegion,
        focusLeaf: paneWorkspace.focusLeaf,
      }),
    lastSessionStorageKey: LAST_SESSION_KEY,
  });
  // A desktop notification click reveals its tab through this (app-frame-entry-intake.ts).
  nav.activatePaneSurfaceRef.current = activatePaneSurface;
  const { focusedLeafForShortcuts, tabSwitcher, quickAccessProjectPath, quickAccessRecentFiles, workbenchCommands } =
    useAppWorkbenchNavigationHub({
      ...shellPanels,
      ...sideDocks,
      ...editorState,
      paneWorkspace,
      requestedSessionId,
      focusedPaneSelection,
      activeTabKey,
      navigateTab,
      focusPaneTypingSurface,
      activatePaneSurface,
      startTask,
      startProjectlessTask,
      openSettings,
      setQuickAccessMode,
      navigateEditorHistory,
      editorNavigationHistory,
      chooseFileTab,
      activeFileKey,
      openTerminalTab,
      openStudioTab,
      toolProjectPath,
      workbenchWorkspace,
      quickAccessMode,
    });

  const {
    sidebarNewTask,
    sidebarNewStudio,
    sidebarResumeSession,
    renderSidebarPanel,
    openProjectSettings,
    projectEditorHost,
    projectAddHost,
    openProjectAdd,
    revealedProject,
    sideViewDescriptors,
    selectWorkbenchSideView,
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
  } = useSidebarHubWiring(shell, nav, lifecycle, commands, context, tabWorkflow, quickAccessProjectPath);

  return {
    activatePaneSurface,
    paneStripFor,
    stripTitleFor,
    focusedLeafForShortcuts,
    tabSwitcher,
    quickAccessProjectPath,
    quickAccessRecentFiles,
    workbenchCommands,
    sidebarNewTask,
    sidebarNewStudio,
    sidebarResumeSession,
    renderSidebarPanel,
    openProjectSettings,
    projectEditorHost,
    projectAddHost,
    openProjectAdd,
    revealedProject,
    sideViewDescriptors,
    selectWorkbenchSideView,
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
  };
}

export type AppWorkbenchHubs = ReturnType<typeof useAppWorkbenchHubs>;

/** Sidebar hub: side-view descriptors, sidebar panels, project editor/add hosts and sidebar task entry points. */
function useSidebarHubWiring(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  lifecycle: AppSessionLifecycle,
  commands: AppSessionCommands,
  context: AppSelectionContext,
  tabWorkflow: AppTabWorkflow,
  quickAccessProjectPath: string
) {
  const {
    paneWorkspace,
    shellPanels,
    sideDocks,
    projectCatalog,
    sessionPaneSurfaces,
    extensionsSection,
    setExtensionsSection,
    focusedLeafIdRef,
    paneLeavesRef,
    quickAccessMode,
    setQuickAccessMode,
  } = shell;
  const { closeSidebarForNavigation, onboardingOpen, setOnboardingOpen } = nav;
  const { taskLifecycle, runningAutomationNames, updateDialogOpen, updaterState, closeDesktopUpdate } = lifecycle;
  const { openSession, renameProject, removeProject } = commands;
  const { openStudioTab, pendingUnsavedClose, cancelPendingTabClose } = tabWorkflow;

  return useAppSidebarHub({
    ...shellPanels,
    ...sideDocks,
    ...projectCatalog,
    ...sessionPaneSurfaces,
    runningAutomationNames,
    selectedProjectPath: context.selectedProjectPath,
    quickAccessProjectPath,
    extensionsSection,
    setExtensionsSection,
    closeSidebarForNavigation,
    startTask: taskLifecycle.startTask,
    openStudioTab,
    openSession,
    renameProject,
    removeProject,
    focusedLeafIdRef,
    paneLeavesRef,
    paneLeaves: paneWorkspace.leaves,
    focusedLeafId: paneWorkspace.focusedLeafId,
    onboardingOpen,
    setOnboardingOpen,
    quickAccessMode,
    setQuickAccessMode,
    pendingUnsavedClose,
    cancelPendingTabClose,
    updateDialogOpen,
    updaterState,
    closeDesktopUpdate,
    sessionPaneSurfaces,
  });
}
