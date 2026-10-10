import type React from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout';
import { DesktopTitlebar, type NavigationSelection } from './navigation';
import { usePaneWorkspace } from './pane-workspace-state';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import type { ExtensionsSection } from './extension-sections';
import type { WorkbenchQuickAccessMode } from './workbench-overlays-loader';

import { desktopBootPrerequisitesReady, markBootStage } from './boot-metrics';
import { DesktopBootGate } from './PaneSurfaceGate';
import { usePaneTypingFocus } from './use-composer-focus';
import { navigationKey } from './text-format';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { useSideFileGuardOpeners } from './app-root/use-side-file-guard';
import { bindAppFrameSideFileGuard } from './app-root/app-frame-side-file-guard';
import { useAppFrameEntryIntake } from './app-root/app-frame-entry-intake';
import { useAppFrameNavigationState } from './app-root/app-frame-navigation-state';
import { useAppFrameBootEffects } from './app-root/app-frame-boot-effects';
import { useEditorNavigation } from './use-editor-navigation';
import { usePaneTabClose } from './use-pane-tab-close';
import { usePaneTabNavigation } from './use-pane-tab-navigation';
import { useAppPaneChrome } from './use-app-pane-chrome';
import { useAppStartupRestore } from './use-app-startup-restore';
import { useAppSessionActions } from './use-app-session-actions';
import { desktopChromeSnapshotsEqual } from './desktop-snapshot-store';
import { RemoteConnectionBanner } from './RemoteConnectionBanner';
import { selectDesktopSnapshot, requestSessionRead, useDesktopSnapshotSelector } from './app-snapshot-views';

import { useDesktopState } from './app-desktop-state';
import { createProjectActions } from './app-project-actions';
import { useSessionCatalog } from './app-session-catalog';
import { useAppShellPanels } from './use-app-shell-panels';
import { useDraftPanePreferences } from './use-draft-pane-preferences';
import { useAppSubmitRouting } from './use-app-submit-routing';
import { useAppPersistentPaneSurfaces } from './use-app-persistent-pane-surfaces';
import { useUnreadSessions } from './app-unread-sessions';
import { useWorkbenchWorkspace } from './workbench-workspace';
import { SessionBrowserParkingHost } from './session-browser-surfaces';
import { useAppSessionOpen } from './app-shell-session-open';
import { PanelBackdrop, SidebarBackdrop } from './app-root/app-backdrops';
import { useAppSessionTitle } from './app-shell-session-title';
import { useAppToolProject, LAST_PROJECT_KEY } from './app-shell-tool-project';
import { renderPaneDockStripTrailing } from './app-shell-side-dock';
import { SessionTerminalParkingHost } from './session-terminal-surfaces';
import { useSessionPaneSurfaces } from './use-session-pane-surfaces';
import { useAppProjectCatalog } from './use-app-project-catalog';
import { useDesktopUpdater } from './use-desktop-updater';
import { useAppSideDocks } from './use-app-side-docks';
import { useAppOnboarding, useAppSettingsMount, useAppWorkspaceWarmup, useLaunchTabMeasurements } from './use-app-boot';
import { AppShellOverlays } from './app-root/AppShellOverlays';
import { useAppWorkbenchViews } from './app-root/use-app-workbench-views';
import { useAppTabActions } from './app-root/use-app-tab-actions';
import { usePaneConversationRenderer } from './app-root/use-pane-conversation-renderer';
import { AppWorkspaceMain } from './app-root/AppWorkspaceMain';
import { AppSidebarDrawer } from './app-root/AppSidebarDrawer';
import { applySessionLaneResult, LAST_SESSION_KEY, useAppTaskLifecycle } from './app-root/use-app-task-lifecycle';
import { useAppEditorState } from './app-root/use-app-editor-state';
import { useProjectEntryRename } from './app-root/use-project-entry-rename';
import { useAppSettingsRouter } from './app-root/use-app-settings-router';
import { useAppSidebarHub } from './app-root/use-app-sidebar-hub';
import { useAppWorkbenchNavigationHub } from './app-root/use-app-workbench-navigation-hub';
import { useAppSessionActivity } from './app-root/use-app-session-activity';
import { useAppInvocation } from './app-root/use-app-invocation';
import { useSidebarFocusRestore } from './app-root/use-sidebar-focus-restore';
import { useStartupPaneSelection } from './app-root/use-startup-pane-selection';
import { useTranscriptRendererReadiness } from './app-root/use-transcript-renderer-readiness';
import { useUnreadViewedSession } from './app-root/use-unread-viewed-session';
import { useStableEvent } from './use-stable-event';

