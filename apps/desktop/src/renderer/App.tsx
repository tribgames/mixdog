import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout';
import { DesktopTitlebar, type NavigationSelection } from './navigation';
import { paneActiveSelection } from './pane-layout';
import { usePaneWorkspace } from './pane-workspace-state';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import type { ExtensionsSection } from './extension-sections';
import type { ProjectsSection } from './project-sections';
import type { WorkbenchQuickAccessMode } from './workbench-overlays-loader';

import { desktopBootPrerequisitesReady, markBootStage } from './boot-metrics';
import { isMobileRemoteSurface } from './MobileTabOverview';
import { DesktopBootGate } from './PaneSurfaceGate';
import { usePaneTypingFocus } from './use-composer-focus';
import { navigationKey } from './text-format';
import { isMarkdownBodyReady, preloadMarkdownBody } from './markdown-body-loader';
import { useEditorNavigation } from './use-editor-navigation';
import { usePaneTabClose, type ConversationHandoff } from './use-pane-tab-close';
import { usePaneTabNavigation } from './use-pane-tab-navigation';
import { usePushNotificationNavigation } from './use-push-notification-navigation';
import { useSharedIntakeBoot } from './share-target-intake';
import { useAppPaneChrome } from './use-app-pane-chrome';
import { useAppStartupRestore } from './use-app-startup-restore';
import { useAppSessionActions } from './use-app-session-actions';
import { desktopChromeSnapshotsEqual } from './desktop-snapshot-store';
import { RemoteConnectionBanner } from './RemoteConnectionBanner';
const LAST_SESSION_KEY = 'mixdog.desktop-last-session.v1';
import { selectDesktopSnapshot, requestSessionRead, useDesktopSnapshotSelector } from './app-snapshot-views';

