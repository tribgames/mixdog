import { useCallback } from 'react';
import { useServerFileReveal } from '../server-transfers';
import { desktopBootPrerequisitesReady } from '../boot-metrics';
import { useAppPersistentPaneSurfaces } from '../use-app-persistent-pane-surfaces';
import { useAppWorkspaceWarmup } from '../use-app-boot';
import { usePaneConversationRenderer } from './use-pane-conversation-renderer';
import { paneSideDockLinkRoutes } from './app-conversation-pane-renderer';
import { applySessionLaneResult } from './use-app-task-lifecycle';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';
import type { AppSessionLifecycle } from './use-app-session-lifecycle';
import type { AppSessionCommands } from './use-app-session-commands';
import type { AppSelectionContext } from './use-app-selection-context';
import type { AppTabWorkflow } from './use-app-tab-workflow';
import type { AppWorkbenchHubs } from './use-app-workbench-hubs';

/** Side-dock link routes, pane conversation/editor/utility surfaces and boot readiness with workspace warmup. */
export function useAppPaneSurfaces(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  lifecycle: AppSessionLifecycle,
  commands: AppSessionCommands,
  context: AppSelectionContext,
  tabWorkflow: AppTabWorkflow,
  hubs: AppWorkbenchHubs
) {
  const {
    sideDocks,
    focusedLeafIdRef,
    projectCatalog,
    applySnapshot,
    shellPanels,
    paneWorkspace,
    editorState,
    snapshotHydrated,
  } = shell;
  const { workbenchSideLayout, paneSideDocks } = sideDocks;
  const { projects, registeredProjectPath } = projectCatalog;
  const {
    openSidebar,
    openConversationCommandSurface,
    sidebarOpen,
    toggleSidebar,
    mountSidebarPanel,
    trackSidebarPanelModule,
  } = shellPanels;
  const { handleFileDirty, registerEditorSaveHandle } = editorState;
  const {
    conversationHandoff,
    resolvedDraftPrefsFor,
    sessions,
    requestedSessionId,
    invokeResult,
    errors,
    composerFocusRequest,
    stageNewTaskModelSelection,
    rememberSessionRouteForNextTask,
    stageNewTaskWorkflow,
    stageNewTaskOrchestrationMode,
    onboardingReady,
    startupSettled,
  } = nav;
  const { taskLifecycle, updaterStateReady } = lifecycle;
  const { openSettings } = commands;
  const {
    sessionTitle,
    projectChromeLabel,
    paneTranscriptRendererPending,
    paneSubmitFor,
    paneDraftSubmitFor,
    submit,
    workbenchWorkspace,
  } = context;
  const { openFileTab, openFileInSideDock, openPreviewToSide, dockOpenAgentSession, fileReveal, latestEditorLocation } =
    tabWorkflow;
  const { selectWorkbenchSideView } = hubs;

  const openSessionDiffInSideDock = useCallback(
    (leafId: string) => selectWorkbenchSideView('session-diff', leafId),
    [selectWorkbenchSideView]
  );
  const sideDockRoutes = paneSideDockLinkRoutes(workbenchSideLayout.layout.right, {
    openFileInSideDock,
    openFolderInSideDock: paneSideDocks.openFolder,
    openSessionDiffInSideDock,
    openPreviewToSide,
  });
  // A server window reveals files in the focused pane's Files tree.
  const openFolderInDock = paneSideDocks.openFolder;
  const revealServerFile = useCallback(
    (project: string, rel: string) => openFolderInDock(focusedLeafIdRef.current, project, rel),
    [openFolderInDock]
  );
  useServerFileReveal(revealServerFile);
  const paneConversationSurface = usePaneConversationRenderer({
    ...taskLifecycle,
    ...sessionTitle,
    conversationHandoff,
    resolvedDraftPrefsFor,
    sessions,
    registeredProjectPath,
    projectChromeLabel,
    paneTranscriptRendererPending,
    requestedSessionId,
    invokeResult,
    errors,
    paneSubmitFor,
    paneDraftSubmitFor,
    submit,
    applySessionLaneResult,
    applySnapshot,
    composerFocusRequest,
    openSidebar,
    openSettings,
    projects,
    stageNewTaskModelSelection,
    rememberSessionRouteForNextTask,
    stageNewTaskWorkflow,
    stageNewTaskOrchestrationMode,
    openConversationCommandSurface,
    openFileTab,
    openFileInSideDock: sideDockRoutes.openFileInSideDock,
    openFolderInSideDock: sideDockRoutes.openFolderInSideDock,
    openSessionDiffInSideDock: sideDockRoutes.openSessionDiffInSideDock,
    openAgentSession: dockOpenAgentSession,
  });

  const { paneFileEditors, paneUtilitySurfacePortals, paneUtilityTabs } = useAppPersistentPaneSurfaces({
    paneWorkspace,
    workbenchWorkspace,
    fileReveal,
    handleFileDirty,
    registerEditorSaveHandle,
    openFileTab,
    openPreviewToSide: sideDockRoutes.openPreviewToSide,
    latestEditorLocation,
    sidebarOpen,
    toggleSidebar,
  });
  const desktopBootReady = desktopBootPrerequisitesReady({
    snapshotHydrated,
    onboardingReady,
    updaterStateReady,
    startupSettled,
    restorePending: paneWorkspace.restorePending,
  });
  useAppWorkspaceWarmup({
    ready: desktopBootReady,
    workspace: paneWorkspace,
    sessions,
    mountSidebarPanel,
    trackSidebarPanelModule,
  });

  return { paneConversationSurface, paneFileEditors, paneUtilitySurfacePortals, paneUtilityTabs, desktopBootReady };
}
