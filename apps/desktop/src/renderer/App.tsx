import React, {
  // Lucide's Wifi draws its base dot as a 0.01-length stroke ("M12 20h.01") —
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import {
  Bot,
  Clock,
  FileDiff,
  GitCompare,
  Github,
  Globe,
  Layers3,
  MessageSquare,
  Package,
  PanelsTopLeft,
  Search,
  Sparkles,
  SquareTerminal,
  Webhook,
} from "lucide-react";
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import type {
  DesktopModelSelection,
  DesktopProjectSummary,
  DesktopUpdaterState,
  DesktopWorkflowState,
  DesktopWorkspaceFolder,
  SessionSnapshot
} from "../shared/contract";
import {
  sessionSummaryTitle
} from "../shared/session-title.mjs";
import { DESKTOP_WORKSPACE_MIN_WIDTH } from "../shared/window-layout";
import {
  applyDesktopThemePreference,
  getDesktopThemePreference
} from "./desktop-theme";
import {
  DesktopTitlebar,
  SessionSidebar,
  type NavigationSelection,
  type WorkspaceSelection,
  type WorkspaceTab,
} from "./navigation";
import {
  canSplitPaneSize,
  paneActiveSessionIds,
  paneActiveSelection,
  paneLeafIdInVerticalDirection,
  paneTabAcrossVisualBoundary,
  type PaneLeaf,
} from "./pane-layout";
import { usePaneWorkspace } from "./pane-workspace-state";
import { PaneWorkspace } from "./PaneWorkspace";
import {
  defaultSessionLaneStore,
  useSessionLane,
} from "./session-lane-store";
import {
  resolveDesktopSlashCommand,
  type SettingsSection as SlashSettingsSection
} from "./slash-commands";
import {
  extensionSectionForSettings,
  type ExtensionsSection,
} from "./extension-sections";
import { TooltipLayer } from "./TooltipLayer";
import {
  UnsavedChangesDialog,
  WorkbenchQuickAccess,
  type WorkbenchQuickAccessMode,
} from "./WorkbenchOverlays";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";

import { ActivityRail } from "./ActivityRail";
import { preloadAgentPool } from "./AgentActivityPane";
import {
  desktopBootPrerequisitesReady,
  markBootStage,
} from "./boot-metrics";
import { BottomPanel } from "./BottomPanel";
import {
  armBootWarmup,
  BOOT_WARMUP,
  BOOT_WARMUP_ARM_DELAY_MS,
  scheduleBootWarmup,
} from "./boot-warmup";
import { bottomPanelOpenForPane } from "./bottom-panel-pane-state";
import { useBrowserFeatureInstalled } from "./browser-feature-install";
import { agentActivitySessionIds, EMPTY_SNAPSHOT, type RecordValue, type Snapshot } from "./desktop-types";
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
  desktopUtilityDockTabEnabled,
} from "./desktop-feature-config";
import { primeEditorFileLoad } from "./editor-file-loader";
import { isMobileRemoteSurface } from "./MobileTabOverview";
import { registerMobileBack } from "./mobile-back";
import {
  getEditorCommandCapabilities,
  subscribeEditorLanguageStore,
} from "./editor-language-store";
import { loadCommandSurfaceModule } from "./command-surface-loader";
import {
  prefetchBrowserPane,
  prefetchDiffView,
  prefetchEditorPane,
  prefetchSurfaceForSelection,
  prefetchTerminalPane,
} from "./lazy-widgets";
import { connectionQuality } from "./network-conditions";
import {
  DesktopBootGate,
} from "./PaneSurfaceGate";
import {
  type PullRequestOpenHandler,
} from "./PullRequestsPane";
import {
  beginStudioLoad,
  reportStudioLoadStage,
} from "./renderer-load-metrics";
import type { SourceControlDiffRequest } from "./SourceControlDock";
import { shouldFocusComposerFromWindowKey } from "./surface-input-focus";
import { asRecord, displayProject, navigationKey, newDraftSelection, newStudioSelection } from "./text-format";
import { isMarkdownBodyReady, preloadMarkdownBody } from "./markdown-body-loader";
import { useEditorNavigation } from "./use-editor-navigation";
import {
  usePaneTabClose,
  type ConversationHandoff,
} from "./use-pane-tab-close";
import { usePaneTabNavigation } from "./use-pane-tab-navigation";
import { usePushNotificationNavigation } from "./use-push-notification-navigation";
import { useSharedIntakeBoot } from "./share-target-intake";
import { useShellUpdateReload } from "./use-shell-update-reload";
import { useAppWorkspaceNavigation } from "./use-app-workspace-navigation";
import { useAppPaneChrome } from "./use-app-pane-chrome";
import { useAppStartupRestore } from "./use-app-startup-restore";
import { useAppSessionActions } from "./use-app-session-actions";
import {
  AppConversationPaneSurface,
} from "./app-conversation-pane-surfaces";
import { WORKBENCH_PANEL_REGISTRY } from "./workbench-panel-registry";
import {
  ProjectProblemCount,
  WorkbenchProblemsFilter,
  WorkbenchProblemsPane,
  WorkbenchProblemsSeverityActions,
} from "./WorkbenchProblems";

import {
  desktopChromeSnapshotsEqual
} from "./desktop-snapshot-store";
import { DesktopToastRegion, DesktopUpdateDialog } from "./notifications";
import { RemoteConnectionBanner } from "./RemoteConnectionBanner";
import {
  loadSidebarPanelModule,
  StableSessionTitle,
  type SidebarPanelKey,
} from "./app-shell-components";
import { loadStudioViewModule } from "./studio-loader";
export {
  nextHotFileEditorKeys,
  shouldKeepFileEditorMounted,
} from "./app-shell-components";

const LAST_PROJECT_KEY = 'mixdog.desktop-last-project.v1';
const LAST_SESSION_KEY = 'mixdog.desktop-last-session.v1';
function applySessionLaneResult(sessionId: string, next: SessionSnapshot | null): void {
  if (!sessionId || !next || typeof next !== "object") return;
  const returnedSessionId = String((next as Snapshot).sessionId || "");
  if (returnedSessionId && returnedSessionId !== sessionId) return;
  defaultSessionLaneStore.apply({
    sessionId,
    snapshot: next,
    frameSource: "live",
  });
}
function desktopProjectPathKey(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLocaleLowerCase();
}
function registeredDesktopProjectPath(
  projects: readonly DesktopProjectSummary[],
  candidate: unknown,
): string {
  const key = desktopProjectPathKey(candidate);
  if (!key) return "";
  return projects.find((project) => desktopProjectPathKey(project.path) === key)?.path || "";
}
interface EditorSaveHandle {
  save(): Promise<boolean>;
  discard(): Promise<void>;
}
let settingsViewModulePromise: Promise<typeof import("./settings/SettingsView")> | null = null;
function loadSettingsViewModule() {
  settingsViewModulePromise ||= import("./settings/SettingsView");
  return settingsViewModulePromise;
}
const SettingsView = lazy(() => loadSettingsViewModule()
  .then((module) => ({ default: module.SettingsView })));
const loadOnboardingWizardModule = () => import("./settings/OnboardingWizard");
const OnboardingWizard = lazy(() => loadOnboardingWizardModule()
  .then((module) => ({ default: module.OnboardingWizard })));
const CommandSurface = lazy(() => loadCommandSurfaceModule()
  .then((module) => ({ default: module.CommandSurface })));
// Route chunk warm-up is scheduled after startup settles below.
import {
  DraftConversation,
  preloadUtilityDock,
  prewarmUtilityDockGitState,
  selectDesktopSnapshot,
  SnapshotUtilityDock,
  requestSessionRead,
  useDesktopSnapshotSelector,
} from "./app-snapshot-views";

import { useDesktopState } from "./app-desktop-state";
import { createProjectActions } from "./app-project-actions";
import {
  acceptedProjectCatalog,
  readCachedProjectCatalog,
  resolveProjectPathAgainstCatalog,
  writeCachedProjectCatalog,
} from "./project-catalog-cache";
import { useSessionCatalog } from "./app-session-catalog";
import { useAppShellPanels } from "./use-app-shell-panels";
import {
  draftModelSelectionFromSnapshot,
  resolvedStoredProjectPath,
  useDraftPanePreferences,
  type DraftPanePrefs,
} from "./use-draft-pane-preferences";
import { useAppSubmitRouting } from "./use-app-submit-routing";
import { useAppSidebarSurface } from "./use-app-sidebar-surface";
import { buildAppWorkbenchCommands } from "./app-workbench-commands";
import { useAppPersistentPaneSurfaces } from "./use-app-persistent-pane-surfaces";
import { useStableEvent } from "./use-stable-event";
import { resolveUnreadViewedSessionId, useUnreadSessions } from "./app-unread-sessions";
import { DesktopLoadingSurface } from "./RendererRecovery";
import { SessionDiffPane } from "./SessionDiffPane";
import { useWorkbenchWorkspace } from "./workbench-workspace";
import {
  DEFAULT_SIDEBAR_VIEW_ORDER,
  type SidebarViewGroup,
} from "./sidebar-view-layout";
import {
  WorkbenchSideIconBar,
  WorkbenchSidePanel,
  initialActiveWorkbenchSideViews,
  isWorkbenchSideLauncher,
  useWorkbenchSideViewLayout,
  type WorkbenchSide,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewDescriptor,
  type WorkbenchSideViewId,
  type WorkbenchSideViewPlacement,
} from "./workbench-side-view-layout";
import {
  paneDockActiveRoot,
  PaneSideDock,
  usePaneSideDocks,
  type PaneSideDockDiff,
} from "./pane-side-dock";
import { PaneDockToggles } from "./pane-dock-toggles";
import {
  SessionBrowserParkingHost,
  SessionBrowserSlot,
  useSessionBrowserSurfaces,
} from "./session-browser-surfaces";
import {
  browserSurfaceRequestShouldReveal,
  browserSurfaceRevealPlan,
} from "./session-browser-policy";
import {
  sessionSideDockEntryForSession,
  withSessionDiff,
  withSessionPanelView,
  withSessionSideSurface,
  type SessionSidePanelView,
  type SessionSideSurface,
} from "./session-side-surface-policy";
import {
  SessionTerminalParkingHost,
  SessionTerminalSlot,
  useSessionTerminalSurfaces,
} from "./session-terminal-surfaces";
import type { UtilityDockTab } from "./UtilityDock";
import { releaseSessionDiff } from "./session-diff-cache";

const UI_OPEN_REQUEST_TTL_MS = 15_000;

