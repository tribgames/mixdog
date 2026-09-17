import type React from 'react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import type {
  DesktopModelSelection,
  DesktopWorkflowState,
  DesktopWorkspaceFolder,
  SessionSnapshot,
} from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout';
import {
  DesktopTitlebar,
  SessionSidebar,
  type NavigationSelection,
  type WorkspaceSelection,
  type WorkspaceTab,
} from './navigation';
import {
  canSplitPaneSize,
  paneActiveSelection,
  paneLeafIdInVerticalDirection,
  paneTabAcrossVisualBoundary,
  type PaneLeaf,
} from './pane-layout';
import { usePaneWorkspace } from './pane-workspace-state';
import { PaneWorkspace } from './PaneWorkspace';
import { defaultSessionLaneStore, useSessionLane } from './session-lane-store';
import type { SettingsSection as SlashSettingsSection } from './slash-commands';
import { extensionSectionForSettings, type ExtensionsSection } from './extension-sections';
import { projectsSectionForSettings, type ProjectsSection } from './project-sections';
import { TooltipLayer } from './TooltipLayer';
import { UnsavedChangesDialog, WorkbenchQuickAccess, type WorkbenchQuickAccessMode } from './workbench-overlays-loader';
import { WorkspaceEmptyState } from './WorkspaceEmptyState';

import { ActivityRail } from './ActivityRail';
import { desktopBootPrerequisitesReady, markBootStage } from './boot-metrics';
import { EMPTY_SNAPSHOT, type Snapshot } from './desktop-types';
import { desktopFeatureEnabled } from './desktop-feature-config';
import { primeEditorFileLoad } from './editor-file-loader';
import { isMobileRemoteSurface } from './MobileTabOverview';
import { getEditorCommandCapabilities, subscribeEditorLanguageStore } from './editor-language-store';
import { loadCommandSurfaceModule } from './command-surface-loader';
import { prefetchBrowserPane, prefetchDiffView, prefetchEditorPane, prefetchTerminalPane } from './lazy-widgets';
import { DesktopBootGate } from './PaneSurfaceGate';
import type { PullRequestOpenHandler } from './PullRequestsPane';
import { beginStudioLoad, reportStudioLoadStage } from './renderer-load-metrics';
import type { SourceControlDiffRequest } from './SourceControlDock';
import { usePaneTypingFocus } from './use-composer-focus';
import { asRecord, displayProject, navigationKey, newDraftSelection, newStudioSelection } from './text-format';
import { isMarkdownBodyReady, preloadMarkdownBody } from './markdown-body-loader';
import { useEditorNavigation } from './use-editor-navigation';
import { usePaneTabClose, type ConversationHandoff, type EditorSaveHandle } from './use-pane-tab-close';
import { usePaneTabNavigation } from './use-pane-tab-navigation';
import { usePushNotificationNavigation } from './use-push-notification-navigation';
import { useSharedIntakeBoot } from './share-target-intake';
import { useShellUpdateReload } from './use-shell-update-reload';
import { useAppWorkspaceNavigation } from './use-app-workspace-navigation';
import { useAppPaneChrome } from './use-app-pane-chrome';
import { useAppStartupRestore } from './use-app-startup-restore';
import { useAppSessionActions } from './use-app-session-actions';
import { AppConversationPaneSurface } from './app-conversation-pane-surfaces';
import { desktopChromeSnapshotsEqual } from './desktop-snapshot-store';
import { DesktopToastRegion, DesktopUpdateDialog } from './notifications';
import { RemoteConnectionBanner } from './RemoteConnectionBanner';
import {
  loadSidebarPanelModule,
  OnboardingWizard,
  SettingsView,
  StableSessionTitle,
  warmSettingsView,
  type SidebarPanelKey,
} from './app-shell-components';
import { loadStudioViewModule } from './studio-loader';

const LAST_SESSION_KEY = 'mixdog.desktop-last-session.v1';
function applySessionLaneResult(sessionId: string, next: SessionSnapshot | null): void {
  if (!sessionId || !next || typeof next !== 'object') return;
  const returnedSessionId = String((next as Snapshot).sessionId || '');
  if (returnedSessionId && returnedSessionId !== sessionId) return;
  defaultSessionLaneStore.apply({
    sessionId,
    snapshot: next,
    frameSource: 'live',
  });
}
const CommandSurface = lazy(() => loadCommandSurfaceModule().then((module) => ({ default: module.CommandSurface })));
// Route chunk warm-up is scheduled after startup settles below.
import {
  DraftConversation,
  selectDesktopSnapshot,
  SnapshotUtilityDock,
  requestSessionRead,
  useDesktopSnapshotSelector,
} from './app-snapshot-views';

