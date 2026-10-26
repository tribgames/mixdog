import { useStableEvent } from '../use-stable-event';
import { useAppWorkbenchViews } from './use-app-workbench-views';
import { useProjectEntryRename } from './use-project-entry-rename';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';
import type { AppSessionLifecycle } from './use-app-session-lifecycle';
import type { AppSessionCommands } from './use-app-session-commands';
import type { AppSelectionContext } from './use-app-selection-context';
import type { AppTabWorkflow } from './use-app-tab-workflow';
import type { AppWorkbenchHubs } from './use-app-workbench-hubs';

/** Stable sidebar entry callbacks (project/session context menus). */
function useSidebarEntryEvents(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  commands: AppSessionCommands,
  hubs: AppWorkbenchHubs
) {
  const { paneWorkspace, shellPanels } = shell;
  const { closeSidebarForNavigation, stageNewTaskProject } = nav;
  const { openSession, renameProject, openProjectInExplorer } = commands;
  const { sidebarNewTask, openProjectSettings } = hubs;

  // + on a sidebar project section: a fresh task staged in that project.
  const sidebarNewProjectTask = useStableEvent((projectPath: string) => {
    sidebarNewTask();
    stageNewTaskProject(projectPath);
  });
  // Sidebar right-click menus. "Open to the Side" is the drag-to-split result
  // (a new pane right of the focused one); inheritance needs the session's own
  // tab, so it opens the session first and then its /inherit surface.
  const sidebarOpenSessionInSplit = useStableEvent((sessionId: string, title: string) => {
    closeSidebarForNavigation();
    paneWorkspace.splitLeafAt(paneWorkspace.focusedLeafId, 'right', { kind: 'session', id: sessionId, title });
  });
  const sidebarInheritSession = useStableEvent((sessionId: string) => {
    closeSidebarForNavigation();
    void openSession(sessionId).then(() => shellPanels.openConversationCommandSurface('inherit', sessionId));
  });
  const sidebarRenameProject = useStableEvent((projectPath: string, alias: string) => {
    void renameProject(projectPath, alias);
  });
  // Host-only: a remote surface has no file manager, so the item is hidden
  // whenever the project actions omit the reveal.
  const sidebarRevealProjectEvent = useStableEvent((projectPath: string) => {
    void openProjectInExplorer?.(projectPath);
  });
  const sidebarRevealProject = typeof openProjectInExplorer === 'function' ? sidebarRevealProjectEvent : undefined;
  const sidebarOpenProjectSettings = useStableEvent((projectPath: string) => {
    openProjectSettings(projectPath);
  });

  return {
    sidebarNewProjectTask,
    sidebarOpenSessionInSplit,
    sidebarInheritSession,
    sidebarRenameProject,
    sidebarRevealProject,
    sidebarOpenProjectSettings,
  };
}

/** Project-entry rename, sidebar entry callbacks and the workbench side/dock/problems view renderers. */
export function useAppWorkbenchViewWiring(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  lifecycle: AppSessionLifecycle,
  commands: AppSessionCommands,
  context: AppSelectionContext,
  tabWorkflow: AppTabWorkflow,
  hubs: AppWorkbenchHubs,
  desktopBootReady: boolean
) {
  const { paneWorkspace, editorState, projectCatalog, snapshotStore, sideDocks, sessionPaneSurfaces, shellPanels } =
    shell;
  const { dirtyFileKeys, handleFileDirty, registerEditorSaveHandle } = editorState;
  const { projects, registeredProjectPath } = projectCatalog;
  const { paneSideDocks, setSidebarDiff, workbenchSideLayout, closePaneRightRegion } = sideDocks;
  const { bottomPanel, problemsFilter, setProblemsFilter, problemsCollapseNonce, setProblemsCollapseNonce } =
    shellPanels;
  const {
    sessions,
    sessionCatalogReady,
    unreadSessionIds,
    sidebarSelection,
    closeSidebarForNavigation,
    resolvedDraftPrefsFor,
  } = nav;
  const { prefetchSession, renameSession, archiveSession, favoriteSession, moveSessionToProject, deleteSession } =
    commands;
  const { sessionTitle, workbenchWorkspace, selectToolProject } = context;
  const {
    dockOpenFile,
    dockOpenFileAt,
    dockOpenDiff,
    dockOpenPullRequest,
    dockOpenLeadSession,
    dockOpenAgentSession,
    openFileTab,
    sideFileGuard,
    openProblemQuickFix,
  } = tabWorkflow;
  const {
    openProjectAdd,
    revealedProject,
    sidebarNewTask,
    sidebarNewStudio,
    sidebarResumeSession,
    sideViewDescriptors,
    renderSidebarPanel,
    quickAccessProjectPath,
    selectWorkbenchSideView,
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
  } = hubs;

  const renameProjectEntry = useProjectEntryRename({
    paneWorkspace,
    dirtyFileKeys,
    registerWorkspaceSelection: lifecycle.taskLifecycle.registerWorkspaceSelection,
  });

  const {
    sidebarNewProjectTask,
    sidebarOpenSessionInSplit,
    sidebarInheritSession,
    sidebarRenameProject,
    sidebarRevealProject,
    sidebarOpenProjectSettings,
  } = useSidebarEntryEvents(shell, nav, commands, hubs);

  return useAppWorkbenchViews({
    sessions,
    sessionCatalogReady,
    projects,
    sidebarNewProjectTask,
    sidebarOpenSessionInSplit,
    sidebarInheritSession,
    sidebarRenameProject,
    sidebarRevealProject,
    sidebarOpenProjectSettings,
    sidebarAddProject: openProjectAdd,
    revealedProject,
    workingSessionIds: sessionTitle.workingSessionIds,
    unreadSessionIds,
    sidebarSelection,
    sidebarNewTask,
    sidebarNewStudio,
    prefetchSession,
    sidebarResumeSession,
    renameSession,
    archiveSession,
    favoriteSession,
    moveSessionToProject,
    deleteSession,
    sideViewDescriptors,
    renderSidebarPanel,
    mountedSidebarPanels: shellPanels.mountedSidebarPanels,
    snapshotStore,
    observedAgentSessionIds: sessionTitle.observedAgentSessionIds,
    quickAccessProjectPath,
    workbenchWorkspace,
    selectToolProject,
    dockOpenFile,
    dockOpenFileAt,
    dockOpenDiff,
    dockOpenPullRequest,
    dockOpenLeadSession,
    dockOpenAgentSession,
    closeSidebarForNavigation,
    renameProjectEntry,
    paneSideDocks,
    setSidebarDiff,
    registeredProjectPath,
    resolvedDraftPrefsFor,
    paneWorkspace,
    sessionPaneSurfaces,
    workbenchSideLayout,
    closePaneRightRegion,
    selectWorkbenchSideView,
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
    openFileTab,
    sideFileGuard,
    handleFileDirty,
    registerEditorSaveHandle,
    desktopBootReady,
    bottomPanel,
    problemsFilter,
    setProblemsFilter,
    problemsCollapseNonce,
    setProblemsCollapseNonce,
    openProblemQuickFix,
  });
}