import { useDesktopState } from './app-desktop-state';
import { createProjectActions } from './app-project-actions';
import { useSessionCatalog } from './app-session-catalog';
import { useAppShellPanels } from './use-app-shell-panels';
import { useDraftPanePreferences } from './use-draft-pane-preferences';
import { useAppSubmitRouting } from './use-app-submit-routing';
import { useAppPersistentPaneSurfaces } from './use-app-persistent-pane-surfaces';
import { resolveUnreadViewedSessionId, useUnreadSessions } from './app-unread-sessions';
import { useWorkbenchWorkspace } from './workbench-workspace';
import { SessionBrowserParkingHost } from './session-browser-surfaces';
import { useAppSessionOpen } from './app-shell-session-open';
import { t } from './i18n';
import { useAppSessionTitle } from './app-shell-session-title';
import { useAppToolProject, LAST_PROJECT_KEY } from './app-shell-tool-project';
import { renderPaneDockStripTrailing } from './app-shell-side-dock';
import { SessionTerminalParkingHost } from './session-terminal-surfaces';
import { useSessionPaneSurfaces } from './use-session-pane-surfaces';
import { useAppProjectCatalog } from './use-app-project-catalog';
import { useDesktopUpdater } from './use-desktop-updater';
import { useAppSideDocks } from './use-app-side-docks';
import {
  useAppModuleWarmup,
  useAppOnboarding,
  useAppSettingsMount,
  useAppSettingsPreload,
  useAppThemePreference,
  useAppWorkspaceWarmup,
  useLaunchTabMeasurements,
  useStartupCommitMeasurement,
} from './use-app-boot';
import { AppShellOverlays } from './app-root/AppShellOverlays';
import { useAppWorkbenchViews } from './app-root/use-app-workbench-views';
import { useAppTabActions } from './app-root/use-app-tab-actions';
import { usePaneConversationRenderer } from './app-root/use-pane-conversation-renderer';
import { AppWorkspaceMain } from './app-root/AppWorkspaceMain';
import { AppSidebarDrawer } from './app-root/AppSidebarDrawer';
import { applySessionLaneResult, useAppTaskLifecycle } from './app-root/use-app-task-lifecycle';
import { useAppEditorState } from './app-root/use-app-editor-state';
import { useAppSettingsRouter } from './app-root/use-app-settings-router';
import { useAppSidebarHub } from './app-root/use-app-sidebar-hub';
import { useAppWorkbenchNavigationHub } from './app-root/use-app-workbench-navigation-hub';
import { useAppSessionActivity } from './app-root/use-app-session-activity';
import { useAppInvocation } from './app-root/use-app-invocation';

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
  const {
    browserSurfaces,
    releaseDeletedSessionSurfaces,
    sessionDiffs,
    setSessionDiff,
    setSessionSideSurface,
    terminalSurfaces,
  } = sessionPaneSurfaces;
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
  // Projects panel section (Project | Workflow): owned here like the
  // Extensions one so /workflow and /websearch can land on the Workflow tab.
  const [projectsSection, setProjectsSection] = useState<ProjectsSection>('projects');
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
  const startupFocusedPaneSelection = paneWorkspace.focusedLeaf ? paneActiveSelection(paneWorkspace.focusedLeaf) : null;
  const startupNavigationSelection =
    paneWorkspace.restoredFromStorage &&
    startupFocusedPaneSelection &&
    startupFocusedPaneSelection.kind !== 'studio' &&
    startupFocusedPaneSelection.kind !== 'terminal' &&
    startupFocusedPaneSelection.kind !== 'diff' &&
    startupFocusedPaneSelection.kind !== 'pull-request'
      ? startupFocusedPaneSelection
      : null;
  const editorState = useAppEditorState({ paneWorkspace, startupFocusedPaneSelection, bottomPanel });
  const { dirtyFileKeys, editorSaveHandles, handleFileDirty, registerEditorSaveHandle } = editorState;

  const { pinTab: pinPaneTab } = paneWorkspace;
  // File editors are normal tabs in the focused pane. The focused leaf is the
  // single source of truth for the Files highlight and tab shortcuts; a
  // separate global editor key made a file take over the whole main panel.
  const focusedPaneSelection = paneWorkspace.focusedLeaf ? paneActiveSelection(paneWorkspace.focusedLeaf) : null;
  const paneLeavesRef = useRef(paneWorkspace.leaves);
  paneLeavesRef.current = paneWorkspace.leaves;
  const focusedLeafIdRef = useRef(paneWorkspace.focusedLeafId);
  focusedLeafIdRef.current = paneWorkspace.focusedLeafId;
  const activeFileKey = focusedPaneSelection?.kind === 'file' ? navigationKey(focusedPaneSelection) : '';
  const [quickAccessMode, setQuickAccessMode] = useState<WorkbenchQuickAccessMode | null>(null);

  const selectionRef = useRef<NavigationSelection>({ kind: 'new' });

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
    selection: selectionRef.current,
    selectionRef,
    snapshot,
    projectCatalogValidated,
    preferredDraftProjectPath,
    effectiveDraftProjectPath,
  });
  const [requestedSessionId, setRequestedSessionId] = useState('');
  const [markdownBodyReadyForTranscript, setMarkdownBodyReadyForTranscript] = useState(isMarkdownBodyReady);
  // Closing a conversation removes its tab model immediately. The existing
  // Conversation owner remains visible but inert until the fallback session
  // is ready, so slow/failed host resumes never make Ctrl+Q feel ignored.
  const pendingConversationHandoff = useRef<ConversationHandoff | null>(null);
  const [conversationHandoff, setConversationHandoff] = useState<ConversationHandoff | null>(null);
  const openSessionRef = useRef<(sessionId: string, force?: boolean) => Promise<void>>(async () => {});
  // Monotonic navigation stamp: an async switch completion may only activate
  // its target while no NEWER navigation happened in flight (user: + during a
  // settling session switch resurrected the old transcript in the new draft).
  const navigationEpoch = useRef(0);
  const [sessionCatalogReady, setSessionCatalogReady] = useState(false);
  const [startupSettled, setStartupSettled] = useState(() =>
    Boolean((window as typeof window & { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled)
  );
  // A push notification tapped on the phone opens the session it came from —
  // the app may not even have been running when it arrived.
  usePushNotificationNavigation({
    ready: sessionCatalogReady,
    openSession: (sessionId) => {
      void openSessionRef.current(sessionId);
    },
  });
  // A screenshot shared into the app from the phone's share sheet: the service
  // worker parked it during the launch this claims it from.
  useSharedIntakeBoot();
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  usePaneTypingFocus(paneWorkspace.focusedLeafId, focusedPaneSelection?.kind);
  useAppModuleWarmup(startupSettled, trackSidebarPanelModule);
  useStartupCommitMeasurement();
  useAppSettingsPreload();
  useAppThemePreference();
  const { onboardingOpen, setOnboardingOpen, onboardingReady } = useAppOnboarding(setSettingsOpen);
  useEffect(() => {
    if (sidebarOpen) return;
    const sidebar = document.getElementById('session-sidebar');
    if (sidebar?.contains(document.activeElement)) {
      document.querySelector<HTMLButtonElement>('.sessions-link')?.focus();
    }
  }, [sidebarOpen]);

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

  // The session currently on screen (selection or in-flight switch target):
  // reconcile must never dot it, and selectionRef lags behind a switch.
  const viewedSessionRef = useRef('');
  // Unread consumption additionally treats an IN-FLIGHT switch target
  // (requestedSessionId) as viewed: a slow resume or a fork-on-resume commits
  // a different id, which left the clicked row's dot unconsumed (user report).
  const unreadViewedSessionRef = useRef('');

  // Sidebar catalog state, optimistic rename/archive/delete overlay, push + poll
  // freshness: app-session-catalog.ts.
  const { unreadSessionIds, reconcileUnreadSessions, consumeUnread } = useUnreadSessions({
    viewedSessionRef: unreadViewedSessionRef,
  });

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
    startupNavigationSelection,
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
    selection,
    setSelection,
    tabs,
    setTabs,
    registerWorkspaceSelection,
    activateSelection,
    finishPendingConversationHandoff,
    startTask,
    synchronizeActualHost,
    replaceWithInheritedSession,
  } = taskLifecycle;
  selectionRef.current = selection;

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
  const { startProject, renameProject, removeProject } = createProjectActions({
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
  const { renameSession, archiveSession, deleteSession } = useAppSessionActions({
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
    setProjectsSection,
    uiOpenRequest: snapshot.uiOpenRequest,
    sessionId: snapshot.sessionId,
    setupUiRequest: snapshot.setupUiRequest,
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
  // Stable identity: SessionSidebar is memoised and must not re-render from a
  // fresh selection object literal on every App commit.
  const sidebarSelection: NavigationSelection = useMemo(
    () => (requestedSessionId ? { kind: 'session', id: requestedSessionId } : navigationSelection),
    [requestedSessionId, navigationSelection]
  );
  // Viewing a session consumes its unread dot.
  const viewedSessionId = navigationSelection.kind === 'session' ? navigationSelection.id : '';
  viewedSessionRef.current = viewedSessionId;
  const unreadViewedSessionId = resolveUnreadViewedSessionId({
    viewedSessionId,
    requestedSessionId,
    mobile: isMobileRemoteSurface(),
    sidebarOpen,
    dockOpen: focusedPaneDockOpen,
    bottomPanelOpen: bottomPanel.open,
    settingsOpen,
  });
  unreadViewedSessionRef.current = unreadViewedSessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Window focus must recheck unread state even when session data is unchanged.
  useEffect(() => {
    consumeUnread(unreadViewedSessionId, sessions);
  }, [consumeUnread, sessions, unreadViewedSessionId, windowFocusTick]);
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
  const paneTranscriptRendererPending =
    paneWorkspace.leaves.some((leaf) => paneActiveSelection(leaf)?.kind === 'session') &&
    !markdownBodyReadyForTranscript;
  const transcriptRendererPending = navigationSelection.kind === 'session' && !markdownBodyReadyForTranscript;
  useEffect(() => {
    if (markdownBodyReadyForTranscript) return undefined;
    let active = true;
    void preloadMarkdownBody()
      .catch(() => undefined)
      .finally(() => {
        if (active) setMarkdownBodyReadyForTranscript(true);
      });
    return () => {
      active = false;
    };
  }, [markdownBodyReadyForTranscript]);
  // Subscribe to a requested session while its lane is being opened.
  useSessionLane(requestedSessionId, defaultSessionLaneStore, () => true);
  const {
    fileReveal,
    latestEditorLocation,
    editorNavigationHistory,
    openFileTab,
    openProblemQuickFix,
    navigateEditorHistory,
  } = useEditorNavigation({
    setTabs,
    openSelectionInFocusedPane: paneWorkspace.openInFocused,
  });

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
    sessionPaneSurfaces,
    openFileTab,
    openSession,
    activeProjectPath,
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
    sidebarPanel,
    sidebarResumeSession,
    renderSidebarPanel,
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
    projectsSection,
    setProjectsSection,
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
    mountSidebarPanel,
    trackSidebarPanelModule,
  });

  const { renderWorkbenchSideView, renderPaneSideDock, renderPaneProblems } = useAppWorkbenchViews({
    sessions,
    sessionCatalogReady,
    workingSessionIds,
    unreadSessionIds,
    sidebarSelection,
    sidebarNewTask,
    sidebarNewStudio,
    prefetchSession,
    sidebarResumeSession,
    renameSession,
    archiveSession,
    deleteSession,
    sideViewDescriptors,
    renderSidebarPanel,
    sessionDiffs,
    setSessionDiff,
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
            sidebarPanel={sidebarPanel}
            refreshProjects={refreshProjects}
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
          <button
            type="button"
            className="sidebar-backdrop"
            data-state={sidebarOpen ? 'open' : 'closed'}
            aria-hidden={!sidebarOpen}
            tabIndex={sidebarOpen ? 0 : -1}
            onClick={() => applySidebarOpen(false)}
            aria-label={t('Close session sidebar')}
          />
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
          <button
            type="button"
            className="panel-backdrop"
            data-state={bottomPanel.open ? 'open' : 'closed'}
            aria-hidden={!bottomPanel.open}
            tabIndex={bottomPanel.open ? 0 : -1}
            onClick={() => bottomPanel.setOpen(false)}
            aria-label={t('Close panel')}
          />
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
      </div>
    </DesktopBootGate>
  );
}

export { ApprovalCard } from './ApprovalCard';
export { DesktopUpdateDialog } from './notifications';
export { ContextUsageIndicator, LiveWorkStatus, TranscriptRow } from './TranscriptView';
