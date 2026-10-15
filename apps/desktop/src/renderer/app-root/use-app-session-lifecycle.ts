import { useAppStartupRestore } from '../use-app-startup-restore';
import { LAST_PROJECT_KEY } from '../app-shell-tool-project';
import { useDesktopUpdater } from '../use-desktop-updater';
import { LAST_SESSION_KEY, useAppTaskLifecycle } from './use-app-task-lifecycle';
import { useAppSessionActivity } from './use-app-session-activity';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';

/** Task/tab lifecycle, desktop updater, session activity and startup restore. */
export function useAppSessionLifecycle(shell: AppWorkspaceShell, nav: AppNavigationShell) {
  const {
    paneWorkspace,
    paneLeavesRef,
    focusedLeafIdRef,
    projectCatalog,
    shellPanels,
    applySnapshot,
    startupFocusedPaneSelection,
    startupNavigationSelection,
    snapshot,
    snapshotHydrated,
  } = shell;
  const { projects, projectCatalogReady, preferredDraftProjectPath, effectiveDraftProjectPath, refreshProjects } =
    projectCatalog;
  const { openProjects, setCommandSurface, setCommandSurfaceSessionId } = shellPanels;
  const {
    selection,
    setSelection,
    selectionRef,
    viewedSessionRef,
    unreadViewedSessionRef,
    pendingConversationHandoff,
    setConversationHandoff,
    navigationEpoch,
    setRequestedSessionId,
    setComposerFocusRequest,
    closeSidebarForNavigation,
    newTaskDeferred,
    lastNewTaskPrefs,
    resetNewTaskDraft,
    draftPanePrefs,
    inheritedDraftPrefs,
    persistDraftPanePrefs,
    setDraftPrefsVersion,
    openSessionRef,
    stageNewTaskProject,
    sessions,
    refreshSessions,
    subscribeSessionsRemoved,
    clearNewTaskPreferences,
    invoke,
    setSessionCatalogReady,
    setStartupSettled,
    setNewTaskDeferred,
  } = nav;

  const taskLifecycle = useAppTaskLifecycle({
    selection,
    setSelection,
    selectionRef,
    paneWorkspace,
    paneLeavesRef,
    focusedLeafIdRef,
    viewedSessionRef,
    unreadViewedSessionRef,
    pendingConversationHandoff,
    setConversationHandoff,
    navigationEpoch,
    setRequestedSessionId,
    setComposerFocusRequest,
    closeSidebarForNavigation,
    newTaskDeferred,
    lastNewTaskPrefs,
    effectiveDraftProjectPath,
    preferredDraftProjectPath,
    resetNewTaskDraft,
    draftPanePrefs,
    inheritedDraftPrefs,
    persistDraftPanePrefs,
    setDraftPrefsVersion,
    openSessionRef,
    openProjects,
    refreshProjects,
    stageNewTaskProject,
    sessions,
    refreshSessions,
    applySnapshot,
    projects,
    clearNewTaskPreferences,
    setCommandSurface,
    setCommandSurfaceSessionId,
  });
  const { setTabs, activateSelection } = taskLifecycle;

  const {
    state: updaterState,
    ready: updaterStateReady,
    dialogOpen: updateDialogOpen,
    openDialog: openDesktopUpdate,
    closeDialog: closeDesktopUpdate,
    install: installDesktopUpdate,
  } = useDesktopUpdater(invoke);

  const { windowFocusTick, runningAutomationNames } = useAppSessionActivity({
    sessions,
    setTabs,
    refreshSessions,
    setSessionCatalogReady,
    subscribeSessionsRemoved,
    closePaneTab: paneWorkspace.closeTabByKey,
  });
  useAppStartupRestore({
    restorePending: paneWorkspace.restorePending,
    restoredFromStorage: paneWorkspace.restoredFromStorage,
    startupFocusedPaneSelection,
    startupNavigationSelection,
    projectCatalogReady,
    snapshot,
    // Hydration owns readiness. A first-run profile legitimately hydrates to
    // the empty shell snapshot; waiting for object identity to change leaves
    // New Task restore in a permanent pre-start deadlock.
    snapshotReady: snapshotHydrated,
    sessions,
    selectionRef,
    viewedSessionRef,
    unreadViewedSessionRef,
    setSelection,
    setStartupSettled,
    activateSelection,
    openSessionRef,
    lastNewTaskPrefs,
    effectiveDraftProjectPath,
    preferredDraftProjectPath,
    setNewTaskDeferred,
    resetNewTaskDraft,
    lastSessionStorageKey: LAST_SESSION_KEY,
    lastProjectStorageKey: LAST_PROJECT_KEY,
  });

  return {
    taskLifecycle,
    updaterState,
    updaterStateReady,
    updateDialogOpen,
    openDesktopUpdate,
    closeDesktopUpdate,
    installDesktopUpdate,
    windowFocusTick,
    runningAutomationNames,
  };
}

export type AppSessionLifecycle = ReturnType<typeof useAppSessionLifecycle>;
