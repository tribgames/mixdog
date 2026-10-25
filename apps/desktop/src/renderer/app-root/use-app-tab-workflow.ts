import { useEditorNavigation } from '../use-editor-navigation';
import { usePaneTabClose } from '../use-pane-tab-close';
import { usePaneTabNavigation } from '../use-pane-tab-navigation';
import { useSideFileGuardOpeners } from './use-side-file-guard';
import { bindAppFrameSideFileGuard } from './app-frame-side-file-guard';
import { useAppTabActions } from './use-app-tab-actions';
import { LAST_SESSION_KEY } from './use-app-task-lifecycle';
import type { AppWorkspaceShell } from './use-app-workspace-shell';
import type { AppNavigationShell } from './use-app-navigation-shell';
import type { AppSessionLifecycle } from './use-app-session-lifecycle';
import type { AppSessionCommands } from './use-app-session-commands';
import type { AppSelectionContext } from './use-app-selection-context';

/** Editor navigation, tab opening/navigation/closing and the side-file guard. */
export function useAppTabWorkflow(
  shell: AppWorkspaceShell,
  nav: AppNavigationShell,
  lifecycle: AppSessionLifecycle,
  commands: AppSessionCommands,
  context: AppSelectionContext
) {
  const { paneWorkspace, shellPanels, sessionPaneSurfaces, sideDocks, editorState, setQuickAccessMode } = shell;
  const { setSessionSideSurface } = sessionPaneSurfaces;
  const { paneSideDocks, closePaneRightRegion } = sideDocks;
  const { dirtyFileKeys, editorSaveHandles, handleFileDirty } = editorState;
  const {
    setComposerFocusRequest,
    pendingConversationHandoff,
    setConversationHandoff,
    selectionRef,
    viewedSessionRef,
    unreadViewedSessionRef,
    setSelection,
    setRequestedSessionId,
  } = nav;
  const { setTabs, startTask } = lifecycle.taskLifecycle;
  const { openSession, startProject } = commands;
  const { activeProjectPath, activeTabKey } = context;

  const {
    fileReveal,
    latestEditorLocation,
    editorNavigationHistory,
    openFileTab: openFileTabRaw,
    openProblemQuickFix,
    navigateEditorHistory,
  } = useEditorNavigation({
    setTabs,
    openSelectionInFocusedPane: paneWorkspace.openInFocused,
  });
  // Every main-tab open passes the side-file guard (bound below).
  const { sideFileGuardRef, openFileTab, openFileInSideDock, openPreviewToSide } =
    useSideFileGuardOpeners(openFileTabRaw);

  const {
    openStudioTab,
    openTerminalTab,
    dockOpenFile,
    dockOpenFileAt,
    dockOpenDiff,
    dockOpenPullRequest,
    dockOpenLeadSession,
    dockOpenAgentSession,
    chooseFileTab,
    openDroppedPaths,
  } = useAppTabActions({
    paneWorkspace,
    setTabs,
    closeSidebarPanels: shellPanels.closeSidebarPanels,
    setSessionSideSurface,
    paneSideDocks,
    closePaneRightRegion,
    sessionPaneSurfaces,
    openFileTab,
    openSession,
    activeProjectPath,
    openQuickOpen: () => setQuickAccessMode('files'),
    sessions: nav.sessions,
  });

  const { focusPaneTypingSurface, navigateTab } = usePaneTabNavigation({
    focusedLeafId: paneWorkspace.focusedLeafId,
    activeTabKey,
    openSelectionInFocusedPane: paneWorkspace.openInFocused,
    setComposerFocusRequest,
    startTask,
    startProject,
    openSession,
  });
  const {
    cancelPendingTabClose,
    closeTab,
    confirmSideFileExit,
    discardAndClosePendingTab,
    pendingUnsavedClose,
    saveAndClosePendingTab,
    unsavedCloseBusy,
    unsavedCloseError,
  } = usePaneTabClose({
    paneWorkspace,
    dirtyFileKeys,
    editorSaveHandles,
    handleFileDirty,
    setTabs,
    pendingConversationHandoff,
    setConversationHandoff,
    openSession,
    navigateTab,
    selectionRef,
    viewedSessionRef,
    unreadViewedSessionRef,
    setSelection,
    setRequestedSessionId,
    setComposerFocusRequest,
    lastSessionStorageKey: LAST_SESSION_KEY,
  });
  const sideFileGuard = bindAppFrameSideFileGuard({
    sideFileGuardRef,
    paneSideDocks,
    paneWorkspace,
    dirtyFileKeys,
    handleFileDirty,
    confirmSideFileExit,
    openFileTabRaw,
  });

  return {
    fileReveal,
    latestEditorLocation,
    editorNavigationHistory,
    openProblemQuickFix,
    navigateEditorHistory,
    openFileTab,
    openFileInSideDock,
    openPreviewToSide,
    openStudioTab,
    openTerminalTab,
    dockOpenFile,
    dockOpenFileAt,
    dockOpenDiff,
    dockOpenPullRequest,
    dockOpenLeadSession,
    dockOpenAgentSession,
    chooseFileTab,
    openDroppedPaths,
    focusPaneTypingSurface,
    navigateTab,
    cancelPendingTabClose,
    closeTab,
    discardAndClosePendingTab,
    pendingUnsavedClose,
    saveAndClosePendingTab,
    unsavedCloseBusy,
    unsavedCloseError,
    sideFileGuard,
  };
}

export type AppTabWorkflow = ReturnType<typeof useAppTabWorkflow>;
