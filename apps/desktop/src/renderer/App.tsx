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
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import type {
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
  paneActiveSelection,
  paneLeavesInVisualOrder,
  paneSessionTabIds,
} from "./pane-layout";
import { usePaneWorkspace } from "./pane-workspace-state";
import { PaneWorkspace } from "./PaneWorkspace";
import {
  remoteNewTaskMode,
  setRemoteNewTaskMode,
  subscribeRemoteNewTaskMode,
} from "./remote-preferences";
import {
  defaultSessionLaneStore,
  useSessionLane,
  usePinnedRemoteSession,
} from "./session-lane-store";
import {
  type SettingsSection as SlashSettingsSection
} from "./slash-commands";
import { TooltipLayer } from "./TooltipLayer";
import {
  UnsavedChangesDialog,
  WorkbenchQuickAccess,
  type WorkbenchQuickAccessMode,
} from "./WorkbenchOverlays";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";

import { ActivityRail, type ActivityRailWorkbenchSurface } from "./ActivityRail";
import {
  markBootStage,
} from "./boot-metrics";
import { BottomPanel } from "./BottomPanel";
import { agentActivitySessionIds, EMPTY_SNAPSHOT, type RecordValue, type Snapshot } from "./desktop-types";
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
  desktopUtilityDockTabEnabled,
} from "./desktop-feature-config";
import { primeEditorFileLoad } from "./editor-file-loader";
import {
  getEditorCommandCapabilities,
  subscribeEditorLanguageStore,
} from "./editor-language-store";
import {
  prefetchDiffView,
  prefetchEditorPane,
  prefetchFolderPane,
  prefetchTerminalPane,
} from "./lazy-widgets";
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
import { asRecord, displayProject, navigationKey, newDraftSelection, newFolderSelection, newStudioSelection, newTerminalSelection } from "./text-format";
import { isMarkdownBodyReady, preloadMarkdownBody } from "./TranscriptView";
import { useEditorNavigation } from "./use-editor-navigation";
import {
  usePaneTabClose,
  type ConversationHandoff,
} from "./use-pane-tab-close";
import { usePaneTabNavigation } from "./use-pane-tab-navigation";
import { useAppWorkspaceNavigation } from "./use-app-workspace-navigation";
import { useAppPaneChrome } from "./use-app-pane-chrome";
import { useAppStartupRestore } from "./use-app-startup-restore";
import {
  AppConversationPaneSurface,
} from "./app-conversation-pane-surfaces";
import {
  isWorkbenchPanelId,
  WORKBENCH_PANEL_REGISTRY,
  type WorkbenchPanelId,
} from "./workbench-panel-registry";
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
import {
  loadSidebarPanelModule,
  ReadyTerminalPane,
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
const CommandSurface = lazy(() => import("./CommandSurface")
  .then((module) => ({ default: module.CommandSurface })));
// Startup chunk warm-up (markdown now, diff on idle) lives in
// app-idle-warmup.ts; importing it arms the schedule.
import { schedulePostInteractionIdle } from "./app-idle-warmup";

import {
  DraftConversation,
  PaneHeaderStatus,
  selectDesktopSnapshot,
  SnapshotUtilityDock,
  requestSessionRead,
  useDesktopSnapshotSelector,
} from "./app-snapshot-views";

import { useDesktopState } from "./app-desktop-state";
import { createProjectActions } from "./app-project-actions";
import { useSessionCatalog } from "./app-session-catalog";
import { useAppShellPanels } from "./use-app-shell-panels";
import {
  draftModelSelectionFromSnapshot,
  useDraftPanePreferences,
  type DraftPanePrefs,
} from "./use-draft-pane-preferences";
import { useAppSubmitRouting } from "./use-app-submit-routing";
import { useAppSidebarSurface } from "./use-app-sidebar-surface";
import { buildAppWorkbenchCommands } from "./app-workbench-commands";
import { useAppPersistentPaneSurfaces } from "./use-app-persistent-pane-surfaces";
import { useStableEvent } from "./use-stable-event";
import { useUnreadSessions } from "./app-unread-sessions";
import { DesktopLoadingSurface } from "./RendererRecovery";
import { useWorkbenchWorkspace } from "./workbench-workspace";

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
  const sidebarRemoteSessionId = usePinnedRemoteSession(defaultSessionLaneStore);
  const {
    applyDockOpen,
    applySidebarOpen,
    bottomPanel,
    bottomSheetBand,
    closeActiveRailPanel,
    closeSidebarPanels,
    commandSurface,
    commandSurfaceLane,
    dismissSheetsForBottomPanel,
    dockOpen,
    dockOpenIntent,
    dockSettled,
    dockTab,
    dockWidth,
    failedSidebarPanels,
    loadedSidebarPanels,
    mainPanelRef,
    markSidebarPanelFailed,
    mountSidebarPanel,
    mountedSidebarPanels,
    openConversationCommandSurface,
    openDockTab,
    openProjects,
    openSchedules,
    openSidebar,
    openUtilities,
    openWebhooks,
    openWorkflows,
    problemsCollapseNonce,
    problemsFilter,
    projectsOpen,
    resizeDock,
    retrySidebarPanel,
    schedulesOpen,
    setCommandSurface,
    setCommandSurfaceSessionId,
    setDockTab,
    setProblemsCollapseNonce,
    setProblemsFilter,
    setSettingsOpen,
    setSettingsSection,
    settingsOpen,
    settingsSection,
    sidebarMotion,
    sidebarOpen,
    sidebarOpenIntent,
    sidebarPanes,
    toggleBottomPanel,
    toggleDock,
    toggleSidebar,
    trackSidebarPanelModule,
    utilitiesOpen,
    wasBottomSheetBand,
    webhooksOpen,
    workflowsOpen,
  } = useAppShellPanels();
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingReady, setOnboardingReady] = useState(false);
  const [updaterState, setUpdaterState] = useState<DesktopUpdaterState>({ status: "disabled" });
  const [updaterStateReady, setUpdaterStateReady] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  useEffect(() => {
    if (updaterState.status !== "ready") setUpdateDialogOpen(false);
  }, [updaterState.status]);
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [projectCatalogReady, setProjectCatalogReady] = useState(false);
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
    if (!projectCatalogReady) return candidates[0] || "";
    for (const candidate of candidates) {
      const registered = registeredProjectPath(candidate);
      if (registered) return registered;
    }
    return "";
  }, [
    projectCatalogReady,
    projects,
    registeredProjectPath,
    snapshot.currentProject,
    snapshot.recentProjects,
  ]);
  const effectiveDraftProjectPath = useCallback((candidate: unknown): string => {
    const requested = String(candidate || "").trim();
    if (!requested || !projectCatalogReady) return requested;
    return registeredProjectPath(requested) || preferredDraftProjectPath;
  }, [preferredDraftProjectPath, projectCatalogReady, registeredProjectPath]);
  // Persisted panes restore synchronously. Session addresses are reconciled
  // incrementally after first paint and remain guarded by exact daemon reads.
  const paneWorkspace = usePaneWorkspace();
  const startupFocusedPaneSelection = paneWorkspace.focusedLeaf
    ? paneActiveSelection(paneWorkspace.focusedLeaf)
    : null;
  const startupNavigationSelection = paneWorkspace.restoredFromStorage
    && startupFocusedPaneSelection
    && startupFocusedPaneSelection.kind !== "studio"
    && startupFocusedPaneSelection.kind !== "terminal"
    && startupFocusedPaneSelection.kind !== "folder"
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
  const newTaskRemoteMode = useSyncExternalStore(
    subscribeRemoteNewTaskMode,
    remoteNewTaskMode,
    () => "off",
  );
  const setNewTaskRemoteEnabled = useCallback((enabled: boolean): void => {
    setRemoteNewTaskMode(enabled ? "on" : "off");
  }, []);
  // /clear · /new replacing a remote-holding session arms exactly ONE skip of
  // the draft remote-off reset below so the seat carries into the replacement
  // task (user rule: 전 세션 리모트 설정 승계).
  const inheritDraftRemoteOnce = useRef(false);
  useEffect(() => {
    // One-shot remote never carries between drafts (user decision): entering a
    // NEW TASK always starts remote-off, so an unconsumed toggle from an
    // abandoned draft — or a stale persisted value from a previous run — can
    // never leak into the next task.
    if (selection.kind !== "new") return;
    if (inheritDraftRemoteOnce.current) {
      inheritDraftRemoteOnce.current = false;
      return;
    }
    setRemoteNewTaskMode("off");
  }, [selection]);
  // The registry starts empty; the first task creates the initial tab.
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  // Folder panes report the folder they are VIEWING so their tab title
  // follows navigation (Explorer window-title grammar). Keyed by tab key.
  const [folderPaneTitles, setFolderPaneTitles] = useState<ReadonlyMap<string, string>>(new Map());
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
      bottomPanel.setTab("problems");
    };
    window.addEventListener("mixdog:show-problems", showProblems);
    return () => window.removeEventListener("mixdog:show-problems", showProblems);
  }, [bottomPanel.setTab]);
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
    projectCatalogReady,
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
  // Studio's module chunk is heavy; entering a Studio tab cold paid the whole
  // import at click time (user: 스튜디오 로딩이 너무 오래 걸린다). Prefetch it
  // once the shell has settled and the main thread is idle.
  useEffect(() => {
    if (!startupSettled) return undefined;
    const run = () => { void loadStudioViewModule().catch(() => {}); };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: 5_000 });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(run, 1_500);
    return () => window.clearTimeout(timer);
  }, [startupSettled]);
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
    if (!desktopFeatureEnabled("settings")) return undefined;
    // Stage 1 warms the settings chunk on idle. Stage 2 (separate idle slot,
    // 1.5s quiet window): hydrate the
    // capability/git/connection caches after the chunk exists, so the first
    // settings open paints from cache instead of holding the dialog behind
    // the hydrate spinner (user: 옵션이 스피너만 보이고 늦게 뜬다). An
    // earlier always-on hydrate collided with the first typing interactions;
    // the quiet window plus interaction-postponed idle keeps the sweep out
    // of the user's way, and open-time refresh still replaces stale values
    // without a spinner.
    const host = window.mixdogDesktop;
    if (!host) return schedulePostInteractionIdle(warmSettingsView);
    let cancelData: (() => void) | undefined;
    const cancelCode = schedulePostInteractionIdle(() => {
      void loadSettingsViewModule().then((module) => {
        cancelData = schedulePostInteractionIdle(
          () => { void module.preloadSettings(host).catch(() => {}); },
          5_000, 1_500, 1_500,
        );
      }).catch(() => {});
    });
    return () => { cancelCode(); cancelData?.(); };
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
      // "panes are not individual". Viewing one session twice is still
      // possible by drag-splitting its tab (move) plus reopening it.
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
      document.querySelector<HTMLButtonElement>(".toolbar-sidebar")?.focus();
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
  const remoteRequestEpoch = useRef(0);
  const setRemoteEnabled = useCallback(async (
    sessionId: string,
    enabled: boolean,
  ): Promise<void> => {
    if (!sessionId) return;
    const requestId = ++remoteRequestEpoch.current;
    const result = await invokeResult(() => window.mixdogDesktop.invokeCapability({
      capability: enabled ? "claimRemote" : "releaseRemote",
      args: [],
      sessionId,
    }));
    if (requestId !== remoteRequestEpoch.current) return;
    if (result?.snapshot !== undefined) {
      applySessionLaneResult(sessionId, result.snapshot);
      return;
    }
    void requestSessionRead(sessionId);
  }, [invokeResult]);
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
    document.addEventListener("visibilitychange", onEngage);
    return () => {
      window.removeEventListener("focus", onEngage);
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
        if (tab.selection.kind !== "session") return tab;
        const title = catalogTitles.get(tab.selection.id);
        if (!title || title === tab.title) return tab;
        changed = true;
        return { ...tab, title };
      });
      return changed ? next : current;
    });
  }, [sessions]);
  const refreshProjects = useCallback(async () => {
    const host = window.mixdogDesktop;
    const listProjects = (host as {
      listProjects?: () => Promise<DesktopProjectSummary[]>;
    } | undefined)?.listProjects;
    if (!listProjects) return [];
    const next = await listProjects();
    setProjects(Array.isArray(next) ? next : []);
    return next;
  }, []);
  useEffect(() => {
    let live = true;
    // React commits child pane effects before this parent effect, so visible
    // file/session/Studio reads enter the worker queue first. The lightweight
    // catalog may then reconcile without adding another frame of sidebar lag.
    void invoke(async () => {
      try {
        await refreshSessions();
      } finally {
        if (live) setSessionCatalogReady(true);
      }
    });
    void invoke(refreshProjects).finally(() => {
      if (live) setProjectCatalogReady(true);
    });
    return () => { live = false; };
  }, [invoke, refreshProjects, refreshSessions]);
  useAppStartupRestore({
    restorePending: paneWorkspace.restorePending,
    restoredFromStorage: paneWorkspace.restoredFromStorage,
    startupFocusedPaneSelection,
    startupNavigationSelection,
    projectCatalogReady,
    snapshot,
    snapshotReady: snapshot !== EMPTY_SNAPSHOT,
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

  const closeSidebarForNavigation = () => {
    if (window.innerWidth <= 760) {
      applySidebarOpen(false);
      applyDockOpen(false);
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
  const renameSession = useCallback(async (sessionId: string, rawTitle: string) => {
    const title = rawTitle.trim();
    if (!title) return;
    const previousSession = sessions.find((session) => session.id === sessionId);
    if (!previousSession || sessionSummaryTitle(previousSession) === title) return;
    const tabKey = navigationKey({ kind: "session", id: sessionId });
    const previousTabTitle = tabs.find((tab) => tab.key === tabKey)?.title;
    const pending = { title };
    pendingSessionRenames.current.set(sessionId, pending);
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, title }
      : session));
    setTabs((current) => current.map((tab) => tab.key === tabKey ? { ...tab, title } : tab));
    setError("");
    try {
      await window.mixdogDesktop.renameSession(sessionId, title);
    } catch (reason) {
      if (pendingSessionRenames.current.get(sessionId) !== pending) return;
      pendingSessionRenames.current.delete(sessionId);
      invalidateSessionListings();
      setSessions((current) => current.map((session) =>
        session.id === sessionId && session.title === title ? previousSession : session));
      if (previousTabTitle !== undefined) {
        setTabs((current) => current.map((tab) =>
          tab.key === tabKey && tab.title === title ? { ...tab, title: previousTabTitle } : tab));
      }
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    if (pendingSessionRenames.current.get(sessionId) === pending) {
      try {
        await refreshSessions();
      } catch {
        // The persisted optimistic title remains authoritative if reconciliation is unavailable.
      } finally {
        if (pendingSessionRenames.current.get(sessionId) === pending) {
          pendingSessionRenames.current.delete(sessionId);
        }
      }
    }
  }, [refreshSessions, sessions, setError, tabs]);
  // Archive: hide from Recent without touching the on-disk file.
  // Optimistic flip moves the row immediately; the sessions push reconciles.
  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    const previousSession = sessions.find((session) => session.id === sessionId);
    if (!previousSession || previousSession.archived === archived) return;
    const pending = { archived };
    pendingSessionArchives.current.set(sessionId, pending);
    invalidateSessionListings();
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, archived }
      : session));
    setError("");
    try {
      await window.mixdogDesktop.setSessionArchived?.(sessionId, archived);
    } catch (reason) {
      if (pendingSessionArchives.current.get(sessionId) !== pending) return;
      pendingSessionArchives.current.delete(sessionId);
      invalidateSessionListings();
      setSessions((current) => current.map((session) =>
        session.id === sessionId && session.archived === archived ? previousSession : session));
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
    if (pendingSessionArchives.current.get(sessionId) === pending) {
      pendingSessionArchives.current.delete(sessionId);
    }
  }, [invalidateSessionListings, pendingSessionArchives, sessions, setError, setSessions]);
  const deleteSession = useCallback(async (sessionId: string) => {
    const previousSession = sessions.find((session) => session.id === sessionId);
    if (!previousSession || pendingSessionDeletes.current.has(sessionId)) return;
    const deletingCurrent = selection.kind === "session" && selection.id === sessionId;
    pendingSessionDeletes.current.add(sessionId);
    setError("");
    let next: SessionSnapshot;
    try {
      next = await window.mixdogDesktop.deleteSession(sessionId);
    } catch (reason) {
      pendingSessionDeletes.current.delete(sessionId);
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
    invalidateSessionListings();
    pendingSessionRenames.current.delete(sessionId);
    applySnapshot(next);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setTabs((current) => current.filter((tab) =>
      !(tab.selection.kind === "session" && tab.selection.id === sessionId)));
    if (deletingCurrent) {
      navigationEpoch.current += 1;
      activateSelection({ kind: "new" }, "New task");
      setRequestedSessionId("");
    }
    try {
      await refreshSessions();
    } catch {
      // The successful deletion remains authoritative if reconciliation is unavailable.
    } finally {
      pendingSessionDeletes.current.delete(sessionId);
    }
  }, [activateSelection, applySnapshot, clearNewTaskPreferences, refreshSessions, selection, sessions, setError]);
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
    const cached = lastNewTaskPrefs.current;
    resetNewTaskDraft(cached
      ? effectiveDraftProjectPath(cached.projectPath)
      : preferredDraftProjectPath);
  };
  const openSession = async (
    sessionId: string,
    _force = false,
    fallbackTitle = "",
  ): Promise<void> => {
    navigationEpoch.current += 1;
    closeSidebarForNavigation();
    setRequestedSessionId("");
    if (!defaultSessionLaneStore.get(sessionId)) requestSessionRead(sessionId);
    const session = sessions.find((item) => item.id === sessionId);
    finishPendingConversationHandoff();
    activateSelection(
      {
        kind: "session",
        id: sessionId,
        ...(!session && fallbackTitle.trim() ? { title: fallbackTitle.trim() } : {}),
      },
      session ? sessionSummaryTitle(session) : fallbackTitle.trim() || "Untitled session",
    );
  };
  openSessionRef.current = openSession;
  const prefetchSession = useCallback((sessionId: string) => (
    window.mixdogDesktop?.prefetchSession?.(sessionId) ?? Promise.resolve(false)
  ), []);
  const openSettings = useCallback((section: SlashSettingsSection | null = null) => {
    // Workflow and search-model settings graduated to the main-pane Workflows
    // page (user decision): /workflow, /search, and legacy links land there.
    if (section === "workflow" || section === "search") {
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
  }, [openWorkflows, warmSettingsView]);
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
    // Remote seat: when the cleared session holds it, the replacement draft
    // starts remote-on so its first submit takes the seat over.
    const holdsRemote = source?.remoteEnabled === true
      && String(source.remoteSessionId || "") === sessionId;
    inheritDraftRemoteOnce.current = holdsRemote;
    setRemoteNewTaskMode(holdsRemote ? "on" : "off");
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
    void refreshProjects();
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
  const unreadViewedSessionId = requestedSessionId || viewedSessionId;
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
    utilitySelection: Extract<WorkspaceSelection, { kind: "studio" | "terminal" | "folder" }>,
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
    // New Terminal ALWAYS creates a terminal tab (user: 생성 안 되고 아래창이
    // 열리는 버그). The old coding-surface redirect made the result depend on
    // whichever tab happened to be focused; the bottom-panel terminal keeps
    // its own explicit path (Ctrl+` / openTerminalPanel).
    openUtilityTab(newTerminalSelection(activeProjectPath), "Terminal", leafId);
  };
  // Open Folder pane (Windows-Explorer-style): opens INSTANTLY at the user's
  // home folder — no OS dialog (the parented picker proved unable to present
  // reliably on Windows); navigation happens inside the pane itself.
  const openFolderTab = (leafId = paneWorkspace.focusedLeafId) => {
    void prefetchFolderPane().catch(() => {});
    void Promise.resolve(window.mixdogDesktop?.folderPlaces?.() ?? [])
      .then((places) => {
        const home = places.find((place) => place.kind === "home")?.path
          || activeProjectPath;
        if (!home) return;
        openUtilityTab(
          newFolderSelection(home),
          displayProject(home).name || "Files",
          leafId,
        );
      })
      .catch(() => {});
  };
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
      if (entry.dir) {
        openUtilityTab(
          newFolderSelection(entry.absolutePath),
          displayProject(entry.absolutePath).name || "Files",
          leafId,
        );
      } else if (entry.projectPath && entry.relPath) {
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
    folderPaneTitles,
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
    lastSessionStorageKey: LAST_SESSION_KEY,
  });
  // Ctrl+Left/Right crosses pane boundaries in visual row-major order:
  // a 2x2 layout walks top-left, top-right, bottom-left, bottom-right.
  const focusSiblingPane = (offset: number) => {
    const leaves = paneLeavesInVisualOrder(paneWorkspace.layout);
    if (leaves.length < 2) return;
    const index = leaves.findIndex((leaf) => leaf.id === paneWorkspace.focusedLeafId);
    if (index < 0) return;
    const next = leaves[(index + offset + leaves.length) % leaves.length];
    if (!next) return;
    paneWorkspace.focusLeaf(next.id);
    // Mirror the pane-click path: route the engine surface AND land the
    // caret in that pane's typing area.
    const nextActive = paneActiveSelection(next);
    if (nextActive) activatePaneSurface(nextActive);
    focusPaneTypingSurface(next.id, nextActive);
  };
  const {
    focusedLeafForShortcuts,
    focusedLeafTabs,
    tabSwitcher,
    toggleTerminalPanel,
  } = useAppWorkspaceNavigation({
    paneWorkspace,
    requestedSessionId,
    focusedPaneSelection,
    activeTabKey,
    navigateTab,
    focusPaneTypingSurface,
    focusSiblingPane,
    bottomPanel,
    dismissSheetsForBottomPanel,
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
    toggleTerminalPanel,
    editorCommandCapabilities,
    toggleSidebar,
    toggleDock,
    openTerminalTab,
    openFolderTab,
    startTask,
    openStudioTab,
    openSettings,
  });

  // Rail destinations (Projects/Workflows/Schedules/Webhooks) swap the
  // session panel instead of owning the main pane (user decision): the
  // workspace, tab strips, and utility dock stay mounted and interactive
  // while their editors float as popup dialogs.
  const {
    presentedSidebarPanel,
    sidebarNewTask,
    sidebarPanel,
    sidebarPanelChildren,
    sidebarPanelTitle,
    sidebarResumeSession,
    sidebarTreeMounted,
  } = useAppSidebarSurface({
    utilitiesOpen,
    schedulesOpen,
    webhooksOpen,
    projectsOpen,
    workflowsOpen,
    sidebarOpen,
    loadedSidebarPanels,
    failedSidebarPanels,
    mountedSidebarPanels,
    sidebarPanes,
    markSidebarPanelFailed,
    retrySidebarPanel,
    runningAutomationNames,
    projects,
    selectedProjectPath,
    closeSidebarForNavigation,
    startTask,
    openSession,
    openStudioTab,
    openTerminalTab,
    openFolderTab,
    refreshProjects,
    renameProject,
    removeProject,
  });
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
    const paneTitle = paneSessionId
      ? sessionRow
        ? sessionSummaryTitle(sessionRow)
        : presentedSelection.kind === "session" && presentedSelection.title
          ? presentedSelection.title
          : "Untitled session"
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
      headerStatus={<PaneHeaderStatus sessionId={paneSessionId}
        hidden={false}
        draftRemoteEnabled={focused && draftKey ? newTaskRemoteMode === "on" : undefined}
        onOpen={() => {
          setCommandSurfaceSessionId(paneSessionId);
          setCommandSurface("context");
        }}
        onOpenAgents={desktopFeatureEnabled("agents")
          ? () => openDockTab("agents")
          : undefined}
        onRemoteChange={draftKey
          ? setNewTaskRemoteEnabled
          : (enabled) => setRemoteEnabled(paneSessionId, enabled)} />}
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
        draftModelSelection: draftKey ? prefs.modelSelection : undefined,
        draftWorkflow: draftKey ? prefs.workflow : undefined,
        onDraftModelSelection: focusedDraft ? stageNewTaskModelSelection : undefined,
        onRoutePreferenceApplied: rememberSessionRouteForNextTask,
        onDraftWorkflow: focusedDraft ? stageNewTaskWorkflow : undefined,
        activeProjectPath: paneProjectPath,
        activeProjectLabel: paneProjectLabel,
        onSelectProject: conversationSelectProject,
        onOpenCommandSurface: (surface) => {
          setCommandSurfaceSessionId(surface === "context" ? paneSessionId : "");
          openConversationCommandSurface(surface);
        },
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
    openDroppedPaths,
    setFolderPaneTitles,
    sidebarOpen,
    toggleSidebar,
  });
  const activeBottomPanelTab: WorkbenchPanelId = isWorkbenchPanelId(bottomPanel.tab)
    ? bottomPanel.tab
    : "problems";
  const desktopBootReady = snapshotHydrated
    && projectCatalogReady
    && onboardingReady
    && updaterStateReady
    && startupSettled;
  // PANE tabs are part of the visible workspace: a session tab that is
  // already open must not cold-load on its first click (user: PANE에 이미
  // 올라간 게 왜 콜드냐). Once boot settles, idle-prewarm each open tab's
  // lane. requestSessionRead dedupes (laned/in-flight sessions no-op) and
  // the lane store's byte budget still owns retention, so this only fronts
  // the disk read that the first click would otherwise pay behind a cover.
  useEffect(() => {
    if (!desktopBootReady) return undefined;
    const sessionIds = paneSessionTabIds(
      paneWorkspace.leaves,
      paneWorkspace.focusedLeafId,
    );
    if (sessionIds.length === 0) return undefined;
    const host = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let cancelled = false;
    let stepTimer = 0;
    const queue = sessionIds;
    const step = () => {
      stepTimer = 0;
      if (cancelled) return;
      const next = queue.shift();
      if (!next) return;
      requestSessionRead(next);
      // Spread the reads so they never compete with a live interaction.
      stepTimer = window.setTimeout(step, 250);
    };
    const idle = host.requestIdleCallback?.(step, { timeout: 3_000 });
    if (idle === undefined) stepTimer = window.setTimeout(step, 1_000);
    return () => {
      cancelled = true;
      if (idle !== undefined) host.cancelIdleCallback?.(idle);
      window.clearTimeout(stepTimer);
    };
  }, [desktopBootReady, paneWorkspace.focusedLeafId, paneWorkspace.leaves]);
  useEffect(() => {
    if (!desktopBootReady) return undefined;
    let timer = 0;
    let browserFallbackTimer = 0;
    const warmPanels = () => {
      window.removeEventListener("mixdog:window-shown", warmPanels);
      window.clearTimeout(browserFallbackTimer);
      // Keep boot and the hidden first frame clear, then resolve and
      // HIDDEN-mount every rail pane. useSidebarReferences coalesces their
      // shared hydration, so rows, route controls and overflow options are
      // ready before first click.
      timer = window.setTimeout(() => {
      const warmPanel = (panel: SidebarPanelKey) => {
        if (!desktopSidebarDestinationEnabled(panel)) return Promise.resolve();
        const module = loadSidebarPanelModule[panel]();
        trackSidebarPanelModule(panel, module);
        void module.then(() => mountSidebarPanel(panel)).catch(() => {});
        return module;
      };
      void Promise.all([
        warmPanel("utilities"),
        warmPanel("schedules"),
        warmPanel("webhooks"),
        warmPanel("projects"),
        warmPanel("workflows"),
      ]).catch(() => {});
      }, 120);
    };
    const host = window as typeof window & { __mixdogWindowShown?: boolean };
    if (host.__mixdogWindowShown) warmPanels();
    else {
      window.addEventListener("mixdog:window-shown", warmPanels, { once: true });
      // Browser/LAN clients have no Electron main process to emit this event.
      browserFallbackTimer = window.setTimeout(warmPanels, 1_200);
    }
    return () => {
      window.removeEventListener("mixdog:window-shown", warmPanels);
      window.clearTimeout(browserFallbackTimer);
      window.clearTimeout(timer);
    };
  }, [desktopBootReady, mountSidebarPanel, trackSidebarPanelModule]);
  return (
    <DesktopBootGate
      enabled={Boolean(window.mixdogDesktop?.bootContext?.bootId)}
      ready={desktopBootReady}>
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}
      style={{
        "--desktop-workspace-min-width": `${DESKTOP_WORKSPACE_MIN_WIDTH}px`,
      } as React.CSSProperties}>
      <DesktopTitlebar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        panelOpen={bottomPanel.open}
        onTogglePanel={toggleBottomPanel}
        dockOpen={dockOpen}
        onToggleDock={toggleDock}
        dockLabel="utility panel"
        updaterState={updaterState}
        onOpenUpdate={openDesktopUpdate} />
      <div className="desktop-body">
        <div className="sidebar-drawer-frame"
          data-state={sidebarOpen ? "open" : "closed"}
          data-motion={sidebarMotion}>
          <ActivityRail
          sidebarOpen={sidebarOpen && !sidebarPanel}
          activeWorkbenchSurface={dockOpen
            && (["search", "source-control"] as string[]).includes(dockTab)
            ? dockTab as ActivityRailWorkbenchSurface
            : null}
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
          onOpenUtilities={openUtilities}
          onPrefetchUtilities={() => {
            trackSidebarPanelModule("utilities", loadSidebarPanelModule.utilities());
          }}
          onOpenProjects={() => {
            openProjects();
            void refreshProjects();
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
          onOpenWorkbench={(surface) => {
            closeSidebarPanels();
            if (sidebarOpenIntent.current) applySidebarOpen(false);
            if (dockOpenIntent.current && dockTab === surface) applyDockOpen(false);
            else openDockTab(surface);
          }}
          onOpenSettings={() => { closeSidebarForNavigation(); openSettings(); }}
          onPrefetchSettings={warmSettingsView} />
        {/* Mounted for the app's lifetime once opened: a collapse hides the
            tree (inert, aria-hidden, zero width) instead of destroying the
            visited destinations' DOM and state. Every expensive effect inside
            already gates on `open`. */}
        {sidebarTreeMounted && <SessionSidebar
          open={sidebarOpen}
          panelActive={Boolean(presentedSidebarPanel)}
          panelTitle={sidebarPanelTitle}
          sessions={sessions}
          sessionsReady={sessionCatalogReady}
          workingSessionIds={workingSessionIds}
          unreadSessionIds={unreadSessionIds}
          remoteSessionId={sidebarRemoteSessionId}
          selection={sidebarSelection}
          onNewTask={sidebarNewTask}
          onPrefetchSession={window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined}
          onResumeSession={sidebarResumeSession}
          onRenameSession={renameSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSession}
        >
          {sidebarPanelChildren}
        </SessionSidebar>}
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
                  onFocusSelection={activatePaneSurface}
                  onOpenDroppedPaths={openDroppedPaths}
                  // Defensive fallback for malformed external state; normal
                  // startup and close paths always retain a New Task pane.
                  renderActive={(leaf) => leaf.tabs.length === 0
                    ? <WorkspaceEmptyState />
                    : workspaceSurface}
                />;
          })()}
          <BottomPanel
            open={bottomPanel.open}
            height={bottomPanel.height}
            motion={wasBottomSheetBand.current !== bottomSheetBand
              ? "instant"
              : bottomPanel.motion}
            onHeightChange={bottomPanel.setHeight}
            tabs={WORKBENCH_PANEL_REGISTRY.map((panel) => ({
              id: panel.id,
              label: panel.label,
              ...(panel.id === "problems"
                ? { badge: <ProjectProblemCount projectPath={quickAccessProjectPath} /> }
                : {}),
            }))}
            activeTab={activeBottomPanelTab}
            onSelectTab={bottomPanel.setTab}
            onClose={() => bottomPanel.setOpen(false)}
            headerActions={activeBottomPanelTab === "problems"
              ? <WorkbenchProblemsFilter
                  filter={problemsFilter}
                  onFilter={setProblemsFilter} />
              : undefined}
            actions={activeBottomPanelTab === "problems"
              ? <WorkbenchProblemsSeverityActions
                  projectPath={quickAccessProjectPath}
                  filter={problemsFilter}
                  onFilter={setProblemsFilter}
                  onCollapseAll={() => setProblemsCollapseNonce((value) => value + 1)} />
              : undefined}>
            {bottomPanel.open && activeBottomPanelTab === "problems" &&
              <div className="workbench-panel-surface utility-dock-pane stable-surface-layer"
                data-tab="problems"
                data-surface-active="true">
                  <WorkbenchProblemsPane projectPath={quickAccessProjectPath}
                    active
                    activeFileRel={focusedPaneSelection?.kind === "file"
                      ? focusedPaneSelection.rel : ""}
                    filter={problemsFilter}
                    collapseNonce={problemsCollapseNonce}
                    onOpenFile={openFileTab}
                    onQuickFix={openProblemQuickFix} />
                </div>}
            {bottomPanel.open && activeBottomPanelTab === "terminal" &&
              <div className="workbench-panel-surface workbench-terminal-panel stable-surface-layer"
                data-tab="terminal"
                data-surface-active="true">
                  <ReadyTerminalPane cwd={quickAccessProjectPath || null}
                    active />
                </div>}
          </BottomPanel>
        </main>
        {/* Phone: the dock floats over the thread, so give it the same
            outside-tap dismiss scrim as the left drawer (CSS shows it only
            on narrow viewports). */}
        <button className="dock-backdrop"
          data-state={dockOpen ? "open" : "closed"}
          aria-hidden={!dockOpen}
          tabIndex={dockOpen ? 0 : -1}
          onClick={() => applyDockOpen(false)} aria-label="Close utility panel" />
        {/* Bottom sheet band keeps outside-tap dismissal without dimming the
            work surface, matching both side sheets. */}
        <button className="panel-backdrop"
          data-state={bottomPanel.open ? "open" : "closed"}
          aria-hidden={!bottomPanel.open}
          tabIndex={bottomPanel.open ? 0 : -1}
          onClick={() => bottomPanel.setOpen(false)} aria-label="Close panel" />
    {dockOpen && <SnapshotUtilityDock snapshotStore={snapshotStore}
          hidden={false}
      open={dockOpen} width={dockWidth} tab={dockTab}
          sessions={sessions}
          activeSessionIds={observedAgentSessionIds}
          unreadSessionIds={unreadSessionIds}
          projectPath={quickAccessProjectPath}
          workspaceFolders={workbenchWorkspace.workspace.folders as DesktopWorkspaceFolder[]}
          onSelectProject={selectToolProject}
          metricSurface="dock"
          entering={dockSettled || wasBottomSheetBand.current !== bottomSheetBand} contentReady
          onTab={(tab) => {
            if (desktopUtilityDockTabEnabled(tab)) setDockTab(tab);
          }} onResize={resizeDock}
          onClose={toggleDock}
          onOpenFile={dockOpenFile}
          onOpenFileAt={dockOpenFileAt}
          onOpenDiff={dockOpenDiff}
          onOpenPullRequest={dockOpenPullRequest}
          onOpenLeadSession={dockOpenLeadSession}
          onOpenAgentSession={dockOpenAgentSession}
        />}
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
      <Suspense fallback={(settingsOpen || commandSurface || onboardingOpen)
        ? <DesktopLoadingSurface label="Loading view…" overlay />
        : null}>
        {settingsOpen && <SettingsView
          open
          initialSection={settingsSection}
          onCompose={(text) => {
            setSettingsOpen(false);
            window.dispatchEvent(new CustomEvent('mixdog:composer-draft', { detail: text }));
          }}
          onClose={() => setSettingsOpen(false)} />}
        {commandSurface && <CommandSurface surface={commandSurface}
          snapshot={commandSurface === "context"
            ? commandSurfaceLane ?? EMPTY_SNAPSHOT
            : snapshot}
          onClose={() => {
            setCommandSurface(null);
            setCommandSurfaceSessionId("");
          }} />}
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