import { useDesktopState } from './app-desktop-state';
import { createProjectActions } from './app-project-actions';
import { useSessionCatalog } from './app-session-catalog';
import { useAppShellPanels } from './use-app-shell-panels';
import {
  draftModelSelectionFromSnapshot,
  resolvedStoredProjectPath,
  useDraftPanePreferences,
  type DraftPanePrefs,
} from './use-draft-pane-preferences';
import { useAppSubmitRouting } from './use-app-submit-routing';
import { inheritSessionInPlace } from './app-session-inheritance';
import { useAppSidebarSurface } from './use-app-sidebar-surface';
import { buildAppWorkbenchCommands } from './app-workbench-commands';
import type { UtilityDockTab } from './UtilityDock';
import { useAppPersistentPaneSurfaces } from './use-app-persistent-pane-surfaces';
import { createAppSideViewDescriptors } from './app-side-view-descriptors';
import { useStableEvent } from './use-stable-event';
import { resolveUnreadViewedSessionId, useUnreadSessions } from './app-unread-sessions';
import { DesktopLoadingSurface } from './RendererRecovery';
import { SessionDiffPane } from './SessionDiffPane';
import { useWorkbenchWorkspace } from './workbench-workspace';
import { DEFAULT_SIDEBAR_VIEW_ORDER } from './sidebar-view-layout';
import {
  WorkbenchSideIconBar,
  WorkbenchSidePanel,
  type WorkbenchSide,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewId,
} from './workbench-side-view-layout';
import { SidebarDiffColumn, sidebarDiffColumnAvailable } from './sidebar-diff-column';
import { SessionBrowserParkingHost } from './session-browser-surfaces';
import { useAgentBrowserSurfaceRequests } from './use-agent-browser-surface-requests';
import { useAppSessionOpen } from './app-shell-session-open';
import { useAppUiOpenRequest } from './app-shell-ui-open-request';
import { useSetupDesktopRequest } from './use-setup-desktop-request';
import { t } from './i18n';
import { useAppSessionTitle } from './app-shell-session-title';
import { useAppToolProject, LAST_PROJECT_KEY } from './app-shell-tool-project';
import { useAppMobileBack, useAppMobileInitialClose } from './app-shell-mobile-back';
import { useSideViewPrefetch, useSideViewSelection, useSideViewReordering } from './app-shell-side-views';
import { renderPaneSideDockView, renderPaneDockStripTrailing } from './app-shell-side-dock';
import { renderPaneProblemsView } from './app-shell-pane-problems';
import { SessionTerminalParkingHost } from './session-terminal-surfaces';
import { useSessionPaneSurfaces } from './use-session-pane-surfaces';
import { useAppProjectCatalog } from './use-app-project-catalog';
import { useDesktopUpdater } from './use-desktop-updater';
import { useAppSideDocks } from './use-app-side-docks';
import {
  useAppDockWarmup,
  useAppModuleWarmup,
  useAppOnboarding,
  useAppSettingsMount,
  useAppSettingsPreload,
  useAppThemePreference,
  useAppWorkspaceWarmup,
  useLaunchTabMeasurements,
  useStartupCommitMeasurement,
} from './use-app-boot';

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
    pendingBrowserAutoReveal,
    releaseDeletedSessionSurfaces,
    sessionDiffs,
    setSessionDiff,
    setSessionPanelView,
    setSessionSideSurface,
    terminalSurfaces,
  } = sessionPaneSurfaces;
  const {
    applySidebarOpen,
    bottomPanel,
    closeActiveRailPanel,
    closeSidebarPanels,
    commandSurface,
    commandSurfaceLane,
    commandSurfaceSessionId,
    failedSidebarPanels,
    loadedSidebarPanels,
    mainPanelRef,
    markSidebarPanelFailed,
    mountSidebarPanel,
    mountedSidebarPanels,
    openConversationCommandSurface,
    openProjects,
    openSchedules,
    openSidebar,
    openWebhooks,
    problemsCollapseNonce,
    problemsFilter,
    projectsOpen,
    retrySidebarPanel,
    schedulesOpen,
    setCommandSurface,
    setCommandSurfaceSessionId,
    setProblemsCollapseNonce,
    setProblemsFilter,
    setSettingsOpen,
    setSettingsSection,
    settingsOpen,
    settingsSection,
    sidebarMotion,
    sidebarOpen,
    sidebarPanes,
    toggleBottomPanel,
    toggleSidebar,
    trackSidebarPanelModule,
    webhooksOpen,
  } = useAppShellPanels(paneWorkspace.focusedLeafId);
  const { settingsMounted, settingsPrewarmed } = useAppSettingsMount(settingsOpen);
  const mountedCommandSurfaces = useRef(new Set<string>());
  if (commandSurface) mountedCommandSurfaces.current.add(commandSurface);
  const {
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
  } = useAppSideDocks({
    paneWorkspace,
    sessionSurfaces: sessionPaneSurfaces,
    applySidebarOpen,
  });
  const [extensionsSection, setExtensionsSection] = useState<ExtensionsSection>('plugins');
  // Projects panel section (Project | Workflow): owned here like the
  // Extensions one so /workflow and /websearch can land on the Workflow tab.
  const [projectsSection, setProjectsSection] = useState<ProjectsSection>('projects');
  const {
    projects,
    projectCatalogReady,
    projectCatalogValidated,
    registeredProjectPath,
    preferredDraftProjectPath,
    effectiveDraftProjectPath,
    refreshProjects,
  } = useAppProjectCatalog(snapshot);
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
  const startupFilePrimed = useRef(false);
  useLayoutEffect(() => {
    if (startupFilePrimed.current) return;
    startupFilePrimed.current = true;
    // Prime EVERY restored file tab, focused pane first: only the focused
    // file primed before, so background editors started their engine-gated
    // reads seconds later at boot and sat visibly empty (user report).
    const primed = new Set<string>();
    const prime = (selection: ReturnType<typeof paneActiveSelection>) => {
      if (selection?.kind !== 'file') return;
      const key = `${selection.project}\u0000${selection.rel}\u0000${selection.accessToken || ''}`;
      if (primed.has(key)) return;
      primed.add(key);
      void primeEditorFileLoad(window.mixdogDesktop, selection.project, selection.rel, selection.accessToken)?.catch(
        () => {}
      );
    };
    prime(startupFocusedPaneSelection);
    for (const leaf of paneWorkspace.leaves) prime(paneActiveSelection(leaf));
  }, [paneWorkspace.leaves, startupFocusedPaneSelection]);
  const [selection, setSelection] = useState<NavigationSelection>(() => startupNavigationSelection ?? { kind: 'new' });
  const selectionRef = useRef<NavigationSelection>(selection);
  // The registry starts empty; the first task creates the initial tab.
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  // The pane tree is the visible multi-surface; `tabs` remains the internal
  // registry that keeps dirty file editors mounted and titled.
  const {
    openInFocused: openSelectionInFocusedPane,
    promoteInLeaf: promoteSelectionInLeaf,
    pinTab: pinPaneTab,
    pinTabByKey: pinPaneTabByKey,
    splitFocused: splitFocusedPane,
  } = paneWorkspace;
  // File editors are normal tabs in the focused pane. The focused leaf is the
  // single source of truth for the Files highlight and tab shortcuts; a
  // separate global editor key made a file take over the whole main panel.
  const focusedPaneSelection = paneWorkspace.focusedLeaf ? paneActiveSelection(paneWorkspace.focusedLeaf) : null;
  const paneLeavesRef = useRef(paneWorkspace.leaves);
  paneLeavesRef.current = paneWorkspace.leaves;
  const focusedLeafIdRef = useRef(paneWorkspace.focusedLeafId);
  focusedLeafIdRef.current = paneWorkspace.focusedLeafId;
  const activeFileKey = focusedPaneSelection?.kind === 'file' ? navigationKey(focusedPaneSelection) : '';
  useEffect(() => {
    const showProblems = () => {
      if (bottomPanel.open) bottomPanel.setOpen(false);
      else bottomPanel.setTab('problems');
    };
    window.addEventListener('mixdog:show-problems', showProblems);
    return () => window.removeEventListener('mixdog:show-problems', showProblems);
  }, [bottomPanel.open, bottomPanel.setOpen, bottomPanel.setTab]);
  const editorCommandCapabilities = useSyncExternalStore(
    subscribeEditorLanguageStore,
    getEditorCommandCapabilities,
    getEditorCommandCapabilities
  );
  const [dirtyFileKeys, setDirtyFileKeys] = useState<ReadonlySet<string>>(() => new Set());
  const editorSaveHandles = useRef(new Map<string, EditorSaveHandle>());
  const [quickAccessMode, setQuickAccessMode] = useState<WorkbenchQuickAccessMode | null>(null);
  const handleFileDirty = useCallback(
    (key: string, dirty: boolean) => {
      if (dirty) pinPaneTabByKey(key);
      setDirtyFileKeys((current) => {
        if (current.has(key) === dirty) return current;
        const next = new Set(current);
        if (dirty) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    [pinPaneTabByKey]
  );
  const registerEditorSaveHandle = useCallback((key: string, save: EditorSaveHandle | null) => {
    if (save) editorSaveHandles.current.set(key, save);
    else editorSaveHandles.current.delete(key);
  }, []);
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
  const errors = useMemo(
    () =>
      [error || (!connected ? 'Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop.' : '')].filter(
        Boolean
      ),
    [connected, error]
  );

  const registerWorkspaceSelection = useCallback(
    (nextSelection: NavigationSelection, title: string, replaceKey = '') => {
      const key = navigationKey(nextSelection);
      setTabs((current) => {
        const existing = current.findIndex((tab) => tab.key === key);
        if (replaceKey) {
          const replaced = current.findIndex((tab) => tab.key === replaceKey);
          if (replaced >= 0) {
            // Promote the destination into the draft's exact strip position.
            // If that session is already open elsewhere, remove the old copy
            // instead of leaving New task behind or creating a duplicate.
            const next = [...current];
            next[replaced] = { key, title, selection: nextSelection };
            if (existing >= 0 && existing !== replaced) next.splice(existing, 1);
            return next;
          }
        }
        if (existing >= 0) {
          if (current[existing].title === title && navigationKey(current[existing].selection) === key) return current;
          const next = [...current];
          next[existing] = { key, title, selection: nextSelection };
          return next;
        }
        // Chrome parity: the strip never DROPS a tab. Tabs shrink to their
        // minimum width and then the strip scrolls (styles.css overflow-x),
        // instead of silently evicting the oldest — which also stranded
        // activeKey when the evicted tab was the selected one.
        return [...current, { key, title, selection: nextSelection }];
      });
    },
    []
  );

  const activateSelection = useCallback(
    (nextSelection: NavigationSelection, title: string, replaceKey = '') => {
      try {
        window.mixdogDesktop?.perfLog?.(
          `selection-commit kind=${nextSelection.kind}` +
            ` target=${nextSelection.kind === 'session' ? nextSelection.id : '(none)'}`
        );
      } catch {
        /* diagnostics only */
      }
      try {
        if (nextSelection.kind === 'session') {
          window.localStorage.setItem(LAST_SESSION_KEY, nextSelection.id);
        } else {
          window.localStorage.removeItem(LAST_SESSION_KEY);
        }
      } catch {
        /* startup restoration remains best-effort */
      }
      selectionRef.current = nextSelection;
      viewedSessionRef.current = nextSelection.kind === 'session' ? nextSelection.id : '';
      unreadViewedSessionRef.current = viewedSessionRef.current;
      setSelection(nextSelection);
      // The focused pane mirrors the interactive surface, so every navigation
      // keeps the pane tree and the classic selection state in lockstep. The
      // focused GROUP opens/activates the tab; replaceKey promotes in place.
      openSelectionInFocusedPane(nextSelection, replaceKey);
      registerWorkspaceSelection(nextSelection, title, replaceKey);
    },
    [openSelectionInFocusedPane, registerWorkspaceSelection]
  );
  // Ctrl/Cmd+\ opens a pane beside the focused one; Shift opens it below.
  useEffect(() => {
    // globalThis: React's KeyboardEvent type shadows the DOM one in App.
    const onPaneSplitKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== '\\') return;
      event.preventDefault();
      // A split ALWAYS opens an independent new task (terminal-style panes,
      // user requirement). Cloning the current view put the SAME session (or
      // the same draftId) into several panes — one engine, one settings set —
      // so a model change legitimately repainted them all and read as
      // "panes are not individual". Navigation and drop paths reveal or move
      // an owned session tab instead of duplicating it across panes.
      const fresh = newDraftSelection();
      const direction = event.shiftKey ? 'column' : 'row';
      const paneElement = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).find(
        (element) => element.dataset.paneId === paneWorkspace.focusedLeafId
      );
      const rect = paneElement?.getBoundingClientRect();
      if (rect && !canSplitPaneSize(direction, rect.width, rect.height)) return;
      splitFocusedPane(direction, fresh, rect ? { width: rect.width, height: rect.height } : undefined);
      activateSelection(fresh, 'New task');
    };
    window.addEventListener('keydown', onPaneSplitKey);
    return () => window.removeEventListener('keydown', onPaneSplitKey);
  }, [activateSelection, paneWorkspace.focusedLeafId, splitFocusedPane]);
  useEffect(() => {
    if (sidebarOpen) return;
    const sidebar = document.getElementById('session-sidebar');
    if (sidebar?.contains(document.activeElement)) {
      document.querySelector<HTMLButtonElement>('.sessions-link')?.focus();
    }
  }, [sidebarOpen]);

  const invokeResult = useCallback(
    async <T,>(action: () => T | Promise<T>): Promise<T | undefined> => {
      setError('');
      try {
        return await action();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
        return undefined;
      }
    },
    [setError]
  );
  const invoke = useCallback(
    async (action: () => unknown): Promise<void> => {
      await invokeResult(action);
    },
    [invokeResult]
  );
  const {
    state: updaterState,
    ready: updaterStateReady,
    dialogOpen: updateDialogOpen,
    openDialog: openDesktopUpdate,
    closeDialog: closeDesktopUpdate,
    install: installDesktopUpdate,
  } = useDesktopUpdater(invoke);
  // The session currently on screen (selection or in-flight switch target):
  // reconcile must never dot it, and selectionRef lags behind a switch.
  const viewedSessionRef = useRef('');
  // Unread consumption additionally treats an IN-FLIGHT switch target
  // (requestedSessionId) as viewed: a slow resume or a fork-on-resume commits
  // a different id, which left the clicked row's dot unconsumed (user report).
  const unreadViewedSessionRef = useRef('');
  // Bumps when the window regains focus/visibility so viewed-session unread
  // consumption re-evaluates (dots earned while unfocused clear on return).
  const [windowFocusTick, setWindowFocusTick] = useState(0);
  useEffect(() => {
    const onEngage = () => setWindowFocusTick((tick) => (tick + 1) % 1_000_000);
    window.addEventListener('focus', onEngage);
    // A resumed phone does not reliably pair its return with visibilitychange,
    // so pageshow is the independent foreground signal that lets a session the
    // user came back to consume its dot.
    window.addEventListener('pageshow', onEngage);
    document.addEventListener('visibilitychange', onEngage);
    return () => {
      window.removeEventListener('focus', onEngage);
      window.removeEventListener('pageshow', onEngage);
      document.removeEventListener('visibilitychange', onEngage);
    };
  }, []);
  // Recent-list unread dots (seen message counts + completion transitions).
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
  // A deploy that landed while this app was open applies to the running app,
  // once discarding the current screen costs nothing.
  useShellUpdateReload({ busy: sessions.some((session) => session.working === true) });
  const runningAutomationNames = useMemo(() => {
    const schedule = new Set<string>();
    const webhook = new Set<string>();
    for (const session of sessions) {
      if (session.working !== true || !session.sourceName) continue;
      if (session.sourceType === 'schedule') schedule.add(session.sourceName);
      if (session.sourceType === 'webhook') webhook.add(session.sourceName);
    }
    return { schedule, webhook };
  }, [sessions]);
  useEffect(() => {
    const catalogTitles = new Map(sessions.map((session) => [session.id, sessionSummaryTitle(session)] as const));
    if (!catalogTitles.size) return;
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        // A selection-pinned title (agent tabs) is caller-owned: the catalog
        // sync must not replace it with the session's auto-generated title.
        if (tab.selection.kind !== 'session' || tab.selection.title) return tab;
        const title = catalogTitles.get(tab.selection.id);
        if (!title || title === tab.title) return tab;
        changed = true;
        return { ...tab, title };
      });
      return changed ? next : current;
    });
  }, [sessions]);
  useEffect(() => {
    let live = true;
    // React commits child pane effects before this parent effect, so visible
    // file/session/Studio reads enter the worker queue first. The lightweight
    // catalog may then reconcile without adding another frame of sidebar lag.
    // Catalog hydration is a background read, not a user action. A host that
    // is still settling may reject this first pass; revealing a global red
    // error for that transient miss makes whichever side view opens first look
    // broken. Recovery events and later explicit refreshes remain authoritative.
    void refreshSessions()
      .catch(() => undefined)
      .finally(() => {
        if (live) setSessionCatalogReady(true);
      });
    return () => {
      live = false;
    };
  }, [refreshSessions]);
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
  const synchronizeActualHost = async () => {
    const actual = (await window.mixdogDesktop?.getSnapshot().catch(() => null)) ?? null;
    applySnapshot(actual);
    const state = actual && typeof actual === 'object' ? (actual as Snapshot) : null;
    const actualProject = String(state?.currentProject || state?.project || '');
    const actualSessionId = String(state?.sessionId || '');
    const knownActualSession = actualSessionId && sessions.some((session) => session.id === actualSessionId);
    if (knownActualSession) {
      const actualSession = sessions.find((session) => session.id === actualSessionId);
      activateSelection({ kind: 'session', id: actualSessionId }, sessionSummaryTitle(actualSession));
    } else if (actualProject) {
      const project = projects.find((item) => item.path === actualProject);
      activateSelection(
        { kind: 'project', path: actualProject },
        project?.alias?.trim() || project?.name?.trim() || displayProject(actualProject).name || 'Project'
      );
    } else if (actualSessionId) {
      activateSelection({ kind: 'new' }, 'New task');
      clearNewTaskPreferences();
      // This is an existing host session that the current catalog cannot
      // identify, not a draft-owned prepared route. Marking the visual draft
      // ready made its first prompt call host.submit() and append to that
      // foreign session. Keep it cold so submitNewTask() must mint/address a
      // fresh session before accepting the message.
    } else {
      activateSelection({ kind: 'new' }, 'New task');
    }
  };

  // Workspace navigation keeps the drawer's exit animation. Full-screen
  // destinations close it immediately to avoid overlapping screen transitions.
  const closeSidebarForNavigation = (motion: 'animated' | 'instant' = 'animated') => {
    if (window.innerWidth <= 760) {
      applySidebarOpen(false, motion);
      paneSideDocks.setOpen(focusedLeafIdRef.current, false);
    }
  };
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
  const finishPendingConversationHandoff = () => {
    if (!pendingConversationHandoff.current) return;
    pendingConversationHandoff.current = null;
    setConversationHandoff(null);
  };
  const startTask = (draft?: NavigationSelection, requestComposerFocus = true) => {
    closeSidebarForNavigation();
    navigationEpoch.current += 1;
    setRequestedSessionId('');
    finishPendingConversationHandoff();
    const alreadyActive = selectionRef.current.kind === 'new';
    // Clicking an existing draft tab revisits THAT draft; a plain Ctrl+N /
    // New task always opens another independent draft tab (Chrome parity)
    // instead of reusing a singleton.
    const revisit = draft?.kind === 'new';
    const nextSelection = revisit && draft ? draft : newDraftSelection();
    activateSelection(nextSelection, 'New task');
    if (requestComposerFocus) setComposerFocusRequest((value) => value + 1);
    // Revisiting a draft tab, or opening an additional draft while one is
    // already active, keeps the shared staged project/model/workflow instead
    // of resetting it mid-flight. The first submit can still lazily start the
    // engine when the boot draft has never been prepared.
    if (revisit || alreadyActive) return;
    // A parked draft tab survives session switches (user decision): pressing
    // New task again opens a fresh tab that inherits its staged
    // project/model/workflow instead of resetting the draft.
    if (newTaskDeferred && tabs.some((tab) => tab.selection.kind === 'new')) return;
    const cachedProjectPath = lastNewTaskPrefs.current?.projectPath ?? null;
    // An explicit choice is restored as-is ("" stays No project); with none,
    // the fresh draft inherits so a catalog that lands later still reaches it.
    // A stored path the catalog cannot place also inherits — freezing its
    // failed lookup as "" made the pill blank for good.
    resetNewTaskDraft(
      cachedProjectPath === null
        ? effectiveDraftProjectPath(preferredDraftProjectPath) || null
        : resolvedStoredProjectPath(cachedProjectPath, effectiveDraftProjectPath)
    );
  };
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
  const openSettings = useCallback(
    (section: SlashSettingsSection | null = null) => {
      const extensionSection = extensionSectionForSettings(section);
      if (extensionSection) {
        if (!desktopFeatureEnabled('extensions')) return;
        const side = workbenchSideLayout.sideOf('extensions');
        setExtensionsSection(extensionSection);
        setSettingsOpen(false);
        setCommandSurface(null);
        mountSidebarPanel('extensions');
        trackSidebarPanelModule('extensions', loadSidebarPanelModule.extensions());
        if (side === 'right') {
          paneSideDocks.open(focusedLeafIdRef.current, 'extensions');
          return;
        }
        setActiveSideViews((current) => (current.left === 'extensions' ? current : { ...current, left: 'extensions' }));
        applySidebarOpen(true);
        return;
      }
      // Workflow and web-search-model settings live on the Projects panel's
      // Workflow tab: /workflow and /websearch land there.
      const projectsTab = projectsSectionForSettings(section);
      if (projectsTab) {
        if (!desktopFeatureEnabled('projects')) return;
        setCommandSurface(null);
        setProjectsSection(projectsTab);
        openProjects();
        return;
      }
      if (!desktopFeatureEnabled('settings')) return;
      // Perf diagnostics: SettingsView's mount effect reports the request→paint
      // delta through the perf-log channel (no-op unless MIXDOG_DESKTOP_PERF=1).
      (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt = performance.now();
      warmSettingsView();
      setCommandSurface(null);
      setSettingsSection(section === 'memory' ? 'memory-enabled' : section);
      setSettingsOpen(true);
    },
    [
      applySidebarOpen,
      mountSidebarPanel,
      openProjects,
      paneSideDocks.open,
      trackSidebarPanelModule,
      warmSettingsView,
      workbenchSideLayout.sideOf,
    ]
  );
  useAppUiOpenRequest({
    uiOpenRequest: snapshot.uiOpenRequest,
    sessionId: snapshot.sessionId,
    openConversationCommandSurface,
    openSettings,
  });
  useSetupDesktopRequest(snapshot.setupUiRequest, snapshot.sessionId, window.mixdogDesktop);
  /** /clear · /new replaces the tab with a New Task draft in the same position,
   *  carrying forward that session's project/model/workflow and remote-seat
   *  settings. The original transcript remains available in sidebar history. */
  const clearSessionToNewTask = (sessionId: string) => {
    const sessionKey = navigationKey({ kind: 'session', id: sessionId });
    const leaves = paneLeavesRef.current;
    const ownerLeaf =
      leaves.find(
        (leaf) => leaf.id === focusedLeafIdRef.current && leaf.tabs.some((tab) => navigationKey(tab) === sessionKey)
      ) ?? leaves.find((leaf) => leaf.tabs.some((tab) => navigationKey(tab) === sessionKey));
    // The session's OWN lane seeds the draft; focus has no data authority.
    const source = defaultSessionLaneStore.get(sessionId);
    const inherited = inheritedDraftPrefs();
    const seeded: DraftPanePrefs = {
      projectPath: effectiveDraftProjectPath(
        String(source?.currentProject || source?.project || '') || inherited.projectPath
      ),
      modelSelection: (source ? draftModelSelectionFromSnapshot(source) : null) ?? inherited.modelSelection,
      workflow:
        (asRecord(source?.workflow) ? (source?.workflow as unknown as DesktopWorkflowState) : null) ??
        inherited.workflow,
      orchestrationMode: source?.orchestrationMode ?? inherited.orchestrationMode,
    };
    const draftSelection = newDraftSelection();
    // Per-draft prefs are keyed by draftId, not navigationKey: the old
    // "new:<id>" key orphaned this entry, so the replacement draft resolved
    // stale inherited prefs instead of the cleared session's settings.
    const draftPrefsKey = draftSelection.kind === 'new' ? draftSelection.draftId || 'default' : 'default';
    draftPanePrefs.current.set(draftPrefsKey, seeded);
    // The cleared session's settings become the seed for FUTURE new tasks as
    // well (same rule as explicit staging).
    lastNewTaskPrefs.current = seeded;
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
    navigationEpoch.current += 1;
    setRequestedSessionId('');
    finishPendingConversationHandoff();
    if (ownerLeaf && ownerLeaf.id !== focusedLeafIdRef.current) {
      // Addressed replacement in a background pane: swap the tab in place
      // without stealing focus, and leave the one-shot remote toggle (owned
      // by the FOCUSED draft) untouched.
      promoteSelectionInLeaf(ownerLeaf.id, draftSelection, sessionKey);
      registerWorkspaceSelection(draftSelection, 'New task', sessionKey);
      return;
    }
    activateSelection(draftSelection, 'New task', ownerLeaf ? sessionKey : '');
    setComposerFocusRequest((value) => value + 1);
  };
  // App owns broad workspace state and legitimately re-renders for chrome,
  // panel and catalog changes. Conversation is the expensive persistent tree:
  // stable event facades let React.memo retain it while each callback still
  // dispatches through the latest render state.
  const conversationNewTask = useStableEvent(() => startTask());
  const conversationClearToNewTask = useStableEvent(clearSessionToNewTask);
  const conversationClearProject = useStableEvent(() => stageNewTaskProject(''));
  const conversationResumeSession = useStableEvent((sessionId: string) => {
    void openSession(sessionId);
  });
  const conversationOpenProjects = useStableEvent(() => {
    if (!desktopFeatureEnabled('projects')) return;
    setProjectsSection('projects');
    openProjects();
    void refreshProjects().catch(() => undefined);
  });
  const conversationSelectProject = useStableEvent((path: string) => {
    // The composer selector edits the focused draft in place. Project-panel
    // navigation still uses selectNewTaskProject() to open a fresh draft.
    stageNewTaskProject(path);
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
    promoteSelectionInLeaf,
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
  useEffect(() => {
    consumeUnread(unreadViewedSessionId, sessions);
  }, [consumeUnread, sessions, unreadViewedSessionId, windowFocusTick]);
  const {
    headerTitleEditingSessionId,
    headerTitleDraft,
    setHeaderTitleDraft,
    headerTitleInvalid,
    selectedSession,
    workingSessionIds,
    observedAgentSessionIds,
    visibleSessionTitle,
    openHeaderTitleEditor,
    closeHeaderTitleEditor,
    commitHeaderTitleEditor,
  } = useAppSessionTitle({
    navigationSelection,
    sessions,
    tabs,
    renameSession,
  });
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
    openSelectionInFocusedPane,
  });
  const openUtilityTab = (
    utilitySelection: Extract<WorkspaceSelection, { kind: 'studio' | 'terminal' | 'browser' }>,
    title: string,
    leafId = paneWorkspace.focusedLeafId
  ) => {
    paneWorkspace.focusLeaf(leafId);
    const key = navigationKey(utilitySelection);
    setTabs((current) =>
      current.some((tab) => tab.key === key) ? current : [...current, { key, title, selection: utilitySelection }]
    );
    openSelectionInFocusedPane(utilitySelection);
  };
  const openStudioTab = (leafId = paneWorkspace.focusedLeafId) => {
    closeSidebarPanels();
    const metricToken = beginStudioLoad();
    void loadStudioViewModule()
      .then(() => reportStudioLoadStage('module', '', false, metricToken))
      .catch(() => {});
    openUtilityTab(newStudioSelection(), 'Studio', leafId);
  };
  const openTerminalTab = (leafId = paneWorkspace.focusedLeafId) => {
    void prefetchTerminalPane().catch(() => {});
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    if (selection?.kind !== 'session') return;
    setSessionSideSurface(selection.id, 'terminal');
    paneSideDocks.select(leafId, 'terminal');
  };
  useAgentBrowserSurfaceRequests({
    owners: paneWorkspace.leaves.map((leaf) => {
      const selection = paneActiveSelection(leaf);
      return {
        leafId: leaf.id,
        sessionId: selection?.kind === 'session' ? selection.id : null,
      };
    }),
    focusedLeafId: paneWorkspace.focusedLeafId,
    surfaces: sessionPaneSurfaces,
    prefetch: prefetchBrowserPane,
    select: paneSideDocks.select,
    temporarySelect: paneSideDocks.temporarySelect,
  });
  const openDiffTab = (project: string, rel: string, request: SourceControlDiffRequest) => {
    const cleanProject = String(project || '').trim();
    const cleanRel = String(rel || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    if (!cleanProject || !cleanRel) return;
    void prefetchDiffView().catch(() => {});
    const diffSelection: Extract<WorkspaceSelection, { kind: 'diff' }> = {
      kind: 'diff',
      project: cleanProject,
      rel: cleanRel,
      ...request,
    };
    const key = navigationKey(diffSelection);
    setTabs((current) =>
      current.some((tab) => tab.key === key)
        ? current
        : [
            ...current,
            {
              key,
              title: `${cleanRel.split('/').at(-1) || cleanRel} (Diff)`,
              selection: diffSelection,
            },
          ]
    );
    openSelectionInFocusedPane(diffSelection);
  };
  const openPullRequestTab: PullRequestOpenHandler = (project, pullRequest, mode, toSide = false) => {
    if (!desktopFeatureEnabled('pullRequests')) return;
    const cleanProject = String(project || '').trim();
    if (!cleanProject || !Number.isInteger(pullRequest.number) || pullRequest.number <= 0) return;
    const instanceId = toSide ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` : undefined;
    const pullRequestSelection: Extract<WorkspaceSelection, { kind: 'pull-request' }> = {
      kind: 'pull-request',
      project: cleanProject,
      number: pullRequest.number,
      title: pullRequest.title,
      mode,
      ...(instanceId ? { instanceId } : {}),
    };
    const key = navigationKey(pullRequestSelection);
    const title =
      mode === 'changes'
        ? `Changes in Pull Request #${pullRequest.number}`
        : pullRequest.title || `Pull Request #${pullRequest.number}`;
    setTabs((current) => {
      const existing = current.findIndex((tab) => tab.key === key);
      if (existing < 0) return [...current, { key, title, selection: pullRequestSelection }];
      const next = [...current];
      next[existing] = { key, title, selection: pullRequestSelection };
      return next;
    });
    const focusedLeaf = paneWorkspace.focusedLeaf;
    if (toSide && focusedLeaf?.tabs.length) {
      const paneElement = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]')).find(
        (element) => element.dataset.paneId === focusedLeaf.id
      );
      const rect = paneElement?.getBoundingClientRect();
      if (!rect || canSplitPaneSize('row', rect.width, rect.height)) {
        splitFocusedPane('row', pullRequestSelection, rect ? { width: rect.width, height: rect.height } : undefined);
        return;
      }
    }
    openSelectionInFocusedPane(pullRequestSelection);
  };
  const dockOpenFile = useStableEvent((project: string, rel: string, mode?: 'preview' | 'pinned') => {
    openFileTab(project, rel, undefined, undefined, true, mode);
  });
  const dockOpenFileAt = useStableEvent(openFileTab);
  const dockOpenDiff = useStableEvent(openDiffTab);
  const dockOpenPullRequest = useStableEvent(openPullRequestTab);
  const dockOpenLeadSession = useStableEvent((sessionId: string) => {
    void openSession(sessionId);
  });
  const dockOpenAgentSession = useStableEvent((sessionId: string, title: string, _ownerSessionId: string) => {
    const childSessionId = String(sessionId || '').trim();
    if (!childSessionId) return;
    void openSession(childSessionId, false, String(title || '').trim());
  });
  const chooseFileTab = async (leafId = paneWorkspace.focusedLeafId) => {
    // Native file selection gives Monaco useful preload time without charging
    // every chat-only window its permanent module heap.
    void prefetchEditorPane().catch(() => {});
    const picked = await window.mixdogDesktop?.chooseFiles?.(activeProjectPath || null);
    if (!picked?.length) return;
    paneWorkspace.focusLeaf(leafId);
    for (const entry of picked) {
      if (entry.dir || !entry.projectPath || !entry.relPath) continue;
      openFileTab(entry.projectPath, entry.relPath, undefined, entry.accessToken);
    }
  };
  const openDroppedPaths = useStableEvent(async (leafId: string, paths: string[]) => {
    const entries = await window.mixdogDesktop?.resolveLocalPaths?.(paths);
    if (!entries?.length) return;
    paneWorkspace.focusLeaf(leafId);
    for (const entry of entries) {
      if (!entry.dir && entry.projectPath && entry.relPath) {
        openFileTab(entry.projectPath, entry.relPath, undefined, entry.accessToken);
      }
    }
  });
  const { focusPaneTypingSurface, navigateTab } = usePaneTabNavigation({
    focusedLeafId: paneWorkspace.focusedLeafId,
    activeTabKey,
    openSelectionInFocusedPane,
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
    // Session and New Task tabs share trailing dock controls on desktop and
    // projected phone; other surfaces leave that strip slot empty.
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
  // Ctrl+Left/Right crosses pane boundaries in visual row-major order and
  // enters at the adjacent edge tab, never the pane's stale active tab.
  const focusSiblingPane = (offset: number) => {
    const target = paneTabAcrossVisualBoundary(paneWorkspace.layout, paneWorkspace.focusedLeafId, offset);
    if (!target) return;
    paneWorkspace.focusLeaf(target.leafId);
    paneWorkspace.activateTab(target.leafId, navigationKey(target.selection));
    // Mirror the pane-click path: route the engine surface AND land the
    // caret in that pane's typing area.
    activatePaneSurface(target.selection);
    focusPaneTypingSurface(target.leafId, target.selection);
  };
  const focusVerticalPane = (direction: 'up' | 'down') => {
    const nextId = paneLeafIdInVerticalDirection(paneWorkspace.layout, paneWorkspace.focusedLeafId, direction);
    if (!nextId) return;
    const next = paneWorkspace.leaves.find((leaf) => leaf.id === nextId);
    if (!next) return;
    paneWorkspace.focusLeaf(next.id);
    const nextActive = paneActiveSelection(next);
    if (nextActive) activatePaneSurface(nextActive);
    focusPaneTypingSurface(next.id, nextActive);
  };
  const { focusedLeafForShortcuts, focusedLeafTabs, tabSwitcher } = useAppWorkspaceNavigation({
    paneWorkspace,
    requestedSessionId,
    focusedPaneSelection,
    activeTabKey,
    navigateTab,
    focusPaneTypingSurface,
    focusSiblingPane,
    focusVerticalPane,
    startTask,
    openSettings,
    toggleSidebar,
    toggleDock,
    toggleBottomPanel,
    setQuickAccessMode,
    openDockTab,
    navigateEditorHistory,
  });
  const quickAccessProjectPath = toolProjectPath || workbenchWorkspace.workspace.folders[0]?.path || '';
  const quickAccessRecentFiles = useMemo(() => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const leaf of paneWorkspace.leaves) {
      for (const paneTab of leaf.tabs) {
        if (paneTab.kind !== 'file' || paneTab.project !== quickAccessProjectPath || seen.has(paneTab.rel)) continue;
        seen.add(paneTab.rel);
        paths.push(paneTab.rel);
      }
    }
    return paths;
  }, [paneWorkspace.leaves, quickAccessProjectPath]);
  // This registry is large and only consumed by the command palette. Avoid
  // rebuilding its callbacks and objects behind every unrelated button click.
  const workbenchCommands = buildAppWorkbenchCommands({
    quickAccessMode,
    editorNavigationHistory,
    navigateEditorHistory,
    setQuickAccessMode,
    chooseFileTab,
    activeFileKey,
    editorSaveHandles,
    dirtyFileKeys,
    focusedLeafTabs,
    openDockTab,
    bottomPanel,
    toggleBottomPanel,
    editorCommandCapabilities,
    toggleSidebar,
    toggleDock,
    openTerminalTab,
    startTask,
    openStudioTab,
    openSettings,
  });

  // Rail destinations (Projects/Workflows/Schedules/Webhooks) swap the
  // session panel instead of owning the main pane (user decision): the
  // workspace, tab strips, and utility dock stay mounted and interactive
  // while their editors float as popup dialogs.
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
  // Both inheritance entry points replace the source tab only after its heir
  // is ready. The original transcript remains available in session history.
  const replaceWithInheritedSession = useStableEvent(async (sourceSessionId: string, route: DesktopModelSelection) => {
    const api = window.mixdogDesktop;
    if (typeof api?.inheritSession !== 'function') {
      throw new Error('Session inheritance is unavailable on this surface.');
    }
    await inheritSessionInPlace(sourceSessionId, route, {
      inherit: (id, selection) => api.inheritSession(id, selection),
      leaves: () => paneLeavesRef.current,
      focusedLeafId: () => focusedLeafIdRef.current,
      sourceTitle: () => {
        const row = sessions.find((entry) => entry.id === sourceSessionId);
        return row
          ? sessionSummaryTitle(row)
          : tabs.find((tab) => tab.key === `session:${sourceSessionId}`)?.title || '';
      },
      refreshSessions,
      readSession: requestSessionRead,
      snapshot: (id) => defaultSessionLaneStore.get(id) as SessionSnapshot,
      prepare: applySessionLaneResult,
      replace: (leafId, selection, title, sourceKey, focused) => {
        if (focused) {
          navigationEpoch.current += 1;
          setRequestedSessionId('');
          finishPendingConversationHandoff();
          activateSelection(selection, title, sourceKey);
        } else {
          promoteSelectionInLeaf(leafId, selection, sourceKey);
          registerWorkspaceSelection(selection, title, sourceKey);
        }
      },
    });
    setCommandSurface(null);
    setCommandSurfaceSessionId('');
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
    pendingBrowserAutoReveal,
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
  }, [paneSideDocks.open, sidebarPanel, workbenchSideLayout.sideOf]);
  // Every chat pane keeps the same Conversation tree mounted. Focus only
  // selects the command/snapshot owner. Because the
  // root and picker instances survive that prop change, the pointer event that
  // focuses a pane continues into the control the user actually clicked.
  const paneConversationSurface = (
    paneSelection: NavigationSelection,
    focused: boolean,
    focusPane: () => void,
    leafId: string
  ) => {
    const activeHandoff = conversationHandoff?.leafId === leafId ? conversationHandoff : null;
    const presentedSelection = activeHandoff?.selection ?? paneSelection;
    const paneSessionId = presentedSelection.kind === 'session' ? presentedSelection.id : '';
    const draftKey = presentedSelection.kind === 'new' ? presentedSelection.draftId || 'default' : '';
    const prefs = resolvedDraftPrefsFor(draftKey);
    const sessionRow = paneSessionId ? sessions.find((row) => row.id === paneSessionId) : undefined;
    const paneProjectPath = paneSessionId ? registeredProjectPath(sessionRow?.projectPath || '') : prefs.projectPath;
    const paneProjectLabel = projectChromeLabel(paneProjectPath);
    // An agent worker session is deliberately absent from the session catalog
    // (owner === 'agent' is filtered out), so `sessionRow` is undefined and a
    // catalog-derived title degrades to the "Untitled session" placeholder.
    // The title its opener pinned — the worker tag from the Agents panel — is
    // the authoritative label here, so it outranks the catalog lookup.
    const pinnedPaneTitle = presentedSelection.kind === 'session' ? String(presentedSelection.title || '').trim() : '';
    const paneTitle = paneSessionId
      ? pinnedPaneTitle || (sessionRow ? sessionSummaryTitle(sessionRow) : 'Untitled session')
      : 'New task';
    const focusedDraft = focused && Boolean(draftKey);
    const focusedSession = focused && Boolean(paneSessionId);
    return (
      <AppConversationPaneSurface
        focused={focused}
        focusPane={focusPane}
        handoffActive={Boolean(activeHandoff)}
        title={paneTitle}
        projectLabel={paneSessionId ? paneProjectLabel : ''}
        titleContent={
          focusedSession && selectedSession ? (
            <StableSessionTitle
              title={paneTitle}
              editing={headerTitleEditingSessionId === selectedSession.id}
              draft={headerTitleDraft}
              invalid={headerTitleInvalid}
              onOpen={openHeaderTitleEditor}
              onDraftChange={setHeaderTitleDraft}
              onCommit={commitHeaderTitleEditor}
              onCancel={closeHeaderTitleEditor}
            />
          ) : (
            paneTitle
          )
        }
        conversationProps={{
          focused,
          sessionId: paneSessionId,
          hidden: false,
          transcriptPending: Boolean(paneSessionId) && paneTranscriptRendererPending,
          reconcileOnMount: paneSessionId !== requestedSessionId,
          invokeResult,
          errors,
          submit: paneSessionId
            ? paneSubmitFor(paneSessionId)
            : presentedSelection.kind === 'new'
              ? paneDraftSubmitFor(presentedSelection, leafId)
              : submit,
          applySnapshot: paneSessionId ? (next) => applySessionLaneResult(paneSessionId, next) : applySnapshot,
          transitioning: false,
          composerFocusRequest: focused ? composerFocusRequest : 0,
          onNewTask: conversationNewTask,
          onClearToNewTask: conversationClearToNewTask,
          onClearProject: conversationClearProject,
          onResumeSession: conversationResumeSession,
          onOpenSessions: openSidebar,
          onOpenProjects: conversationOpenProjects,
          onOpenSettings: openSettings,
          projects,
          showProjectSelector: Boolean(draftKey),
          draftMode: Boolean(draftKey),
          draftId: draftKey,
          draftModelSelection: draftKey ? prefs.modelSelection : undefined,
          draftWorkflow: draftKey ? prefs.workflow : undefined,
          draftOrchestrationMode: draftKey ? prefs.orchestrationMode : undefined,
          onDraftModelSelection: focusedDraft ? stageNewTaskModelSelection : undefined,
          onRoutePreferenceApplied: rememberSessionRouteForNextTask,
          onDraftWorkflow: focusedDraft ? stageNewTaskWorkflow : undefined,
          onDraftOrchestrationMode: focusedDraft ? stageNewTaskOrchestrationMode : undefined,
          activeProjectPath: paneProjectPath,
          activeProjectLabel: paneProjectLabel,
          onSelectProject: conversationSelectProject,
          onOpenCommandSurface: (surface) => openConversationCommandSurface(surface, paneSessionId),
          onOpenFile: (project, rel) => {
            focusPane();
            openFileTab(project, rel);
          },
          // The context card runs inheritance in place; /inherit keeps the
          // dialog for the typed command.
          onInheritSession: replaceWithInheritedSession,
        }}
      />
    );
  };
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
  // The restored pane tree does not mount its Conversation owners until
  // validation completes. Keep the opaque boot cover up until then, so those
  // owners can register with the surface barrier and reveal only after their
  // real transcript frame has painted.
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
  const renderWorkbenchSideView = (
    side: WorkbenchSide,
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
    // Pane-embedded right dock: binds session Diff and project-scoped legacy
    // views to the pane's own session/project, routing tab/close back to that
    // pane. A prewarmed pane mounts its remembered view while still folded.
    pane?: {
      leafId: string;
      projectPath: string;
      sessionId: string;
      prewarm?: boolean;
    }
  ): React.ReactNode => {
    if (id === 'sessions') {
      return (
        <SessionSidebar
          open={active}
          panelTitleDragProps={titleDragProps}
          sessions={sessions}
          sessionsReady={sessionCatalogReady}
          workingSessionIds={workingSessionIds}
          unreadSessionIds={unreadSessionIds}
          selection={sidebarSelection}
          onNewTask={sidebarNewTask}
          onNewStudio={sidebarNewStudio}
          onPrefetchSession={window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined}
          onResumeSession={sidebarResumeSession}
          onRenameSession={renameSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSession}
        />
      );
    }
    if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
      return (
        <SessionSidebar
          open={active}
          panelActive
          panelTitle={sideViewDescriptors.get(id)?.label}
          panelTitleDragProps={titleDragProps}
          sessions={sessions}
          sessionsReady={sessionCatalogReady}
          workingSessionIds={workingSessionIds}
          unreadSessionIds={unreadSessionIds}
          selection={sidebarSelection}
          onNewTask={sidebarNewTask}
          onNewStudio={sidebarNewStudio}
          onPrefetchSession={window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined}
          onResumeSession={sidebarResumeSession}
          onRenameSession={renameSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSession}
        >
          {renderSidebarPanel(id as SidebarPanelKey, active)}
        </SessionSidebar>
      );
    }
    if (id === 'session-diff') {
      if (!pane) return null;
      const sessionId = pane.sessionId;
      return (
        <SessionDiffPane
          sessionId={sessionId}
          active={active}
          openRel={sessionDiffs.get(sessionId)?.rel ?? ''}
          onOpenDiff={
            sessionId && pane.projectPath
              ? (rel) => {
                  void prefetchDiffView().catch(() => {});
                  setSessionDiff(sessionId, {
                    kind: 'diff',
                    project: pane.projectPath,
                    rel,
                    source: 'session',
                    hash: sessionId,
                  });
                }
              : undefined
          }
        />
      );
    }
    // Session-owned surfaces render in the pane dock's persistent stack.
    if (id === 'browser' || id === 'terminal') return null;
    const tab = id as UtilityDockTab;
    return (
      <SnapshotUtilityDock
        snapshotStore={snapshotStore}
        hidden={!active}
        prewarm={Boolean(pane?.prewarm)}
        open={active}
        tab={tab}
        showTitle={!pane}
        title={sideViewDescriptors.get(id)?.label}
        titleDragProps={titleDragProps}
        sessions={sessions}
        sessionsReady={sessionCatalogReady}
        activeSessionIds={observedAgentSessionIds}
        unreadSessionIds={unreadSessionIds}
        onPrefetchSession={prefetchSession}
        projectPath={pane?.projectPath || quickAccessProjectPath}
        workspaceFolders={workbenchWorkspace.workspace.folders as DesktopWorkspaceFolder[]}
        onSelectProject={selectToolProject}
        metricSurface={side === 'left' ? 'sidebar' : 'dock'}
        entering
        contentReady
        onOpenFile={dockOpenFile}
        onOpenFileAt={dockOpenFileAt}
        onOpenDiff={
          pane
            ? (project, rel, request) => {
                void prefetchDiffView().catch(() => {});
                paneSideDocks.openDiff(pane.leafId, project, rel, request);
              }
            : (project, rel, request) => {
                // Left sidebar: the diff pairs beside the panel; narrow bands
                // keep the diff tab.
                const cleanProject = String(project || '').trim();
                const cleanRel = String(rel || '')
                  .replace(/\\/g, '/')
                  .replace(/^\/+/, '');
                if (!cleanProject || !cleanRel) return;
                if (!sidebarDiffColumnAvailable()) {
                  dockOpenDiff(project, rel, request);
                  return;
                }
                void prefetchDiffView().catch(() => {});
                setSidebarDiff({
                  view: id,
                  diff: { kind: 'diff', project: cleanProject, rel: cleanRel, ...request },
                });
              }
        }
        onOpenPullRequest={dockOpenPullRequest}
        onOpenLeadSession={dockOpenLeadSession}
        onOpenAgentSession={dockOpenAgentSession}
      />
    );
  };
  // Pane-scoped tools follow the active session project, while the left-side
  // Source Control uses the shared quick-access Project.
  const paneProjectPathFor = (leaf: PaneLeaf): string => {
    const active = paneActiveSelection(leaf);
    if (active?.kind === 'session') {
      const row = sessions.find((session) => session.id === active.id);
      const registered = registeredProjectPath(row?.projectPath || '');
      if (registered) return registered;
    }
    if (active?.kind === 'file' && active.project) return active.project;
    if (active?.kind === 'new') {
      const prefs = resolvedDraftPrefsFor(active.draftId || 'default');
      if (prefs.projectPath) return prefs.projectPath;
    }
    return quickAccessProjectPath;
  };
  const focusedPaneForDockPrewarm = paneWorkspace.leaves.find((leaf) => leaf.id === paneWorkspace.focusedLeafId);
  const focusedPaneDockProjectPath = focusedPaneForDockPrewarm
    ? paneProjectPathFor(focusedPaneForDockPrewarm)
    : quickAccessProjectPath;
  const dockBodyWarm = useAppDockWarmup(desktopBootReady, focusedPaneDockProjectPath);
  const renderPaneSideDock = (leaf: PaneLeaf, focused: boolean) =>
    renderPaneSideDockView(leaf, focused, {
      paneWorkspace,
      paneSideDocks,
      sessionSurfaces: sessionPaneSurfaces,
      workbenchSideLayout,
      sideViewDescriptors,
      dockBodyWarm,
      closePaneRightRegion,
      selectWorkbenchSideView,
      moveWorkbenchSideGroup,
      moveWorkbenchSideView,
      openFileTab,
      paneProjectPathFor,
      renderRightView: (id, active, titleDragProps, pane) =>
        renderWorkbenchSideView('right', id, active, titleDragProps, pane),
    });
  // Problems belongs to the file editor, like its diff sub-panel:
  // it docks under the pane's file editor, scoped to that file's project,
  // and exists only while the pane's active tab is a file. Open state stays
  // per pane (openPaneIds), height is shared.
  const renderPaneProblems = (leaf: PaneLeaf) =>
    renderPaneProblemsView(leaf, {
      bottomPanel,
      problemsFilter,
      setProblemsFilter,
      problemsCollapseNonce,
      setProblemsCollapseNonce,
      openFileTab,
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
          <div
            className="sidebar-drawer-frame"
            data-state={sidebarOpen ? 'open' : 'closed'}
            data-motion={sidebarMotion}
          >
            <ActivityRail
              sidebarOpen={sidebarOpen && !sidebarPanel}
              onToggleSessions={() => {
                // Do not force-close the right dock here. Narrow layouts enforce
                // one sheet in openSidebar/toggleSidebar; wide layouts keep both
                // edges open.
                // With a rail panel showing, Sessions first reclaims the panel
                // area; a plain click keeps the normal expand/collapse toggle.
                if (sidebarPanel) {
                  closeSidebarPanels();
                  openSidebar();
                } else toggleSidebar();
              }}
              // Primary-nav selection mirror (user request): the button for the
              // visible sidebar panel reads as selected. Selection mirrors the
              // REQUESTED panel: presentation lags by the settle window, and a
              // re-click during that window must still read as the toggle-close.
              activeSurface={settingsOpen ? 'settings' : sidebarOpen && sidebarPanel ? sidebarPanel : null}
              // Rail destinations share the Sessions toggle contract: the first
              // click opens that list, while re-selecting it collapses the whole
              // sidebar and resets the next expansion to Sessions.
              onOpenProjects={() => {
                openProjects();
                void refreshProjects().catch(() => undefined);
              }}
              onPrefetchProjects={() => {
                trackSidebarPanelModule('projects', loadSidebarPanelModule.projects());
              }}
              onOpenSchedules={openSchedules}
              onPrefetchSchedules={() => {
                trackSidebarPanelModule('schedules', loadSidebarPanelModule.schedules());
              }}
              onOpenWebhooks={openWebhooks}
              onPrefetchWebhooks={() => {
                trackSidebarPanelModule('webhooks', loadSidebarPanelModule.webhooks());
              }}
              onCloseActiveSurface={closeActiveRailPanel}
              onOpenSettings={() => {
                closeSidebarForNavigation('instant');
                openSettings();
              }}
              onOpenProviders={() => {
                closeSidebarForNavigation('instant');
                openSettings('providers');
              }}
              // The usage flyout answers what is LEFT; its ℹ️ opens what was SPENT.
              onOpenUsageStats={() => setCommandSurface('stats')}
              onPrefetchSettings={warmSettingsView}
              navigationItems={workbenchSideLayout.layout.left.flatMap((group) => {
                const descriptor = sideViewDescriptors.get(group[0]);
                return descriptor ? [{ id: group[0], label: descriptor.tooltip || descriptor.label }] : [];
              })}
              primaryNavigation={
                <WorkbenchSideIconBar
                  side="left"
                  groups={workbenchSideLayout.layout.left}
                  activeRoot={activeSideViews.left}
                  descriptors={sideViewDescriptors}
                  orientation="vertical"
                  onSelect={selectWorkbenchSideView}
                  onMoveGroup={moveWorkbenchSideGroup}
                  onMoveView={moveWorkbenchSideView}
                />
              }
            />
            <WorkbenchSidePanel
              side="left"
              open={sidebarOpen}
              groups={workbenchSideLayout.layout.left}
              activeRoot={activeSideViews.left}
              descriptors={sideViewDescriptors}
              onSelect={selectWorkbenchSideView}
              onMoveGroup={moveWorkbenchSideGroup}
              onMoveView={moveWorkbenchSideView}
              renderView={(id, active, titleDragProps) => renderWorkbenchSideView('left', id, active, titleDragProps)}
            />
            <SidebarDiffColumn
              diff={sidebarDiff?.diff ?? null}
              showing={
                Boolean(sidebarDiff) &&
                sidebarOpen &&
                workbenchSideLayout.layout.left.length > 0 &&
                activeSideViews.left === sidebarDiff?.view
              }
              onClose={closeSidebarDiff}
              openFileTab={openFileTab}
            />
          </div>
          {/* The scrim stays mounted so it can FADE with the drawer instead of
            blinking out the moment the slide starts (CSS shows it only on
            narrow viewports). */}
          <button
            className="sidebar-backdrop"
            data-state={sidebarOpen ? 'open' : 'closed'}
            aria-hidden={!sidebarOpen}
            tabIndex={sidebarOpen ? 0 : -1}
            onClick={() => applySidebarOpen(false)}
            aria-label={t('Close session sidebar')}
          />
          <main className="main-panel" ref={mainPanelRef}>
            {/* Split-pane workspace: with one pane the classic markup renders
              1:1 — zero layout drift. With 2+ panes the focused leaf keeps
              this same interactive surface and every other session leaf
              streams live from its session lane. */}
            {(() => {
              const workspaceSurface = (
                <div className="workspace">
                  <header className="session-header" aria-label={t('Current task')}>
                    <div className="session-header-content">
                      <h1 data-tooltip={visibleSessionTitle}>
                        {selectedSession ? (
                          <StableSessionTitle
                            title={visibleSessionTitle}
                            editing={headerTitleEditingSessionId === selectedSession.id}
                            draft={headerTitleDraft}
                            invalid={headerTitleInvalid}
                            onOpen={openHeaderTitleEditor}
                            onDraftChange={setHeaderTitleDraft}
                            onCommit={commitHeaderTitleEditor}
                            onCancel={closeHeaderTitleEditor}
                          />
                        ) : (
                          visibleSessionTitle
                        )}
                      </h1>
                      {navigationSelection.kind === 'session' && activeProjectLabel && (
                        <span className="session-project-badge">{activeProjectLabel}</span>
                      )}
                    </div>
                  </header>
                  <DraftConversation
                    transcriptPending={transcriptRendererPending}
                    invokeResult={invokeResult}
                    errors={errors}
                    submit={submit}
                    applySnapshot={applySnapshot}
                    transitioning={false}
                    composerFocusRequest={composerFocusRequest}
                    onNewTask={conversationNewTask}
                    onClearToNewTask={conversationClearToNewTask}
                    onClearProject={conversationClearProject}
                    onResumeSession={conversationResumeSession}
                    onOpenSessions={desktopFeatureEnabled('sessions') ? openSidebar : () => {}}
                    onOpenProjects={conversationOpenProjects}
                    onOpenSettings={openSettings}
                    projects={projects}
                    showProjectSelector={selection.kind === 'new'}
                    // A draft ALWAYS stages model/workflow locally (per-draft
                    // prefs) — routing a pre-session change through the engine made
                    // it a GLOBAL default that repainted every pane (user report).
                    // The staged values commit at session creation: the first
                    // submit passes them as submitNewTask options. Mid-session
                    // changes keep flowing to that session's own engine.
                    draftMode={selection.kind === 'new'}
                    draftId={selection.kind === 'new' ? selection.draftId || 'default' : ''}
                    draftModelSelection={newTaskModelSelection}
                    draftWorkflow={newTaskWorkflow}
                    draftOrchestrationMode={newTaskOrchestrationMode}
                    onDraftModelSelection={selection.kind === 'new' ? stageNewTaskModelSelection : undefined}
                    onRoutePreferenceApplied={rememberSessionRouteForNextTask}
                    onDraftWorkflow={selection.kind === 'new' ? stageNewTaskWorkflow : undefined}
                    onDraftOrchestrationMode={selection.kind === 'new' ? stageNewTaskOrchestrationMode : undefined}
                    activeProjectPath={activeProjectPath}
                    activeProjectLabel={activeProjectLabel}
                    onSelectProject={conversationSelectProject}
                    onOpenFile={openFileTab}
                    onOpenCommandSurface={openConversationCommandSurface}
                  />
                </div>
              );
              return (
                <PaneWorkspace
                  workspace={paneWorkspace}
                  observedSessionIds={observedAgentSessionIds}
                  renderStrip={paneStripFor}
                  renderConversation={paneConversationSurface}
                  renderFileEditors={paneFileEditors}
                  renderUtilityTabs={paneUtilityTabs}
                  renderSideDock={renderPaneSideDock}
                  renderProblems={renderPaneProblems}
                  onFocusSelection={activatePaneSurface}
                  onOpenDroppedPaths={openDroppedPaths}
                  // Defensive fallback for malformed external state; normal
                  // startup and close paths always retain a New Task pane.
                  renderActive={(leaf) => (leaf.tabs.length === 0 ? <WorkspaceEmptyState /> : workspaceSurface)}
                />
              );
            })()}
          </main>
          <SessionBrowserParkingHost controller={browserSurfaces} />
          <SessionTerminalParkingHost controller={terminalSurfaces} />
          {/* Bottom sheet band keeps outside-tap dismissal without dimming the
            work surface, matching both side sheets. */}
          <button
            className="panel-backdrop"
            data-state={bottomPanel.open ? 'open' : 'closed'}
            aria-hidden={!bottomPanel.open}
            tabIndex={bottomPanel.open ? 0 : -1}
            onClick={() => bottomPanel.setOpen(false)}
            aria-label={t('Close panel')}
          />
        </div>
        {paneUtilitySurfacePortals}
        {quickAccessMode && (
          <WorkbenchQuickAccess
            key={quickAccessMode}
            mode={quickAccessMode}
            projectPath={quickAccessProjectPath}
            recentFiles={quickAccessRecentFiles}
            commands={workbenchCommands}
            onOpenFile={(rel, line) => {
              if (quickAccessProjectPath) openFileTab(quickAccessProjectPath, rel, line);
            }}
            onClose={() => setQuickAccessMode(null)}
          />
        )}
        {tabSwitcher && (
          <div className="workspace-tab-switcher" role="listbox" aria-label={t('Open tabs, most recent first')}>
            {tabSwitcher.keys.map((key, index) => {
              const selection = focusedLeafForShortcuts?.tabs.find((entry) => navigationKey(entry) === key);
              if (!selection) return null;
              return (
                <div
                  key={key}
                  role="option"
                  aria-selected={index === tabSwitcher.index}
                  className={index === tabSwitcher.index ? 'active' : ''}
                >
                  {stripTitleFor(key, selection)}
                </div>
              );
            })}
          </div>
        )}
        {pendingUnsavedClose && (
          <UnsavedChangesDialog
            title={pendingUnsavedClose.tab.title.replace(/^●\s*/, '')}
            busy={unsavedCloseBusy}
            error={unsavedCloseError}
            onSave={() => {
              void saveAndClosePendingTab();
            }}
            onDiscard={discardAndClosePendingTab}
            onCancel={cancelPendingTabClose}
          />
        )}
        <Suspense
          fallback={
            settingsOpen ? // Keep the current workbench visible until the lazy Settings dialog is
            // ready. A full-window cover made a cold web chunk look like an empty
            // page before the actual dialog appeared.
            null : commandSurface || onboardingOpen ? (
              <DesktopLoadingSurface label="Loading view…" overlay />
            ) : null
          }
        >
          {(settingsOpen || settingsMounted.current || settingsPrewarmed) && (
            <SettingsView
              open={settingsOpen}
              initialSection={settingsSection}
              onCompose={(text) => {
                setSettingsOpen(false);
                window.dispatchEvent(new CustomEvent('mixdog:composer-draft', { detail: text }));
              }}
              onClose={() => setSettingsOpen(false)}
            />
          )}
          {(['context', 'usage', 'doctor', 'inherit', 'stats'] as const).map((surface) =>
            commandSurface === surface || mountedCommandSurfaces.current.has(surface) ? (
              <CommandSurface
                key={surface === 'context' || surface === 'inherit' ? `${surface}:${commandSurfaceSessionId}` : surface}
                surface={surface}
                open={commandSurface === surface}
                sessionId={surface === 'context' || surface === 'inherit' ? commandSurfaceSessionId : ''}
                snapshot={
                  surface === 'context' || surface === 'inherit' ? (commandSurfaceLane ?? EMPTY_SNAPSHOT) : snapshot
                }
                onInherit={surface === 'inherit' ? replaceWithInheritedSession : undefined}
                onClose={() => {
                  setCommandSurface(null);
                  setCommandSurfaceSessionId('');
                }}
              />
            ) : null
          )}
          {onboardingOpen && <OnboardingWizard api={window.mixdogDesktop} onDone={() => setOnboardingOpen(false)} />}
        </Suspense>
        {updateDialogOpen && updaterState.status === 'ready' && (
          <DesktopUpdateDialog
            version={updaterState.version}
            onCancel={closeDesktopUpdate}
            onConfirm={installDesktopUpdate}
          />
        )}
        <DesktopToastRegion
          bridgeError={
            error || (!connected ? 'Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop.' : '')
          }
          toasts={Array.isArray(snapshot.toasts) ? snapshot.toasts : []}
          onDismissBridgeError={() => setError('')}
        />
        <TooltipLayer />
      </div>
    </DesktopBootGate>
  );
}

export { ApprovalCard } from './ApprovalCard';
export { DesktopUpdateDialog } from './notifications';
export { ContextUsageIndicator, LiveWorkStatus, TranscriptRow } from './TranscriptView';