export function App() {
  markBootStage("app-render");
  useLayoutEffect(() => {
    markBootStage("react-committed");
    window.dispatchEvent(new Event("mixdog:react-committed"));
  }, []);
  const {
    snapshotStore,
    connected,
    hydrated: snapshotHydrated,
    error,
    setError,
    applySnapshot,
  } = useDesktopState();
  const snapshot = useDesktopSnapshotSelector(
    snapshotStore,
    selectDesktopSnapshot,
    desktopChromeSnapshotsEqual,
  );
  const paneWorkspace = usePaneWorkspace();
  const browserSurfaces = useSessionBrowserSurfaces();
  const terminalSurfaces = useSessionTerminalSurfaces();
  const [sessionSideSurfaces, setSessionSideSurfaces] =
    useState<ReadonlyMap<string, SessionSideSurface>>(() => new Map());
  const setSessionSideSurface = useCallback((
    sessionId: string,
    surface: SessionSideSurface | null,
  ) => {
    setSessionSideSurfaces((current) =>
      withSessionSideSurface(current, sessionId, surface));
  }, []);
  // The Session Diff LIST's open state, per session (user: 세션 종속 — 다른
  // 세션으로 넘어가면 그 세션 기본값으로, 안 열려 있었으면 닫힘). The diff
  // FILE rides `sessionDiffs`, the browser/terminal ride
  // `sessionSideSurfaces`; this covers the list itself.
  const [sessionPanelViews, setSessionPanelViews] =
    useState<ReadonlyMap<string, SessionSidePanelView>>(() => new Map());
  const setSessionPanelView = useCallback((
    sessionId: string,
    view: SessionSidePanelView | null,
  ) => {
    setSessionPanelViews((current) =>
      withSessionPanelView(current, sessionId, view));
  }, []);
  // The Session Diff rows' open file, per session (user: 세션 종속): it rides
  // the dock's diff column only while its own session is the pane's active
  // conversation, and never touches the pane's remembered dock state.
  const [sessionDiffs, setSessionDiffs] =
    useState<ReadonlyMap<string, PaneSideDockDiff>>(() => new Map());
  const setSessionDiff = useCallback((
    sessionId: string,
    diff: PaneSideDockDiff | null,
  ) => {
    setSessionDiffs((current) => withSessionDiff(current, sessionId, diff));
  }, []);
  const pendingBrowserAutoReveal = useRef(new Set<string>());
  const releaseDeletedSessionSurfaces = useCallback((sessionId: string) => {
    pendingBrowserAutoReveal.current.delete(sessionId);
    setSessionSideSurfaces((current) =>
      withSessionSideSurface(current, sessionId, null));
    setSessionDiffs((current) => withSessionDiff(current, sessionId, null));
    setSessionPanelViews((current) => withSessionPanelView(current, sessionId, null));
    releaseSessionDiff(sessionId);
    browserSurfaces.release(sessionId);
    terminalSurfaces.release(sessionId);
  }, [browserSurfaces, terminalSurfaces]);
  useEffect(() => window.mixdogDesktop?.onBrowserRemoteViewerChanged?.((change) => {
    browserSurfaces.setRemoteViewed(String(change?.sessionId || ""), change?.active === true);
  }), [browserSurfaces]);
  useEffect(() => window.mixdogDesktop?.onBrowserSessionReleased?.((sessionId) => {
    pendingBrowserAutoReveal.current.delete(sessionId);
    setSessionSideSurfaces((current) => current.get(sessionId) === "browser"
      ? withSessionSideSurface(current, sessionId, null)
      : current);
    browserSurfaces.release(sessionId);
  }), [browserSurfaces]);
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
    openWorkflows,
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
    workflowsOpen,
  } = useAppShellPanels(paneWorkspace.focusedLeafId);
  const settingsMounted = useRef(false);
  const mountedCommandSurfaces = useRef(new Set<string>());
  if (settingsOpen) settingsMounted.current = true;
  // The dialog stays mounted after its first open for a warm reopen; the
  // warm-up lane grants that first mount too, once the settings sweep has
  // landed, so the gear click toggles a live tree (316ms cold → warm).
  const [settingsPrewarmed, setSettingsPrewarmed] = useState(false);
  useEffect(() => {
    if (!desktopFeatureEnabled("settings") || settingsPrewarmed) return undefined;
    return scheduleBootWarmup({
      id: "settings:mount",
      priority: BOOT_WARMUP.settingsMount,
      run: () => loadSettingsViewModule().then(() => setSettingsPrewarmed(true)).catch(() => {}),
    });
  }, [settingsPrewarmed]);
  if (commandSurface) mountedCommandSurfaces.current.add(commandSurface);
  const browserFeatureInstalled = useBrowserFeatureInstalled();
  const availableSideViews = useMemo<WorkbenchSideViewId[]>(() => [
    ...(desktopFeatureEnabled("sessions") ? ["sessions" as const] : []),
    ...DEFAULT_SIDEBAR_VIEW_ORDER.filter((panel) =>
      desktopSidebarDestinationEnabled(panel)),
    "studio" as const,
    "session-diff" as const,
    // Browser Use is install-first, so its launcher joins the rail only once
    // the install marker resolves.
    ...(browserFeatureInstalled ? ["browser" as const] : []),
    "terminal" as const,
    ...(["agents", "search", "source-control", "pull-requests"] as const)
      .filter((panel) => desktopUtilityDockTabEnabled(panel)),
  ], [browserFeatureInstalled]);
  const workbenchSideLayout = useWorkbenchSideViewLayout(availableSideViews);
  const sidebarViewGroups = useMemo<readonly SidebarViewGroup[]>(() =>
    [...workbenchSideLayout.layout.left, ...workbenchSideLayout.layout.right]
      .map((group) => group.filter((id) =>
        DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) as SidebarViewGroup)
      .filter((group) => group.length > 0),
  [workbenchSideLayout.layout]);
  const [activeSideViews, setActiveSideViews] = useState<
    Record<WorkbenchSide, WorkbenchSideViewId | null>
  >(() => initialActiveWorkbenchSideViews(workbenchSideLayout.layout));
  // Per-pane right docks (user: 오른쪽 사이드탭을 PANE에 종속): every pane
  // leaf owns its own dock open/view state, and window-level dock actions
  // (shortcuts, status-island toggle, rail drops) land on the focused pane.
  const paneSideDocks = usePaneSideDocks({
    leafIds: paneWorkspace.leaves.map((leaf) => leaf.id),
    groups: workbenchSideLayout.layout.right,
  });
  const focusedPaneDockOpen =
    paneSideDocks.entryFor(paneWorkspace.focusedLeafId).open
    && workbenchSideLayout.layout.right.length > 0;
  // The fold toggle folds the WHOLE side-tab unit (user: 한몸) — header,
  // panel view, browser, and diff surfaces together; children survive folds.
  const togglePaneRightRegion = useStableEvent((leafId: string) => {
    const rawEntry = paneSideDocks.entryFor(leafId);
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    const sessionId = selection?.kind === "session" ? selection.id : "";
    const selectedSurface = sessionSideSurfaces.get(sessionId) ?? null;
    const selectedPanelView = sessionPanelViews.get(sessionId) ?? null;
    const displayedEntry = sessionSideDockEntryForSession(
      rawEntry,
      sessionId,
      selectedSurface,
      sessionDiffs.get(sessionId) ?? null,
      selectedPanelView,
    );
    if (displayedEntry.open) {
      if ((displayedEntry.surface === "browser"
        || displayedEntry.surface === "terminal") && sessionId) {
        setSessionSideSurface(sessionId, null);
      }
      if (displayedEntry.diff?.source === "session" && sessionId) {
        setSessionDiff(sessionId, null);
      }
      // Folding releases the session's own list with the unit, so the next
      // open lands on the classic panel view again.
      if (displayedEntry.view === "session-diff"
        && displayedEntry.surface === "" && sessionId) {
        setSessionPanelView(sessionId, null);
      }
      paneSideDocks.setOpen(leafId, false);
      return;
    }
    // A closed session surface remains the pane's last child. Reopening the
    // dock adopts that child for the CURRENT session rather than leaking the
    // previous session's selection or leaving the global toggle inert.
    if (sessionId && selectedSurface === null
      && (rawEntry.surface === "browser" || rawEntry.surface === "terminal")) {
      setSessionSideSurface(sessionId, rawEntry.surface);
      paneSideDocks.setOpen(leafId, true);
      return;
    }
    // Same adoption for the session-owned Session Diff list: an explicit
    // reopen lands on the remembered child for this session.
    if (sessionId && selectedPanelView === null && selectedSurface === null
      && rawEntry.surface === "" && rawEntry.view === "session-diff") {
      setSessionPanelView(sessionId, "session-diff");
      paneSideDocks.setOpen(leafId, true);
      return;
    }
    paneSideDocks.toggle(leafId);
  });
  const toggleDock = useStableEvent(() => {
    togglePaneRightRegion(paneWorkspace.focusedLeafId);
  });
  // Folding releases a session-owned surface (browser/terminal) with the
  // unit, so the next open lands on the classic panel view again.
  const closePaneRightRegion = useStableEvent((leafId: string) => {
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    const sessionId = selection?.kind === "session" ? selection.id : "";
    const entry = sessionSideDockEntryForSession(
      paneSideDocks.entryFor(leafId),
      sessionId,
      sessionSideSurfaces.get(sessionId) ?? null,
      sessionDiffs.get(sessionId) ?? null,
      sessionPanelViews.get(sessionId) ?? null,
    );
    if ((entry.surface === "browser" || entry.surface === "terminal") && sessionId) {
      setSessionSideSurface(sessionId, null);
    }
    if (entry.diff?.source === "session" && sessionId) {
      setSessionDiff(sessionId, null);
    }
    if (entry.view === "session-diff" && entry.surface === "" && sessionId) {
      setSessionPanelView(sessionId, null);
    }
    paneSideDocks.setOpen(leafId, false);
  });
  const openDockTab = useStableEvent((tab: UtilityDockTab) => {
    if (!desktopUtilityDockTabEnabled(tab)) return;
    if (workbenchSideLayout.sideOf(tab) === "left") {
      setActiveSideViews((current) =>
        current.left === tab ? current : { ...current, left: tab });
      applySidebarOpen(true);
      return;
    }
    paneSideDocks.open(paneWorkspace.focusedLeafId, tab);
  });
  const [extensionsSection, setExtensionsSection] = useState<ExtensionsSection>("plugins");
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingReady, setOnboardingReady] = useState(false);
  const [updaterState, setUpdaterState] = useState<DesktopUpdaterState>({ status: "disabled" });
  const [updaterStateReady, setUpdaterStateReady] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  useEffect(() => {
    if (updaterState.status !== "ready") setUpdateDialogOpen(false);
  }, [updaterState.status]);
  const [projects, setProjects] = useState<DesktopProjectSummary[]>(
    readCachedProjectCatalog,
  );
  const [projectCatalogReady, setProjectCatalogReady] = useState(
    // Only the relay-backed phone needs cache-first boot. Desktop keeps its
    // existing authoritative catalog gate and merely refreshes the cache.
    () => projects.length > 0 && isMobileRemoteSurface(),
  );
  const [projectCatalogValidated, setProjectCatalogValidated] = useState(false);
  const registeredProjectPath = useCallback(
    (candidate: unknown) => registeredDesktopProjectPath(projects, candidate),
    [projects],
  );
  // `snapshot.project` is the engine workspace, not a desktop project. For a
  // projectless task it may be an internal folder or the process cwd (the
  // reported `C:\Users\tempe`), so only currentProject + the authoritative
  // recent registry order may seed a New task.
  const preferredDraftProjectPath = useMemo(() => {
    const recent = Array.isArray(snapshot.recentProjects) ? snapshot.recentProjects : [];
    const candidates = [
      String(snapshot.currentProject || ""),
      ...recent.map((path) => String(path || "")),
      String(projects[0]?.path || ""),
    ].filter(Boolean);
    if (!projectCatalogValidated) return candidates[0] || "";
    for (const candidate of candidates) {
      const registered = registeredProjectPath(candidate);
      if (registered) return registered;
    }
    return "";
  }, [
    projectCatalogValidated,
    projects,
    registeredProjectPath,
    snapshot.currentProject,
    snapshot.recentProjects,
  ]);
  const effectiveDraftProjectPath = useCallback((candidate: unknown): string => {
    const requested = String(candidate || "").trim();
    return resolveProjectPathAgainstCatalog(
      requested,
      projectCatalogValidated,
      registeredProjectPath(requested),
      preferredDraftProjectPath,
    );
  }, [preferredDraftProjectPath, projectCatalogValidated, registeredProjectPath]);
  // Persisted panes restore synchronously. Session addresses are reconciled
  // incrementally after first paint and remain guarded by exact daemon reads.
  const startupFocusedPaneSelection = paneWorkspace.focusedLeaf
    ? paneActiveSelection(paneWorkspace.focusedLeaf)
    : null;
  const startupNavigationSelection = paneWorkspace.restoredFromStorage
    && startupFocusedPaneSelection
    && startupFocusedPaneSelection.kind !== "studio"
    && startupFocusedPaneSelection.kind !== "terminal"
    && startupFocusedPaneSelection.kind !== "diff"
    && startupFocusedPaneSelection.kind !== "pull-request"
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
      if (selection?.kind !== "file") return;
      const key = `${selection.project}\u0000${selection.rel}\u0000${selection.accessToken || ""}`;
      if (primed.has(key)) return;
      primed.add(key);
      void primeEditorFileLoad(
        window.mixdogDesktop,
        selection.project,
        selection.rel,
        selection.accessToken,
      )?.catch(() => {});
    };
    prime(startupFocusedPaneSelection);
    for (const leaf of paneWorkspace.leaves) prime(paneActiveSelection(leaf));
  }, [paneWorkspace.leaves, startupFocusedPaneSelection]);
  const [selection, setSelection] = useState<NavigationSelection>(
    () => startupNavigationSelection ?? { kind: "new" },
  );
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
  const focusedPaneSelection = paneWorkspace.focusedLeaf
    ? paneActiveSelection(paneWorkspace.focusedLeaf)
    : null;
  const paneLeavesRef = useRef(paneWorkspace.leaves);
  paneLeavesRef.current = paneWorkspace.leaves;
  const focusedLeafIdRef = useRef(paneWorkspace.focusedLeafId);
  focusedLeafIdRef.current = paneWorkspace.focusedLeafId;
  const activeFileKey = focusedPaneSelection?.kind === "file"
    ? navigationKey(focusedPaneSelection)
    : "";
  useEffect(() => {
    const showProblems = () => {
      if (bottomPanel.open) bottomPanel.setOpen(false);
      else bottomPanel.setTab("problems");
    };
    window.addEventListener("mixdog:show-problems", showProblems);
    return () => window.removeEventListener("mixdog:show-problems", showProblems);
  }, [bottomPanel.open, bottomPanel.setOpen, bottomPanel.setTab]);
  const editorCommandCapabilities = useSyncExternalStore(
    subscribeEditorLanguageStore,
    getEditorCommandCapabilities,
    getEditorCommandCapabilities,
  );
  const [dirtyFileKeys, setDirtyFileKeys] = useState<ReadonlySet<string>>(() => new Set());
  const editorSaveHandles = useRef(new Map<string, EditorSaveHandle>());
  const [quickAccessMode, setQuickAccessMode] = useState<WorkbenchQuickAccessMode | null>(null);
  const handleFileDirty = useCallback((key: string, dirty: boolean) => {
    if (dirty) pinPaneTabByKey(key);
    setDirtyFileKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, [pinPaneTabByKey]);
  const registerEditorSaveHandle = useCallback((key: string, save: EditorSaveHandle | null) => {
    if (save) editorSaveHandles.current.set(key, save);
    else editorSaveHandles.current.delete(key);
  }, []);
  const [headerTitleEditingSessionId, setHeaderTitleEditingSessionId] = useState("");
  const [headerTitleDraft, setHeaderTitleDraft] = useState("");
  const [headerTitleInvalid, setHeaderTitleInvalid] = useState(false);
  const {
    clearNewTaskPreferences,
    draftPanePrefs,
    inheritedDraftPrefs,
    lastNewTaskPrefs,
    newTaskDeferred,
    newTaskModelSelection,
    newTaskProjectPath,
    newTaskWorkflow,
    persistDraftPanePrefs,
    rememberSessionRouteForNextTask,
    resetNewTaskDraft,
    resolvedDraftPrefsFor,
    setDraftPrefsVersion,
    setNewTaskDeferred,
    stageNewTaskModelSelection,
    stageNewTaskProject,
    stageNewTaskWorkflow,
  } = useDraftPanePreferences({
    selection,
    selectionRef,
    snapshot,
    projectCatalogValidated,
    preferredDraftProjectPath,
    effectiveDraftProjectPath,
  });
  const [requestedSessionId, setRequestedSessionId] = useState("");
  const [markdownBodyReadyForTranscript, setMarkdownBodyReadyForTranscript] = useState(isMarkdownBodyReady);
  // Closing a conversation removes its tab model immediately. The existing
  // Conversation owner remains visible but inert until the fallback session
  // is ready, so slow/failed host resumes never make Ctrl+Q feel ignored.
  const pendingConversationHandoff = useRef<ConversationHandoff | null>(null);
  const [conversationHandoff, setConversationHandoff] =
    useState<ConversationHandoff | null>(null);
  const openSessionRef = useRef<(sessionId: string, force?: boolean) => Promise<void>>(async () => {});
  // Monotonic navigation stamp: an async switch completion may only activate
  // its target while no NEWER navigation happened in flight (user: + during a
  // settling session switch resurrected the old transcript in the new draft).
  const navigationEpoch = useRef(0);
  const [sessionCatalogReady, setSessionCatalogReady] = useState(false);
  const [startupSettled, setStartupSettled] = useState(
    () => Boolean((window as typeof window & { __mixdogStartupSettled?: boolean })
      .__mixdogStartupSettled),
  );
  // A push notification tapped on the phone opens the session it came from —
  // the app may not even have been running when it arrived.
  usePushNotificationNavigation({
    ready: sessionCatalogReady,
    openSession: (sessionId) => { void openSessionRef.current(sessionId); },
  });
  // A screenshot shared into the app from the phone's share sheet: the service
  // worker parked it during the launch this claims it from.
  useSharedIntakeBoot();
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  useEffect(() => {
    const focusComposerForTyping = (event: globalThis.KeyboardEvent) => {
      const typingSurfaceSelector = focusedPaneSelection?.kind === "studio"
        ? ".studio-root[data-surface-active='true'] textarea"
        : focusedPaneSelection?.kind === "session" || focusedPaneSelection?.kind === "new"
          ? "form.composer textarea"
          : "";
      if (!typingSurfaceSelector) return;
      if (!shouldFocusComposerFromWindowKey(event)) return;
      const pane = document.querySelector<HTMLElement>(
        `[data-pane-id="${paneWorkspace.focusedLeafId}"]`,
      );
      const typingSurface = pane?.querySelector<HTMLTextAreaElement>(typingSurfaceSelector);
      if (!typingSurface || typingSurface.closest("[inert]")) return;
      // Focus during keydown capture, before Chromium commits the printable
      // character or starts IME composition. This gives the desktop shell the
      // same type-anywhere grammar across Task and Studio while real editors,
      // terminals, menus, dialogs, and form fields keep their own keyboard.
      typingSurface.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", focusComposerForTyping, true);
    return () => window.removeEventListener("keydown", focusComposerForTyping, true);
  }, [focusedPaneSelection?.kind, paneWorkspace.focusedLeafId]);
  // Warm route CODE as soon as startup settles, before the stricter desktop
  // boot gate waits on every catalog. Hidden mounting and reference DATA still
  // stay behind desktopBootReady below, so this removes click-time downloads
  // without competing RPC hydration with the opening conversation.
  // Every warm-up rides ONE idle lane (boot-warmup.ts) that opens once the
  // window has shown its first frames — see armBootWarmup below.
  useEffect(() => {
    if (!startupSettled) return undefined;
    const nativeWindow = Boolean(window.mixdogDesktop?.bootContext?.bootId);
    const cancels = [scheduleBootWarmup({
      id: "module:studio",
      priority: BOOT_WARMUP.studioModule,
      run: () => loadStudioViewModule().catch(() => {}),
    })];
    if (!nativeWindow) {
      cancels.push(scheduleBootWarmup({
        id: "module:command-surface",
        priority: BOOT_WARMUP.commandSurfaceModule,
        run: () => loadCommandSurfaceModule().catch(() => {}),
      }));
      if (connectionQuality() === "normal") {
        cancels.push(scheduleBootWarmup({
          id: "module:utility-dock",
          priority: BOOT_WARMUP.utilityDockModule,
          run: () => preloadUtilityDock().catch(() => {}),
        }));
        for (const panel of DEFAULT_SIDEBAR_VIEW_ORDER) {
          if (!desktopSidebarDestinationEnabled(panel)) continue;
          cancels.push(scheduleBootWarmup({
            id: `module:sidebar:${panel}`,
            priority: BOOT_WARMUP.sidebarPanel,
            run: () => {
              const module = loadSidebarPanelModule[panel]();
              trackSidebarPanelModule(panel, module);
              return module.catch(() => {});
            },
          }));
        }
      }
    }
    return () => { for (const cancel of cancels) cancel(); };
  }, [startupSettled, trackSidebarPanelModule]);
  // Callback-safe view of the active selection for tab-promotion decisions.
  const startupMeasured = useRef(false);
  useEffect(() => {
    if (!import.meta.env?.DEV || startupMeasured.current) return;
    startupMeasured.current = true;
    performance.mark("mixdog:startup:first-commit");
    performance.measure(
      "mixdog:startup:entry-to-first-commit",
      "mixdog:startup:renderer-entry",
      "mixdog:startup:first-commit",
    );
    const duration = performance.getEntriesByName("mixdog:startup:entry-to-first-commit").at(-1)?.duration;
    console.info(`[perf] desktop startup first commit: ${duration?.toFixed(1) ?? "?"}ms`);
  }, []);
  const warmSettingsView = useCallback(() => {
    if (!desktopFeatureEnabled("settings")) return;
    void loadSettingsViewModule().catch(() => {});
  }, []);
  useEffect(() => {
    preloadAgentPool(window.mixdogDesktop);
  }, []);
  // The settings sweep (two dozen capability reads plus the full model
  // catalog) used to start the moment App mounted — inside the boot cover,
  // ahead of the opening conversation. It is the LAST warm-up now: Settings
  // opens fine without it (the dialog sweeps on open), so it only has to
  // beat the user to the gear icon, not to the composer.
  useEffect(() => {
    if (!desktopFeatureEnabled("settings")) return undefined;
    return scheduleBootWarmup({
      id: "settings:preload",
      priority: BOOT_WARMUP.settingsPreload,
      run: () => loadSettingsViewModule().then((module) => {
        const host = window.mixdogDesktop;
        return host ? module.preloadSettings(host).catch(() => {}) : undefined;
      }).catch(() => {}),
    });
  }, [warmSettingsView]);
  useEffect(() => {
    const host = window.mixdogDesktop;
    let live = true;
    const getUpdaterState = host?.getUpdaterState;
    if (typeof getUpdaterState !== "function") {
      setUpdaterStateReady(true);
    } else {
      void getUpdaterState().then((next) => {
        if (live) setUpdaterState(next);
      }).catch(() => {}).finally(() => {
        if (live) setUpdaterStateReady(true);
      });
    }
    const unsubscribe = host?.subscribeUpdaterState?.((next) => {
      if (live) setUpdaterState(next);
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    let live = true;
    const systemTheme = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
    // The desktop theme is a LOCAL preference (user decision): it never
    // reads or writes the engine/TUI theme, so both apps theme independently.
    const applyStoredPreference = () => {
      const preference = getDesktopThemePreference();
      if (!preference) return false;
      applyDesktopThemePreference(preference);
      return true;
    };
    const handleSystemThemeChange = () => {
      if (live && getDesktopThemePreference() === 'system') applyStoredPreference();
    };
    systemTheme?.addEventListener('change', handleSystemThemeChange);
    // A fresh install lands on the true-dark surface, not the grey ramp.
    if (!applyStoredPreference()) applyDesktopThemePreference('dark');
    return () => {
      live = false;
      systemTheme?.removeEventListener('change', handleSystemThemeChange);
    };
  }, []);
  useEffect(() => {
    const openOnboarding = () => {
      setSettingsOpen(false);
      setOnboardingOpen(true);
    };
    window.addEventListener('mixdog:open-onboarding', openOnboarding);
    return () => window.removeEventListener('mixdog:open-onboarding', openOnboarding);
  }, []);
  useEffect(() => {
    let live = true;
    const invoke = window.mixdogDesktop?.invokeCapability;
    if (!invoke) {
      setOnboardingReady(true);
      return () => { live = false; };
    }
    void invoke<RecordValue>({ capability: 'getOnboardingStatus' })
      .then(async (result) => {
        if (asRecord(result.value)?.completed !== false) return;
        // Both chunks preload before the wizard mounts: a lazy import at open
        // time flashed the dark Suspense overlay (user: 검정 빈 화면).
        await Promise.all([loadSettingsViewModule(), loadOnboardingWizardModule()])
          .catch(() => undefined);
        if (live) setOnboardingOpen(true);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setOnboardingReady(true);
      });
    return () => { live = false; };
  }, []);
  const errors = useMemo(() => [
    error || (!connected ? "Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop." : ""),
  ].filter(Boolean), [connected, error]);

  const registerWorkspaceSelection = useCallback((
    nextSelection: NavigationSelection,
    title: string,
    replaceKey = "",
  ) => {
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
        if (current[existing].title === title
          && navigationKey(current[existing].selection) === key) return current;
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
  }, []);

  const activateSelection = useCallback((
    nextSelection: NavigationSelection,
    title: string,
    replaceKey = "",
  ) => {
    try {
      window.mixdogDesktop?.perfLog?.(
        `selection-commit kind=${nextSelection.kind}`
        + ` target=${nextSelection.kind === "session" ? nextSelection.id : "(none)"}`,
      );
    } catch { /* diagnostics only */ }
    try {
      if (nextSelection.kind === "session") {
        window.localStorage.setItem(LAST_SESSION_KEY, nextSelection.id);
      } else {
        window.localStorage.removeItem(LAST_SESSION_KEY);
      }
    } catch { /* startup restoration remains best-effort */ }
    selectionRef.current = nextSelection;
    viewedSessionRef.current = nextSelection.kind === "session" ? nextSelection.id : "";
    unreadViewedSessionRef.current = viewedSessionRef.current;
    setSelection(nextSelection);
    // The focused pane mirrors the interactive surface, so every navigation
    // keeps the pane tree and the classic selection state in lockstep. The
    // focused GROUP opens/activates the tab; replaceKey promotes in place.
    openSelectionInFocusedPane(nextSelection, replaceKey);
    registerWorkspaceSelection(nextSelection, title, replaceKey);
  }, [openSelectionInFocusedPane, registerWorkspaceSelection]);
  // Ctrl/Cmd+\ opens a pane beside the focused one; Shift opens it below.
  useEffect(() => {
    // globalThis: React's KeyboardEvent type shadows the DOM one in App.
    const onPaneSplitKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== "\\") return;
      event.preventDefault();
      // A split ALWAYS opens an independent new task (terminal-style panes,
      // user requirement). Cloning the current view put the SAME session (or
      // the same draftId) into several panes — one engine, one settings set —
      // so a model change legitimately repainted them all and read as
      // "panes are not individual". Navigation and drop paths reveal or move
      // an owned session tab instead of duplicating it across panes.
      const fresh = newDraftSelection();
      const direction = event.shiftKey ? "column" : "row";
      const paneElement = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"))
        .find((element) => element.dataset.paneId === paneWorkspace.focusedLeafId);
      const rect = paneElement?.getBoundingClientRect();
      if (rect && !canSplitPaneSize(direction, rect.width, rect.height)) return;
      splitFocusedPane(direction, fresh, rect
        ? { width: rect.width, height: rect.height }
        : undefined);
      activateSelection(fresh, "New task");
    };
    window.addEventListener("keydown", onPaneSplitKey);
    return () => window.removeEventListener("keydown", onPaneSplitKey);
  }, [activateSelection, paneWorkspace.focusedLeafId, splitFocusedPane]);
  useEffect(() => {
    if (sidebarOpen) return;
    const sidebar = document.getElementById("session-sidebar");
    if (sidebar?.contains(document.activeElement)) {
      document.querySelector<HTMLButtonElement>(".sessions-link")?.focus();
    }
  }, [sidebarOpen]);

  const invoke = useCallback(async (action: () => unknown): Promise<void> => {
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [setError]);
  const invokeResult = useCallback(async <T,>(action: () => T | Promise<T>): Promise<T | undefined> => {
    setError("");
    try {
      return await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return undefined;
    }
  }, [setError]);
  const openDesktopUpdate = useCallback(() => {
    if (updaterState.status === "ready") setUpdateDialogOpen(true);
  }, [updaterState.status]);
  const closeDesktopUpdate = useCallback(() => setUpdateDialogOpen(false), []);
  const installDesktopUpdate = useCallback(() => {
    setUpdateDialogOpen(false);
    void invoke(async () => {
      const next = await window.mixdogDesktop.showDesktopUpdate();
      setUpdaterState(next);
    });
  }, [invoke]);
  // The session currently on screen (selection or in-flight switch target):
  // reconcile must never dot it, and selectionRef lags behind a switch.
  const viewedSessionRef = useRef("");
  // Unread consumption additionally treats an IN-FLIGHT switch target
  // (requestedSessionId) as viewed: a slow resume or a fork-on-resume commits
  // a different id, which left the clicked row's dot unconsumed (user report).
  const unreadViewedSessionRef = useRef("");
  // Bumps when the window regains focus/visibility so viewed-session unread
  // consumption re-evaluates (dots earned while unfocused clear on return).
  const [windowFocusTick, setWindowFocusTick] = useState(0);
  useEffect(() => {
    const onEngage = () => setWindowFocusTick((tick) => (tick + 1) % 1_000_000);
    window.addEventListener("focus", onEngage);
    // A resumed phone does not reliably pair its return with visibilitychange,
    // so pageshow is the independent foreground signal that lets a session the
    // user came back to consume its dot.
    window.addEventListener("pageshow", onEngage);
    document.addEventListener("visibilitychange", onEngage);
    return () => {
      window.removeEventListener("focus", onEngage);
      window.removeEventListener("pageshow", onEngage);
      document.removeEventListener("visibilitychange", onEngage);
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
      if (session.sourceType === "schedule") schedule.add(session.sourceName);
      if (session.sourceType === "webhook") webhook.add(session.sourceName);
    }
    return { schedule, webhook };
  }, [sessions]);
  useEffect(() => {
    const catalogTitles = new Map(sessions
      .map((session) => [session.id, sessionSummaryTitle(session)] as const));
    if (!catalogTitles.size) return;
    setTabs((current) => {
      let changed = false;
      const next = current.map((tab) => {
        // A selection-pinned title (agent tabs) is caller-owned: the catalog
        // sync must not replace it with the session's auto-generated title.
        if (tab.selection.kind !== "session" || tab.selection.title) return tab;
        const title = catalogTitles.get(tab.selection.id);
        if (!title || title === tab.title) return tab;
        changed = true;
        return { ...tab, title };
      });
      return changed ? next : current;
    });
  }, [sessions]);
  const refreshProjects = useCallback(async (
    options: { acceptEmpty?: boolean } = {},
  ) => {
    const host = window.mixdogDesktop;
    const listProjects = (host as {
      listProjects?: () => Promise<DesktopProjectSummary[]>;
    } | undefined)?.listProjects;
    if (!listProjects) return [];
    const next = await listProjects();
    const accepted = acceptedProjectCatalog(
      Array.isArray(next) ? next : [],
      options.acceptEmpty !== false,
    );
    if (accepted) {
      setProjects(accepted);
      setProjectCatalogValidated(true);
      writeCachedProjectCatalog(accepted);
    }
    return next;
  }, []);
  useEffect(() => {
    let live = true;
    // React commits child pane effects before this parent effect, so visible
    // file/session/Studio reads enter the worker queue first. The lightweight
    // catalog may then reconcile without adding another frame of sidebar lag.
    // Catalog hydration is a background read, not a user action. A host that
    // is still settling may reject this first pass; revealing a global red
    // error for that transient miss makes whichever side view opens first look
    // broken. Recovery events and later explicit refreshes remain authoritative.
    void refreshSessions().catch(() => undefined).finally(() => {
      if (live) setSessionCatalogReady(true);
    });
    void refreshProjects({
      // An empty phone result before the relay leg connects is not an
      // authoritative project registry. Keep the cached catalog until a
      // recovered connection can answer.
      acceptEmpty: !isMobileRemoteSurface(),
    }).catch(() => []).finally(() => {
      if (live) setProjectCatalogReady(true);
    });
    return () => { live = false; };
  }, [refreshProjects, refreshSessions]);
  // A phone's first catalog read can land before the relay leg is up. The boot
  // pass then settles to an EMPTY list and nothing ever asks again, so the
  // composer's project pill stays blank (user: 모바일에서 오래 비어 있다).
  // A gap may still be mid-recovery, so its empty response remains
  // unverified. Reconnected is the authority boundary and may legitimately
  // replace the cache with an empty registry.
  useEffect(() => {
    const retry = () => {
      void refreshProjects({ acceptEmpty: false }).catch(() => undefined);
    };
    const revalidate = () => {
      void refreshProjects({ acceptEmpty: true }).catch(() => undefined);
    };
    window.addEventListener("mixdog:remote-state-gap", retry);
    window.addEventListener("mixdog:remote-reconnected", revalidate);
    return () => {
      window.removeEventListener("mixdog:remote-state-gap", retry);
      window.removeEventListener("mixdog:remote-reconnected", revalidate);
    };
  }, [refreshProjects]);
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
    const actual = await window.mixdogDesktop?.getSnapshot().catch(() => null) ?? null;
    applySnapshot(actual);
    const state = actual && typeof actual === "object" ? actual as Snapshot : null;
    const actualProject = String(state?.currentProject || state?.project || "");
    const actualSessionId = String(state?.sessionId || "");
    const knownActualSession = actualSessionId &&
      sessions.some((session) => session.id === actualSessionId);
    if (knownActualSession) {
      const actualSession = sessions.find((session) => session.id === actualSessionId);
      activateSelection(
        { kind: "session", id: actualSessionId },
        sessionSummaryTitle(actualSession),
      );
    } else if (actualProject) {
      const project = projects.find((item) => item.path === actualProject);
      activateSelection(
        { kind: "project", path: actualProject },
        project?.alias?.trim() || project?.name?.trim() || displayProject(actualProject).name || "Project",
      );
    } else if (actualSessionId) {
      activateSelection({ kind: "new" }, "New task");
      clearNewTaskPreferences();
      // This is an existing host session that the current catalog cannot
      // identify, not a draft-owned prepared route. Marking the visual draft
      // ready made its first prompt call host.submit() and append to that
      // foreign session. Keep it cold so submitNewTask() must mint/address a
      // fresh session before accepting the message.
    } else {
      activateSelection({ kind: "new" }, "New task");
    }
  };

  // Navigating INTO the workspace keeps the sheet slide: the destination sits
  // under the drawer, so the exit is part of the gesture. A destination that
  // COVERS the screen (Settings) must close instantly instead — otherwise the
  // drawer is still sliding while the new screen paints over it, showing both
  // at once, and its mount work stutters the very slide it overlaps
  // (user: 설정창 들어갈 때 접히는 거랑 설정창이랑 둘 다 같이 보인다).
  const closeSidebarForNavigation = (motion: "animated" | "instant" = "animated") => {
    if (window.innerWidth <= 760) {
      applySidebarOpen(false, motion);
      paneSideDocks.setOpen(focusedLeafIdRef.current, false);
    }
  };
  // Project navigation and registry edits: app-project-actions.ts.
  const {
    startProject,
    renameProject,
    removeProject,
  } = createProjectActions({
    projects,
    invoke,
    applySnapshot,
    activateSelection,
    synchronizeActualHost,
    closeSidebarForNavigation,
    refreshProjects,
    refreshSessionsBestEffort,
    beginNavigation: () => { navigationEpoch.current += 1; },
  });
  const {
    renameSession,
    archiveSession,
    deleteSession,
  } = useAppSessionActions({
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
    setRequestedSessionId("");
    finishPendingConversationHandoff();
    const alreadyActive = selectionRef.current.kind === "new";
    // Clicking an existing draft tab revisits THAT draft; a plain Ctrl+N /
    // New task always opens another independent draft tab (Chrome parity)
    // instead of reusing a singleton.
    const revisit = draft?.kind === "new";
    const nextSelection = revisit && draft ? draft : newDraftSelection();
    activateSelection(nextSelection, "New task");
    if (requestComposerFocus) setComposerFocusRequest((value) => value + 1);
    // Revisiting a draft tab, or opening an additional draft while one is
    // already active, keeps the shared staged project/model/workflow instead
    // of resetting it mid-flight. The first submit can still lazily start the
    // engine when the boot draft has never been prepared.
    if (revisit || alreadyActive) return;
    // A parked draft tab survives session switches (user decision): pressing
    // New task again opens a fresh tab that inherits its staged
    // project/model/workflow instead of resetting the draft.
    if (newTaskDeferred && tabs.some((tab) => tab.selection.kind === "new")) return;
    const cachedProjectPath = lastNewTaskPrefs.current?.projectPath ?? null;
    // An explicit choice is restored as-is ("" stays No project); with none,
    // the fresh draft inherits so a catalog that lands later still reaches it.
    // A stored path the catalog cannot place also inherits — freezing its
    // failed lookup as "" made the pill blank for good.
    resetNewTaskDraft(cachedProjectPath === null
      ? effectiveDraftProjectPath(preferredDraftProjectPath) || null
      : resolvedStoredProjectPath(cachedProjectPath, effectiveDraftProjectPath));
  };
  const openSession = async (
    sessionId: string,
    _force = false,
    fallbackTitle = "",
  ): Promise<void> => {
    const navigationToken = ++navigationEpoch.current;
    closeSidebarForNavigation();
    setRequestedSessionId(sessionId);
    // Select immediately; a cold lane fills behind the already-committed tab
    // instead of making the relay RTT part of navigation latency.
    const laneReady = defaultSessionLaneStore.get(sessionId)
      ? Promise.resolve(true)
      : requestSessionRead(sessionId);
    if (navigationEpoch.current !== navigationToken) return;
    const session = sessions.find((item) => item.id === sessionId);
    finishPendingConversationHandoff();
    // An explicit caller title (agent pool rows: "Reviewer · tag") is PINNED
    // into the selection so pane moves and catalog refreshes cannot swap the
    // label for the child session's auto-generated title (user: 이동했다 오면
    // 네이밍이 이상해진다).
    // Re-entering an ALREADY OPEN tab (strip click, Ctrl+Tab, close fallback,
    // resume-on-restart) calls in without a title. The pin the opener stored on
    // that tab's selection is recovered here, so a worker label survives every
    // return trip instead of degrading to the catalog placeholder.
    const openedTab = tabs.find((tab) => tab.selection.kind === "session"
      && tab.selection.id === sessionId);
    const openedPinnedTitle = openedTab && openedTab.selection.kind === "session"
      ? String(openedTab.selection.title || "").trim()
      : "";
    const pinnedTitle = fallbackTitle.trim() || openedPinnedTitle;
    void laneReady.finally(() => {
      if (navigationEpoch.current === navigationToken) setRequestedSessionId("");
    });
    activateSelection(
      {
        kind: "session",
        id: sessionId,
        ...(pinnedTitle ? { title: pinnedTitle } : {}),
      },
      pinnedTitle || (session ? sessionSummaryTitle(session) : "Untitled session"),
    );
  };
  openSessionRef.current = openSession;
  const prefetchSession = useCallback((sessionId: string) => (
    requestSessionRead(sessionId)
  ), []);
  const openSettings = useCallback((section: SlashSettingsSection | null = null) => {
    const extensionSection = extensionSectionForSettings(section);
    if (extensionSection) {
      if (!desktopFeatureEnabled("extensions")) return;
      const side = workbenchSideLayout.sideOf("extensions");
      setExtensionsSection(extensionSection);
      setSettingsOpen(false);
      setCommandSurface(null);
      mountSidebarPanel("extensions");
      trackSidebarPanelModule("extensions", loadSidebarPanelModule.extensions());
      if (side === "right") {
        paneSideDocks.open(focusedLeafIdRef.current, "extensions");
        return;
      }
      setActiveSideViews((current) =>
        current.left === "extensions" ? current : { ...current, left: "extensions" });
      applySidebarOpen(true);
      return;
    }
    // Workflow and web-search-model settings graduated to the main-pane
    // Workflows page: /workflow and /websearch land there.
    if (section === "workflow" || section === "websearch") {
      setCommandSurface(null);
      openWorkflows();
      return;
    }
    if (!desktopFeatureEnabled("settings")) return;
    // Perf diagnostics: SettingsView's mount effect reports the request→paint
    // delta through the perf-log channel (no-op unless MIXDOG_DESKTOP_PERF=1).
    (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt = performance.now();
    warmSettingsView();
    setCommandSurface(null);
    setSettingsSection(section === "memory" ? "memory-enabled" : section);
    setSettingsOpen(true);
  }, [
    applySidebarOpen,
    mountSidebarPanel,
    openWorkflows,
    paneSideDocks.open,
    trackSidebarPanelModule,
    warmSettingsView,
    workbenchSideLayout.sideOf,
  ]);
  // Setup tool `open`: the engine publishes { command, seq } on the session
  // snapshot when the model asks for a settings surface. Route it exactly as
  // the typed slash command would (settings row, rail page, or command
  // surface); the seq guard makes a repeated identical request fire again.
  const uiOpenSeen = useRef(0);
  useEffect(() => {
    const request = snapshot.uiOpenRequest;
    const seq = Number(request?.seq) || 0;
    if (!request?.command || seq <= uiOpenSeen.current) return;
    uiOpenSeen.current = seq;
    // A re-attached renderer replays the retained snapshot; a request older
    // than a few seconds is history, not an instruction.
    if (Number(request.at) > 0 && Date.now() - Number(request.at) > UI_OPEN_REQUEST_TTL_MS) return;
    const command = resolveDesktopSlashCommand(request.command);
    if (!command) return;
    if (command.surface) {
      openConversationCommandSurface(command.surface, String(snapshot.sessionId || ""));
      return;
    }
    if (command.settingsRow) openSettings(command.settingsRow);
    else if (command.action === "settings") openSettings(null);
  }, [openConversationCommandSurface, openSettings, snapshot.sessionId, snapshot.uiOpenRequest]);
  /** /clear · /new typed in a session pane: close that session's tab and open
   *  a New Task draft in its exact strip position, seeded from the cleared
   *  session's own project/model/workflow and its remote seat (user rule:
   *  전 세션의 마지막 세팅 승계). The session itself keeps its transcript and
   *  stays available in the sidebar history. */
  const clearSessionToNewTask = (sessionId: string) => {
    const sessionKey = navigationKey({ kind: "session", id: sessionId });
    const leaves = paneLeavesRef.current;
    const ownerLeaf = leaves.find((leaf) => leaf.id === focusedLeafIdRef.current
        && leaf.tabs.some((tab) => navigationKey(tab) === sessionKey))
      ?? leaves.find((leaf) => leaf.tabs.some((tab) => navigationKey(tab) === sessionKey));
    // The session's OWN lane seeds the draft; focus has no data authority.
    const source = defaultSessionLaneStore.get(sessionId);
    const inherited = inheritedDraftPrefs();
    const seeded: DraftPanePrefs = {
      projectPath: effectiveDraftProjectPath(
        String(source?.currentProject || source?.project || "") || inherited.projectPath),
      modelSelection: (source ? draftModelSelectionFromSnapshot(source) : null)
        ?? inherited.modelSelection,
      workflow: (asRecord(source?.workflow)
        ? source?.workflow as unknown as DesktopWorkflowState
        : null) ?? inherited.workflow,
    };
    const draftSelection = newDraftSelection();
    // Per-draft prefs are keyed by draftId, not navigationKey: the old
    // "new:<id>" key orphaned this entry, so the replacement draft resolved
    // stale inherited prefs instead of the cleared session's settings.
    const draftPrefsKey = draftSelection.kind === "new"
      ? draftSelection.draftId || "default"
      : "default";
    draftPanePrefs.current.set(draftPrefsKey, seeded);
    // The cleared session's settings become the seed for FUTURE new tasks as
    // well (same rule as explicit staging).
    lastNewTaskPrefs.current = seeded;
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
    navigationEpoch.current += 1;
    setRequestedSessionId("");
    finishPendingConversationHandoff();
    if (ownerLeaf && ownerLeaf.id !== focusedLeafIdRef.current) {
      // Addressed replacement in a background pane: swap the tab in place
      // without stealing focus, and leave the one-shot remote toggle (owned
      // by the FOCUSED draft) untouched.
      promoteSelectionInLeaf(ownerLeaf.id, draftSelection, sessionKey);
      registerWorkspaceSelection(draftSelection, "New task", sessionKey);
      return;
    }
    activateSelection(draftSelection, "New task", ownerLeaf ? sessionKey : "");
    setComposerFocusRequest((value) => value + 1);
  };
  // App owns broad workspace state and legitimately re-renders for chrome,
  // panel and catalog changes. Conversation is the expensive persistent tree:
  // stable event facades let React.memo retain it while each callback still
  // dispatches through the latest render state.
  const conversationNewTask = useStableEvent(() => startTask());
  const conversationClearToNewTask = useStableEvent(clearSessionToNewTask);
  const conversationClearProject = useStableEvent(() => stageNewTaskProject(""));
  const conversationResumeSession = useStableEvent((sessionId: string) => {
    void openSession(sessionId);
  });
  const conversationOpenProjects = useStableEvent(() => {
    if (!desktopFeatureEnabled("projects")) return;
    openProjects();
    void refreshProjects().catch(() => undefined);
  });
  const conversationSelectProject = useStableEvent((path: string) => {
    // The composer selector edits the focused draft in place. Project-panel
    // navigation still uses selectNewTaskProject() to open a fresh draft.
    stageNewTaskProject(path);
  });
  // Launch-jolt diagnostics (MIXDOG_DESKTOP_PERF=1): the top tab reportedly
  // pops once right after start. Sample the first tab's rect over the boot
  // window so the exact moment/delta shows up in the perf log.
  useEffect(() => {
    if (!window.mixdogDesktop?.perfLog) return undefined;
    const startedAt = performance.now();
    let last = '';
    const timers = [100, 400, 1000, 2000, 3500].map((delay) => window.setTimeout(() => {
      const tab = document.querySelector('.workspace-tab');
      const box = tab?.getBoundingClientRect();
      const line = box
        ? `tabs=${document.querySelectorAll('.workspace-tab').length} left=${box.left.toFixed(1)} top=${box.top.toFixed(1)} w=${box.width.toFixed(1)} h=${box.height.toFixed(1)}`
        : 'tabs=0';
      if (line !== last) {
        last = line;
        window.mixdogDesktop?.perfLog?.(`launch-tab t=${(performance.now() - startedAt).toFixed(0)}ms ${line}`);
      }
    }, delay));
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, []);
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
    () => requestedSessionId
      ? { kind: "session", id: requestedSessionId }
      : navigationSelection,
    [requestedSessionId, navigationSelection],
  );
  // Viewing a session consumes its unread dot.
  const viewedSessionId = navigationSelection.kind === "session" ? navigationSelection.id : "";
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
  const selectedSession = navigationSelection.kind === "session"
    ? sessions.find((session) => session.id === navigationSelection.id)
    : undefined;
  const currentSessionTitle = selectedSession ? sessionSummaryTitle(selectedSession) : "";
  const workingSessionIds = useMemo(() => new Set(
    sessions
      .filter((session) => session.leadWorking === true || session.agentWorking === true)
      .map((session) => session.id),
  ), [sessions]);
  const observedAgentSessionIds = useMemo(
    () => desktopUtilityDockTabEnabled("agents") ? agentActivitySessionIds(sessions) : [],
    [sessions],
  );
  const visibleSessionTitle = currentSessionTitle ||
    tabs.find((tab) => tab.key === navigationKey(navigationSelection))?.title || "New task";
  const openHeaderTitleEditor = () => {
    if (!selectedSession) return;
    setHeaderTitleDraft(visibleSessionTitle);
    setHeaderTitleInvalid(false);
    setHeaderTitleEditingSessionId(selectedSession.id);
  };
  const closeHeaderTitleEditor = () => {
    setHeaderTitleEditingSessionId("");
    setHeaderTitleDraft("");
    setHeaderTitleInvalid(false);
  };
  const commitHeaderTitleEditor = (fromBlur = false) => {
    if (!selectedSession) return closeHeaderTitleEditor();
    const title = headerTitleDraft.trim();
    if (!title) {
      setHeaderTitleInvalid(true);
      if (fromBlur) closeHeaderTitleEditor();
      return;
    }
    closeHeaderTitleEditor();
    if (title !== visibleSessionTitle) void renameSession(selectedSession.id, title);
  };
  const activeProjectPath = navigationSelection.kind === "session"
    ? registeredProjectPath(selectedSession?.projectPath || "")
    : navigationSelection.kind === "project" ? navigationSelection.path
      : effectiveDraftProjectPath(newTaskProjectPath);
  const focusedPaneProjectPath = focusedPaneSelection?.kind === "file"
    || focusedPaneSelection?.kind === "diff"
    || focusedPaneSelection?.kind === "pull-request"
    ? focusedPaneSelection.project
    : focusedPaneSelection?.kind === "terminal" && focusedPaneSelection.cwd
      ? focusedPaneSelection.cwd
      : "";
  const activeToolProjectPath = focusedPaneProjectPath || activeProjectPath;
  const [lastToolProjectPath, setLastToolProjectPath] = useState(() => {
    try { return window.localStorage.getItem(LAST_PROJECT_KEY) || ""; }
    catch { return ""; }
  });
  // Explorer, Source Control and Pull Requests share ONE sticky project
  // context. Projectless panes never clear it; focusing a pane with an
  // explicit project resumes automatic following and releases a manual pick.
  const [toolProjectOverride, setToolProjectOverride] = useState("");
  useLayoutEffect(() => {
    if (!activeToolProjectPath) return;
    setToolProjectOverride("");
    setLastToolProjectPath((current) =>
      current === activeToolProjectPath ? current : activeToolProjectPath);
    try { window.localStorage.setItem(LAST_PROJECT_KEY, activeToolProjectPath); }
    catch { /* persistence is a convenience only */ }
  }, [activeToolProjectPath]);
  const toolProjectPath = toolProjectOverride || activeToolProjectPath || lastToolProjectPath;
  const selectToolProject = useCallback((path: string) => {
    if (!path) return;
    setToolProjectOverride(path);
    setLastToolProjectPath(path);
    try { window.localStorage.setItem(LAST_PROJECT_KEY, path); }
    catch { /* persistence is a convenience only */ }
  }, []);
  const workbenchWorkspace = useWorkbenchWorkspace(toolProjectPath);
  const activeProjectSummary = projects.find((project) =>
    project.path.replace(/[\\/]+/g, "/").toLocaleLowerCase() ===
    activeProjectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase());
  // Only an explicitly registered project gets project chrome. Historical or
  // temporary cwd values remain normal Tasks even when a legacy row carries a
  // project-like path.
  const activeProjectLabel = activeProjectSummary
    ? activeProjectSummary.alias?.trim() || activeProjectSummary.name?.trim() ||
      displayProject(activeProjectSummary.path).name || "Project"
    : "";
  const selectedProjectPath = activeProjectPath || preferredDraftProjectPath;
  const activeTabKey = navigationKey(navigationSelection);
  const paneTranscriptRendererPending = paneWorkspace.leaves.some((leaf) =>
    paneActiveSelection(leaf)?.kind === "session")
    && !markdownBodyReadyForTranscript;
  const transcriptRendererPending = navigationSelection.kind === "session"
    && !markdownBodyReadyForTranscript;
  useEffect(() => {
    if (markdownBodyReadyForTranscript) return undefined;
    let active = true;
    void preloadMarkdownBody()
      .catch(() => undefined)
      .finally(() => {
        if (active) setMarkdownBodyReadyForTranscript(true);
      });
    return () => { active = false; };
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
    utilitySelection: Extract<WorkspaceSelection, { kind: "studio" | "terminal" | "browser" }>,
    title: string,
    leafId = paneWorkspace.focusedLeafId,
  ) => {
    paneWorkspace.focusLeaf(leafId);
    const key = navigationKey(utilitySelection);
    setTabs((current) => current.some((tab) => tab.key === key)
      ? current
      : [...current, { key, title, selection: utilitySelection }]);
    openSelectionInFocusedPane(utilitySelection);
  };
  const openStudioTab = (leafId = paneWorkspace.focusedLeafId) => {
    closeSidebarPanels();
    const metricToken = beginStudioLoad();
    void loadStudioViewModule()
      .then(() => reportStudioLoadStage("module", "", false, metricToken))
      .catch(() => {});
    openUtilityTab(newStudioSelection(), "Studio", leafId);
  };
  const openTerminalTab = (leafId = paneWorkspace.focusedLeafId) => {
    void prefetchTerminalPane().catch(() => {});
    const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
    const selection = leaf ? paneActiveSelection(leaf) : null;
    if (selection?.kind !== "session") return;
    setSessionSideSurface(selection.id, "terminal");
    paneSideDocks.select(leafId, "terminal");
  };
  // Agent browser bridge: retain each session's persistent surface, and reveal
  // it beside the owner only when the host marks the request as foreground.
  const browserPaneOwners = paneWorkspace.leaves.map((leaf) => {
    const selection = paneActiveSelection(leaf);
    return {
      leafId: leaf.id,
      sessionId: selection?.kind === "session" ? selection.id : null,
    };
  });
  const openBrowserSurfaceForAgent = (sessionId: string, reveal = true) => {
    if (!sessionId) return;
    void prefetchBrowserPane().catch(() => {});
    browserSurfaces.ensure(sessionId);
    if (!reveal) return;
    setSessionSideSurface(sessionId, "browser");
    const plan = browserSurfaceRevealPlan(
      browserPaneOwners,
      sessionId,
      paneWorkspace.focusedLeafId,
    );
    if (plan.leafId) {
      pendingBrowserAutoReveal.current.delete(sessionId);
      paneSideDocks.select(plan.leafId, "browser");
    } else {
      pendingBrowserAutoReveal.current.add(sessionId);
    }
  };
  const openBrowserSurfaceForAgentRef = useRef(openBrowserSurfaceForAgent);
  openBrowserSurfaceForAgentRef.current = openBrowserSurfaceForAgent;
  useEffect(() => window.mixdogDesktop?.onBrowserOpenRequested?.((request) => {
    openBrowserSurfaceForAgentRef.current(
      String(request?.sessionId || "").trim(),
      browserSurfaceRequestShouldReveal(request),
    );
  }), []);
  useEffect(() => {
    for (const sessionId of pendingBrowserAutoReveal.current) {
      const plan = browserSurfaceRevealPlan(
        browserPaneOwners,
        sessionId,
        paneWorkspace.focusedLeafId,
      );
      if (!plan.leafId) continue;
      pendingBrowserAutoReveal.current.delete(sessionId);
      paneSideDocks.select(plan.leafId, "browser");
    }
  }, [browserPaneOwners, paneSideDocks.select, paneWorkspace.focusedLeafId]);
  const openDiffTab = (
    project: string,
    rel: string,
    request: SourceControlDiffRequest,
  ) => {
    const cleanProject = String(project || "").trim();
    const cleanRel = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleanProject || !cleanRel) return;
    void prefetchDiffView().catch(() => {});
    const diffSelection: Extract<WorkspaceSelection, { kind: "diff" }> = {
      kind: "diff",
      project: cleanProject,
      rel: cleanRel,
      ...request,
    };
    const key = navigationKey(diffSelection);
    setTabs((current) => current.some((tab) => tab.key === key)
      ? current
      : [...current, {
        key,
        title: `${cleanRel.split("/").at(-1) || cleanRel} (Diff)`,
        selection: diffSelection,
      }]);
    openSelectionInFocusedPane(diffSelection);
  };
  const openPullRequestTab: PullRequestOpenHandler = (
    project,
    pullRequest,
    mode,
    toSide = false,
  ) => {
    if (!desktopFeatureEnabled("pullRequests")) return;
    const cleanProject = String(project || "").trim();
    if (!cleanProject || !Number.isInteger(pullRequest.number) || pullRequest.number <= 0) return;
    const instanceId = toSide
      ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      : undefined;
    const pullRequestSelection: Extract<WorkspaceSelection, { kind: "pull-request" }> = {
      kind: "pull-request",
      project: cleanProject,
      number: pullRequest.number,
      title: pullRequest.title,
      mode,
      ...(instanceId ? { instanceId } : {}),
    };
    const key = navigationKey(pullRequestSelection);
    const title = mode === "changes"
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
      const paneElement = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]"))
        .find((element) => element.dataset.paneId === focusedLeaf.id);
      const rect = paneElement?.getBoundingClientRect();
      if (!rect || canSplitPaneSize("row", rect.width, rect.height)) {
        splitFocusedPane("row", pullRequestSelection, rect
          ? { width: rect.width, height: rect.height }
          : undefined);
        return;
      }
    }
    openSelectionInFocusedPane(pullRequestSelection);
  };
  const dockOpenFile = useStableEvent((project: string, rel: string, mode?: "preview" | "pinned") => {
    openFileTab(project, rel, undefined, undefined, true, mode);
  });
  const dockOpenFileAt = useStableEvent(openFileTab);
  const dockOpenDiff = useStableEvent(openDiffTab);
  const dockOpenPullRequest = useStableEvent(openPullRequestTab);
  const dockOpenLeadSession = useStableEvent((sessionId: string) => {
    void openSession(sessionId);
  });
  const dockOpenAgentSession = useStableEvent((
    sessionId: string,
    title: string,
    _ownerSessionId: string,
  ) => {
    const childSessionId = String(sessionId || "").trim();
    if (!childSessionId) return;
    void openSession(childSessionId, false, String(title || "").trim());
  });
  const chooseFileTab = async (leafId = paneWorkspace.focusedLeafId) => {
    // Native file selection gives Monaco useful preload time without charging
    // every chat-only window its permanent module heap.
    void prefetchEditorPane().catch(() => {});
    const picked = window.mixdogDesktop?.chooseFiles
      ? await window.mixdogDesktop.chooseFiles(activeProjectPath || null)
      : await window.mixdogDesktop?.chooseFile?.(activeProjectPath || null)
        .then((entry) => entry ? [{
          absolutePath: "",
          name: entry.relPath.split("/").at(-1) || entry.relPath,
          dir: false,
          size: 0,
          ...entry,
        }] : null);
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
  const {
    activatePaneSurface,
    paneStripFor,
    stripTitleFor,
  } = useAppPaneChrome({
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
    // Right-edge strip actions (user: 최종결정은 우상단 — Claude Desktop처럼
    // PANE 우상단): the ACTIVE session tab docks its status island at the
    // strip row's right end. Non-session tabs keep the slot empty, and the
    // projected phone keeps its transcript-floating capsule instead.
    stripTrailing: (leaf) => {
      const active = leaf.tabs.find((tab) => navigationKey(tab) === leaf.activeKey);
      // A conversation surface owns the dock toggles even before its session
      // exists: a NEW TASK draft keeps the same three slots (session-bound
      // children inert) so the strip never reflows on commit. Non-conversation
      // tabs (file/Studio) keep the slot empty. The context gauge rides the
      // composer footer now; the Agent/Shell readout is retired from chrome.
      if (!active || (active.kind !== "session" && active.kind !== "new")) return null;
      const groups = workbenchSideLayout.layout.right;
      if (groups.length === 0) return null;
      const sessionId = active.kind === "session" ? active.id : "";
      const entry = sessionSideDockEntryForSession(
        paneSideDocks.entryFor(leaf.id),
        sessionId,
        sessionSideSurfaces.get(sessionId) ?? null,
        sessionDiffs.get(sessionId) ?? null,
        sessionPanelViews.get(sessionId) ?? null,
      );
      // The phone draws the SAME strip and the same trailing toggles (user:
      // PC에 최대한 맞춰서); its old bottom-panel opener is gone with the
      // Chrome-style toolbar (user: 하단 사이드탭 열리는 거 제거, 기능 없어).
      return <PaneDockToggles
        groups={groups}
        descriptors={sideViewDescriptors}
        activeRoot={paneDockActiveRoot(entry)}
        sessionBound={Boolean(sessionId)}
        onSelect={(id) => {
          paneWorkspace.focusLeaf(leaf.id);
          selectWorkbenchSideView(id, leaf.id);
        }}
        onClose={() => {
          paneWorkspace.focusLeaf(leaf.id);
          closePaneRightRegion(leaf.id);
        }} />;
    },
    lastSessionStorageKey: LAST_SESSION_KEY,
  });
  // Ctrl+Left/Right crosses pane boundaries in visual row-major order and
  // enters at the adjacent edge tab, never the pane's stale active tab.
  const focusSiblingPane = (offset: number) => {
    const target = paneTabAcrossVisualBoundary(
      paneWorkspace.layout,
      paneWorkspace.focusedLeafId,
      offset,
    );
    if (!target) return;
    paneWorkspace.focusLeaf(target.leafId);
    paneWorkspace.activateTab(target.leafId, navigationKey(target.selection));
    // Mirror the pane-click path: route the engine surface AND land the
    // caret in that pane's typing area.
    activatePaneSurface(target.selection);
    focusPaneTypingSurface(target.leafId, target.selection);
  };
  const focusVerticalPane = (direction: "up" | "down") => {
    const nextId = paneLeafIdInVerticalDirection(
      paneWorkspace.layout,
      paneWorkspace.focusedLeafId,
      direction,
    );
    if (!nextId) return;
    const next = paneWorkspace.leaves.find((leaf) => leaf.id === nextId);
    if (!next) return;
    paneWorkspace.focusLeaf(next.id);
    const nextActive = paneActiveSelection(next);
    if (nextActive) activatePaneSurface(nextActive);
    focusPaneTypingSurface(next.id, nextActive);
  };
  const {
    focusedLeafForShortcuts,
    focusedLeafTabs,
    tabSwitcher,
  } = useAppWorkspaceNavigation({
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
  const quickAccessProjectPath = toolProjectPath
    || workbenchWorkspace.workspace.folders[0]?.path || "";
  const quickAccessRecentFiles = useMemo(() => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const leaf of paneWorkspace.leaves) {
      for (const paneTab of leaf.tabs) {
        if (paneTab.kind !== "file" || paneTab.project !== quickAccessProjectPath || seen.has(paneTab.rel)) continue;
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
  const {
    sidebarNewTask,
    sidebarPanel,
    sidebarResumeSession,
    renderSidebarPanel,
  } = useAppSidebarSurface({
    schedulesOpen,
    webhooksOpen,
    projectsOpen,
    workflowsOpen,
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
    selectedProjectPath,
    extensionsSection,
    onExtensionsSectionChange: setExtensionsSection,
    closeSidebarForNavigation,
    startTask,
    openSession,
    refreshProjects,
    renameProject,
    removeProject,
  });
  // Phone strip home intent: the strip renders the brand-mark home button
  // but does not own the session drawer, so the intent rides a window event
  // instead of prop-drilling through the pane tree.
  useEffect(() => {
    const onHome = () => applySidebarOpen(!sidebarOpen);
    window.addEventListener("mixdog:mobile-home", onHome);
    return () => window.removeEventListener("mixdog:mobile-home", onHome);
  }, [applySidebarOpen, sidebarOpen]);
  // ABB (user: 백버튼 처리): each open transient layer arms one history
  // sentinel so hardware back closes it instead of leaving the PWA.
  // registerMobileBack no-ops outside the projected phone surface.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    return registerMobileBack(() => applySidebarOpen(false));
  }, [applySidebarOpen, sidebarOpen]);
  useEffect(() => {
    if (!bottomPanel.open) return undefined;
    return registerMobileBack(() => bottomPanel.setOpen(false));
  }, [bottomPanel, bottomPanel.open]);
  useEffect(() => {
    if (!focusedPaneDockOpen) return undefined;
    return registerMobileBack(() => {
      paneSideDocks.setOpen(focusedLeafIdRef.current, false);
    });
  }, [focusedPaneDockOpen, paneSideDocks.setOpen]);
  useLayoutEffect(() => {
    if (!settingsOpen) return undefined;
    return registerMobileBack(() => setSettingsOpen(false));
  }, [settingsOpen, setSettingsOpen]);
  useEffect(() => {
    if (!commandSurface) return undefined;
    return registerMobileBack(() => {
      setCommandSurface(null);
      setCommandSurfaceSessionId("");
    });
  }, [commandSurface, setCommandSurface, setCommandSurfaceSessionId]);
  useEffect(() => {
    if (!onboardingOpen) return undefined;
    return registerMobileBack(() => setOnboardingOpen(false));
  }, [onboardingOpen]);
  useEffect(() => {
    if (!quickAccessMode) return undefined;
    return registerMobileBack(() => setQuickAccessMode(null));
  }, [quickAccessMode]);
  // /inherit: the heir carries this conversation onto the currently selected
  // model under a new id, opens in its own tab, and leaves the source session
  // untouched behind it.
  const inheritSessionToNewTab = useCallback(async (
    sourceSessionId: string,
    route: DesktopModelSelection,
  ) => {
    const api = window.mixdogDesktop;
    if (typeof api?.inheritSession !== "function") {
      throw new Error("Session inheritance is unavailable on this surface.");
    }
    const result = await api.inheritSession(sourceSessionId, route);
    const inherited = String(result?.sessionId || "").trim();
    if (!inherited) throw new Error("The inherited session was not created.");
    setCommandSurface(null);
    setCommandSurfaceSessionId("");
    await openSession(inherited);
  }, [openSession, setCommandSurface, setCommandSurfaceSessionId]);
  const cancelPendingTabCloseRef = useRef(cancelPendingTabClose);
  cancelPendingTabCloseRef.current = cancelPendingTabClose;
  useEffect(() => {
    if (!pendingUnsavedClose) return undefined;
    return registerMobileBack(() => cancelPendingTabCloseRef.current());
  }, [pendingUnsavedClose]);
  useEffect(() => {
    if (!updateDialogOpen || updaterState.status !== "ready") return undefined;
    return registerMobileBack(closeDesktopUpdate);
  }, [closeDesktopUpdate, updateDialogOpen, updaterState.status]);
  // Mobile entry starts CLEAN (user: 들어가면 좌우·하단 탭 다 닫힌 상태):
  // whatever layout the last session or the desktop persisted, the phone
  // boots with drawer, dock and bottom panel closed — once per load.
  // Layout effect: the close lands BEFORE first paint, so a persisted-open
  // terminal/panel can never flash for one frame (user: 열자마자 터미널창이
  // 한 번 열렸다 닫히네).
  const mobileStartedClosed = useRef(false);
  useLayoutEffect(() => {
    if (mobileStartedClosed.current || !isMobileRemoteSurface()) return;
    mobileStartedClosed.current = true;
    applySidebarOpen(false, "instant");
    paneSideDocks.setOpen(focusedLeafIdRef.current, false);
    bottomPanel.setOpen(false, "instant");
  }, [applySidebarOpen, bottomPanel, paneSideDocks.setOpen]);
  const launchStudioSurface = useStableEvent(() => openStudioTab());
  const prefetchWorkbenchSideView = useCallback((id: WorkbenchSideViewId) => {
    if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
      const panel = id as SidebarPanelKey;
      trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
      return;
    }
    // A launcher warms the surface its tab will present, not the dock.
    if (id === "studio") {
      void loadStudioViewModule().catch(() => {});
      return;
    }
    if (id === "browser") {
      void prefetchBrowserPane().catch(() => {});
      return;
    }
    if (id === "terminal") {
      void prefetchTerminalPane().catch(() => {});
      return;
    }
    if (id === "session-diff") {
      void prefetchDiffView().catch(() => {});
      return;
    }
    if (id !== "sessions") void preloadUtilityDock().catch(() => {});
  }, [trackSidebarPanelModule]);
  const sideViewDescriptors = useMemo(() => new Map<
    WorkbenchSideViewId,
    WorkbenchSideViewDescriptor
  >([
    ["sessions", { id: "sessions", label: "Sessions", icon: MessageSquare }],
    ["projects", { id: "projects", label: "Projects", icon: PanelsTopLeft,
      onPrefetch: () => prefetchWorkbenchSideView("projects") }],
    ["workflows", { id: "workflows", label: "Workflows", icon: Layers3,
      onPrefetch: () => prefetchWorkbenchSideView("workflows") }],
    ["extensions", { id: "extensions", label: "Extensions", icon: Package,
      onPrefetch: () => prefetchWorkbenchSideView("extensions") }],
    ["schedules", { id: "schedules", label: "Schedules", icon: Clock,
      onPrefetch: () => prefetchWorkbenchSideView("schedules") }],
    ["webhooks", { id: "webhooks", label: "Webhooks", icon: Webhook,
      onPrefetch: () => prefetchWorkbenchSideView("webhooks") }],
    // Launchers: the icon mints a workspace tab instead of opening a panel.
    ["studio", { id: "studio", label: "Studio", icon: Sparkles,
      onPrefetch: () => prefetchWorkbenchSideView("studio") }],
    ["browser", { id: "browser", label: "Browser Use", title: "Browser", icon: Globe,
      onPrefetch: () => prefetchWorkbenchSideView("browser") }],
    ["terminal", { id: "terminal", label: "Terminal", icon: SquareTerminal,
      onPrefetch: () => prefetchWorkbenchSideView("terminal") }],
    ["session-diff", {
      id: "session-diff",
      label: "Diff",
      tooltip: "Session Diff",
      icon: FileDiff,
      onPrefetch: () => prefetchWorkbenchSideView("session-diff"),
    }],
    ["agents", { id: "agents", label: "Agents", icon: Bot,
      onPrefetch: () => prefetchWorkbenchSideView("agents") }],
    ["search", { id: "search", label: "Search", icon: Search,
      onPrefetch: () => prefetchWorkbenchSideView("search") }],
    ["source-control", {
      id: "source-control",
      label: "Source Control",
      icon: GitCompare,
      onPrefetch: () => prefetchWorkbenchSideView("source-control"),
    }],
    ["pull-requests", {
      id: "pull-requests",
      label: "Pull Requests",
      tooltip: "GitHub Pull Requests",
      icon: Github,
      onPrefetch: () => prefetchWorkbenchSideView("pull-requests"),
    }],
  ]), [prefetchWorkbenchSideView]);
  const selectWorkbenchSideView = useCallback((
    id: WorkbenchSideViewId,
    paneLeafId?: string,
  ) => {
    // A launcher owns no panel: it mints its workspace tab and leaves both
    // sides exactly as they were. The browser is no launcher anymore — it
    // flows to the right-side branch as the pane dock's own child.
    if (isWorkbenchSideLauncher(id)) {
      launchStudioSurface();
      return;
    }
    const side = workbenchSideLayout.sideOf(id);
    if (id === "sessions") {
      closeSidebarPanels();
    } else if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
      const panel = id as SidebarPanelKey;
      mountSidebarPanel(panel);
      trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
      if (panel === "projects") void refreshProjects().catch(() => undefined);
    }
    if (side === "right") {
      // A pane strip passes ITS leaf; window-level entry points (commands,
      // rail drops, /settings extensions) land on the focused pane's dock.
      const leafId = paneLeafId ?? focusedLeafIdRef.current;
      const leaf = paneWorkspace.leaves.find((candidate) => candidate.id === leafId);
      const selection = leaf ? paneActiveSelection(leaf) : null;
      if (id === "browser" || id === "terminal") {
        if (selection?.kind !== "session") return;
        if (id === "browser") {
          browserSurfaces.ensure(selection.id);
          pendingBrowserAutoReveal.current.delete(selection.id);
        } else {
          void prefetchTerminalPane().catch(() => {});
        }
        setSessionSideSurface(selection.id, id);
      } else if (selection?.kind === "session") {
        setSessionSideSurface(selection.id, null);
        // The Session Diff list is session-owned too (user: 브라우저랑
        // 터미널도 마찬가지): opening it remembers the session, landing
        // anywhere else forgets it for this session.
        setSessionPanelView(selection.id, id === "session-diff" ? "session-diff" : null);
      }
      paneSideDocks.select(leafId, id);
      return;
    }
    if (activeSideViews.left === id && sidebarOpen) {
      applySidebarOpen(false);
      return;
    }
    setActiveSideViews((current) =>
      current.left === id ? current : { ...current, left: id });
    applySidebarOpen(true);
  }, [
    activeSideViews,
    applySidebarOpen,
    closeSidebarPanels,
    launchStudioSurface,
    mountSidebarPanel,
    paneSideDocks.select,
    browserSurfaces,
    paneWorkspace.leaves,
    refreshProjects,
    setSessionSideSurface,
    sidebarOpen,
    trackSidebarPanelModule,
    workbenchSideLayout.sideOf,
  ]);
  const moveWorkbenchSideGroup = useCallback((
    sourceRoot: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ) => {
    // The pane-scoped right side is a fixed set (the pure move helpers refuse
    // every cross-right move), so only the left rail actually reorders.
    const sourceSide = workbenchSideLayout.sideOf(sourceRoot);
    if (sourceSide === "right" || targetSide === "right") return;
    workbenchSideLayout.moveGroup(sourceRoot, targetSide, targetRoot, placement);
    const landedRoot = placement.startsWith("inside") && targetRoot
      ? targetRoot
      : sourceRoot;
    if (!isWorkbenchSideLauncher(landedRoot)) {
      setActiveSideViews((current) =>
        current.left === landedRoot ? current : { ...current, left: landedRoot });
      applySidebarOpen(true);
    }
  }, [
    applySidebarOpen,
    workbenchSideLayout.moveGroup,
    workbenchSideLayout.sideOf,
  ]);
  const moveWorkbenchSideView = useCallback((
    sourceId: WorkbenchSideViewId,
    targetSide: WorkbenchSide,
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ) => {
    const sourceSide = workbenchSideLayout.sideOf(sourceId);
    if (sourceSide === "right" || targetSide === "right") return;
    workbenchSideLayout.moveView(sourceId, targetSide, targetRoot, placement);
    const landedView = placement.startsWith("inside") && targetRoot
      ? targetRoot
      : sourceId;
    if (!isWorkbenchSideLauncher(landedView)) {
      setActiveSideViews((current) =>
        current.left === landedView ? current : { ...current, left: landedView });
      applySidebarOpen(true);
    }
  }, [
    applySidebarOpen,
    workbenchSideLayout.moveView,
    workbenchSideLayout.sideOf,
  ]);
  useLayoutEffect(() => {
    if (workbenchSideLayout.layout.left.length === 0 && sidebarOpen) {
      applySidebarOpen(false);
    }
  }, [
    applySidebarOpen,
    sidebarOpen,
    workbenchSideLayout.layout.left.length,
  ]);
  useLayoutEffect(() => {
    if (!sidebarPanel) return;
    const side = workbenchSideLayout.sideOf(sidebarPanel);
    if (side === "right") {
      paneSideDocks.open(focusedLeafIdRef.current, sidebarPanel);
      return;
    }
    setActiveSideViews((current) =>
      current.left === sidebarPanel ? current : { ...current, left: sidebarPanel });
  }, [
    paneSideDocks.open,
    sidebarPanel,
    workbenchSideLayout.sideOf,
  ]);
  // Every chat pane keeps the same Conversation tree mounted. Focus only
  // selects the command/snapshot owner. Because the
  // root and picker instances survive that prop change, the pointer event that
  // focuses a pane continues into the control the user actually clicked.
  const projectChromeLabel = useCallback((path: string): string => {
    const summary = projects.find((project) =>
      project.path.replace(/[\\/]+/g, "/").toLocaleLowerCase() ===
      path.replace(/[\\/]+/g, "/").toLocaleLowerCase());
    return summary
      ? summary.alias?.trim() || summary.name?.trim() ||
        displayProject(summary.path).name || "Project"
      : "";
  }, [projects]);
  const paneConversationSurface = (
    paneSelection: NavigationSelection,
    focused: boolean,
    focusPane: () => void,
    leafId: string,
  ) => {
    const activeHandoff = conversationHandoff?.leafId === leafId
      ? conversationHandoff
      : null;
    const presentedSelection = activeHandoff?.selection ?? paneSelection;
    const paneSessionId = presentedSelection.kind === "session" ? presentedSelection.id : "";
    const draftKey = presentedSelection.kind === "new"
      ? presentedSelection.draftId || "default"
      : "";
    const prefs = resolvedDraftPrefsFor(draftKey);
    const sessionRow = paneSessionId
      ? sessions.find((row) => row.id === paneSessionId)
      : undefined;
    const paneProjectPath = paneSessionId
      ? registeredProjectPath(sessionRow?.projectPath || "")
      : prefs.projectPath;
    const paneProjectLabel = projectChromeLabel(paneProjectPath);
    // An agent worker session is deliberately absent from the session catalog
    // (owner === 'agent' is filtered out), so `sessionRow` is undefined and a
    // catalog-derived title degrades to the "Untitled session" placeholder.
    // The title its opener pinned — the worker tag from the Agents panel — is
    // the authoritative label here, so it outranks the catalog lookup.
    const pinnedPaneTitle = presentedSelection.kind === "session"
      ? String(presentedSelection.title || "").trim()
      : "";
    const paneTitle = paneSessionId
      ? pinnedPaneTitle
        || (sessionRow ? sessionSummaryTitle(sessionRow) : "Untitled session")
      : "New task";
    const focusedDraft = focused && Boolean(draftKey);
    const focusedSession = focused && Boolean(paneSessionId);
    return <AppConversationPaneSurface
      focused={focused}
      focusPane={focusPane}
      handoffActive={Boolean(activeHandoff)}
      title={paneTitle}
      projectLabel={paneSessionId ? paneProjectLabel : ""}
      titleContent={focusedSession && selectedSession
        ? <StableSessionTitle title={paneTitle}
            editing={headerTitleEditingSessionId === selectedSession.id}
            draft={headerTitleDraft} invalid={headerTitleInvalid}
            onOpen={openHeaderTitleEditor}
            onDraftChange={setHeaderTitleDraft}
            onCommit={commitHeaderTitleEditor}
            onCancel={closeHeaderTitleEditor} />
        : paneTitle}
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
          : presentedSelection.kind === "new"
            ? paneDraftSubmitFor(presentedSelection, leafId)
            : submit,
        applySnapshot: paneSessionId
          ? (next) => applySessionLaneResult(paneSessionId, next)
          : applySnapshot,
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
        onDraftModelSelection: focusedDraft ? stageNewTaskModelSelection : undefined,
        onRoutePreferenceApplied: rememberSessionRouteForNextTask,
        onDraftWorkflow: focusedDraft ? stageNewTaskWorkflow : undefined,
        activeProjectPath: paneProjectPath,
        activeProjectLabel: paneProjectLabel,
        onSelectProject: conversationSelectProject,
        onOpenCommandSurface: (surface) =>
          openConversationCommandSurface(surface, paneSessionId),
      }} />;
  };
  const {
    paneFileEditors,
    paneUtilitySurfacePortals,
    paneUtilityTabs,
  } = useAppPersistentPaneSurfaces({
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
  // PANE tabs are part of the visible workspace: a session tab that is
  // already open must not cold-load on its first click (user: PANE에 이미
  // 올라간 게 왜 콜드냐). Once boot settles, idle-prewarm each open tab's
  // lane. requestSessionRead dedupes (laned/in-flight sessions no-op) and
  // the lane store's byte budget still owns retention, so this only fronts
  // the disk read that the first click would otherwise pay behind a cover.
  useEffect(() => {
    if (!desktopBootReady) return undefined;
    // A phone pays for every prewarmed transcript over the relay and only ever
    // shows one tab, so restored background tabs stay cold until opened
    // (user: vps라 비용때문에).
    if (isMobileRemoteSurface()) return undefined;
    const sessionIds = paneActiveSessionIds(
      paneWorkspace.leaves,
      paneWorkspace.focusedLeafId,
    );
    if (sessionIds.length === 0) return undefined;
    // One lane task per tab, focused pane first (paneActiveSessionIds order).
    const cancels = sessionIds.map((sessionId, index) => scheduleBootWarmup({
      id: `transcript:${sessionId}`,
      priority: BOOT_WARMUP.transcript + index,
      run: () => requestSessionRead(sessionId),
    }));
    return () => { for (const cancel of cancels) cancel(); };
  }, [desktopBootReady, paneWorkspace.focusedLeafId, paneWorkspace.leaves]);
  // Restored file/terminal/diff/folder tabs are surfaces the user already
  // chose to keep open, and they own the heaviest chunks in the app — the
  // first switch to one otherwise paid that entire fetch at open time (user:
  // 창 들어갈 때 지연). Unlike the transcript prewarm above this is CODE: it
  // lands in the immutable asset cache once and costs nothing on later visits,
  // which is why a phone may warm it as well. A metered or slow link still
  // opts out and pays only for the tabs actually opened.
  useEffect(() => {
    if (!desktopBootReady) return undefined;
    const nativeSurface = Boolean(window.mixdogDesktop?.bootContext?.bootId);
    if (!nativeSurface && connectionQuality() !== "normal") return undefined;
    const queue = paneWorkspace.leaves.flatMap((leaf) => [...leaf.tabs]);
    if (queue.length === 0) return undefined;
    // Session and draft tabs resolve to no chunk at all; the rest join
    // whatever load their own surface may already have started. One lane
    // task per tab keeps them behind the transcript reads.
    const cancels = queue.map((selection, index) => scheduleBootWarmup({
      id: `chunk:${navigationKey(selection)}`,
      priority: BOOT_WARMUP.surfaceChunk + index,
      run: () => prefetchSurfaceForSelection(selection),
    }));
    return () => { for (const cancel of cancels) cancel(); };
  }, [desktopBootReady, paneWorkspace.leaves]);
  // The warm-up lane opens once boot is ready AND the window has shown its
  // first frames (Electron emits mixdog:window-shown after two composed
  // frames). Until then every scheduled task stays parked, so nothing
  // competes with the boot cover or the opening conversation.
  useEffect(() => {
    if (!desktopBootReady) return undefined;
    const nativeWindow = Boolean(window.mixdogDesktop?.bootContext?.bootId);
    const host = window as typeof window & { __mixdogWindowShown?: boolean };
    let fallbackTimer = 0;
    const arm = () => {
      window.removeEventListener("mixdog:window-shown", arm);
      window.clearTimeout(fallbackTimer);
      armBootWarmup(BOOT_WARMUP_ARM_DELAY_MS);
    };
    if (!nativeWindow || host.__mixdogWindowShown) arm();
    else {
      window.addEventListener("mixdog:window-shown", arm, { once: true });
      // A native window normally emits this after show; keep a bounded
      // fallback for an abnormal missed event.
      fallbackTimer = window.setTimeout(arm, 1_200);
    }
    return () => {
      window.removeEventListener("mixdog:window-shown", arm);
      window.clearTimeout(fallbackTimer);
    };
  }, [desktopBootReady]);
  // Rail panels HIDDEN-mount one per idle slice (user: 메뉴 진입 반응성):
  // useSidebarReferences coalesces their shared hydration, so rows, route
  // controls and overflow options are ready before the first click — without
  // five module loads and five mounts landing in the same 120ms as before.
  useEffect(() => {
    if (!desktopBootReady) return undefined;
    const cancels = [scheduleBootWarmup({
      id: "module:utility-dock",
      priority: BOOT_WARMUP.utilityDockModule,
      run: () => preloadUtilityDock().catch(() => {}),
    })];
    const panels: SidebarPanelKey[] = ["schedules", "webhooks", "projects", "workflows", "extensions"];
    panels.forEach((panel, index) => {
      if (!desktopSidebarDestinationEnabled(panel)) return;
      cancels.push(scheduleBootWarmup({
        id: `mount:sidebar:${panel}`,
        priority: BOOT_WARMUP.sidebarPanel + index,
        run: () => {
          const module = loadSidebarPanelModule[panel]();
          trackSidebarPanelModule(panel, module);
          return module.then(() => mountSidebarPanel(panel)).catch(() => {});
        },
      }));
    });
    return () => { for (const cancel of cancels) cancel(); };
  }, [desktopBootReady, mountSidebarPanel, trackSidebarPanelModule]);
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
    },
  ): React.ReactNode => {
    if (id === "sessions") {
      return <SessionSidebar
        open={active}
        panelTitleDragProps={titleDragProps}
        sessions={sessions}
        sessionsReady={sessionCatalogReady}
        workingSessionIds={workingSessionIds}
        unreadSessionIds={unreadSessionIds}
        selection={sidebarSelection}
        onNewTask={sidebarNewTask}
        onPrefetchSession={window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined}
        onResumeSession={sidebarResumeSession}
        onRenameSession={renameSession}
        onArchiveSession={archiveSession}
        onDeleteSession={deleteSession}
      />;
    }
    if (DEFAULT_SIDEBAR_VIEW_ORDER.includes(id as SidebarPanelKey)) {
      return <SessionSidebar
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
        onPrefetchSession={window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined}
        onResumeSession={sidebarResumeSession}
        onRenameSession={renameSession}
        onArchiveSession={archiveSession}
        onDeleteSession={deleteSession}>
        {renderSidebarPanel(id as SidebarPanelKey, active)}
      </SessionSidebar>;
    }
    if (id === "session-diff") {
      if (!pane) return null;
      const sessionId = pane.sessionId;
      return <SessionDiffPane sessionId={sessionId} active={active}
        openRel={sessionDiffs.get(sessionId)?.rel ?? ""}
        onOpenDiff={sessionId && pane.projectPath
          ? (rel) => {
              void prefetchDiffView().catch(() => {});
              setSessionDiff(sessionId, {
                kind: "diff",
                project: pane.projectPath,
                rel,
                source: "session",
                hash: sessionId,
              });
            }
          : undefined} />;
    }
    // Launchers have no panel body, and session-owned surfaces render in the
    // pane dock's persistent stack.
    if (isWorkbenchSideLauncher(id) || id === "browser" || id === "terminal") return null;
    const tab = id as UtilityDockTab;
    return <SnapshotUtilityDock snapshotStore={snapshotStore}
      hidden={!active}
      prewarm={Boolean(pane?.prewarm)}
      open={active}
      tab={tab}
      showTitle={!pane}
      title={sideViewDescriptors.get(id)?.label}
      titleDragProps={titleDragProps}
      sessions={sessions}
      activeSessionIds={observedAgentSessionIds}
      unreadSessionIds={unreadSessionIds}
      onPrefetchSession={prefetchSession}
      projectPath={pane?.projectPath || quickAccessProjectPath}
      workspaceFolders={workbenchWorkspace.workspace.folders as DesktopWorkspaceFolder[]}
      onSelectProject={selectToolProject}
      metricSurface={side === "left" ? "sidebar" : "dock"}
      entering
      contentReady
      onOpenFile={dockOpenFile}
      onOpenFileAt={dockOpenFileAt}
      onOpenDiff={pane
        ? (project, rel, request) => {
            void prefetchDiffView().catch(() => {});
            paneSideDocks.openDiff(pane.leafId, project, rel, request);
          }
        : dockOpenDiff}
      onOpenPullRequest={dockOpenPullRequest}
      onOpenLeadSession={dockOpenLeadSession}
      onOpenAgentSession={dockOpenAgentSession}
    />;
  };
  // Pane-scoped tools follow the active session project, while the left-side
  // Source Control uses the shared quick-access Project.
  const paneProjectPathFor = (leaf: PaneLeaf): string => {
    const active = paneActiveSelection(leaf);
    if (active?.kind === "session") {
      const row = sessions.find((session) => session.id === active.id);
      const registered = registeredProjectPath(row?.projectPath || "");
      if (registered) return registered;
    }
    if (active?.kind === "file" && active.project) return active.project;
    if (active?.kind === "new") {
      const prefs = resolvedDraftPrefsFor(active.draftId || "default");
      if (prefs.projectPath) return prefs.projectPath;
    }
    return quickAccessProjectPath;
  };
  const focusedPaneForDockPrewarm = paneWorkspace.leaves.find(
    (leaf) => leaf.id === paneWorkspace.focusedLeafId,
  );
  const focusedPaneDockProjectPath = focusedPaneForDockPrewarm
    ? paneProjectPathFor(focusedPaneForDockPrewarm)
    : quickAccessProjectPath;
  useEffect(() => {
    if (!desktopBootReady || !focusedPaneDockProjectPath) return undefined;
    if (isMobileRemoteSurface() || !window.mixdogDesktop?.gitStatus) return undefined;
    return scheduleBootWarmup({
      id: "dock:git-state",
      priority: BOOT_WARMUP.dockGitState,
      run: () => prewarmUtilityDockGitState(focusedPaneDockProjectPath).catch(() => {}),
    });
  }, [desktopBootReady, focusedPaneDockProjectPath]);
  // The focused pane's dock body hidden-mounts only after the lane reaches it
  // — a mount that big must not ride the boot-ready render itself.
  const [dockBodyWarm, setDockBodyWarm] = useState(false);
  useEffect(() => {
    if (!desktopBootReady || dockBodyWarm || isMobileRemoteSurface()) return undefined;
    return scheduleBootWarmup({
      id: "dock:body",
      priority: BOOT_WARMUP.dockBody,
      run: () => setDockBodyWarm(true),
    });
  }, [desktopBootReady, dockBodyWarm]);
  const renderPaneSideDock = (leaf: PaneLeaf, focused: boolean) => {
    const active = paneActiveSelection(leaf);
    const sessionId = active?.kind === "session" ? active.id : "";
    const entry = sessionSideDockEntryForSession(
      paneSideDocks.entryFor(leaf.id),
      sessionId,
      sessionSideSurfaces.get(sessionId) ?? null,
      sessionDiffs.get(sessionId) ?? null,
      sessionPanelViews.get(sessionId) ?? null,
    );
    const prewarm = focused && dockBodyWarm;
    return <PaneSideDock
      leafId={leaf.id}
      entry={entry}
      groups={workbenchSideLayout.layout.right}
      descriptors={sideViewDescriptors}
      focused={focused}
      prewarm={prewarm}
      onFocusPane={() => paneWorkspace.focusLeaf(leaf.id)}
      onSelect={(id) => selectWorkbenchSideView(id, leaf.id)}
      onClose={() => closePaneRightRegion(leaf.id)}
      onCloseDiff={() => {
        // A session's own diff closes in its session map; the pane entry
        // never held it.
        if (entry.diff?.source === "session" && sessionId) {
          setSessionDiff(sessionId, null);
          return;
        }
        paneSideDocks.closeDiff(leaf.id);
      }}
      openFileTab={openFileTab}
      renderBrowserSurface={(active) => {
        if (!sessionId) return null;
        return <SessionBrowserSlot
          controller={browserSurfaces}
          sessionId={sessionId}
          active={active}
          foreground={active && focused}
        />;
      }}
      renderTerminalSurface={(active) => {
        if (!sessionId) return null;
        return <SessionTerminalSlot
          controller={terminalSurfaces}
          sessionId={sessionId}
          cwd={paneProjectPathFor(leaf) || null}
          active={active}
          foreground={active && focused}
        />;
      }}
      onMoveGroup={moveWorkbenchSideGroup}
      onMoveView={moveWorkbenchSideView}
      renderView={(id, active, titleDragProps) =>
        renderWorkbenchSideView("right", id,
          // The Session Diff list fetches only while actually showing: a
          // covering browser/terminal surface keeps it mounted but quiet.
          id === "session-diff" ? active && entry.surface === "" : active,
          titleDragProps, {
          leafId: leaf.id,
          projectPath: paneProjectPathFor(leaf),
          sessionId,
          prewarm,
        })}
    />;
  };
  // Problems is the SCRIPT's own sub-panel (user: DIFF처럼 스크립트에 종속):
  // it docks under the pane's file editor, scoped to that file's project,
  // and exists only while the pane's active tab is a file. Open state stays
  // per pane (openPaneIds), height is shared.
  const renderPaneProblems = (leaf: PaneLeaf) => {
    const active = paneActiveSelection(leaf);
    if (active?.kind !== "file") return null;
    const open = bottomPanelOpenForPane(bottomPanel.openPaneIds, leaf.id);
    return <BottomPanel
      open={open}
      height={bottomPanel.height}
      motion={bottomPanel.motion}
      onHeightChange={bottomPanel.setHeight}
      tabs={WORKBENCH_PANEL_REGISTRY.map((panel) => ({
        id: panel.id,
        label: panel.label,
        ...(panel.id === "problems"
          ? { badge: <ProjectProblemCount projectPath={active.project} /> }
          : {}),
      }))}
      activeTab="problems"
      onSelectTab={() => {}}
      onClose={() => bottomPanel.setOpenFor(leaf.id, false)}
      headerActions={<WorkbenchProblemsFilter
        filter={problemsFilter}
        onFilter={setProblemsFilter} />}
      actions={<WorkbenchProblemsSeverityActions
        projectPath={active.project}
        filter={problemsFilter}
        onFilter={setProblemsFilter}
        onCollapseAll={() => setProblemsCollapseNonce((value) => value + 1)} />}>
      {open &&
        <div className="workbench-panel-surface utility-dock-pane stable-surface-layer"
          data-tab="problems"
          data-surface-active="true">
            <WorkbenchProblemsPane projectPath={active.project}
              active={open}
              activeFileRel={active.rel}
              filter={problemsFilter}
              collapseNonce={problemsCollapseNonce}
              onOpenFile={openFileTab}
              onQuickFix={openProblemQuickFix} />
          </div>}
    </BottomPanel>;
  };
  return (
    <DesktopBootGate
      enabled={Boolean(window.mixdogDesktop?.bootContext?.bootId)}
      restorePending={paneWorkspace.restorePending}
      ready={desktopBootReady}>
    <div className={`app-shell ${
      sidebarOpen && workbenchSideLayout.layout.left.length ? "" : "sidebar-collapsed"
    }`}
      style={{
        "--desktop-workspace-min-width": `${DESKTOP_WORKSPACE_MIN_WIDTH}px`,
      } as React.CSSProperties}>
      <RemoteConnectionBanner />
      <DesktopTitlebar
        updaterState={updaterState}
        onOpenUpdate={openDesktopUpdate} />
      <div className="desktop-body">
        <div className="sidebar-drawer-frame"
          data-state={sidebarOpen ? "open" : "closed"}
          data-motion={sidebarMotion}>
          <ActivityRail
          sidebarOpen={sidebarOpen && !sidebarPanel}
          onToggleSessions={() => {
            // The right dock is NEVER force-closed here (user: 설정 외의
            // 강제 닫힘 금지): the narrow-band one-sheet rule already lives
            // inside openSidebar/toggleSidebar, and wide inline layouts keep
            // both edges open.
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
          activeSurface={settingsOpen ? "settings"
            : sidebarOpen && sidebarPanel ? sidebarPanel
            : null}
          // Rail destinations share the Sessions toggle contract: the first
          // click opens that list, while re-selecting it collapses the whole
          // sidebar and resets the next expansion to Sessions.
          onOpenProjects={() => {
            openProjects();
            void refreshProjects().catch(() => undefined);
          }}
          onPrefetchProjects={() => {
            trackSidebarPanelModule("projects", loadSidebarPanelModule.projects());
          }}
          onOpenWorkflows={openWorkflows}
          onPrefetchWorkflows={() => {
            trackSidebarPanelModule("workflows", loadSidebarPanelModule.workflows());
          }}
          onOpenSchedules={openSchedules}
          onPrefetchSchedules={() => {
            trackSidebarPanelModule("schedules", loadSidebarPanelModule.schedules());
          }}
          onOpenWebhooks={openWebhooks}
          onPrefetchWebhooks={() => {
            trackSidebarPanelModule("webhooks", loadSidebarPanelModule.webhooks());
          }}
          onCloseActiveSurface={closeActiveRailPanel}
          onOpenSettings={() => { closeSidebarForNavigation("instant"); openSettings(); }}
          onPrefetchSettings={warmSettingsView}
          primaryNavigation={<WorkbenchSideIconBar
            side="left"
            groups={workbenchSideLayout.layout.left}
            activeRoot={activeSideViews.left}
            descriptors={sideViewDescriptors}
            orientation="vertical"
            onSelect={selectWorkbenchSideView}
            onMoveGroup={moveWorkbenchSideGroup}
            onMoveView={moveWorkbenchSideView} />} />
        <WorkbenchSidePanel
          side="left"
          open={sidebarOpen}
          groups={workbenchSideLayout.layout.left}
          activeRoot={activeSideViews.left}
          descriptors={sideViewDescriptors}
          onSelect={selectWorkbenchSideView}
          onMoveGroup={moveWorkbenchSideGroup}
          onMoveView={moveWorkbenchSideView}
          renderView={(id, active, titleDragProps) =>
            renderWorkbenchSideView("left", id, active, titleDragProps)}
        />
        </div>
        {/* The scrim stays mounted so it can FADE with the drawer instead of
            blinking out the moment the slide starts (CSS shows it only on
            narrow viewports). */}
        <button className="sidebar-backdrop"
          data-state={sidebarOpen ? "open" : "closed"}
          aria-hidden={!sidebarOpen}
          tabIndex={sidebarOpen ? 0 : -1}
          onClick={() => applySidebarOpen(false)} aria-label="Close session sidebar" />
        <main className="main-panel" ref={mainPanelRef}>
          {/* Split-pane workspace: with one pane the classic markup renders
              1:1 — zero layout drift. With 2+ panes the focused leaf keeps
              this same interactive surface and every other session leaf
              streams live from its session lane. */}
          {(() => {
            const workspaceSurface = (
          <div className="workspace">
            <header className="session-header" aria-label="Current task">
              <div className="session-header-content">
                <h1 data-tooltip={visibleSessionTitle}>
                  {selectedSession
                    ? <StableSessionTitle title={visibleSessionTitle}
                        editing={headerTitleEditingSessionId === selectedSession.id}
                        draft={headerTitleDraft} invalid={headerTitleInvalid}
                        onOpen={openHeaderTitleEditor}
                        onDraftChange={setHeaderTitleDraft}
                        onCommit={commitHeaderTitleEditor}
                        onCancel={closeHeaderTitleEditor} />
                    : visibleSessionTitle}
                </h1>
                {navigationSelection.kind === "session" && activeProjectLabel &&
                  <span className="session-project-badge">{activeProjectLabel}</span>}
              </div>
            </header>
            <DraftConversation
              transcriptPending={transcriptRendererPending}
              invokeResult={invokeResult}
              errors={errors} submit={submit} applySnapshot={applySnapshot}
              transitioning={false}
              composerFocusRequest={composerFocusRequest}
              onNewTask={conversationNewTask}
              onClearToNewTask={conversationClearToNewTask}
              onClearProject={conversationClearProject}
              onResumeSession={conversationResumeSession}
              onOpenSessions={desktopFeatureEnabled("sessions") ? openSidebar : () => {}}
              onOpenProjects={conversationOpenProjects}
              onOpenSettings={openSettings}
              projects={projects}
              showProjectSelector={selection.kind === "new"}
              // A draft ALWAYS stages model/workflow locally (per-draft
              // prefs) — routing a pre-session change through the engine made
              // it a GLOBAL default that repainted every pane (user report).
              // The staged values commit at session creation: the first
              // submit passes them as submitNewTask options. Mid-session
              // changes keep flowing to that session's own engine.
              draftMode={selection.kind === "new"}
              draftId={selection.kind === "new"
                ? selection.draftId || "default"
                : ""}
              draftModelSelection={newTaskModelSelection}
              draftWorkflow={newTaskWorkflow}
              onDraftModelSelection={selection.kind === "new"
                ? stageNewTaskModelSelection
                : undefined}
              onRoutePreferenceApplied={rememberSessionRouteForNextTask}
              onDraftWorkflow={selection.kind === "new"
                ? stageNewTaskWorkflow
                : undefined}
              activeProjectPath={activeProjectPath}
              activeProjectLabel={activeProjectLabel}
              onSelectProject={conversationSelectProject}
              onOpenCommandSurface={openConversationCommandSurface} />
          </div>
            );
            return <PaneWorkspace
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
                  renderActive={(leaf) => leaf.tabs.length === 0
                    ? <WorkspaceEmptyState />
                    : workspaceSurface}
                />;
          })()}
        </main>
        <SessionBrowserParkingHost controller={browserSurfaces} />
        <SessionTerminalParkingHost controller={terminalSurfaces} />
        {/* Bottom sheet band keeps outside-tap dismissal without dimming the
            work surface, matching both side sheets. */}
        <button className="panel-backdrop"
          data-state={bottomPanel.open ? "open" : "closed"}
          aria-hidden={!bottomPanel.open}
          tabIndex={bottomPanel.open ? 0 : -1}
          onClick={() => bottomPanel.setOpen(false)} aria-label="Close panel" />
      </div>
      {paneUtilitySurfacePortals}
      {quickAccessMode && <WorkbenchQuickAccess key={quickAccessMode}
        mode={quickAccessMode}
        projectPath={quickAccessProjectPath}
        recentFiles={quickAccessRecentFiles}
        commands={workbenchCommands}
        onOpenFile={(rel, line) => {
          if (quickAccessProjectPath) openFileTab(quickAccessProjectPath, rel, line);
        }}
        onClose={() => setQuickAccessMode(null)} />}
      {tabSwitcher && <div className="workspace-tab-switcher" role="listbox"
        aria-label="Open tabs, most recent first">
        {tabSwitcher.keys.map((key, index) => {
          const selection = focusedLeafForShortcuts?.tabs
            .find((entry) => navigationKey(entry) === key);
          if (!selection) return null;
          return <div key={key} role="option" aria-selected={index === tabSwitcher.index}
            className={index === tabSwitcher.index ? "active" : ""}>
            {stripTitleFor(key, selection)}
          </div>;
        })}
      </div>}
      {pendingUnsavedClose && <UnsavedChangesDialog
        title={pendingUnsavedClose.tab.title.replace(/^●\s*/, "")}
        busy={unsavedCloseBusy}
        error={unsavedCloseError}
        onSave={() => { void saveAndClosePendingTab(); }}
        onDiscard={discardAndClosePendingTab}
        onCancel={cancelPendingTabClose} />}
      <Suspense fallback={settingsOpen
        // Keep the current workbench visible until the lazy Settings dialog is
        // ready. A full-window cover made a cold web chunk look like an empty
        // page before the actual dialog appeared.
        ? null
        : (commandSurface || onboardingOpen)
          ? <DesktopLoadingSurface label="Loading view…" overlay />
          : null}>
        {(settingsOpen || settingsMounted.current || settingsPrewarmed) && <SettingsView
          open={settingsOpen}
          initialSection={settingsSection}
          onCompose={(text) => {
            setSettingsOpen(false);
            window.dispatchEvent(new CustomEvent('mixdog:composer-draft', { detail: text }));
          }}
          onClose={() => setSettingsOpen(false)} />}
        {(["context", "usage", "doctor", "inherit"] as const).map((surface) =>
          commandSurface === surface || mountedCommandSurfaces.current.has(surface)
            ? <CommandSurface
                key={surface === "context" || surface === "inherit"
                  ? `${surface}:${commandSurfaceSessionId}`
                  : surface}
                surface={surface}
                open={commandSurface === surface}
                sessionId={surface === "context" || surface === "inherit"
                  ? commandSurfaceSessionId
                  : ""}
                snapshot={surface === "context" || surface === "inherit"
                  ? commandSurfaceLane ?? EMPTY_SNAPSHOT
                  : snapshot}
                onInherit={surface === "inherit" ? inheritSessionToNewTab : undefined}
                onClose={() => {
                  setCommandSurface(null);
                  setCommandSurfaceSessionId("");
                }} />
            : null)}
        {onboardingOpen && <OnboardingWizard api={window.mixdogDesktop} onDone={() => setOnboardingOpen(false)} />}
      </Suspense>
      {updateDialogOpen && updaterState.status === "ready" && <DesktopUpdateDialog
        version={updaterState.version}
        onCancel={closeDesktopUpdate}
        onConfirm={installDesktopUpdate}
      />}
      <DesktopToastRegion
        bridgeError={error || (!connected ? 'Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop.' : '')}
        toasts={Array.isArray(snapshot.toasts) ? snapshot.toasts : []}
        onDismissBridgeError={() => setError('')}
      />
      <TooltipLayer />
    </div>
    </DesktopBootGate>
  );
}

export { ApprovalCard } from "./ApprovalCard";
export { DesktopUpdateDialog } from "./notifications";
export { ContextUsageIndicator, LiveWorkStatus, TranscriptRow } from "./TranscriptView";