export function App() {
  markBootStage('app-render');
  useLayoutEffect(() => {
    markBootStage('react-committed');
    window.dispatchEvent(new Event('mixdog:react-committed'));
  }, []);
  const { snapshotStore, connected, hydrated: snapshotHydrated, error, setError, applySnapshot } = useDesktopState();
  const snapshot = useDesktopSnapshotSelector(snapshotStore, selectDesktopSnapshot, desktopChromeSnapshotsEqual);
  const paneWorkspace = usePaneWorkspace();
  const sessionPaneSurfaces = useSessionPaneSurfaces();
  const { browserSurfaces, releaseDeletedSessionSurfaces, setSessionSideSurface, terminalSurfaces } =
    sessionPaneSurfaces;
  const shellPanels = useAppShellPanels(paneWorkspace.focusedLeafId);
  const {
    applySidebarOpen,
    bottomPanel,
    closeSidebarPanels,
    mainPanelRef,
    mountSidebarPanel,
    openConversationCommandSurface,
    openProjects,
    openSidebar,
    problemsCollapseNonce,
    problemsFilter,
    setCommandSurface,
    setCommandSurfaceSessionId,
    setProblemsCollapseNonce,
    setProblemsFilter,
    setSettingsOpen,
    settingsOpen,
    sidebarOpen,
    toggleSidebar,
    trackSidebarPanelModule,
  } = shellPanels;
  const { settingsMounted, settingsPrewarmed } = useAppSettingsMount(settingsOpen);
  const sideDocks = useAppSideDocks({
    paneWorkspace,
    sessionSurfaces: sessionPaneSurfaces,
    applySidebarOpen,
  });
  const {
    workbenchSideLayout,
    activeSideViews,
    paneSideDocks,
    focusedPaneDockOpen,
    sidebarDiff,
    setSidebarDiff,
    closeSidebarDiff,
    closePaneRightRegion,
  } = sideDocks;
  const [extensionsSection, setExtensionsSection] = useState<ExtensionsSection>('plugins');
  const projectCatalog = useAppProjectCatalog(snapshot);
  const {
    projects,
    projectCatalogReady,
    projectCatalogValidated,
    registeredProjectPath,
    preferredDraftProjectPath,
    effectiveDraftProjectPath,
    refreshProjects,
  } = projectCatalog;
  // Persisted panes restore synchronously. Session addresses are reconciled
  // incrementally after first paint and remain guarded by exact daemon reads.
  // File editors are normal tabs in the focused pane. The focused leaf is the
  // single source of truth for the Files highlight and tab shortcuts; a
  // separate global editor key made a file take over the whole main panel.
  const { focusedPaneSelection, startupNavigationSelection } = useStartupPaneSelection(paneWorkspace);
  const startupFocusedPaneSelection = focusedPaneSelection;
  const editorState = useAppEditorState({ paneWorkspace, startupFocusedPaneSelection, bottomPanel });
  const { dirtyFileKeys, editorSaveHandles, handleFileDirty, registerEditorSaveHandle } = editorState;

  const { pinTab: pinPaneTab } = paneWorkspace;

  const paneLeavesRef = useRef(paneWorkspace.leaves);
  paneLeavesRef.current = paneWorkspace.leaves;
  const focusedLeafIdRef = useRef(paneWorkspace.focusedLeafId);
  focusedLeafIdRef.current = paneWorkspace.focusedLeafId;
  const activeFileKey = focusedPaneSelection?.kind === 'file' ? navigationKey(focusedPaneSelection) : '';
  const [quickAccessMode, setQuickAccessMode] = useState<WorkbenchQuickAccessMode | null>(null);

  const {
    selection,
    setSelection,
    selectionRef,
    requestedSessionId,
    setRequestedSessionId,
    pendingConversationHandoff,
    conversationHandoff,
    setConversationHandoff,
    openSessionRef,
    navigationEpoch,
    viewedSessionRef,
    unreadViewedSessionRef,
    sidebarSelection,
  } = useAppFrameNavigationState(startupNavigationSelection);

  const {
    clearNewTaskPreferences,
    draftPanePrefs,
    inheritedDraftPrefs,
    lastNewTaskPrefs,
    newTaskDeferred,
    newTaskModelSelection,
    newTaskProjectPath,
    newTaskWorkflow,
    newTaskOrchestrationMode,
    persistDraftPanePrefs,
    rememberSessionRouteForNextTask,
    resetNewTaskDraft,
    resolvedDraftPrefsFor,
    setDraftPrefsVersion,
    setNewTaskDeferred,
    stageNewTaskModelSelection,
    stageNewTaskProject,
    stageNewTaskWorkflow,
    stageNewTaskOrchestrationMode,
  } = useDraftPanePreferences({
    selection,
    selectionRef,
    snapshot,
    projectCatalogValidated,
    preferredDraftProjectPath,
    effectiveDraftProjectPath,
  });
  const [sessionCatalogReady, setSessionCatalogReady] = useState(false);
  const [startupSettled, setStartupSettled] = useState(() =>
    Boolean((window as typeof window & { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled)
  );
  useAppFrameEntryIntake({ sessionCatalogReady, openSessionRef, paneWorkspace });
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  usePaneTypingFocus(paneWorkspace.focusedLeafId, focusedPaneSelection?.kind);
  useAppFrameBootEffects(startupSettled, trackSidebarPanelModule);
  const { onboardingOpen, setOnboardingOpen, onboardingReady } = useAppOnboarding(setSettingsOpen);
  useSidebarFocusRestore(sidebarOpen);

  const { invokeResult, invoke, errors } = useAppInvocation({ error, connected, setError });

  const closeSidebarForNavigation = useCallback(
    (motion: 'animated' | 'instant' = 'animated') => {
      if (window.innerWidth <= 760) {
        applySidebarOpen(false, motion);
        paneSideDocks.setOpen(focusedLeafIdRef.current, false);
      }
    },
    [applySidebarOpen, paneSideDocks]
  );

  const { unreadSessionIds, reconcileUnreadSessions, consumeUnread } = useUnreadSessions({
    viewedSessionRef: unreadViewedSessionRef,
  });

  // Sidebar catalog state, optimistic rename/archive/delete overlay, push + poll
  // freshness: app-session-catalog.ts.
  const {
    sessions,
    setSessions,
    stageCreatedSession,
    refreshSessions,
    pendingRenames: pendingSessionRenames,
    pendingArchives: pendingSessionArchives,
    pendingDeletes: pendingSessionDeletes,
    invalidateInFlight: invalidateSessionListings,
  } = useSessionCatalog(reconcileUnreadSessions);

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
  const {
    tabs,
    setTabs,
    registerWorkspaceSelection,
    activateSelection,
    finishPendingConversationHandoff,
    startTask,
    synchronizeActualHost,
    replaceWithInheritedSession,
  } = taskLifecycle;

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
  const refreshSessionsBestEffort = useCallback(() => {
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions]);

  // Project navigation and registry edits: app-project-actions.ts.
  const { startProject, renameProject, removeProject, openProjectInExplorer } = createProjectActions({
    projects,
    invoke,
    applySnapshot,
    activateSelection,
    synchronizeActualHost,
    closeSidebarForNavigation,
    refreshProjects,
    refreshSessionsBestEffort,
    beginNavigation: () => {
      navigationEpoch.current += 1;
    },
  });
  const { renameSession, archiveSession, favoriteSession, deleteSession } = useAppSessionActions({
    sessions,
    setSessions,
    tabs,
    setTabs,
    selection,
    setError,
    refreshSessions,
    pendingRenames: pendingSessionRenames,
    pendingArchives: pendingSessionArchives,
    pendingDeletes: pendingSessionDeletes,
    invalidateSessionListings,
    applySnapshot,
    activateSelection,
    onSessionDeleted: releaseDeletedSessionSurfaces,
    navigationEpoch,
    setRequestedSessionId,
  });

  const { openSession } = useAppSessionOpen({
    navigationEpoch,
    closeSidebarForNavigation,
    setRequestedSessionId,
    sessions,
    tabs,
    finishPendingConversationHandoff,
    activateSelection,
  });
  openSessionRef.current = openSession;
  const prefetchSession = useCallback((sessionId: string) => requestSessionRead(sessionId), []);
  const { openSettings } = useAppSettingsRouter({
    ...shellPanels,
    ...sideDocks,
    setExtensionsSection,
    focusedLeafIdRef,
    uiOpenRequest: snapshot.uiOpenRequest,
    sessionId: snapshot.sessionId,
    setupUiRequest: snapshot.setupUiRequest,
    setupChanged: snapshot.setupChanged,
  });

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
    dockOpen: focusedPaneDockOpen,
    bottomPanelOpen: bottomPanel.open,
    settingsOpen,
    sessions,
    windowFocusTick,
    viewedSessionRef,
    unreadViewedSessionRef,
    consumeUnread,
  });
  const sessionTitle = useAppSessionTitle({
    navigationSelection,
    sessions,
    tabs,
    renameSession,
  });
  const { selectedSession, workingSessionIds, observedAgentSessionIds } = sessionTitle;
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
  const { sideFileGuardRef, openFileTab, openFileInSideDock } = useSideFileGuardOpeners(openFileTabRaw);

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
    closeSidebarPanels,
    setSessionSideSurface,
    paneSideDocks,
    closePaneRightRegion,
    sessionPaneSurfaces,
    openFileTab,
    openSession,
    activeProjectPath,
    openQuickOpen: () => setQuickAccessMode('files'),
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
  const { activatePaneSurface, paneStripFor, stripTitleFor } = useAppPaneChrome({
    tabs,
    sessions,
    paneWorkspace,
    dirtyFileKeys,
    workingSessionIds,
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
    sideViewDescriptors,
    selectWorkbenchSideView,
    moveWorkbenchSideGroup,
    moveWorkbenchSideView,
  } = useAppSidebarHub({
    ...shellPanels,
    ...sideDocks,
    ...projectCatalog,
    ...sessionPaneSurfaces,
    runningAutomationNames,
    selectedProjectPath,
    extensionsSection,
    setExtensionsSection,
    closeSidebarForNavigation,
    startTask,
    openStudioTab,
    openSession,
    renameProject,
    removeProject,
    focusedLeafIdRef,
    paneLeavesRef,
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

  // A phone/web renderer has no side dock to host the editor: it keeps main tabs.
  const sideDockHostsFiles = !isRemoteHostRenderer() && workbenchSideLayout.layout.right.length > 0;
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
    openFileInSideDock: sideDockHostsFiles ? openFileInSideDock : undefined,
    openFolderInSideDock: sideDockHostsFiles ? paneSideDocks.openFolder : undefined,
  });

  const { paneFileEditors, paneUtilitySurfacePortals, paneUtilityTabs } = useAppPersistentPaneSurfaces({
    paneWorkspace,
    workbenchWorkspace,
    fileReveal,
    handleFileDirty,
    registerEditorSaveHandle,
    openFileTab,
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

  const renameProjectEntry = useProjectEntryRename({ paneWorkspace, dirtyFileKeys, registerWorkspaceSelection });

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
    void openSession(sessionId).then(() => openConversationCommandSurface('inherit', sessionId));
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

  const { renderWorkbenchSideView, renderPaneSideDock, renderPaneProblems } = useAppWorkbenchViews({
    sessions,
    sessionCatalogReady,
    projects,
    sidebarNewProjectTask,
    sidebarOpenSessionInSplit,
    sidebarInheritSession,
    sidebarRenameProject,
    sidebarRevealProject,
    sidebarOpenProjectSettings,
    workingSessionIds,
    unreadSessionIds,
    sidebarSelection,
    sidebarNewTask,
    sidebarNewStudio,
    prefetchSession,
    sidebarResumeSession,
    renameSession,
    archiveSession,
    favoriteSession,
    deleteSession,
    sideViewDescriptors,
    renderSidebarPanel,
    snapshotStore,
    observedAgentSessionIds,
    quickAccessProjectPath,
    workbenchWorkspace,
    selectToolProject,
    dockOpenFile,
    dockOpenFileAt,
    dockOpenDiff,
    dockOpenPullRequest,
    dockOpenLeadSession,
    dockOpenAgentSession,
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

  return (
    <DesktopBootGate restorePending={paneWorkspace.restorePending} ready={desktopBootReady}>
      <div
        className={`app-shell ${sidebarOpen && workbenchSideLayout.layout.left.length ? '' : 'sidebar-collapsed'}`}
        style={
          {
            '--desktop-workspace-min-width': `${DESKTOP_WORKSPACE_MIN_WIDTH}px`,
          } as React.CSSProperties
        }
      >
        <RemoteConnectionBanner />
        <DesktopTitlebar updaterState={updaterState} onOpenUpdate={openDesktopUpdate} />
        <div className="desktop-body">
          <AppSidebarDrawer
            {...shellPanels}
            onboardingActive={onboardingOpen || !onboardingReady}
            closeSidebarForNavigation={closeSidebarForNavigation}
            openSettings={openSettings}
            workbenchSideLayout={workbenchSideLayout}
            sideViewDescriptors={sideViewDescriptors}
            activeSideViews={activeSideViews}
            selectWorkbenchSideView={selectWorkbenchSideView}
            moveWorkbenchSideGroup={moveWorkbenchSideGroup}
            moveWorkbenchSideView={moveWorkbenchSideView}
            renderWorkbenchSideView={renderWorkbenchSideView}
            sidebarDiff={sidebarDiff}
            closeSidebarDiff={closeSidebarDiff}
            openFileTab={openFileTab}
          />
          <SidebarBackdrop open={sidebarOpen} onClose={() => applySidebarOpen(false)} />
          <main className="main-panel" ref={mainPanelRef}>
            <AppWorkspaceMain
              {...taskLifecycle}
              {...sessionTitle}
              navigationSelection={navigationSelection}
              activeProjectLabel={activeProjectLabel}
              transcriptRendererPending={transcriptRendererPending}
              invokeResult={invokeResult}
              errors={errors}
              submit={submit}
              applySnapshot={applySnapshot}
              composerFocusRequest={composerFocusRequest}
              openSidebar={openSidebar}
              openSettings={openSettings}
              projects={projects}
              newTaskModelSelection={newTaskModelSelection}
              newTaskWorkflow={newTaskWorkflow}
              newTaskOrchestrationMode={newTaskOrchestrationMode}
              stageNewTaskModelSelection={stageNewTaskModelSelection}
              rememberSessionRouteForNextTask={rememberSessionRouteForNextTask}
              stageNewTaskWorkflow={stageNewTaskWorkflow}
              stageNewTaskOrchestrationMode={stageNewTaskOrchestrationMode}
              activeProjectPath={activeProjectPath}
              openFileTab={openFileTab}
              openConversationCommandSurface={openConversationCommandSurface}
              paneWorkspace={paneWorkspace}
              observedAgentSessionIds={observedAgentSessionIds}
              paneStripFor={paneStripFor}
              paneConversationSurface={paneConversationSurface}
              paneFileEditors={paneFileEditors}
              paneUtilityTabs={paneUtilityTabs}
              renderPaneSideDock={renderPaneSideDock}
              renderPaneProblems={renderPaneProblems}
              activatePaneSurface={activatePaneSurface}
              openDroppedPaths={openDroppedPaths}
            />
          </main>
          <SessionBrowserParkingHost controller={browserSurfaces} />
          <SessionTerminalParkingHost controller={terminalSurfaces} />
          <PanelBackdrop open={bottomPanel.open} onClose={() => bottomPanel.setOpen(false)} />
        </div>
        {paneUtilitySurfacePortals}
        <AppShellOverlays
          {...shellPanels}
          quickAccessMode={quickAccessMode}
          quickAccessProjectPath={quickAccessProjectPath}
          quickAccessRecentFiles={quickAccessRecentFiles}
          workbenchCommands={workbenchCommands}
          openFileTab={openFileTab}
          setQuickAccessMode={setQuickAccessMode}
          sessions={sessions}
          openSearchSession={sidebarResumeSession}
          tabSwitcher={tabSwitcher}
          focusedLeafForShortcuts={focusedLeafForShortcuts}
          stripTitleFor={stripTitleFor}
          pendingUnsavedClose={pendingUnsavedClose}
          unsavedCloseBusy={unsavedCloseBusy}
          unsavedCloseError={unsavedCloseError}
          saveAndClosePendingTab={saveAndClosePendingTab}
          discardAndClosePendingTab={discardAndClosePendingTab}
          cancelPendingTabClose={cancelPendingTabClose}
          settingsMounted={settingsMounted}
          settingsPrewarmed={settingsPrewarmed}
          openSettings={openSettings}
          replaceWithInheritedSession={replaceWithInheritedSession}
          onboardingOpen={onboardingOpen}
          setOnboardingOpen={setOnboardingOpen}
          updateDialogOpen={updateDialogOpen}
          updaterState={updaterState}
          closeDesktopUpdate={closeDesktopUpdate}
          installDesktopUpdate={installDesktopUpdate}
          error={error}
          connected={connected}
          setError={setError}
          snapshot={snapshot}
        />
        {projectEditorHost}
      </div>
    </DesktopBootGate>
  );
}

export { ApprovalCard } from './ApprovalCard';
export { DesktopUpdateDialog } from './notifications';
export { TranscriptRow } from './transcript-row';
export { ContextUsageIndicator } from './transcript-status';
