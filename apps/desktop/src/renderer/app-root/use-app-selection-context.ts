import type { NavigationSelection } from '../navigation';
import { defaultSessionLaneStore, useSessionLane } from '../session-lane-store';
import { navigationKey } from '../text-format';
import { useAppSubmitRouting } from '../use-app-submit-routing';
import { useWorkbenchWorkspace } from '../workbench-workspace';
import { useAppSessionTitle } from '../app-shell-session-title';
import { useAppToolProject } from '../app-shell-tool-project';
import { useLaunchTabMeasurements } from '../use-app-boot';
import { applySessionLaneResult } from './use-app-task-lifecycle';
import { useTranscriptRendererReadiness } from './use-transcript-renderer-readiness';
import { useUnreadViewedSession } from './use-unread-viewed-session';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';
import type { AppSessionLifecycle } from './use-app-session-lifecycle';
import type { AppSessionCommands } from './use-app-session-commands';

/** Submit routing and everything derived from the current selection: title, tool project, workbench workspace. */
export function useAppSelectionContext(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  lifecycle: AppSessionLifecycle,
  commands: AppSessionCommands
) {
  const {
    focusedLeafIdRef,
    paneLeavesRef,
    projectCatalog,
    paneWorkspace,
    shellPanels,
    sideDocks,
    focusedPaneSelection,
  } = shell;
  const { projects, registeredProjectPath, preferredDraftProjectPath, effectiveDraftProjectPath } = projectCatalog;
  const { sidebarOpen, bottomPanel, settingsOpen } = shellPanels;
  const {
    selectionRef,
    navigationEpoch,
    resolvedDraftPrefsFor,
    clearNewTaskPreferences,
    setNewTaskDeferred,
    stageCreatedSession,
    selection,
    requestedSessionId,
    sessions,
    viewedSessionRef,
    unreadViewedSessionRef,
    unreadScreenSessionIdsRef,
    consumeUnread,
    newTaskProjectPath,
  } = nav;
  const { tabs, activateSelection, registerWorkspaceSelection } = lifecycle.taskLifecycle;
  const { renameSession } = commands;

  useLaunchTabMeasurements();
  const { paneDraftSubmitFor, paneSubmitFor, submit } = useAppSubmitRouting({
    selectionRef,
    focusedLeafIdRef,
    paneLeavesRef,
    navigationEpoch,
    resolvedDraftPrefsFor,
    effectiveDraftProjectPath,
    clearNewTaskPreferences,
    setNewTaskDeferred,
    stageCreatedSession,
    activateSelection,
    promoteSelectionInLeaf: paneWorkspace.promoteInLeaf,
    registerWorkspaceSelection,
    applySessionLaneResult,
  });
  const navigationSelection: NavigationSelection = selection;
  // Viewing a session consumes its unread dot.
  useUnreadViewedSession({
    navigationSelection,
    requestedSessionId,
    sidebarOpen,
    dockOpen: sideDocks.focusedPaneDockOpen,
    bottomPanelOpen: bottomPanel.open,
    settingsOpen,
    sessions,
    windowFocusTick: lifecycle.windowFocusTick,
    viewedSessionRef,
    unreadViewedSessionRef,
    screenSessionIdsRef: unreadScreenSessionIdsRef,
    consumeUnread,
  });
  const sessionTitle = useAppSessionTitle({
    navigationSelection,
    sessions,
    tabs,
    renameSession,
  });
  const { selectedSession } = sessionTitle;
  const {
    activeProjectPath,
    toolProjectPath,
    selectToolProject,
    projectChromeLabel,
    activeProjectLabel,
    selectedProjectPath,
  } = useAppToolProject({
    navigationSelection,
    focusedPaneSelection,
    selectedSessionProjectPath: selectedSession?.projectPath || '',
    newTaskProjectPath,
    effectiveDraftProjectPath,
    registeredProjectPath,
    preferredDraftProjectPath,
    projects,
  });
  const workbenchWorkspace = useWorkbenchWorkspace(toolProjectPath);
  const activeTabKey = navigationKey(navigationSelection);
  const { paneTranscriptRendererPending, transcriptRendererPending } = useTranscriptRendererReadiness(
    paneWorkspace.leaves,
    navigationSelection
  );
  // Subscribe to a requested session while its lane is being opened.
  useSessionLane(requestedSessionId, defaultSessionLaneStore, () => true);

  return {
    paneDraftSubmitFor,
    paneSubmitFor,
    submit,
    navigationSelection,
    sessionTitle,
    activeProjectPath,
    toolProjectPath,
    selectToolProject,
    projectChromeLabel,
    activeProjectLabel,
    selectedProjectPath,
    workbenchWorkspace,
    activeTabKey,
    paneTranscriptRendererPending,
    transcriptRendererPending,
  };
}

export type AppSelectionContext = ReturnType<typeof useAppSelectionContext>;
