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
  DesktopModelSelection,
  DesktopProjectSummary,
  DesktopPromptContent,
  DesktopSubmitOptions,
  DesktopUpdaterState,
  DesktopWorkflowState,
  DesktopWorkspaceFolder,
  SessionSnapshot
} from "../shared/contract";
import {
  promptTitle,
  sessionSummaryTitle
} from "../shared/session-title.mjs";
import { DESKTOP_WORKSPACE_MIN_WIDTH } from "../shared/window-layout";
import {
  applyDesktopThemePreference,
  getDesktopThemePreference
} from "./desktop-theme";
import { nextWorkspaceTabAfterClose } from "./nav-types";
import {
  DesktopTitlebar,
  SessionSidebar,
  WorkspaceTabStrip,
  type NavigationSelection,
  type WorkspaceSelection,
  type WorkspaceTab,
} from "./navigation";
import {
  canSplitPaneSize,
  paneActiveSelection,
  paneLeavesInColumnOrder,
  paneLeavesInVisualOrder,
  type PaneLeaf,
} from "./pane-layout";
import { usePaneWorkspace } from "./pane-workspace-state";
import { PaneWorkspace } from "./PaneWorkspace";
import {
  remoteNewTaskMode,
  setRemoteNewTaskMode,
  subscribeRemoteNewTaskMode,
} from "./remote-preferences";
import {
  startupRestorePlan
} from "./renderer-logic.mjs";
import {
  applyFocusedSnapshotToSessionLane,
  defaultSessionLaneStore,
  useSessionLane,
} from "./session-lane-store";
import {
  getSidePanelMode,
  sidePanelLayout,
  subscribeSidePanelMode,
  type SidePanelMode
} from "./side-panel-preferences";
import {
  type CommandSurface as CommandSurfaceName,
  type SettingsSection
} from "./slash-commands";
import { TooltipLayer } from "./TooltipLayer";
import {
  UnsavedChangesDialog,
  WorkbenchQuickAccess,
  type WorkbenchCommand,
  type WorkbenchQuickAccessMode,
} from "./WorkbenchOverlays";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";

import { ActivityRail, type ActivityRailWorkbenchSurface } from "./ActivityRail";
import {
  beginBootSurface,
  markBootStage,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import { BottomPanel, useBottomPanelState } from "./BottomPanel";
import { EMPTY_SNAPSHOT, hasActiveSnapshotWork, workingSessionIdsForSnapshot, type RecordValue, type Snapshot } from "./desktop-types";
import {
  desktopFeatureEnabled,
  desktopSidebarDestinationEnabled,
  desktopUtilityDockTabEnabled,
  firstEnabledDesktopUtilityDockTab,
  hasDesktopUtilityDockFeature,
  resolveDesktopUtilityDockTab,
} from "./desktop-feature-config";
import { primeEditorFileLoad } from "./editor-file-loader";
import {
  getEditorCommandCapabilities,
  getEditorLanguageSnapshot,
  subscribeEditorLanguageStore,
  type EditorProblem,
} from "./editor-language-store";
import { GitDiffPane } from "./GitDiffPane";
import {
  disposeTerminalPane,
  EditorPane,
  FolderPane,
  prefetchDiffView,
  prefetchEditorPane,
  prefetchFolderPane,
  prefetchTerminalPane,
  TerminalPane
} from "./lazy-widgets";
import {
  DeferredPersistentSurface,
  DesktopBootGate,
  PaneSurfaceGate,
  PersistentPanePortal,
  scheduleStableSurfaceCommit,
} from "./PaneSurfaceGate";
import {
  PullRequestEditor,
  type PullRequestOpenHandler,
} from "./PullRequestsPane";
import { SidebarPanelBoundary } from "./sidebar-panel-surface";
import {
  beginStudioLoad,
  editorLoadKey,
  ensureEditorLoad,
  reportEditorLoadStage,
  reportStudioLoadStage,
} from "./renderer-load-metrics";
import type { SourceControlDiffRequest } from "./SourceControlDock";
import { loadStudioViewModule } from "./studio-loader";
import { shouldFocusComposerFromWindowKey, shouldFocusSurfaceInput } from "./surface-input-focus";
import { asRecord, displayProject, navigationKey, newDraftSelection, newFolderSelection, newStudioSelection, newTerminalSelection } from "./text-format";
import { isMarkdownBodyReady, preloadMarkdownBody } from "./TranscriptView";
import { clampDockWidth, DOCK_STATE_KEY, readDockState, type UtilityDockTab } from "./UtilityDock";
import {
  isWorkbenchPanelId,
  WORKBENCH_PANEL_REGISTRY,
  type WorkbenchPanelId,
} from "./workbench-panel-registry";
import {
  DEFAULT_PROBLEMS_PANEL_FILTER,
  ProjectProblemCount,
  WorkbenchProblemsFilter,
  WorkbenchProblemsPane,
  WorkbenchProblemsSeverityActions,
  type ProblemsPanelFilter,
} from "./WorkbenchProblems";

import {
  desktopChromeSnapshotsEqual,
  desktopSidebarSnapshotsEqual
} from "./desktop-snapshot-store";
import { DesktopToastRegion, DesktopUpdateDialog } from "./notifications";

const SIDEBAR_OPEN_KEY = 'mixdog.desktop-sidebar-open.v1';
const LAST_PROJECT_KEY = 'mixdog.desktop-last-project.v1';
const LAST_SESSION_KEY = 'mixdog.desktop-last-session.v1';
const DRAFT_PANE_PREFS_KEY = 'mixdog.desktop-draft-pane-prefs.v1';
const LAST_NEW_TASK_PREFS_KEY = 'mixdog.desktop-last-new-task-prefs.v1';
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
interface EditorNavigationLocation {
  project: string;
  rel: string;
  line: number;
  accessToken?: string;
}
interface PendingUnsavedClose {
  leafId: string;
  tab: WorkspaceTab;
}
function useStableEvent<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

function StableSessionTitle({
  title,
  editing,
  draft,
  invalid,
  onOpen,
  onDraftChange,
  onCommit,
  onCancel,
}: {
  title: string;
  editing: boolean;
  draft: string;
  invalid: boolean;
  onOpen(): void;
  onDraftChange(value: string): void;
  onCommit(fromBlur?: boolean): void;
  onCancel(): void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!editing) return;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [editing]);
  return <span className="session-title-mode" data-editing={editing ? "true" : "false"}>
    <button type="button" className="session-title-trigger"
      aria-hidden={editing ? true : undefined} tabIndex={editing ? -1 : undefined}
      onClick={onOpen} aria-label={`Rename ${title}`}>
      {title}
    </button>
    <input ref={inputRef} className="session-header-title-input"
      value={draft} maxLength={160} disabled={!editing}
      tabIndex={editing ? undefined : -1}
      aria-hidden={editing ? undefined : true}
      aria-label={`Rename ${title}`}
      aria-invalid={invalid || undefined}
      onInput={(event) => onDraftChange(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        if (editing) onCommit(true);
      }} />
  </span>;
}
export function shouldKeepFileEditorMounted(
  tabKey: string,
  activeFileKey: string,
  _dirtyFileKeys: ReadonlySet<string>,
  _hotFileKeys: ReadonlySet<string> = new Set(),
): boolean {
  return tabKey === activeFileKey;
}
const HOT_FILE_EDITOR_LIMIT = 4;
export function nextHotFileEditorKeys(
  current: readonly string[],
  active: readonly string[],
  limit = HOT_FILE_EDITOR_LIMIT,
): string[] {
  const seen = new Set<string>();
  return [...active, ...current]
    .filter((key) => {
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(0, limit));
}
const paneUtilitySurfaceSlotId = (leafId: string, key: string): string =>
  `pane-utility-surface:${leafId}:${key}`;
const loadSchedulesViewModule = () => import("./SchedulesView");
const loadWebhooksViewModule = () => import("./WebhooksView");
const loadProjectsViewModule = () => import("./ProjectsView");
const loadWorkflowsViewModule = () => import("./WorkflowsView");
const loadUtilitiesViewModule = () => import("./UtilitiesView");
type SidebarPanelKey = "utilities" | "schedules" | "webhooks" | "projects" | "workflows";
/** Bounded loader gate: when present it runs before the real chunk import, so
 *  a slow or rejected sidebar chunk can be exercised (tests/diagnostics)
 *  without stubbing the module system. Production never sets it. */
type SidebarPanelLoaderGate = (panel: SidebarPanelKey) => Promise<unknown>;
function gateSidebarPanelModule<T>(panel: SidebarPanelKey, load: () => Promise<T>): Promise<T> {
  const gate = (window as typeof window & {
    __mixdogSidebarPanelLoader?: SidebarPanelLoaderGate;
  }).__mixdogSidebarPanelLoader;
  return gate ? Promise.resolve(gate(panel)).then(load) : load();
}
const loadSidebarPanelModule = {
  utilities: () => gateSidebarPanelModule("utilities", loadUtilitiesViewModule),
  schedules: () => gateSidebarPanelModule("schedules", loadSchedulesViewModule),
  webhooks: () => gateSidebarPanelModule("webhooks", loadWebhooksViewModule),
  projects: () => gateSidebarPanelModule("projects", loadProjectsViewModule),
  workflows: () => gateSidebarPanelModule("workflows", loadWorkflowsViewModule),
} as const;
// React.lazy caches a REJECTED loader forever, so recovery needs a brand-new
// lazy component per attempt: each panel keeps its own factory instead of one
// module-level constant.
const createSchedulesPane = () => lazy(() => loadSidebarPanelModule.schedules()
  .then((module) => ({ default: module.SchedulesPane })));
const createUtilitiesPane = () => lazy(() => loadSidebarPanelModule.utilities()
  .then((module) => ({ default: module.UtilitiesPane })));
const createWebhooksPane = () => lazy(() => loadSidebarPanelModule.webhooks()
  .then((module) => ({ default: module.WebhooksPane })));
const createProjectsPane = () => lazy(() => loadSidebarPanelModule.projects()
  .then((module) => ({ default: module.ProjectsPane })));
const createWorkflowsPane = () => lazy(() => loadSidebarPanelModule.workflows()
  .then((module) => ({ default: module.WorkflowsPane })));
const StudioPane = lazy(() => loadStudioViewModule()
  .then((module) => ({ default: module.StudioPane })));

const EDITOR_COVER_MAX_MS = 900;
const EDITOR_STARTUP_DELAY_MS = 32;
const DIFF_STARTUP_DELAY_MS = 64;
const TERMINAL_STARTUP_DELAY_MS = 96;
function ReadyEditorPane(props: React.ComponentProps<typeof EditorPane>) {
  const metricKey = editorLoadKey(props.projectPath, props.relPath, props.accessToken);
  beginBootSurface("editor", metricKey);
  ensureEditorLoad(props.projectPath, props.relPath, props.accessToken);
  reportBootSurfaceStage("editor", metricKey, "boundary");
  const [readyKey, setReadyKey] = useState("");
  const [expiredKey, setExpiredKey] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setExpiredKey(metricKey), EDITOR_COVER_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [metricKey]);
  return <PaneSurfaceGate
    ready={readyKey === metricKey || expiredKey === metricKey}
    transitionKey={metricKey}
    label="Loading editor…">
    <Suspense fallback={<div className="editor-pane editor-pane-cold-shell" aria-hidden="true" />}>
      <EditorPane {...props} onReady={() => {
        setReadyKey(metricKey);
        reportBootSurfaceStage("editor", metricKey, "dom", "shell");
      }} />
    </Suspense>
  </PaneSurfaceGate>;
}

function ReadyStudioPane(props: React.ComponentProps<typeof StudioPane>) {
  const metricKey = "studio";
  beginBootSurface("studio", metricKey);
  reportBootSurfaceStage("studio", metricKey, "boundary");
  const [ready, setReady] = useState(false);
  return <PaneSurfaceGate ready={ready} transitionKey={metricKey} label="Preparing Studio…">
    <Suspense fallback={null}>
      <StudioPane {...props} onReady={() => {
        setReady(true);
        reportBootSurfaceStage("studio", metricKey, "dom", "shell");
      }} />
    </Suspense>
  </PaneSurfaceGate>;
}

function ReadyTerminalPane(props: React.ComponentProps<typeof TerminalPane>) {
  const metricKey = props.terminalId || "bottom-terminal";
  beginBootSurface("terminal", metricKey);
  reportBootSurfaceStage("terminal", metricKey, "boundary");
  const [readyKey, setReadyKey] = useState("");
  return <PaneSurfaceGate ready={readyKey === metricKey}
    transitionKey={metricKey} label="Loading terminal…">
    <Suspense fallback={null}>
      <TerminalPane {...props} onReady={() => {
        setReadyKey(metricKey);
        reportBootSurfaceReady("terminal", metricKey);
      }} />
    </Suspense>
  </PaneSurfaceGate>;
}

function ReadyGitDiffPane(props: React.ComponentProps<typeof GitDiffPane>) {
  const metricKey = navigationKey(props.selection);
  beginBootSurface("diff", metricKey);
  reportBootSurfaceStage("diff", metricKey, "boundary");
  const [readyKey, setReadyKey] = useState("");
  return <PaneSurfaceGate ready={readyKey === metricKey}
    transitionKey={metricKey} label="Loading diff…">
    <GitDiffPane {...props} onReady={() => {
      setReadyKey(metricKey);
      reportBootSurfaceStage("diff", metricKey, "dom", "shell");
    }} />
  </PaneSurfaceGate>;
}
const draftModelSelectionFromSnapshot = (snapshot: Snapshot): DesktopModelSelection | null => {
  const provider = String(snapshot.provider || "");
  const model = String(snapshot.model || "");
  if (!provider || !model) return null;
  const effort = String(snapshot.effort || "");
  return {
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(typeof snapshot.fast === "boolean" ? { fast: snapshot.fast } : {}),
  };
};
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
  AgentSessionConversation,
  LiveConversation,
  PaneConversation,
  PaneHeaderStatus,
  selectDesktopSnapshot,
  SnapshotLiveWork,
  SnapshotUtilityDock,
  requestSessionPeek,
  useDesktopSnapshotSelector,
  type SnapshotSessionScope,
} from "./app-snapshot-views";

import { useDesktopState } from "./app-desktop-state";
import { createProjectActions } from "./app-project-actions";
import { useSessionCatalog } from "./app-session-catalog";
import { useSessionSnapshotCache } from "./app-session-snapshots";
import { useSidePanelOpenFlip } from "./app-side-panel-flip";
import { useUnreadSessions } from "./app-unread-sessions";
import { useWorkspaceShortcuts } from "./app-workspace-shortcuts";
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
    snapshotRef,
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
  const sidebarSnapshot = useDesktopSnapshotSelector(
    snapshotStore,
    selectDesktopSnapshot,
    desktopSidebarSnapshotsEqual,
  );
  const preferredSidePanelMode = useSyncExternalStore(
    subscribeSidePanelMode,
    getSidePanelMode,
    (): SidePanelMode => "close-both",
  );
  // Narrow web/desktop windows use the both-folding policy; the layout now
  // depends only on available resolution, never device or pointer type.
  const responsiveSidePanels = window.matchMedia?.("(max-width: 760px)").matches === true;
  const activeSidePanelMode = responsiveSidePanels ? "close-both" : preferredSidePanelMode;
  const activeSidePanelLayout = sidePanelLayout(activeSidePanelMode);
  // Chrome-like responsive side panels (user decision): crossing into the
  // narrow band changes the panels' MODE (inline → overlay drawer), never
  // their meaning — a drawer always starts closed, and returning to the
  // desktop band restores the inline open/collapsed states exactly as they
  // were (접혀있던 걸 굳이 펼치거나 펼쳐져 있던 걸 굳이 접지 않기).
  const [narrowShell, setNarrowShell] = useState(
    () => window.matchMedia?.("(max-width: 760px)").matches === true,
  );
  const wasNarrowShell = useRef(narrowShell);
  // Callback-safe mirror: the sheet-exclusivity rule below runs inside
  // stable useCallbacks and must read the CURRENT band.
  const narrowShellRef = useRef(narrowShell);
  narrowShellRef.current = narrowShell;
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 760px)");
    if (!query) return undefined;
    const onChange = (): void => setNarrowShell(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    // CSS media queries update before React can commit their matching state.
    // Arm a DOM-level guard on the first resize event so a 763→760px drag
    // cannot start one decorative frame before the responsive effects run.
    const root = document.documentElement;
    let settleTimer = 0;
    const onResize = (): void => {
      root.classList.add("mx-window-resizing");
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        root.classList.remove("mx-window-resizing");
        settleTimer = 0;
      }, 180);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(settleTimer);
      root.classList.remove("mx-window-resizing");
    };
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (!desktopFeatureEnabled("sessions")) return false;
    if (activeSidePanelLayout.sidebarLockedOpen) return true;
    try {
      if (responsiveSidePanels) return false;
      // Default layout starts MINIMIZED on both edges (user decision): only
      // an explicit stored "true" (the user opened it before) restores an
      // open sidebar. The right dock already defaults to closed.
      return window.localStorage.getItem(SIDEBAR_OPEN_KEY) === "true";
    } catch {
      return false;
    }
  });
  const desktopSidebarOpen = useRef(sidebarOpen);
  useEffect(() => {
    // Narrow-band drawer toggles are transient: they update neither the
    // stored preference nor the restore target. The wasNarrowShell guard
    // also holds the first wide render back until the crossing effect below
    // has re-applied the inline state.
    if (narrowShell || wasNarrowShell.current) return;
    desktopSidebarOpen.current = sidebarOpen;
    const timer = window.setTimeout(() => {
      try { window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen)); }
      catch { /* layout persistence is a convenience only */ }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [narrowShell, sidebarOpen]);
  // Projects panel (rail → Projects): hosted in the session-panel area with
  // popup editors (user decision — Schedules grammar, no takeover).
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [commandSurface, setCommandSurface] = useState<CommandSurfaceName | null>(null);
  const openConversationCommandSurface = useCallback((surface: CommandSurfaceName) => {
    if (surface === "usage" && !desktopFeatureEnabled("usage")) return;
    setSettingsOpen(false);
    setCommandSurface(surface);
  }, []);
  // Right utility dock (Cursor-style side panel): tab/width persist; the
  // General side-panel policy owns whether either edge starts open.
  const [dockOpen, setDockOpen] = useState<boolean>(() =>
    hasDesktopUtilityDockFeature
      && (activeSidePanelLayout.dockLockedOpen ? true : readDockState().open));
  const [dockTab, setDockTab] = useState<UtilityDockTab>(() =>
    resolveDesktopUtilityDockTab(readDockState().tab)
      ?? firstEnabledDesktopUtilityDockTab()
      ?? "agents");
  const [dockWidth, setDockWidth] = useState<number>(() => readDockState().width);
  const desktopDockOpen = useRef(dockOpen);
  const bottomPanel = useBottomPanelState("terminal");
  const [problemsFilter, setProblemsFilter] = useState<ProblemsPanelFilter>(
    () => ({ ...DEFAULT_PROBLEMS_PANEL_FILTER }),
  );
  const [problemsCollapseNonce, setProblemsCollapseNonce] = useState(0);
  // View Transition update callbacks can land a frame after the click. Keep
  // the user's latest intent separately so rapid toggles never read a stale
  // rendered state or let an older close completion reverse the newest input.
  const sidebarOpenIntent = useRef(sidebarOpen);
  const dockOpenIntent = useRef(dockOpen);
  const [sidebarMotion, setSidebarMotion] = useState<"animated" | "instant">("animated");
  const applySidebarOpen = useCallback((
    open: boolean,
    motion: "animated" | "instant" = "animated",
  ) => {
    sidebarOpenIntent.current = open;
    setSidebarMotion(motion);
    setSidebarOpen(open);
  }, []);
  const applyDockOpen = useCallback((open: boolean) => {
    dockOpenIntent.current = open;
    setDockOpen(open);
  }, []);
  // The bottom panel is the SAME kind of narrow-band surface as the side
  // sheets (user: 하단 탭도 좌우 탭과 같은 취급 — 겹치면 안 된다): while a
  // sheet would overlap it (dock ≤940px, drawer ≤760px), opening either
  // side folds the bottom panel, mirroring the bottom-panel toggle that
  // folds the sheets. Wide inline layouts coexist untouched.
  const dismissBottomPanelForSheet = useCallback((band: "dock" | "drawer") => {
    const query = band === "dock" ? "(max-width: 940px)" : "(max-width: 760px)";
    if (window.matchMedia?.(query).matches === true && bottomPanel.open) {
      bottomPanel.setOpen(false);
    }
  }, [bottomPanel]);
  // A band change re-applies the sheet media rules to the ALREADY-open dock,
  // which used to replay the slide-in (user: 해상도 바뀔 때 굳이 애니 나올
  // 필요 없다). Once the fresh-open animation has run, `data-entering`
  // pins animation/transition off for the rest of the mount.
  const [dockSettled, setDockSettled] = useState(false);
  useEffect(() => {
    if (!dockOpen) { setDockSettled(false); return undefined; }
    const timer = window.setTimeout(() => setDockSettled(true), 400);
    return () => window.clearTimeout(timer);
  }, [dockOpen]);
  const openDockTab = useCallback((tab: UtilityDockTab) => {
    if (!desktopUtilityDockTabEnabled(tab)) return;
    setDockTab(tab);
    // Narrow shells keep ONE sheet: the last-pressed side wins (user).
    if (narrowShellRef.current && sidebarOpenIntent.current) applySidebarOpen(false);
    dismissBottomPanelForSheet("dock");
    applyDockOpen(true);
  }, [applyDockOpen, applySidebarOpen, dismissBottomPanelForSheet]);
  const resizeDock = useCallback((value: number) => {
    setDockWidth(clampDockWidth(value));
  }, []);
  const appliedSidePanelMode = useRef(activeSidePanelMode);
  useEffect(() => {
    // Existing installs retain their last folding state on launch. A mode
    // CHANGE applies immediately; navigation applies the same exact policy.
    if (appliedSidePanelMode.current === activeSidePanelMode) return;
    appliedSidePanelMode.current = activeSidePanelMode;
    applySidebarOpen(activeSidePanelLayout.sidebarOpen && desktopFeatureEnabled("sessions"));
    applyDockOpen(activeSidePanelLayout.dockOpen && hasDesktopUtilityDockFeature);
  }, [activeSidePanelMode]);
  // Manual toggles ALWAYS win (user: a dead open/close button reads as a
  // bug). The keep-open policy re-applies on the next navigation instead of
  // rejecting the click outright.
  // Both directions commit their final layout synchronously in one frame —
  // VS Code grammar, no snapshot interpolation (user: 잔상/폰트 튐 금지).
  const {
    mainPanel: mainPanelRef,
    beginOpen: beginSidePanelOpen,
    beginClose: beginSidePanelClose,
  } = useSidePanelOpenFlip();
  const openSidebar = useCallback(() => {
    if (sidebarOpenIntent.current) return;
    sidebarOpenIntent.current = true;
    // Narrow shells keep ONE sheet: opening the drawer dismisses the dock.
    if (narrowShellRef.current && dockOpenIntent.current) applyDockOpen(false);
    dismissBottomPanelForSheet("drawer");
    beginSidePanelOpen("sidebar", () => applySidebarOpen(true));
  }, [applyDockOpen, applySidebarOpen, beginSidePanelOpen, dismissBottomPanelForSheet]);
  // Toggle spam queues expensive panel mounts and replays them after the
  // clicks stop (user: 연타하면 예약되어서 여러 번 열린다): clicks inside
  // one motion window coalesce into the FIRST one instead of stacking.
  // The window is measured on the EVENT clock, not the handler clock: a
  // mount that blocks longer than the window would otherwise re-space the
  // queued clicks and let every one of them through (user: 여러 번 예약된
  // 것처럼 다시 열려).
  const lastSidePanelToggle = useRef(0);
  const sidePanelToggleReady = useCallback((stamp?: number) => {
    const now = typeof stamp === "number" && stamp > 0 ? stamp : performance.now();
    if (lastSidePanelToggle.current > 0
      && now - lastSidePanelToggle.current < 220) return false;
    lastSidePanelToggle.current = now;
    return true;
  }, []);
  const toggleSidebar = useCallback((event?: { timeStamp?: number }) => {
    if (!sidebarOpenIntent.current && !desktopFeatureEnabled("sessions")) return;
    if (!sidePanelToggleReady(event?.timeStamp)) return;
    const nextOpen = !sidebarOpenIntent.current;
    sidebarOpenIntent.current = nextOpen;
    if (nextOpen) {
      if (narrowShellRef.current && dockOpenIntent.current) applyDockOpen(false);
      dismissBottomPanelForSheet("drawer");
      beginSidePanelOpen("sidebar", () => applySidebarOpen(true));
    } else {
      beginSidePanelClose("sidebar", () => applySidebarOpen(false));
    }
  }, [applyDockOpen, applySidebarOpen, beginSidePanelClose, beginSidePanelOpen, dismissBottomPanelForSheet, sidePanelToggleReady]);
  const toggleDock = useCallback((event?: { timeStamp?: number }) => {
    if (!dockOpenIntent.current && !hasDesktopUtilityDockFeature) return;
    if (!sidePanelToggleReady(event?.timeStamp)) return;
    const nextOpen = !dockOpenIntent.current;
    dockOpenIntent.current = nextOpen;
    if (nextOpen) {
      if (narrowShellRef.current && sidebarOpenIntent.current) applySidebarOpen(false);
      dismissBottomPanelForSheet("dock");
      beginSidePanelOpen("dock", () => applyDockOpen(true));
    } else {
      beginSidePanelClose("dock", () => applyDockOpen(false));
    }
  }, [applyDockOpen, applySidebarOpen, beginSidePanelClose, beginSidePanelOpen, dismissBottomPanelForSheet, sidePanelToggleReady]);
  // Expanding the bottom panel in the sheet band dismisses the overlay
  // sheets — last press wins (user: 좁은 폭일 때 아래쪽 탭을 확장하면
  // 오른쪽은 사라져야지). The dock floats as a sheet ≤940px, the drawer
  // ≤760px; wide inline layouts coexist and stay untouched.
  const dismissSheetsForBottomPanel = useCallback(() => {
    if (window.matchMedia?.("(max-width: 940px)").matches !== true) return;
    if (dockOpenIntent.current) applyDockOpen(false);
    if (narrowShellRef.current && sidebarOpenIntent.current) applySidebarOpen(false);
  }, [applyDockOpen, applySidebarOpen]);
  const toggleBottomPanel = useCallback(() => {
    if (!bottomPanel.open) dismissSheetsForBottomPanel();
    bottomPanel.toggle();
  }, [bottomPanel, dismissSheetsForBottomPanel]);
  // The breakpoint crossing itself (user: 축소할 때 왼쪽 세션창은 숨기고
  // 다시 늘리면 열리게 — 아래쪽도): the LEFT drawer hides on the way IN and
  // the stored inline state returns on the way OUT; the RIGHT sheet is the
  // one surface that survives the crossing (user: 오른쪽이 우선순위가
  // 높다). The bottom panel follows the same hide/restore rule on its own
  // 940px sheet band below. Runs after the side-panel mode effect above so
  // a mode-policy write never overrides the restore.
  useEffect(() => {
    if (wasNarrowShell.current === narrowShell) return;
    wasNarrowShell.current = narrowShell;
    if (narrowShell) {
      if (sidebarOpenIntent.current) applySidebarOpen(false, "instant");
      return;
    }
    if (desktopSidebarOpen.current !== sidebarOpenIntent.current) {
      applySidebarOpen(desktopSidebarOpen.current, "instant");
    }
    if (desktopDockOpen.current !== dockOpenIntent.current) {
      applyDockOpen(desktopDockOpen.current);
    }
  }, [narrowShell, applyDockOpen, applySidebarOpen]);
  // Bottom panel band (≤940px = the width where it becomes an overlay
  // sheet): hide on shrink, restore the stored wide state on expand.
  const [bottomSheetBand, setBottomSheetBand] = useState(
    () => window.matchMedia?.("(max-width: 940px)").matches === true,
  );
  useEffect(() => {
    const query = window.matchMedia?.("(max-width: 940px)");
    if (!query) return undefined;
    const onChange = (): void => setBottomSheetBand(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  const wasBottomSheetBand = useRef(bottomSheetBand);
  const desktopBottomPanelOpen = useRef(bottomPanel.open);
  useEffect(() => {
    // Narrow-band opens are transient, exactly like the drawer's.
    if (bottomSheetBand || wasBottomSheetBand.current) return;
    desktopBottomPanelOpen.current = bottomPanel.open;
  }, [bottomPanel.open, bottomSheetBand]);
  useEffect(() => {
    if (wasBottomSheetBand.current === bottomSheetBand) return;
    wasBottomSheetBand.current = bottomSheetBand;
    // A 940px mode crossing must never replay the right Dock's sheet
    // animation, even when it happens inside the initial settle window.
    if (dockOpenIntent.current) setDockSettled(true);
    if (bottomSheetBand) {
      if (bottomPanel.open) bottomPanel.setOpen(false, "instant");
      return;
    }
    if (desktopBottomPanelOpen.current !== bottomPanel.open) {
      bottomPanel.setOpen(desktopBottomPanelOpen.current, "instant");
    }
  }, [bottomSheetBand, bottomPanel]);
  // Workflow and agent configuration panel (rail → Workflows).
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  // Rail destinations pre-mount hidden after boot and stay mounted while the
  // sidebar remains open. Their shared reference cache coalesces hydration, so
  // this constructs rows, route controls and overflow options without issuing
  // duplicate provider/catalog requests.
  const [mountedSidebarPanels, setMountedSidebarPanels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const mountSidebarPanel = useCallback((panel: string) => {
    setMountedSidebarPanels((current) => {
      if (current.has(panel)) return current;
      return new Set([...current, panel]);
    });
  }, []);
  // "Already visited" is not enough to present a destination instantly: the
  // panel's lazy chunk must have RESOLVED, otherwise a fast swap would only
  // reveal the Suspense fallback (null) as an empty panel. A rejected chunk
  // never lands here, so that destination keeps the safe settle path.
  const [loadedSidebarPanels, setLoadedSidebarPanels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const trackSidebarPanelModule = useCallback((panel: string, load: Promise<unknown>) => {
    void load.then(() => {
      setLoadedSidebarPanels((current) => {
        if (current.has(panel)) return current;
        return new Set([...current, panel]);
      });
    }).catch(() => { /* an unresolved chunk simply stays cold */ });
  }, []);
  // A rejected chunk is reported by the panel-local boundary. The destination
  // then presents a compact unavailable state (it has real content to show)
  // but never counts as warm, so it keeps the safe settle path.
  const [failedSidebarPanels, setFailedSidebarPanels] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [sidebarPanes, setSidebarPanes] = useState(() => ({
    utilities: createUtilitiesPane(),
    schedules: createSchedulesPane(),
    webhooks: createWebhooksPane(),
    projects: createProjectsPane(),
    workflows: createWorkflowsPane(),
  }));
  const markSidebarPanelFailed = useCallback((panel: SidebarPanelKey) => {
    setFailedSidebarPanels((current) => {
      if (current.has(panel)) return current;
      return new Set([...current, panel]);
    });
  }, []);
  const retrySidebarPanel = useCallback((panel: SidebarPanelKey) => {
    // A fresh lazy component is the only way back from a rejected loader.
    setSidebarPanes((current) => panel === "schedules"
      ? { ...current, schedules: createSchedulesPane() }
      : panel === "webhooks"
        ? { ...current, webhooks: createWebhooksPane() }
        : panel === "projects"
          ? { ...current, projects: createProjectsPane() }
          : panel === "utilities"
            ? { ...current, utilities: createUtilitiesPane() }
            : { ...current, workflows: createWorkflowsPane() });
    setFailedSidebarPanels((current) => {
      if (!current.has(panel)) return current;
      const next = new Set(current);
      next.delete(panel);
      return next;
    });
    trackSidebarPanelModule(panel, loadSidebarPanelModule[panel]());
  }, [trackSidebarPanelModule]);
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  const openUtilities = useCallback(() => {
    if (!desktopFeatureEnabled("utilities")) return;
    mountSidebarPanel("utilities");
    trackSidebarPanelModule("utilities", loadSidebarPanelModule.utilities());
    setUtilitiesOpen(true);
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setProjectsOpen(false);
    setWorkflowsOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  // Scheduled-tasks panel (rail → Schedules): lives in the session-panel
  // area, so navigation leaves it alone (user decision).
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const openSchedules = useCallback(() => {
    if (!desktopFeatureEnabled("schedules")) return;
    mountSidebarPanel("schedules");
    trackSidebarPanelModule("schedules", loadSidebarPanelModule.schedules());
    setSchedulesOpen(true);
    setWebhooksOpen(false);
    setProjectsOpen(false);
    setWorkflowsOpen(false);
    setUtilitiesOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  // Inbound-webhooks panel: same session-panel concept as Schedules
  // (user decision — moved out of the settings dialog).
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const openWebhooks = useCallback(() => {
    if (!desktopFeatureEnabled("webhooks")) return;
    mountSidebarPanel("webhooks");
    trackSidebarPanelModule("webhooks", loadSidebarPanelModule.webhooks());
    setWebhooksOpen(true);
    setSchedulesOpen(false);
    setProjectsOpen(false);
    setWorkflowsOpen(false);
    setUtilitiesOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  const openProjects = useCallback(() => {
    if (!desktopFeatureEnabled("projects")) return;
    mountSidebarPanel("projects");
    trackSidebarPanelModule("projects", loadSidebarPanelModule.projects());
    setProjectsOpen(true);
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setWorkflowsOpen(false);
    setUtilitiesOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  const openWorkflows = useCallback(() => {
    if (!desktopFeatureEnabled("workflows")) return;
    mountSidebarPanel("workflows");
    trackSidebarPanelModule("workflows", loadSidebarPanelModule.workflows());
    setWorkflowsOpen(true);
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setProjectsOpen(false);
    setUtilitiesOpen(false);
    openSidebar();
  }, [mountSidebarPanel, openSidebar, trackSidebarPanelModule]);
  // Returns the rail panel area to the Sessions list.
  const closeSidebarPanels = useCallback(() => {
    setSchedulesOpen(false);
    setWebhooksOpen(false);
    setProjectsOpen(false);
    setWorkflowsOpen(false);
    setUtilitiesOpen(false);
  }, []);
  // A collapsed drawer forgets its rail destination on EVERY close path
  // (toggle, backdrop, exclusivity, band crossing): the next open always
  // starts from Sessions (user: 다시 열고 닫을 때 세션으로 초기화).
  useEffect(() => {
    if (!sidebarOpen) closeSidebarPanels();
  }, [closeSidebarPanels, sidebarOpen]);
  // Re-selecting the visible rail destination mirrors the Sessions button:
  // collapse the whole sidebar, but clear the destination first so the next
  // expand always starts from Sessions instead of restoring a stale panel.
  const closeActiveRailPanel = useCallback(() => {
    closeSidebarPanels();
    sidebarOpenIntent.current = false;
    beginSidePanelClose("sidebar", () => applySidebarOpen(false));
  }, [applySidebarOpen, beginSidePanelClose, closeSidebarPanels]);
  useEffect(() => {
    // Same transience rule as the sidebar: drawer-band dock toggles never
    // overwrite the desktop dock preference or the restore target.
    if (narrowShell || wasNarrowShell.current) return;
    desktopDockOpen.current = dockOpen;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(DOCK_STATE_KEY, JSON.stringify({ open: dockOpen, tab: dockTab, width: dockWidth }));
      } catch { /* dock state is a convenience only */ }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [narrowShell, dockOpen, dockTab, dockWidth]);
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
    && startupFocusedPaneSelection.kind !== "agent-session"
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
  // The registry starts EMPTY (VS Code/Orca): the workspace opens with no
  // pane, and the first task creates its tab.
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  // Folder panes report the folder they are VIEWING so their tab title
  // follows navigation (Explorer window-title grammar). Keyed by tab key.
  const [folderPaneTitles, setFolderPaneTitles] = useState<ReadonlyMap<string, string>>(new Map());
  // Split-pane workspace (VS Code-style): the pane tree is the visible
  // multi-surface — the top tab strip is retired — while `tabs` remains the
  // internal registry that keeps dirty file editors mounted and titled.
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
  const focusedPaneSessionId = focusedPaneSelection?.kind === "session"
    ? focusedPaneSelection.id
    : "";
  const focusedPaneSnapshot = useSessionLane(
    focusedPaneSessionId,
    defaultSessionLaneStore,
  );
  useEffect(() => {
    if (!focusedPaneSnapshot || focusedPaneSnapshot === snapshotRef.current) return;
    // The daemon has no active session. Renderer chrome follows the lane of
    // the focused pane, while every pane continues painting its own lane.
    applySnapshot(focusedPaneSnapshot as SessionSnapshot);
  }, [applySnapshot, focusedPaneSnapshot, snapshotRef]);
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
  // VS Code sequential prompts: Close Others with several dirty files walks
  // one Save/Don't Save dialog per file instead of keeping only the last.
  const [pendingUnsavedCloses, setPendingUnsavedCloses] = useState<PendingUnsavedClose[]>([]);
  const pendingUnsavedClose = pendingUnsavedCloses[0] ?? null;
  const [unsavedCloseBusy, setUnsavedCloseBusy] = useState(false);
  const [unsavedCloseError, setUnsavedCloseError] = useState("");
  // Ctrl+Tab MRU switcher (VS Code): most-recent-first within the focused
  // group; releasing Ctrl commits the highlighted tab.
  const tabMruRef = useRef<string[]>([]);
  const [tabSwitcher, setTabSwitcher] = useState<{ keys: string[]; index: number } | null>(null);
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
  const [newTaskDeferred, setNewTaskDeferred] = useState(false);
  const [newTaskProjectPath, setNewTaskProjectPath] = useState("");
  const newTaskProjectPathRef = useRef("");
  const [newTaskModelSelection, setNewTaskModelSelection] = useState<DesktopModelSelection | null>(null);
  const newTaskModelSelectionRef = useRef<DesktopModelSelection | null>(null);
  const [newTaskWorkflow, setNewTaskWorkflow] = useState<DesktopWorkflowState | null>(null);
  const newTaskWorkflowRef = useRef<DesktopWorkflowState | null>(null);
  // Per-draft-tab prefs (user requirement: every pane manages its OWN
  // project/model/workflow). The singletons above always mirror the FOCUSED
  // draft (submit path unchanged); this map keeps each draftId's staged
  // values so switching drafts restores them and non-focused draft panes
  // render their own chrome instead of the focused draft's.
  type DraftPanePrefs = {
    projectPath: string;
    modelSelection: DesktopModelSelection | null;
    workflow: DesktopWorkflowState | null;
  };
  const draftPanePrefs = useRef(new Map<string, DraftPanePrefs>());
  const [, setDraftPrefsVersion] = useState(0);
  // The LAST staged model/workflow/project (any draft, persisted): every NEW
  // draft seeds from it (user rule: a new task reuses the last cached
  // settings; each pane then diverges independently).
  const lastNewTaskPrefs = useRef<DraftPanePrefs | null>(null);
  // Before the user explicitly changes a draft route, the engine snapshot is
  // still its authoritative default. Preserve that route in the same prefs
  // chain so unfocused panes (whose lane snapshot is intentionally empty)
  // render exactly what the focused pane renders.
  const snapshotDraftModelSelection = useMemo(
    // ONLY while the engine snapshot actually owns the draft: a blank engine
    // (no session id) is the new task's own route. A draft focused while the
    // engine still runs the PREVIOUS session must never inherit — let alone
    // freeze — that unrelated session's model.
    () => selection.kind === "new" && !String(snapshot.sessionId || "")
      ? draftModelSelectionFromSnapshot(snapshot)
      : null,
    [selection.kind, snapshot.sessionId, snapshot.effort, snapshot.fast, snapshot.model,
      snapshot.provider],
  );
  const inheritedDraftPrefs = useCallback((): DraftPanePrefs => {
    const last = lastNewTaskPrefs.current;
    return {
      // An explicit empty path means No project and must not fall through to a
      // previous non-empty value. With no saved preference, seed the registry's
      // most recently selected project.
      projectPath: effectiveDraftProjectPath(last
        ? last.projectPath
        : newTaskProjectPathRef.current || preferredDraftProjectPath),
      modelSelection: newTaskModelSelectionRef.current
        ?? last?.modelSelection
        ?? snapshotDraftModelSelection,
      workflow: newTaskWorkflowRef.current
        ?? last?.workflow ?? null,
    };
  }, [effectiveDraftProjectPath, preferredDraftProjectPath, snapshotDraftModelSelection]);
  // ONE display/restore rule for a draft's effective prefs (focused and
  // unfocused): the entry's explicit values, with unset fields inheriting the
  // last-used prefs. Without the shared rule a null-model entry showed
  // "Select model" focused while the unfocused pane showed the inherited
  // model (user report: the two states disagreed).
  // The engine-derived fallback is captured ONCE per draft: it follows the
  // FOCUSED engine and is null while a session pane owns focus, so a draft
  // with no explicit choice re-rendered a different model on every focus swap
  // and on the first public render of a freshly created New task pane.
  const draftSnapshotModelSeeds = useRef(new Map<string, DesktopModelSelection>());
  const resolvedDraftPrefsFor = useCallback((draftKey: string): DraftPanePrefs => {
    const entry = draftKey ? draftPanePrefs.current.get(draftKey) : undefined;
    const last = lastNewTaskPrefs.current;
    const projectPath = entry
      ? entry.projectPath
      : last
        ? last.projectPath
        : preferredDraftProjectPath;
    if (draftKey && snapshotDraftModelSelection
      && !draftSnapshotModelSeeds.current.has(draftKey)) {
      draftSnapshotModelSeeds.current.set(draftKey, snapshotDraftModelSelection);
      while (draftSnapshotModelSeeds.current.size > 32) {
        const oldest = draftSnapshotModelSeeds.current.keys().next().value;
        if (oldest === undefined) break;
        draftSnapshotModelSeeds.current.delete(oldest);
      }
    }
    return {
      projectPath: effectiveDraftProjectPath(projectPath),
      modelSelection: entry?.modelSelection
        ?? last?.modelSelection
        ?? (draftKey ? draftSnapshotModelSeeds.current.get(draftKey) : undefined)
        ?? snapshotDraftModelSelection,
      workflow: entry?.workflow ?? last?.workflow ?? null,
    };
  }, [effectiveDraftProjectPath, preferredDraftProjectPath, snapshotDraftModelSelection]);
  // Prefs survive reloads: without persistence a restored pane layout showed
  // fallback chrome until focused, then snapped to "Select model" because the
  // freshly-seeded entry was empty (user report).
  const persistDraftPanePrefs = useCallback(() => {
    try {
      const entries = [...draftPanePrefs.current.entries()].slice(-24);
      window.localStorage.setItem(DRAFT_PANE_PREFS_KEY, JSON.stringify(entries));
      if (lastNewTaskPrefs.current) {
        window.localStorage.setItem(LAST_NEW_TASK_PREFS_KEY,
          JSON.stringify(lastNewTaskPrefs.current));
      }
    } catch { /* best-effort */ }
  }, []);
  const rememberDraftPanePrefs = useCallback((patch: Partial<DraftPanePrefs>) => {
    const current = selectionRef.current;
    if (current.kind !== "new") return;
    const draftKey = current.draftId || "default";
    const entry = draftPanePrefs.current.get(draftKey) ?? inheritedDraftPrefs();
    const merged = { ...entry, ...patch };
    // Refresh insertion order so the persistence cap drops the oldest drafts.
    draftPanePrefs.current.delete(draftKey);
    draftPanePrefs.current.set(draftKey, merged);
    // Explicit staging updates the inheritance source for FUTURE new tasks.
    lastNewTaskPrefs.current = merged;
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
  }, [inheritedDraftPrefs, persistDraftPanePrefs]);
  useEffect(() => {
    // Hydrate BEFORE the focused-draft restore effect below (declaration
    // order), so a restored layout's drafts reopen with their saved prefs.
    try {
      const lastRaw = window.localStorage.getItem(LAST_NEW_TASK_PREFS_KEY);
      const lastValue = lastRaw ? asRecord(JSON.parse(lastRaw)) : null;
      if (lastValue) {
        lastNewTaskPrefs.current = {
          projectPath: typeof lastValue.projectPath === "string" ? lastValue.projectPath : "",
          modelSelection: asRecord(lastValue.modelSelection)
            ? lastValue.modelSelection as unknown as DesktopModelSelection
            : null,
          workflow: asRecord(lastValue.workflow)
            ? lastValue.workflow as unknown as DesktopWorkflowState
            : null,
        };
      }
      const raw = window.localStorage.getItem(DRAFT_PANE_PREFS_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!Array.isArray(parsed)) return;
      let changed = false;
      for (const row of parsed) {
        const key = Array.isArray(row) && typeof row[0] === "string" ? row[0] : "";
        const value = Array.isArray(row) ? asRecord(row[1]) : null;
        if (!key || !value || draftPanePrefs.current.has(key)) continue;
        draftPanePrefs.current.set(key, {
          projectPath: typeof value.projectPath === "string" ? value.projectPath : "",
          modelSelection: asRecord(value.modelSelection)
            ? value.modelSelection as unknown as DesktopModelSelection
            : null,
          workflow: asRecord(value.workflow)
            ? value.workflow as unknown as DesktopWorkflowState
            : null,
        });
        changed = true;
      }
      if (changed) setDraftPrefsVersion((value) => value + 1);
    } catch { /* best-effort */ }
  }, []);
  const stageNewTaskProject = useCallback((projectPath: string) => {
    const next = String(projectPath || "").trim();
    newTaskProjectPathRef.current = next;
    setNewTaskProjectPath(next);
    setNewTaskDeferred(true);
    rememberDraftPanePrefs({ projectPath: next });
  }, [rememberDraftPanePrefs]);
  const stageNewTaskModelSelection = useCallback((selection: DesktopModelSelection) => {
    newTaskModelSelectionRef.current = selection;
    setNewTaskModelSelection(selection);
    rememberDraftPanePrefs({ modelSelection: selection });
  }, [rememberDraftPanePrefs]);
  const rememberSessionFastForNextTask = useCallback((selection: DesktopModelSelection) => {
    const cached = lastNewTaskPrefs.current ?? inheritedDraftPrefs();
    const previous = cached.modelSelection;
    // Fast is model-specific. A session tuning change may refresh the cached
    // route only when the next draft already inherits that model (or has no
    // model yet); it must not silently replace another draft model.
    if (previous && (previous.provider !== selection.provider || previous.model !== selection.model)) {
      return;
    }
    const modelSelection = {
      ...(previous || selection),
      ...selection,
      fast: selection.fast === true,
    };
    lastNewTaskPrefs.current = {
      ...cached,
      modelSelection,
    };
    // The working singleton can still contain the last focused draft's stale
    // route while a session owns focus. Refresh it as the seed for a genuinely
    // new draft; parked draft panes keep their own entries unchanged.
    if (selectionRef.current.kind !== "new") {
      newTaskModelSelectionRef.current = modelSelection;
    }
    persistDraftPanePrefs();
  }, [inheritedDraftPrefs, persistDraftPanePrefs]);
  const stageNewTaskWorkflow = useCallback((workflow: DesktopWorkflowState) => {
    newTaskWorkflowRef.current = workflow;
    setNewTaskWorkflow(workflow);
    rememberDraftPanePrefs({ workflow });
  }, [rememberDraftPanePrefs]);
  const clearNewTaskPreferences = useCallback((target?: NavigationSelection) => {
    const current = target?.kind === "new" ? target : selectionRef.current;
    const focusedOwnsTarget = current.kind === "new"
      && selectionRef.current.kind === "new"
      && navigationKey(selectionRef.current) === navigationKey(current);
    if (!target || focusedOwnsTarget) {
      newTaskModelSelectionRef.current = null;
      newTaskWorkflowRef.current = null;
      setNewTaskModelSelection(null);
      setNewTaskWorkflow(null);
    }
    // Retire the draft's entry (materialized into a session, or torn down) —
    // but never write nulls into lastNewTaskPrefs: the just-used settings
    // stay the seed for the NEXT new task (user rule).
    if (current.kind === "new") {
      draftPanePrefs.current.delete(current.draftId || "default");
      // The retired draft key may be reused (the "default" draft): a stale
      // engine-derived seed would otherwise resurface in the next task.
      draftSnapshotModelSeeds.current.delete(current.draftId || "default");
      persistDraftPanePrefs();
      setDraftPrefsVersion((value) => value + 1);
    }
  }, [persistDraftPanePrefs]);
  const resetNewTaskDraft = useCallback((projectPath: string) => {
    stageNewTaskProject(projectPath);
    // A fresh draft INHERITS the last cached model/workflow instead of
    // resetting to "Select model" (user rule); it diverges independently
    // from the first per-pane change.
    const inherited = inheritedDraftPrefs();
    newTaskModelSelectionRef.current = inherited.modelSelection;
    setNewTaskModelSelection(inherited.modelSelection);
    newTaskWorkflowRef.current = inherited.workflow;
    setNewTaskWorkflow(inherited.workflow);
    rememberDraftPanePrefs({
      modelSelection: inherited.modelSelection,
      workflow: inherited.workflow,
    });
  }, [inheritedDraftPrefs, rememberDraftPanePrefs, stageNewTaskProject]);
  // Focused-draft switch: restore THAT draft's staged prefs into the working
  // singletons (or seed a first-seen draft from the inherited values), so
  // Ctrl+N tabs and pane clicks never bleed prefs into each other.
  const activeDraftKey = selection.kind === "new" ? selection.draftId || "default" : "";
  useEffect(() => {
    if (!activeDraftKey) return;
    const entry = draftPanePrefs.current.get(activeDraftKey);
    if (entry) {
      const resolved = resolvedDraftPrefsFor(activeDraftKey);
      // Older/restored panes may have an explicit null model because no picker
      // choice was made. Materialize the effective engine default once so a
      // later pane focus cannot change its visible route.
      if (!entry.modelSelection && resolved.modelSelection) {
        draftPanePrefs.current.set(activeDraftKey, {
          ...entry,
          modelSelection: resolved.modelSelection,
        });
        lastNewTaskPrefs.current = resolved;
        persistDraftPanePrefs();
        setDraftPrefsVersion((value) => value + 1);
      }
      newTaskProjectPathRef.current = resolved.projectPath;
      setNewTaskProjectPath(resolved.projectPath);
      newTaskModelSelectionRef.current = resolved.modelSelection;
      setNewTaskModelSelection(resolved.modelSelection);
      newTaskWorkflowRef.current = resolved.workflow;
      setNewTaskWorkflow(resolved.workflow);
      return;
    }
    // First sight of this draft: seed from the last cached settings and show
    // them immediately (user rule: new tasks reuse the last settings).
    const seeded = inheritedDraftPrefs();
    draftPanePrefs.current.set(activeDraftKey, seeded);
    if (seeded.modelSelection) lastNewTaskPrefs.current = seeded;
    newTaskProjectPathRef.current = seeded.projectPath;
    setNewTaskProjectPath(seeded.projectPath);
    newTaskModelSelectionRef.current = seeded.modelSelection;
    setNewTaskModelSelection(seeded.modelSelection);
    newTaskWorkflowRef.current = seeded.workflow;
    setNewTaskWorkflow(seeded.workflow);
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
  }, [activeDraftKey, inheritedDraftPrefs, persistDraftPanePrefs, resolvedDraftPrefsFor]);
  useEffect(() => {
    if (!projectCatalogReady) return;
    let changed = false;
    for (const [key, prefs] of draftPanePrefs.current) {
      const projectPath = effectiveDraftProjectPath(prefs.projectPath);
      if (projectPath === prefs.projectPath) continue;
      draftPanePrefs.current.set(key, { ...prefs, projectPath });
      changed = true;
    }
    const last = lastNewTaskPrefs.current;
    if (last) {
      const projectPath = effectiveDraftProjectPath(last.projectPath);
      if (projectPath !== last.projectPath) {
        lastNewTaskPrefs.current = { ...last, projectPath };
        changed = true;
      }
    }
    if (activeDraftKey) {
      const resolved = resolvedDraftPrefsFor(activeDraftKey);
      newTaskProjectPathRef.current = resolved.projectPath;
      setNewTaskProjectPath(resolved.projectPath);
    }
    if (!changed) return;
    persistDraftPanePrefs();
    setDraftPrefsVersion((value) => value + 1);
  }, [
    activeDraftKey,
    effectiveDraftProjectPath,
    persistDraftPanePrefs,
    projectCatalogReady,
    resolvedDraftPrefsFor,
  ]);
  // Requested navigation is lightweight sidebar chrome only. The pane,
  // title, transcript and scroll state stay on the committed selection until
  // the final host response can replace that whole surface in one render.
  const [requestedSessionId, setRequestedSessionId] = useState("");
  const [markdownBodyReadyForTranscript, setMarkdownBodyReadyForTranscript] = useState(isMarkdownBodyReady);
  type ConversationHandoff = {
    kind: "close";
    leafId: string;
    selection: Extract<NavigationSelection, { kind: "session" | "new" }>;
  };
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
  const restoredStartupNavigation = useRef(false);
  const [sessionCatalogReady, setSessionCatalogReady] = useState(false);
  const [startupSettled, setStartupSettled] = useState(
    () => Boolean((window as typeof window & { __mixdogStartupSettled?: boolean })
      .__mixdogStartupSettled),
  );
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  useEffect(() => {
    const focusComposerForTyping = (event: globalThis.KeyboardEvent) => {
      if (focusedPaneSelection?.kind !== "session" && focusedPaneSelection?.kind !== "new") return;
      if (!shouldFocusComposerFromWindowKey(event)) return;
      const pane = document.querySelector<HTMLElement>(
        `[data-pane-id="${paneWorkspace.focusedLeafId}"]`,
      );
      const composer = pane?.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message Mixdog"]',
      );
      if (!composer || composer.closest("[inert]")) return;
      // Focus during keydown capture, before Chromium commits the printable
      // character or starts IME composition. This gives the desktop shell the
      // same type-anywhere grammar as Codex/OpenCode while real editors,
      // terminals, menus, dialogs, and form fields keep their own keyboard.
      composer.focus({ preventScroll: true });
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
  // Per-session snapshot cache (bounded LRU) lives in app-session-snapshots.ts.
  const {
    cachedSessionSnapshot,
    forgetSessionSnapshot,
  } = useSessionSnapshotCache(snapshotStore);
  // Seed for a frozen session-transition frame: the live lane is freshest
  // (background panes stream it), then the LRU cache.
  const availableFrozenSeedFor = (targetSessionId: string): Snapshot | null => {
    const available = (defaultSessionLaneStore.get(targetSessionId) as Snapshot | null)
      || cachedSessionSnapshot(targetSessionId);
    if (!available) return null;
    // Legacy/remote snapshots may omit sessionId. Transition frames cannot:
    // pane ownership uses this identity to reject an explicitly foreign frame.
    return String(available.sessionId || "") === targetSessionId
      ? available
      : { ...available, sessionId: targetSessionId };
  };
  // A cold target still needs its own route identity. Falling through to the
  // shared EMPTY snapshot made Conversation treat it as "new-task", mixing a
  // session transition with the draft's saved scroll position.
  // A session's ROUTE is catalog data, not stream data. The sidebar row keeps
  // the last provider/model, so a pane names its model on the first frame —
  // focus, lane arrival and catalog warmup no longer decide whether the label
  // exists (user: 세션에 처음 들어가면 모델명이 비고, 비포커스 패널은 아예 안 뜸).
  const frozenSeedFor = (targetSessionId: string): Snapshot => {
    const seed = availableFrozenSeedFor(targetSessionId)
      || { ...EMPTY_SNAPSHOT, sessionId: targetSessionId };
    if (seed.provider && seed.model) return seed;
    const row = sessions.find((entry) => entry.id === targetSessionId);
    if (!row?.provider && !row?.model) return seed;
    return {
      ...seed,
      provider: seed.provider || String(row?.provider || ""),
      model: seed.model || String(row?.model || ""),
    };
  };
  // Callback-safe view of the active selection for tab-promotion decisions.
  const selectionRef = useRef<NavigationSelection>(selection);
  const sessionRefresh = useRef({
    submitInFlight: false,
    accepted: false,
    sawBusy: false,
    sawSettlement: false,
  });
  // Per-session throttle for foreign-frame suppression diagnostics.
  const foreignFrameLogAt = useRef(new Map<string, number>());
  const isBusy = Boolean(snapshot.busy || snapshot.commandBusy);
  const activeBusy = hasActiveSnapshotWork(sidebarSnapshot);
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
  // VS Code-style pane splitting: Ctrl/Cmd+\ opens a pane beside the focused
  // one, +Shift below it. The new pane adopts the current selection, so the
  // outgoing copy immediately demonstrates the live-lane view while the new
  // pane stays interactive.
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
  const setRemoteEnabled = useCallback(async (enabled: boolean): Promise<void> => {
    const requestId = ++remoteRequestEpoch.current;
    const result = await invokeResult(() => window.mixdogDesktop.invokeCapability({
      capability: enabled ? "claimRemote" : "releaseRemote",
      args: [],
    }));
    if (requestId !== remoteRequestEpoch.current) return;
    if (result?.snapshot !== undefined) {
      applySnapshot(result.snapshot);
      return;
    }
    // A failed latest request still reconciles to engine truth. Earlier
    // completions are ignored so ON cannot repaint over a newer OFF click.
    const authoritative = await invokeResult(() => window.mixdogDesktop.getSnapshot());
    if (requestId === remoteRequestEpoch.current && authoritative !== undefined) {
      applySnapshot(authoritative);
    }
  }, [applySnapshot, invokeResult]);
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
  // Restore the last viewed conversation before falling back to the historical
  // last-project draft. The old launch path always selected New task, making a
  // clean restart look exactly like transcript loss even though the session
  // file remained intact in Recent.
  useEffect(() => {
    const settleStartup = () => {
      (window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled = true;
      setStartupSettled(true);
      markBootStage("startup-settled");
      window.dispatchEvent(new Event("mixdog:startup-settled"));
    };
    if (restoredStartupNavigation.current) return;
    if (paneWorkspace.restorePending) {
      // The persisted geometry and provisional surfaces are already mounted.
      // Reveal them now; the completed reconciliation will synchronize the
      // final focused route without keeping the whole workbench covered.
      window.requestAnimationFrame(settleStartup);
      return;
    }
    // All active persisted pane tabs already mounted and hydrate independently.
    // Synchronize only the focused interaction route; never reopen every
    // session or wait for the sidebar catalog to validate pane identities.
    if (paneWorkspace.restoredFromStorage && startupFocusedPaneSelection) {
      restoredStartupNavigation.current = true;
      if (startupNavigationSelection) {
        selectionRef.current = startupNavigationSelection;
        setSelection(startupNavigationSelection);
        viewedSessionRef.current = startupNavigationSelection.kind === "session"
          ? startupNavigationSelection.id
          : "";
        unreadViewedSessionRef.current = viewedSessionRef.current;
        try {
          if (startupNavigationSelection.kind === "session") {
            window.localStorage.setItem(LAST_SESSION_KEY, startupNavigationSelection.id);
          } else {
            window.localStorage.removeItem(LAST_SESSION_KEY);
          }
        } catch { /* startup routing remains best-effort */ }
      }
      window.requestAnimationFrame(settleStartup);
      return;
    }
    if (!projectCatalogReady || snapshot === EMPTY_SNAPSHOT) return;
    restoredStartupNavigation.current = true;
    // The persisted LAST VIEWED selection outranks the engine's current
    // session. The engine-first order made every renderer reload (crash
    // recovery, dev HMR) yank a draft/other view onto whatever session the
    // engine happened to hold — perceived as a forced switch onto a
    // background session (user report). An absent stored id means the user
    // last viewed New task: stay there instead of adopting the engine session.
    // An unconfirmed/deleted stored id follows the same safe fallback.
    let storedSessionId = "";
    try { storedSessionId = window.localStorage.getItem(LAST_SESSION_KEY) || ""; }
    catch { /* fall through */ }
    const plan = startupRestorePlan({
      storedSessionId,
      storedSessionKnown: Boolean(storedSessionId
        && sessions.some((session) => session.id === storedSessionId)),
      engineSessionId: String(snapshot.sessionId || ""),
    });
    if (plan.clearStored) {
      try { window.localStorage.removeItem(LAST_SESSION_KEY); } catch { /* stale key is harmless */ }
    }
    try {
      window.mixdogDesktop?.perfLog?.(
        `startup-restore action=${plan.action} target=${plan.sessionId || "(none)"}`
        + ` stored=${storedSessionId || "(none)"} engine=${String(snapshot.sessionId || "") || "(none)"}`,
      );
    } catch { /* diagnostics only */ }
    if (plan.action === "activate") {
      const current = sessions.find((session) => session.id === plan.sessionId);
      activateSelection(
        { kind: "session", id: plan.sessionId },
        current ? sessionSummaryTitle(current) : String(snapshot.desktopSessionTitle || "New task"),
      );
      settleStartup();
      return;
    }
    if (plan.action === "resume") {
      void openSessionRef.current(plan.sessionId, true).finally(settleStartup);
      return;
    }
    let storedProject = "";
    try { storedProject = window.localStorage.getItem(LAST_PROJECT_KEY) || ""; } catch { /* fall through */ }
    const cachedDraftProject = lastNewTaskPrefs.current
      ? effectiveDraftProjectPath(lastNewTaskPrefs.current.projectPath)
      : effectiveDraftProjectPath(storedProject || preferredDraftProjectPath);
    if (!cachedDraftProject) {
      setNewTaskDeferred(true);
      settleStartup();
      return;
    }
    resetNewTaskDraft(cachedDraftProject);
    activateSelection({ kind: "new" }, "New task");
    settleStartup();
  }, [
    activateSelection,
    effectiveDraftProjectPath,
    preferredDraftProjectPath,
    projectCatalogReady,
    resetNewTaskDraft,
    sessions,
    snapshot,
    paneWorkspace.restoredFromStorage,
    paneWorkspace.restorePending,
    startupFocusedPaneSelection,
    startupNavigationSelection,
  ]);
  const refreshSessionsBestEffort = useCallback(() => {
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions]);
  const refreshSettledSession = useCallback(() => {
    const pending = sessionRefresh.current;
    if (!pending.accepted || !pending.sawSettlement) return;
    sessionRefresh.current = {
      submitInFlight: false,
      accepted: false,
      sawBusy: false,
      sawSettlement: false,
    };
    // Native desktop hosts push the updated catalog from the session-store
    // watcher. Running the authoritative list path here as well rescans every
    // stored session inside the host transition lock, so a prompt submitted
    // immediately after turn completion waits behind that scan. Remote/legacy
    // bridges without catalog push retain the explicit fallback refresh.
    if (typeof window.mixdogDesktop?.subscribeSessions !== "function") {
      refreshSessionsBestEffort();
    }
  }, [refreshSessionsBestEffort]);
  useEffect(() => {
    const pending = sessionRefresh.current;
    if (isBusy) {
      if (pending.submitInFlight || pending.accepted) pending.sawBusy = true;
      return;
    }
    if (!pending.sawBusy) return;
    pending.sawSettlement = true;
    refreshSettledSession();
  }, [isBusy, refreshSettledSession]);
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
    startProjectTask,
    selectNewTaskProject,
    chooseNewTaskProject,
    openProjectInExplorer,
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
    stageNewTaskProject,
    focusComposer: () => setComposerFocusRequest((value) => value + 1),
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
    const deletingCurrent = (selection.kind === "session" && selection.id === sessionId)
      || String(snapshot.sessionId || "") === sessionId;
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
      forgetSessionSnapshot(sessionId);
    }
    try {
      await refreshSessions();
    } catch {
      // The successful deletion remains authoritative if reconciliation is unavailable.
    } finally {
      pendingSessionDeletes.current.delete(sessionId);
    }
  }, [activateSelection, applySnapshot, clearNewTaskPreferences, refreshSessions, selection, sessions, setError, snapshot.sessionId]);
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
  ): Promise<void> => {
    navigationEpoch.current += 1;
    closeSidebarForNavigation();
    setRequestedSessionId("");
    if (!availableFrozenSeedFor(sessionId)) requestSessionPeek(sessionId);
    const session = sessions.find((item) => item.id === sessionId);
    finishPendingConversationHandoff();
    activateSelection(
      { kind: "session", id: sessionId },
      session ? sessionSummaryTitle(session) : "Untitled session",
    );
  };
  openSessionRef.current = openSession;
  const prefetchSession = useCallback((sessionId: string) => (
    window.mixdogDesktop?.prefetchSession?.(sessionId) ?? Promise.resolve(false)
  ), []);
  const openSettings = useCallback((section: SettingsSection | null = null) => {
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
    setSettingsSection(section);
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
    // The session's OWN route seeds the draft: pane-local lane frame first,
    // then the focused engine snapshot; the usual inheritance chain fills any
    // field the session never named.
    const lane = defaultSessionLaneStore.get(sessionId);
    const source = lane
      ?? (String(snapshotRef.current.sessionId || "") === sessionId
        ? snapshotRef.current
        : null);
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
    const draftKey = navigationKey(draftSelection);
    draftPanePrefs.current.set(draftKey, seeded);
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
      || (snapshotRef.current.remoteEnabled === true
        && String(snapshotRef.current.remoteSessionId || "") === sessionId);
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
  const conversationChooseProject = useStableEvent(() => {
    chooseNewTaskProject();
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
  type SubmitRoute = {
    selection: NavigationSelection;
    leafId: string;
  };
  const submitFromRoute = useCallback(async (
    route: SubmitRoute,
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<unknown> => {
    const host = window.mixdogDesktop;
    if (!host) return false;
    const routeSelection = route.selection;
    const draftKey = routeSelection.kind === "new" ? navigationKey(routeSelection) : "";
    const draftPrefsKey = routeSelection.kind === "new"
      ? routeSelection.draftId || "default"
      : "";
    const draftPrefs = draftPrefsKey ? resolvedDraftPrefsFor(draftPrefsKey) : null;
    const submitEpoch = navigationEpoch.current;
    const draftRouteStillExists = () => Boolean(draftKey)
      && paneLeavesRef.current.some((leaf) => leaf.id === route.leafId
        && leaf.tabs.some((tab) => navigationKey(tab) === draftKey));
    const draftStillSelected = () => draftRouteStillExists()
      && focusedLeafIdRef.current === route.leafId
      && selectionRef.current.kind === "new"
      && navigationKey(selectionRef.current) === draftKey
      && navigationEpoch.current === submitEpoch;
    const pending = sessionRefresh.current;
    pending.submitInFlight = true;
    pending.sawBusy ||= isBusy;
    let startedSessionId = "";
    let accepted: unknown;
    // One-shot channel-relay reservation: capture the draft's Remote choice at
    // submit time. The atomic new-task path claims the seat host-side at
    // session creation (attach immediately); success consumes the reservation
    // so the NEXT new task starts remote-off again (user decision).
    const newTaskRemoteRequested = routeSelection.kind === "new"
      && remoteNewTaskMode() === "on";
    const submittedProjectPath = routeSelection.kind === "new"
      ? effectiveDraftProjectPath(draftPrefs?.projectPath || "")
      : "";
    try {
      if (routeSelection.kind === "new") {
        const result = await host.submitNewTask(content, options, {
          ...(submittedProjectPath
            ? { projectPath: submittedProjectPath }
            : {}),
          ...(draftPrefs?.modelSelection
            ? { route: draftPrefs.modelSelection }
            : {}),
          ...(draftPrefs?.workflow?.id
            ? { workflowId: draftPrefs.workflow.id }
            : {}),
          ...(newTaskRemoteRequested ? { remote: true } : {}),
        });
        accepted = result.accepted;
        startedSessionId = result.accepted ? String(result.sessionId || "") : "";
        if (result.accepted && !startedSessionId) {
          throw new Error("New task submission was accepted without a session id.");
        }
        if (result.accepted && startedSessionId) {
          const resultRecord = asRecord(result.snapshot);
          const resultSessionId = String(resultRecord?.sessionId || "");
          if (!resultRecord || resultSessionId !== startedSessionId) {
            throw new Error("New task session returned a mismatched session snapshot.");
          }
          // The session projection is authoritative. The optimistic input row
          // remains a renderer concern until the durable user item arrives.
          applyFocusedSnapshotToSessionLane(resultRecord as Snapshot, defaultSessionLaneStore, {
            source: "renderer-result",
          });
        }
        if (result.accepted && draftStillSelected()) {
          clearNewTaskPreferences(routeSelection);
          setNewTaskDeferred(false);
        }
      } else if (routeSelection.kind === "session") {
        accepted = await host.submitToSession(routeSelection.id, content, options);
      } else {
        throw new Error("Prompt submission requires a New task draft or session.");
      }
    } catch (reason) {
      sessionRefresh.current = {
        submitInFlight: false,
        accepted: false,
        sawBusy: false,
        sawSettlement: false,
      };
      throw reason;
    }
    pending.submitInFlight = false;
    if (accepted === true) {
      pending.accepted = true;
      // Consume the reservation once a session actually claimed it, even when
      // the user already navigated away: the seat is taken either way.
      if (newTaskRemoteRequested) setRemoteNewTaskMode("off");
      if (routeSelection.kind === "new" && draftRouteStillExists()) {
        const activeSessionId = startedSessionId;
        if (activeSessionId) {
          const title = promptTitle(content, options?.displayText || "") || "New task";
          const sessionSelection = { kind: "session", id: activeSessionId } as const;
          if (draftStillSelected()) {
            navigationEpoch.current += 1;
            activateSelection(sessionSelection, title, draftKey);
            setNewTaskDeferred(false);
          } else {
            // The ACK belongs to the pane/draft that dispatched it. A focus
            // change while it was in flight may not redirect the promotion or
            // pull the user back from the pane they moved to.
            promoteSelectionInLeaf(route.leafId, sessionSelection, draftKey);
            registerWorkspaceSelection(sessionSelection, title, draftKey);
          }
        }
      }
      refreshSettledSession();
    } else {
      sessionRefresh.current = {
        submitInFlight: false,
        accepted: false,
        sawBusy: false,
        sawSettlement: false,
      };
    }
    return accepted;
  }, [
    activateSelection,
    clearNewTaskPreferences,
    effectiveDraftProjectPath,
    isBusy,
    promoteSelectionInLeaf,
    refreshSettledSession,
    registerWorkspaceSelection,
    resolvedDraftPrefsFor,
  ]);
  const submitFromRouteRef = useRef(submitFromRoute);
  submitFromRouteRef.current = submitFromRoute;
  const submit = useCallback((
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<unknown> => submitFromRouteRef.current({
    selection: selectionRef.current,
    leafId: focusedLeafIdRef.current,
  }, content, options), []);
  // Split panes: a session pane's prompt path is addressed by ITS sessionId,
  // never by the globally active selection. Snapshot lanes are already
  // pane-local; routing every submit through the active route made a focused
  // pane's Enter land in — or promote onto — another pane's session, or stall
  // silently when selection and focus disagreed (user: 다른 세션이 복사됨 /
  // 간헐적으로 입력이 안 먹음).
  const submitToPaneSession = useCallback(async (
    sessionId: string,
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<unknown> => {
    const host = window.mixdogDesktop;
    if (!host) return false;
    // Watchdog: a session-addressed submit that never acknowledges must fail
    // loudly — the composer then restores the exact draft — instead of eating
    // the prompt behind an endless "Requesting" state.
    const PANE_SUBMIT_ACK_TIMEOUT_MS = 15_000;
    let watchdog: number | undefined;
    let accepted: unknown;
    try {
      accepted = await Promise.race([
        host.submitToSession(sessionId, content, options),
        new Promise<never>((_, reject) => {
          watchdog = window.setTimeout(() => reject(new Error(
            "The session did not acknowledge the prompt in time. Your message was restored — try again.",
          )), PANE_SUBMIT_ACK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (watchdog !== undefined) window.clearTimeout(watchdog);
    }
    if (accepted === true) refreshSettledSession();
    return accepted;
  }, [refreshSettledSession]);
  // Stable per-session submit identity so memoised pane trees do not
  // re-render from a fresh closure on every App commit.
  const paneSessionSubmitCache = useRef(new Map<string, (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ) => Promise<unknown>>());
  const submitToPaneSessionRef = useRef(submitToPaneSession);
  submitToPaneSessionRef.current = submitToPaneSession;
  const paneSubmitFor = (sessionId: string) => {
    let fn = paneSessionSubmitCache.current.get(sessionId);
    if (!fn) {
      fn = (content, options) =>
        submitToPaneSessionRef.current(sessionId, content, options);
      paneSessionSubmitCache.current.set(sessionId, fn);
      while (paneSessionSubmitCache.current.size > 32) {
        const oldest = paneSessionSubmitCache.current.keys().next().value;
        if (oldest === undefined) break;
        paneSessionSubmitCache.current.delete(oldest);
      }
    }
    return fn;
  };
  const paneDraftSubmitCache = useRef(new Map<string, (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ) => Promise<unknown>>());
  const paneDraftSubmitFor = (
    draftSelection: Extract<NavigationSelection, { kind: "new" }>,
    leafId: string,
  ) => {
    const key = `${leafId}\u0000${navigationKey(draftSelection)}`;
    let fn = paneDraftSubmitCache.current.get(key);
    if (!fn) {
      fn = (content, options) => submitFromRouteRef.current({
        selection: draftSelection,
        leafId,
      }, content, options);
      paneDraftSubmitCache.current.set(key, fn);
      while (paneDraftSubmitCache.current.size > 32) {
        const oldest = paneDraftSubmitCache.current.keys().next().value;
        if (oldest === undefined) break;
        paneDraftSubmitCache.current.delete(oldest);
      }
    }
    return fn;
  };
  const visibleSnapshot = selection.kind === "new"
    ? EMPTY_SNAPSHOT
    : snapshot;
  const navigationSelection: NavigationSelection = selection;
  // Stable identity: SessionSidebar is memoised and must not re-render from a
  // fresh selection object literal on every App commit.
  const sidebarSelection: NavigationSelection = useMemo(
    () => requestedSessionId
      ? { kind: "session", id: requestedSessionId }
      : navigationSelection,
    [requestedSessionId, navigationSelection],
  );
  // Viewing a session consumes its unread dot. The foreign-frame gate keeps
  // tracking the COMMITTED selection only, while unread consumption also
  // covers the in-flight switch target so a slow resume or fork-on-resume
  // never strands the clicked row's dot.
  const viewedSessionId = navigationSelection.kind === "session" ? navigationSelection.id : "";
  viewedSessionRef.current = viewedSessionId;
  const unreadViewedSessionId = requestedSessionId || viewedSessionId;
  unreadViewedSessionRef.current = unreadViewedSessionId;
  const onForeignFrameSuppressed = useCallback((liveSessionId: string) => {
    const now = Date.now();
    if (now - (foreignFrameLogAt.current.get(liveSessionId) || 0) < 10_000) return;
    foreignFrameLogAt.current.set(liveSessionId, now);
    // The selector runs during render: defer the diagnostic side effect.
    queueMicrotask(() => {
      try {
        const line = `foreign-session-frame suppressed live=${liveSessionId} viewed=${viewedSessionRef.current}`;
        console.warn(`[mixdog] ${line}`);
        window.mixdogDesktop?.perfLog?.(line);
      } catch { /* diagnostics only */ }
    });
  }, []);
  const conversationSessionScope = useMemo<SnapshotSessionScope>(() => ({
    sessionId: viewedSessionId,
    onForeignFrameSuppressed,
  }), [onForeignFrameSuppressed, viewedSessionId]);
  useEffect(() => {
    consumeUnread(unreadViewedSessionId, sessions);
  }, [consumeUnread, sessions, unreadViewedSessionId, windowFocusTick]);
  const selectedSession = navigationSelection.kind === "session"
    ? sessions.find((session) => session.id === navigationSelection.id)
    : undefined;
  const currentSessionTitle = selectedSession ? sessionSummaryTitle(selectedSession) : "";
  const workingSessionIds = useMemo(() => {
    const activeSessionId = String(sidebarSnapshot.sessionId || "");
    return workingSessionIdsForSnapshot(
      sessions,
      activeSessionId,
      activeBusy,
      sidebarSnapshot.sessionRemoteAttached === true,
    );
  }, [activeBusy, sessions, sidebarSnapshot.sessionId, sidebarSnapshot.sessionRemoteAttached]);
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
  const snapshotProjectPath = registeredProjectPath(
    String(asRecord(visibleSnapshot)?.currentProject || ""),
  );
  const activeProjectPath = navigationSelection.kind === "session"
    ? registeredProjectPath(selectedSession?.projectPath || snapshotProjectPath)
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
    if (!paneTranscriptRendererPending) return undefined;
    let active = true;
    void preloadMarkdownBody()
      .catch(() => undefined)
      .finally(() => {
        if (active) setMarkdownBodyReadyForTranscript(true);
      });
    return () => { active = false; };
  }, [paneTranscriptRendererPending]);
  // The SESSION-TRANSITION frame. While a requested switch is in flight and
  // the focused engine still publishes the OUTGOING session, the focused
  // single-surface route paints the TARGET's last cached frame instead of
  // that foreign transcript; a genuinely cold target has no seed and keeps
  // its surface cover. It is never derived from Markdown/renderer readiness —
  // freezing on chunk readiness also froze the composer route, queue and
  // command state.
  // Subscribe to the REQUESTED session's lane while the switch is in flight:
  // the click-time disk peek (or a background pane's stream) lands there, and
  // without this subscription nothing re-rendered the single-surface route,
  // so a cold target kept painting the outgoing transcript.
  // Collapse-equal: only the seed APPEARING (null -> first frame) matters. A
  // BUSY target streams lane frames at turn cadence, and re-rendering the
  // whole App per frame during the transition hitched the close-fallback
  // switch onto a working session for seconds (user report).
  useSessionLane(requestedSessionId, defaultSessionLaneStore, () => true);
  const frozenSnapshot = requestedSessionId
    && requestedSessionId !== String(snapshot.sessionId || "")
    ? availableFrozenSeedFor(requestedSessionId)
    : null;
  const conversationFrozenSnapshot = frozenSnapshot;
  const hideLiveSnapshot = selection.kind === "new";
  const [fileReveal, setFileReveal] = useState<{ key: string; line: number; nonce: number } | null>(null);
  const latestEditorLocation = useRef<EditorNavigationLocation | null>(null);
  const editorNavigationHistory = useRef<{
    entries: EditorNavigationLocation[];
    index: number;
  }>({ entries: [], index: -1 });
  const [, setEditorNavigationRevision] = useState(0);
  const recordEditorNavigation = useCallback((target: EditorNavigationLocation) => {
    const history = editorNavigationHistory.current;
    const entries = history.entries.slice(0, history.index + 1);
    const same = (left: EditorNavigationLocation | undefined, right: EditorNavigationLocation) =>
      Boolean(left && left.project === right.project && left.rel === right.rel
        && left.line === right.line && left.accessToken === right.accessToken);
    const append = (location: EditorNavigationLocation | null) => {
      if (location && !same(entries.at(-1), location)) entries.push(location);
    };
    append(latestEditorLocation.current);
    append(target);
    history.entries = entries.slice(-200);
    history.index = history.entries.length - 1;
    latestEditorLocation.current = target;
    setEditorNavigationRevision((revision) => revision + 1);
  }, []);
  const openFileTab = useCallback((
    project: string,
    rel: string,
    line?: number,
    accessToken?: string,
    recordHistory = true,
    openMode: "preview" | "pinned" = "pinned",
  ) => {
    const cleanProject = String(project || "").trim();
    const cleanRel = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleanProject || !cleanRel) return;
    void primeEditorFileLoad(
      window.mixdogDesktop,
      cleanProject,
      cleanRel,
      accessToken,
    )?.catch(() => {});
    void prefetchEditorPane()
      .then(() => reportEditorLoadStage(
        cleanProject,
        cleanRel,
        accessToken,
        "module",
      ))
      .catch(() => {});
    const fileSelection: NavigationSelection = {
      kind: "file",
      project: cleanProject,
      rel: cleanRel,
      ...(accessToken ? { accessToken } : {}),
    };
    const key = navigationKey(fileSelection);
    const targetLocation = {
      project: cleanProject,
      rel: cleanRel,
      line: typeof line === "number" && line > 0 ? line : 1,
      ...(accessToken ? { accessToken } : {}),
    };
    if (recordHistory) recordEditorNavigation(targetLocation);
    else latestEditorLocation.current = targetLocation;
    setTabs((current) => {
      const existingIndex = current.findIndex((tab) =>
        tab.key === key
        || (tab.selection.kind === "file"
          && tab.selection.project === cleanProject
          && tab.selection.rel === cleanRel));
      if (existingIndex < 0) {
        return [...current, { key, title: cleanRel.split("/").at(-1) || cleanRel, selection: fileSelection }];
      }
      const existing = current[existingIndex];
      if (existing.selection.kind !== "file") return current;
      const resolvedAccessToken = accessToken || existing.selection.accessToken;
      if (existing.key === navigationKey({
        ...fileSelection,
        ...(resolvedAccessToken ? { accessToken: resolvedAccessToken } : {}),
      }) && existing.selection.accessToken === resolvedAccessToken) return current;
      const resolvedSelection: NavigationSelection = {
        ...fileSelection,
        ...(resolvedAccessToken ? { accessToken: resolvedAccessToken } : {}),
      };
      return current.map((tab, index) => index === existingIndex
        ? { ...tab, key: navigationKey(resolvedSelection), selection: resolvedSelection }
        : tab);
    });
    openSelectionInFocusedPane(
      fileSelection,
      "",
      { preview: openMode === "preview" },
    );
    if (typeof line === "number" && line > 0) {
      setFileReveal({ key, line, nonce: Date.now() });
    }
  }, [openSelectionInFocusedPane, recordEditorNavigation]);
  const openProblemQuickFix = useCallback((problem: EditorProblem) => {
    openFileTab(problem.projectPath, problem.relPath, problem.startLineNumber);
    let done = false;
    let timeout = 0;
    let unsubscribe = () => {};
    const stop = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timeout);
      unsubscribe();
    };
    const tryOpen = () => {
      const active = getEditorLanguageSnapshot().active;
      if (!active
        || active.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
          !== problem.projectPath.replace(/[\\/]+/g, "/").toLocaleLowerCase()
        || active.relPath.replace(/\\/g, "/").toLocaleLowerCase()
          !== problem.relPath.replace(/\\/g, "/").toLocaleLowerCase()) return;
      stop();
      window.requestAnimationFrame(() => window.dispatchEvent(
        new CustomEvent("mixdog:editor-action", {
          detail: {
            action: "quickFix",
            line: problem.startLineNumber,
            column: problem.startColumn,
          },
        }),
      ));
    };
    unsubscribe = subscribeEditorLanguageStore(tryOpen);
    timeout = window.setTimeout(stop, 4_000);
    tryOpen();
  }, [openFileTab]);
  const navigateEditorHistory = useCallback((offset: -1 | 1) => {
    const history = editorNavigationHistory.current;
    const nextIndex = history.index + offset;
    const target = history.entries[nextIndex];
    if (!target) return;
    history.index = nextIndex;
    latestEditorLocation.current = target;
    setEditorNavigationRevision((revision) => revision + 1);
    openFileTab(
      target.project,
      target.rel,
      target.line,
      target.accessToken,
      false,
    );
  }, [openFileTab]);
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
  const dockOpenAgentSession = useStableEvent((
    sessionId: string,
    title: string,
    ownerSessionId: string,
  ) => {
    const childSessionId = String(sessionId || "").trim();
    const ownerId = String(ownerSessionId || "").trim();
    if (!childSessionId) return;
    const agentSelection: Extract<WorkspaceSelection, { kind: "agent-session" }> = {
      kind: "agent-session",
      id: childSessionId,
      ownerSessionId: ownerId || childSessionId,
      title: String(title || "").trim() || "Agent",
    };
    const key = navigationKey(agentSelection);
    setTabs((current) => {
      const existing = current.findIndex((tab) => tab.key === key);
      if (existing < 0) {
        return [...current, { key, title: agentSelection.title, selection: agentSelection }];
      }
      const next = [...current];
      next[existing] = { key, title: agentSelection.title, selection: agentSelection };
      return next;
    });
    openSelectionInFocusedPane(agentSelection);
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
  const navigateTab = (tab: WorkspaceTab) => {
    if (tab.selection.kind === "file") {
      // The focused group owns the visible editor tab (add-or-activate).
      openSelectionInFocusedPane(tab.selection);
      focusPaneTypingSurface(paneWorkspace.focusedLeafId, tab.selection);
      return;
    }
    if (tab.selection.kind === "agent-session" || tab.selection.kind === "studio"
      || tab.selection.kind === "terminal"
      || tab.selection.kind === "folder"
      || tab.selection.kind === "diff" || tab.selection.kind === "pull-request") {
      openSelectionInFocusedPane(tab.selection);
      focusPaneTypingSurface(paneWorkspace.focusedLeafId, tab.selection);
      return;
    }
    // Chat surfaces reclaim the caret on EVERY tab navigation, not only when
    // returning from a file tab (user: 컨트롤 좌우/포커싱 시 타이핑 커서가
    // 안 잡히는 경우가 없어야 한다).
    setComposerFocusRequest((value) => value + 1);
    if (tab.key === activeTabKey) return;
    if (tab.selection.kind === "new") startTask(tab.selection);
    else if (tab.selection.kind === "project") startProject(tab.selection.path);
    else openSession(tab.selection.id);
  };
  /** Land the caret in the pane's typing surface after EVERY tab/pane
   *  navigation (user: 커서는 자동으로 다 잡아주되, 터미널에 들어가서도
   *  Ctrl 좌우 탭 전환은 계속 동작). Chat surfaces ride the composer
   *  focusRequest channel; Monaco, xterm and Studio's prompt are focused
   *  directly once mounted. Ctrl/Alt+Arrow keep working from ALL of them
   *  because the skip-shell capture handler in app-workspace-shortcuts owns
   *  those keys before xterm/Monaco can swallow them. */
  const paneTypingFocusGeneration = useRef(0);
  const focusPaneTypingSurface = (
    leafId: string,
    selection: WorkspaceSelection | null | undefined,
  ) => {
    if (!selection) return;
    if (selection.kind === "session" || selection.kind === "new"
      || selection.kind === "project") {
      setComposerFocusRequest((value) => value + 1);
      return;
    }
    const selector = selection.kind === "terminal"
      ? "[data-surface-active='true'] .xterm-helper-textarea"
      : selection.kind === "studio"
        ? "[data-surface-active='true'] textarea"
        : selection.kind === "file" || selection.kind === "diff"
          || selection.kind === "pull-request"
          ? "[data-surface-active='true'] .monaco-editor textarea.inputarea"
          : "";
    if (!selector) return;
    // Moving the caret is the declared intent: release the OLD surface's
    // focus now, so keystrokes typed before the new surface mounts fall into
    // limbo (and still let the pending focus land) instead of leaking into
    // the now-hidden previous input.
    if (document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    // Studio/terminal may still be importing/booting (cold entry rebuilds
    // xterm and can take seconds): retry for ~10s. A newer focus request or
    // a user gesture that engages another real input wins — the pending
    // focus must never steal a caret the user re-engaged.
    const generation = ++paneTypingFocusGeneration.current;
    let tries = 600;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      detach();
    };
    // Held-modifier auto-repeat (Ctrl during rapid tab cycling) is not a
    // user re-engagement; neither is typing into LIMBO (no focused input) —
    // that is the user already typing at the incoming surface, so the
    // pending focus must still land. Only typing that goes into another
    // real input (old composer, rename field, xterm) cancels.
    const onKeyCancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Alt"
        || event.key === "Shift" || event.key === "Meta") return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const typingTarget = target && (target.tagName === "TEXTAREA"
        || target.tagName === "INPUT" || target.isContentEditable
        || target.closest(".xterm"));
      if (typingTarget) cancel();
    };
    const detach = () => {
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("keydown", onKeyCancel, true);
    };
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("keydown", onKeyCancel, true);
    const attempt = () => {
      if (cancelled || generation !== paneTypingFocusGeneration.current) {
        detach();
        return;
      }
      const pane = document.querySelector<HTMLElement>(`[data-pane-id="${leafId}"]`);
      const target = pane
        ? [...pane.querySelectorAll<HTMLElement>(selector)]
          .find((element) => element.getClientRects().length > 0)
        : undefined;
      if (target) {
        target.focus({ preventScroll: true });
        // focus() is a silent no-op inside an inert or still-covered
        // surface (boot gates): only a VERIFIED caret ends the retries.
        if (document.activeElement === target) {
          detach();
          return;
        }
      }
      if (tries-- > 0) {
        window.requestAnimationFrame(attempt);
        return;
      }
      detach();
    };
    window.requestAnimationFrame(attempt);
  };
  /** Close one tab inside one group. The registry
   *  entry only leaves when no other group still shows the tab; an emptied
   *  group collapses into its split sibling. */
  const closeTabNow = (leafId: string, tab: WorkspaceTab) => {
    const leaf = paneWorkspace.leaves.find((entry) => entry.id === leafId);
    if (!leaf) return;
    const openElsewhere = paneWorkspace.leaves.some((entry) => entry.id !== leafId
      && entry.tabs.some((selection) => navigationKey(selection) === tab.key));
    // Fallback BEFORE the model change: the group's next tab, else the
    // neighbor pane's active view (the group collapsed).
    const leafTabs: WorkspaceTab[] = leaf.tabs.map((selection) => ({
      key: navigationKey(selection), title: "", selection,
    }));
    const groupFallback = nextWorkspaceTabAfterClose(leafTabs, tab.key);
    const wasFocused = leafId === paneWorkspace.focusedLeafId;
    const wasActive = wasFocused && tab.key === leaf.activeKey;
    const closingSession = tab.selection.kind === "new"
      || tab.selection.kind === "session"
      || tab.selection.kind === "project";
    const fallback = groupFallback ?? (() => {
      const neighbor = paneWorkspace.leaves.find((entry) => entry.id !== leafId);
      if (!neighbor) return undefined;
      const selection = paneActiveSelection(neighbor);
      return selection ? { key: navigationKey(selection), title: "", selection } : undefined;
    })();
    const commitClose = () => {
      if (!openElsewhere) {
        if (tab.selection.kind === "file") {
          handleFileDirty(tab.key, false);
          editorSaveHandles.current.delete(tab.key);
        }
        if (tab.selection.kind === "terminal") void disposeTerminalPane(tab.selection.id);
        setTabs((current) => current.filter((item) => item.key !== tab.key));
      }
      paneWorkspace.closeTab(leafId, tab.key);
    };
    if (!wasActive) {
      commitClose();
      return;
    }
    // Remove the tab model immediately. When the fallback is another session,
    // the pane-local Conversation owner paints the outgoing transcript inert
    // until resume settles; the strip never waits on host RPC.
    if (closingSession && fallback?.selection.kind === "session") {
      if (tab.selection.kind === "session" || tab.selection.kind === "new") {
        const handoff: ConversationHandoff = {
          kind: "close",
          leafId,
          selection: tab.selection,
        };
        pendingConversationHandoff.current = handoff;
        setConversationHandoff(handoff);
      }
      commitClose();
      void openSession(fallback.selection.id);
      return;
    }
    commitClose();
    if (fallback) navigateTab(fallback);
    else {
      // The last tab closed: the pane model reset to the EMPTY workspace, so
      // show the guidance screen instead of auto-opening a draft. Clear the
      // lingering interactive selection and the startup restore target.
      selectionRef.current = { kind: "new" };
      viewedSessionRef.current = "";
      unreadViewedSessionRef.current = "";
      setSelection({ kind: "new" });
      setRequestedSessionId("");
      try { window.localStorage.removeItem(LAST_SESSION_KEY); } catch { /* best-effort */ }
    }
    // Closing the visible editor tab lands back on a chat surface.
    if (!closingSession && fallback
      && (fallback.selection.kind === "new" || fallback.selection.kind === "session"
        || fallback.selection.kind === "project")) {
      setComposerFocusRequest((value) => value + 1);
    }
  };
  const closeTab = (leafId: string, tab: WorkspaceTab) => {
    const openElsewhere = paneWorkspace.leaves.some((entry) => entry.id !== leafId
      && entry.tabs.some((selection) => navigationKey(selection) === tab.key));
    if (!openElsewhere && tab.selection.kind === "file" && dirtyFileKeys.has(tab.key)) {
      setUnsavedCloseError("");
      setPendingUnsavedCloses((queue) =>
        queue.some((entry) => entry.tab.key === tab.key) ? queue : [...queue, { leafId, tab }]);
      return;
    }
    closeTabNow(leafId, tab);
  };
  const saveAndClosePendingTab = async () => {
    const pending = pendingUnsavedClose;
    if (!pending || unsavedCloseBusy) return;
    const handle = editorSaveHandles.current.get(pending.tab.key);
    if (!handle) {
      setUnsavedCloseError("The editor is unavailable. Return to the file and try again.");
      return;
    }
    setUnsavedCloseBusy(true);
    setUnsavedCloseError("");
    const saved = await handle.save();
    setUnsavedCloseBusy(false);
    if (!saved) {
      setUnsavedCloseError("The file could not be saved. Resolve the editor error and try again.");
      return;
    }
    setPendingUnsavedCloses((queue) => queue.slice(1));
    closeTabNow(pending.leafId, pending.tab);
  };
  const discardAndClosePendingTab = async () => {
    const pending = pendingUnsavedClose;
    if (!pending || unsavedCloseBusy) return;
    await editorSaveHandles.current.get(pending.tab.key)?.discard();
    setPendingUnsavedCloses((queue) => queue.slice(1));
    setUnsavedCloseError("");
    closeTabNow(pending.leafId, pending.tab);
  };
  const cancelPendingTabClose = () => {
    if (unsavedCloseBusy) return;
    // Cancel abandons the whole batch (VS Code: canceling one prompt stops
    // the remaining queued closes too).
    setPendingUnsavedCloses([]);
    setUnsavedCloseError("");
  };
  // The focused group's tabs anchor tab cycling and mod+W (VS Code: shortcuts
  // act within the active editor group).
  const focusedLeafForShortcuts = paneWorkspace.focusedLeaf;
  const focusedLeafTabs = useMemo<WorkspaceTab[]>(
    () => (focusedLeafForShortcuts?.tabs ?? []).map((selection) => ({
      key: navigationKey(selection), title: "", selection,
    })),
    [focusedLeafForShortcuts],
  );
  const focusedActiveTabKey = requestedSessionId
    ? navigationKey({ kind: "session", id: requestedSessionId })
    : focusedPaneSelection ? navigationKey(focusedPaneSelection) : activeTabKey;
  useEffect(() => {
    if (!focusedActiveTabKey) return;
    tabMruRef.current = [
      focusedActiveTabKey,
      ...tabMruRef.current.filter((key) => key !== focusedActiveTabKey),
    ].slice(0, 100);
  }, [focusedActiveTabKey]);
  const openTabSwitcher = (offset: number) => {
    if (focusedLeafTabs.length < 2) return;
    setTabSwitcher((current) => {
      if (current) {
        return {
          ...current,
          index: (current.index + offset + current.keys.length) % current.keys.length,
        };
      }
      const mru = tabMruRef.current;
      const keys = [
        ...mru.filter((key) => focusedLeafTabs.some((tab) => tab.key === key)),
        ...focusedLeafTabs.map((tab) => tab.key).filter((key) => !mru.includes(key)),
      ];
      if (keys.length < 2) return current;
      return { keys, index: offset > 0 ? 1 : keys.length - 1 };
    });
  };
  // Shortcut tab navigation mirrors the strip's click path: activate the
  // pane's tab FIRST, then run the selection side effects. navigateTab alone
  // early-returns when the target key equals the stale global active key, so
  // cycling from Studio back to the previous session did nothing (user:
  // 스튜디오로 가면 컨트롤 좌우가 안 먹는다).
  const navigateFocusedPaneTab = (tab: WorkspaceTab) => {
    paneWorkspace.activateTab(paneWorkspace.focusedLeafId, tab.key);
    navigateTab(tab);
  };
  useEffect(() => {
    if (!tabSwitcher) return undefined;
    const commit = () => {
      setTabSwitcher(null);
      const key = tabSwitcher.keys[tabSwitcher.index];
      const tab = focusedLeafTabs.find((entry) => entry.key === key);
      if (tab && key !== focusedActiveTabKey) navigateFocusedPaneTab(tab);
    };
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setTabSwitcher(null);
    };
    const onKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Control" || event.key === "Meta") commit();
    };
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("blur", commit);
    return () => {
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("blur", commit);
    };
  }, [tabSwitcher, focusedLeafTabs, focusedActiveTabKey, navigateFocusedPaneTab]);
  // Global workspace shortcuts live in app-workspace-shortcuts.ts.
  // Ctrl+T and Ctrl+` are a TOGGLE: pressing again closes the bottom terminal
  // and hands the caret back to the focused pane (user: 다시 눌러서 닫히는 게
  // 안 됨 — 커서가 터미널에 잡혀 있어서).
  // Opening must land the caret INSIDE the panel terminal so typing starts
  // immediately (user: 인터셉트는 하되 타이핑은 바로 되었으면), even though the
  // pane-scoped focus helper cannot reach the bottom panel.
  const panelTerminalFocusGeneration = useRef(0);
  const focusPanelTerminal = () => {
    const generation = ++panelTerminalFocusGeneration.current;
    // A cold panel rebuilds xterm; retry until a VERIFIED caret lands.
    let tries = 600;
    const attempt = () => {
      if (generation !== panelTerminalFocusGeneration.current) return;
      const target = document.querySelector<HTMLTextAreaElement>(
        ".workbench-terminal-panel .xterm-helper-textarea");
      if (target && target.getClientRects().length > 0) {
        target.focus({ preventScroll: true });
        if (document.activeElement === target) return;
      }
      if (tries-- > 0) window.requestAnimationFrame(attempt);
    };
    window.requestAnimationFrame(attempt);
  };
  const toggleTerminalPanel = () => {
    if (bottomPanel.open && bottomPanel.tab === "terminal") {
      bottomPanel.setOpen(false);
      // Cancel any pending panel focus so it cannot steal the caret back.
      panelTerminalFocusGeneration.current += 1;
      const leaf = paneWorkspace.leaves.find((item) => item.id === paneWorkspace.focusedLeafId);
      if (leaf) focusPaneTypingSurface(leaf.id, paneActiveSelection(leaf));
      return;
    }
    void prefetchTerminalPane().catch(() => {});
    dismissSheetsForBottomPanel();
    bottomPanel.setTab("terminal");
    focusPanelTerminal();
  };
  // Axis-aware pane focus cycle. Left/right keeps visual row-major order;
  // up/down walks each vertical lane before wrapping into the next one.
  const focusSiblingPane = (
    offset: number,
    axis: "horizontal" | "vertical",
  ) => {
    const leaves = axis === "vertical"
      ? paneLeavesInColumnOrder(paneWorkspace.layout)
      : paneLeavesInVisualOrder(paneWorkspace.layout);
    if (leaves.length < 2) return;
    const index = leaves.findIndex((leaf) => leaf.id === paneWorkspace.focusedLeafId);
    const next = leaves[(index + offset + leaves.length) % leaves.length];
    if (!next) return;
    paneWorkspace.focusLeaf(next.id);
    // Mirror the pane-click path: route the engine surface AND land the
    // caret in that pane's typing area.
    const nextActive = paneActiveSelection(next);
    if (nextActive) activatePaneSurface(nextActive);
    focusPaneTypingSurface(next.id, nextActive);
  };
  useWorkspaceShortcuts({
    tabs: focusedLeafTabs,
    // File-editor tabs live in the same strip: cycling and mod+W must anchor
    // on the visible tab. During a stable session request, continue cycling
    // from the requested row even though the outgoing pane remains mounted.
    activeTabKey: focusedActiveTabKey,
    navigateTab: navigateFocusedPaneTab,
    // Alt+arrows: axis-specific pane focus cycles across every group.
    focusSiblingPane,
    startTask,
    openSettings,
    toggleSidebar,
    toggleDock,
    togglePanel: toggleBottomPanel,
    openTerminalPanel: toggleTerminalPanel,
    openQuickAccess: () => setQuickAccessMode("files"),
    openCommandPalette: () => setQuickAccessMode("commands"),
    openFindInFiles: () => {
      openDockTab("search");
      window.dispatchEvent(new CustomEvent("mixdog:focus-dock-search"));
    },
    openTabSwitcher,
    navigateBack: () => navigateEditorHistory(-1),
    navigateForward: () => navigateEditorHistory(1),
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
  const workbenchCommands: WorkbenchCommand[] = quickAccessMode === "commands" ? [
    {
      id: "workbench.action.navigateBack",
      category: "Go",
      label: "Go Back",
      enabled: editorNavigationHistory.current.index > 0,
      run: () => navigateEditorHistory(-1),
    },
    {
      id: "workbench.action.navigateForward",
      category: "Go",
      label: "Go Forward",
      enabled: editorNavigationHistory.current.index >= 0
        && editorNavigationHistory.current.index < editorNavigationHistory.current.entries.length - 1,
      run: () => navigateEditorHistory(1),
    },
    {
      id: "workbench.action.quickOpen",
      category: "File",
      label: "Go to File…",
      shortcut: "Ctrl+P",
      run: () => setQuickAccessMode("files"),
    },
    {
      id: "workbench.action.files.openFile",
      category: "File",
      label: "Open File…",
      shortcut: "Ctrl+O",
      run: () => { void chooseFileTab(); },
    },
    {
      id: "workbench.action.files.save",
      category: "File",
      label: "Save",
      shortcut: "Ctrl+S",
      enabled: Boolean(activeFileKey && editorSaveHandles.current.has(activeFileKey)),
      run: async () => {
        const handle = editorSaveHandles.current.get(activeFileKey);
        if (handle) await handle.save();
      },
    },
    {
      id: "workbench.action.files.saveAll",
      category: "File",
      label: "Save All",
      enabled: dirtyFileKeys.size > 0,
      run: async () => {
        for (const key of dirtyFileKeys) {
          const handle = editorSaveHandles.current.get(key);
          if (handle && !await handle.save()) break;
        }
      },
    },
    {
      id: "workbench.action.closeActiveEditor",
      category: "File",
      label: "Close Editor",
      shortcut: "Ctrl+W",
      enabled: focusedLeafTabs.length > 0,
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:close-active-tab")); },
    },
    {
      id: "editor.action.toggleWordWrap",
      category: "View",
      label: "Toggle Word Wrap",
      shortcut: "Alt+Z",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.toggleWordWrap" })); },
    },
    {
      id: "workbench.action.showSearch",
      category: "View",
      label: "Show Search",
      run: () => openDockTab("search"),
    },
    {
      id: "workbench.action.findInFiles",
      category: "Search",
      label: "Find in Files…",
      shortcut: "Ctrl+Shift+F",
      run: () => {
        openDockTab("search");
        window.dispatchEvent(new CustomEvent("mixdog:focus-dock-search"));
      },
    },
    {
      id: "workbench.action.showSourceControl",
      category: "View",
      label: "Show Source Control",
      run: () => openDockTab("source-control"),
    },
    {
      id: "workbench.action.showProblems",
      category: "View",
      label: "Show Problems",
      run: () => bottomPanel.setTab("problems"),
    },
    {
      id: "workbench.action.togglePanel",
      category: "View",
      label: "Toggle Panel",
      shortcut: "Ctrl+J",
      run: toggleBottomPanel,
    },
    {
      id: "workbench.action.terminal.toggleTerminal",
      category: "Terminal",
      label: "Toggle Terminal",
      shortcut: "Ctrl+` / Ctrl+T",
      run: toggleTerminalPanel,
    },
    {
      id: "editor.action.revealDefinition",
      category: "Editor",
      label: "Go to Definition",
      shortcut: "F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.definition),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.revealDefinition" })); },
    },
    {
      id: "editor.action.peekDefinition",
      category: "Editor",
      label: "Peek Definition",
      shortcut: "Alt+F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.definition),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.peekDefinition" })); },
    },
    {
      id: "editor.action.revealDeclaration",
      category: "Editor",
      label: "Go to Declaration",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.declaration),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.revealDeclaration" })); },
    },
    {
      id: "editor.action.goToTypeDefinition",
      category: "Editor",
      label: "Go to Type Definition",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.typeDefinition),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.goToTypeDefinition" })); },
    },
    {
      id: "editor.action.goToImplementation",
      category: "Editor",
      label: "Go to Implementations",
      shortcut: "Ctrl+F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.implementation),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.goToImplementation" })); },
    },
    {
      id: "editor.action.goToReferences",
      category: "Editor",
      label: "Go to References",
      shortcut: "Shift+F12",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.references),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.goToReferences" })); },
    },
    {
      id: "editor.action.referenceSearch.trigger",
      category: "Editor",
      label: "Peek References",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.references),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.referenceSearch.trigger" })); },
    },
    {
      id: "editor.action.triggerSuggest",
      category: "Editor",
      label: "Trigger Suggest",
      shortcut: "Ctrl+Space",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.triggerSuggest" })); },
    },
    {
      id: "editor.action.triggerParameterHints",
      category: "Editor",
      label: "Trigger Parameter Hints",
      shortcut: "Ctrl+Shift+Space",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.signatureHelp),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.triggerParameterHints" })); },
    },
    {
      id: "editor.action.quickOutline",
      category: "Go",
      label: "Go to Symbol in Editor…",
      shortcut: "Ctrl+Shift+O",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.quickOutline" })); },
    },
    {
      id: "editor.action.rename",
      category: "Editor",
      label: "Rename Symbol",
      shortcut: "F2",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.rename),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "rename" })); },
    },
    {
      id: "editor.action.changeAll",
      category: "Editor",
      label: "Change All Occurrences",
      shortcut: "Ctrl+F2",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.changeAll" })); },
    },
    {
      id: "editor.action.quickFix",
      category: "Editor",
      label: "Quick Fix…",
      shortcut: "Ctrl+.",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.codeAction),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "quickFix" })); },
    },
    {
      id: "editor.action.refactor",
      category: "Editor",
      label: "Refactor…",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.codeAction),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "refactor" })); },
    },
    {
      id: "editor.action.sourceAction",
      category: "Editor",
      label: "Source Action…",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.codeAction),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.sourceAction" })); },
    },
    {
      id: "editor.action.formatDocument",
      category: "Editor",
      label: "Format Document",
      shortcut: "Shift+Alt+F",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.formatting),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "format" })); },
    },
    {
      id: "editor.action.formatDocument.multiple",
      category: "Editor",
      label: "Format Document With…",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.formatting),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.formatDocument.multiple" })); },
    },
    {
      id: "editor.action.formatSelection",
      category: "Editor",
      label: "Format Selection",
      shortcut: "Ctrl+K Ctrl+F",
      enabled: Boolean(activeFileKey
        && (editorCommandCapabilities.rangeFormatting || editorCommandCapabilities.formatting)),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.formatSelection" })); },
    },
    {
      id: "editor.action.commentLine",
      category: "Editor",
      label: "Toggle Line Comment",
      shortcut: "Ctrl+/",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.action.commentLine" })); },
    },
    {
      id: "editor.fold",
      category: "Editor",
      label: "Fold",
      shortcut: "Ctrl+Shift+[",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.fold" })); },
    },
    {
      id: "editor.unfold",
      category: "Editor",
      label: "Unfold",
      shortcut: "Ctrl+Shift+]",
      enabled: Boolean(activeFileKey),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "editor.unfold" })); },
    },
    {
      id: "editor.showCallHierarchy",
      category: "Editor",
      label: "Peek Call Hierarchy",
      shortcut: "Shift+Alt+H",
      enabled: Boolean(activeFileKey && editorCommandCapabilities.callHierarchy),
      run: () => { window.dispatchEvent(new CustomEvent("mixdog:editor-action", { detail: "callHierarchy" })); },
    },
    {
      id: "workbench.action.toggleSidebar",
      category: "View",
      label: "Toggle Primary Side Bar",
      shortcut: "Ctrl+B",
      run: toggleSidebar,
    },
    {
      id: "workbench.action.toggleUtilityPanel",
      category: "View",
      label: "Toggle Utility Panel",
      shortcut: "Ctrl+Alt+B",
      run: toggleDock,
    },
    {
      id: "workbench.action.terminal.new",
      category: "Terminal",
      label: "Create New Terminal",
      run: () => openTerminalTab(),
    },
    {
      id: "mixdog.action.openFolderPane",
      category: "View",
      label: "Open Folder…",
      run: () => openFolderTab(),
    },
    {
      id: "mixdog.action.newTask",
      category: "Task",
      label: "New Task",
      shortcut: "Ctrl+N",
      run: () => startTask(),
    },
    {
      id: "mixdog.action.newStudio",
      category: "Studio",
      label: "New Studio",
      run: () => openStudioTab(),
    },
    {
      id: "workbench.action.openSettings",
      category: "Preferences",
      label: "Open Settings",
      shortcut: "Ctrl+,",
      run: () => openSettings(),
    },
  ].filter((command) => {
    if (command.id === "workbench.action.showSearch"
      || command.id === "workbench.action.findInFiles") {
      return desktopFeatureEnabled("explorer");
    }
    if (command.id === "workbench.action.showSourceControl") {
      return desktopFeatureEnabled("sourceControl");
    }
    if (command.id === "workbench.action.openSettings") {
      return desktopFeatureEnabled("settings");
    }
    if (command.id === "workbench.action.toggleSidebar") {
      return desktopFeatureEnabled("sessions");
    }
    if (command.id === "workbench.action.toggleUtilityPanel") {
      return hasDesktopUtilityDockFeature;
    }
    return true;
  }) : [];

  // Rail destinations (Projects/Workflows/Schedules/Webhooks) swap the
  // session panel instead of owning the main pane (user decision): the
  // workspace, tab strips, and utility dock stay mounted and interactive
  // while their editors float as popup dialogs.
  type SidebarSurface = "sessions" | "utilities" | "schedules" | "webhooks" | "projects" | "workflows";
  const requestedSidebarSurface: SidebarSurface = utilitiesOpen ? "utilities"
    : schedulesOpen ? "schedules"
    : webhooksOpen ? "webhooks"
    : projectsOpen ? "projects"
    : workflowsOpen ? "workflows"
    : "sessions";
  const sidebarPanel = requestedSidebarSurface === "sessions" ? null : requestedSidebarSurface;
  // The sidebar subtree owns every visited panel's DOM and state, so it stays
  // mounted (inert + aria-hidden + zero width via .sidebar-collapsed / the
  // narrow drawer transform) once it has been opened: collapsing must not
  // destroy a visited destination's scroll, drafts, or dialogs. Warmth is
  // scoped to THIS tree instance — if the host ever unmounts, every panel
  // starts cold again.
  const [sidebarTreeBooted, setSidebarTreeBooted] = useState(sidebarOpen);
  useEffect(() => {
    if (sidebarOpen && !sidebarTreeBooted) setSidebarTreeBooted(true);
  }, [sidebarOpen, sidebarTreeBooted]);
  const sidebarTreeMounted = sidebarOpen || sidebarTreeBooted;
  // Entering a rail panel for the FIRST time cold-mounts its Suspense chunk,
  // so that one transition still settles hidden before it becomes visible
  // (user: 사이드탭 메뉴 전환 시 툭 튐). Once a destination has genuinely
  // resolved its module AND committed its content on screen, it is warm: the
  // request IS the presentation and flips in the click's own commit, because
  // an artificial settle window there only reads as input lag (user: 좌측
  // 메뉴 전환이 느리다).
  const warmSidebarSurfaces = useRef<ReadonlySet<SidebarSurface>>(new Set(["sessions"]));
  const [laggedSidebarSurface, setLaggedSidebarSurface] = useState<SidebarSurface>("sessions");
  const requestedSidebarPanelReady = requestedSidebarSurface === "sessions"
    || ((loadedSidebarPanels.has(requestedSidebarSurface)
      // A failed chunk still has content to present: the panel-local
      // unavailable state. It is presentable, never warm.
      || failedSidebarPanels.has(requestedSidebarSurface))
      && mountedSidebarPanels.has(requestedSidebarSurface));
  // A resolved module whose pane is already mounted hidden is just as ready
  // as a previously presented destination: both can become visible in this
  // click's own commit. Projects is prepared this way after boot so its rows
  // and overflow options never first-mount in front of the user.
  const requestedSidebarSurfaceWarm = sidebarTreeMounted
    && (warmSidebarSurfaces.current.has(requestedSidebarSurface)
      || (requestedSidebarSurface !== "sessions"
        && loadedSidebarPanels.has(requestedSidebarSurface)
        && mountedSidebarPanels.has(requestedSidebarSurface)));
  const presentedSidebarSurface: SidebarSurface = requestedSidebarSurfaceWarm
    ? requestedSidebarSurface
    : laggedSidebarSurface;
  useLayoutEffect(() => {
    if (laggedSidebarSurface === requestedSidebarSurface) return undefined;
    if (requestedSidebarSurfaceWarm) {
      // Presentation already followed the request during render; keep the
      // cold fallback aligned so the NEXT cold destination lags from the
      // surface the user is actually looking at.
      setLaggedSidebarSurface(requestedSidebarSurface);
      return undefined;
    }
    // A hidden sidebar has nothing to present: closing during a cold settle
    // cancels the pending commit (cleanup below), and reopening restarts the
    // full settle for the still-unresolved destination.
    if (!sidebarOpen || !sidebarTreeMounted) return undefined;
    // Never swap onto an unresolved chunk: the outgoing surface keeps its
    // pixels until the incoming panel can actually paint content.
    if (!requestedSidebarPanelReady) return undefined;
    return scheduleStableSurfaceCommit(() => setLaggedSidebarSurface(requestedSidebarSurface));
  }, [
    laggedSidebarSurface,
    requestedSidebarPanelReady,
    requestedSidebarSurface,
    requestedSidebarSurfaceWarm,
    sidebarOpen,
    sidebarTreeMounted,
  ]);
  useLayoutEffect(() => {
    if (!sidebarTreeMounted) {
      // The panel trees died with their host: nothing may claim to be warm.
      warmSidebarSurfaces.current = new Set(["sessions"]);
      return;
    }
    // Warm means committed usable content: the panel is mounted, its module
    // resolved, and it has actually been presented inside the open sidebar.
    if (!sidebarOpen || presentedSidebarSurface === "sessions") return;
    if (!loadedSidebarPanels.has(presentedSidebarSurface)) return;
    if (!mountedSidebarPanels.has(presentedSidebarSurface)) return;
    if (warmSidebarSurfaces.current.has(presentedSidebarSurface)) return;
    warmSidebarSurfaces.current = new Set([
      ...warmSidebarSurfaces.current,
      presentedSidebarSurface,
    ]);
  }, [
    loadedSidebarPanels,
    mountedSidebarPanels,
    presentedSidebarSurface,
    sidebarOpen,
    sidebarTreeMounted,
  ]);
  const presentedSidebarPanel = presentedSidebarSurface === "sessions"
    ? null
    : presentedSidebarSurface;
  // ACTIVE is the panel lifecycle the panes themselves see. A hidden sidebar
  // has no active destination: rail panels portal their editors to
  // document.body, where the sidebar's inert/aria-hidden does not reach, so a
  // titlebar/backdrop collapse must deactivate the panel even though the
  // request is unchanged. Panels close only their dialogs on deactivation and
  // keep list/filter state.
  const activeSidebarPanel = sidebarOpen ? presentedSidebarPanel : null;
  const SchedulesPane = sidebarPanes.schedules;
  const WebhooksPane = sidebarPanes.webhooks;
  const ProjectsPane = sidebarPanes.projects;
  const WorkflowsPane = sidebarPanes.workflows;
  const UtilitiesPane = sidebarPanes.utilities;
  const sidebarPanelTitle = presentedSidebarSurface === "utilities" ? "Utilities"
    : presentedSidebarSurface === "schedules" ? "Schedules"
    : presentedSidebarSurface === "webhooks" ? "Webhooks"
    : presentedSidebarSurface === "projects" ? "Projects"
    : presentedSidebarSurface === "workflows" ? "Workflows"
    : "";
  // Stable sidebar handlers + memoised panel children: SessionSidebar, its
  // rows, and every rail panel are memoised, but fresh inline closures and a
  // fresh children fragment on every App render defeated those boundaries —
  // a mere tab switch re-rendered the whole sidebar tree (profiled:
  // SessionRow/panel subtrees dominated fast-switch commits, user: 빨리
  // 움직이면 전 화면 잔상이 남는다).
  const sidebarNewTask = useStableEvent(() => {
    closeSidebarForNavigation();
    startTask();
  });
  const sidebarResumeSession = useStableEvent((sessionId: string) => {
    closeSidebarForNavigation();
    openSession(sessionId);
  });
  // Utilities rows launch tabs WITHOUT resetting the rail to Sessions: the
  // panel stays selected so repeated launches need no re-entry (user: 한번
  // 누르면 세션창으로 이동되는데 그냥 유지되도록).
  const utilitiesOpenStudio = useStableEvent(() => openStudioTab());
  const utilitiesOpenTerminal = useStableEvent(() => openTerminalTab());
  const utilitiesOpenExplorer = useStableEvent(() => openFolderTab());
  const projectsCreate = useStableEvent(async (path: string, name?: string) => {
    const host = window.mixdogDesktop;
    if (!host) throw new Error("Desktop bridge is unavailable.");
    await host.addProject(path);
    if (name) await host.renameProject(path, name);
    await refreshProjects();
  });
  const projectsOpenProject = useStableEvent((path: string) => {
    setProjectsOpen(false);
    // A project row opens the normal NEW TASK draft with the project
    // preselected (user: 프로젝트 누른 걸로 선택돼서 뉴태스크 생성하면
    // 되는데) — the bare `project` surface hid the context/remote/project/
    // workflow cluster, so it is no longer minted from the panel.
    selectNewTaskProject(path);
  });
  const projectsStartTask = useStableEvent((path: string) => {
    setProjectsOpen(false);
    startProjectTask(path);
  });
  const projectsOpenExplorer = useStableEvent((path: string) => void openProjectInExplorer(path));
  const projectsRename = useStableEvent((path: string, alias: string) => void renameProject(path, alias));
  const projectsRemove = useStableEvent((path: string) => void removeProject(path));
  const projectsSaveInstructions = useStableEvent(async (path: string, content: string) => {
    const host = window.mixdogDesktop;
    if (!host?.writeInstructions) throw new Error("Desktop bridge is unavailable.");
    await host.writeInstructions(path, content);
  });
  const sidebarPanelChildren = useMemo(() => <>
    {/* One bounded boundary per destination: a rejected chunk becomes a
        compact panel-local unavailable state instead of escaping to the
        root and replacing the whole app. */}
    {mountedSidebarPanels.has("utilities") && (
    <SidebarPanelBoundary label="Utilities" active={activeSidebarPanel === "utilities"}
      onFailure={() => markSidebarPanelFailed("utilities")}
      onRetry={() => retrySidebarPanel("utilities")}>
    <Suspense fallback={null}>
      <UtilitiesPane active={activeSidebarPanel === "utilities"}
        onOpenStudio={utilitiesOpenStudio}
        onOpenTerminal={utilitiesOpenTerminal}
        onOpenExplorer={utilitiesOpenExplorer} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("schedules") && (
    <SidebarPanelBoundary label="Schedules" active={activeSidebarPanel === "schedules"}
      onFailure={() => markSidebarPanelFailed("schedules")}
      onRetry={() => retrySidebarPanel("schedules")}>
    <Suspense fallback={null}>
      <SchedulesPane active={activeSidebarPanel === "schedules"}
        runningNames={runningAutomationNames.schedule} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("webhooks") && (
    <SidebarPanelBoundary label="Webhooks" active={activeSidebarPanel === "webhooks"}
      onFailure={() => markSidebarPanelFailed("webhooks")}
      onRetry={() => retrySidebarPanel("webhooks")}>
    <Suspense fallback={null}>
      <WebhooksPane active={activeSidebarPanel === "webhooks"}
        runningNames={runningAutomationNames.webhook} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("workflows") && (
    <SidebarPanelBoundary label="Workflows" active={activeSidebarPanel === "workflows"}
      onFailure={() => markSidebarPanelFailed("workflows")}
      onRetry={() => retrySidebarPanel("workflows")}>
    <Suspense fallback={null}>
      <WorkflowsPane active={activeSidebarPanel === "workflows"} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
    {mountedSidebarPanels.has("projects") && (
    <SidebarPanelBoundary label="Projects" active={activeSidebarPanel === "projects"}
      onFailure={() => markSidebarPanelFailed("projects")}
      onRetry={() => retrySidebarPanel("projects")}>
    <Suspense fallback={null}>
      <ProjectsPane active={activeSidebarPanel === "projects"}
        projects={projects} selectedProjectPath={selectedProjectPath}
        onChooseFolder={async () => (await window.mixdogDesktop?.chooseProject()) ?? null}
        onCreateProject={projectsCreate}
        onOpenProject={projectsOpenProject}
        onStartProjectTask={projectsStartTask}
        onOpenExplorer={projectsOpenExplorer}
        onRename={projectsRename}
        onRemove={projectsRemove}
        instructionsSupported={!!window.mixdogDesktop?.readInstructions}
        onReadInstructions={async (path) => (await window.mixdogDesktop?.readInstructions?.(path)) ?? ''}
        onSaveInstructions={projectsSaveInstructions} />
    </Suspense>
    </SidebarPanelBoundary>
    )}
  </>, [
    ProjectsPane,
    SchedulesPane,
    UtilitiesPane,
    WebhooksPane,
    WorkflowsPane,
    activeSidebarPanel,
    markSidebarPanelFailed,
    mountedSidebarPanels,
    projects,
    projectsCreate,
    projectsOpenExplorer,
    projectsOpenProject,
    projectsRemove,
    projectsRename,
    projectsSaveInstructions,
    projectsStartTask,
    retrySidebarPanel,
    runningAutomationNames,
    selectedProjectPath,
    utilitiesOpenExplorer,
    utilitiesOpenStudio,
    utilitiesOpenTerminal,
  ]);
  /** One workspace tab strip per pane group. Titles come from the registry
   *  (renames, dirty dots) with catalog/selection fallbacks for restored
   *  layouts the registry has not seen yet. */
  const stripTitleFor = (key: string, selection: WorkspaceSelection): string => {
    const registered = tabs.find((tab) => tab.key === key);
    const title = registered?.title || (
      selection.kind === "session"
        ? (() => {
          const row = sessions.find((session) => session.id === selection.id);
          return row ? sessionSummaryTitle(row) : "Session";
        })()
        : selection.kind === "agent-session"
          ? selection.title
        : selection.kind === "file"
          ? (selection.rel.split("/").at(-1) || selection.rel)
          : selection.kind === "diff"
            ? `${selection.rel.split("/").at(-1) || selection.rel} (Diff)`
          : selection.kind === "pull-request"
            ? (selection.mode === "changes"
              ? `Changes in Pull Request #${selection.number}`
              : selection.title || `Pull Request #${selection.number}`)
          : selection.kind === "studio"
            ? "Studio"
            : selection.kind === "terminal"
              ? "Terminal"
              : selection.kind === "folder"
                ? (folderPaneTitles.get(navigationKey(selection))
                  || displayProject(selection.path).name || selection.path)
          : selection.kind === "project"
            ? (selection.path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || selection.path)
            : "New task");
    return title;
  };
  const activatePaneSurface = (paneSelection: WorkspaceSelection) => {
    if (paneSelection.kind === "agent-session" || paneSelection.kind === "studio"
      || paneSelection.kind === "terminal"
      || paneSelection.kind === "folder"
      || paneSelection.kind === "diff" || paneSelection.kind === "pull-request") return;
    if (paneSelection.kind === "session") {
      try { window.localStorage.setItem(LAST_SESSION_KEY, paneSelection.id); } catch {}
      selectionRef.current = paneSelection;
      viewedSessionRef.current = paneSelection.id;
      unreadViewedSessionRef.current = paneSelection.id;
      setSelection(paneSelection);
    }
    // A draft reopens ITS draft; the plain New task pane must reuse the
    // singleton draft tab instead of minting a new one per click.
    else if (paneSelection.kind === "new") {
      if (paneSelection.draftId) startTask(paneSelection, false);
      else activateSelection(paneSelection, "New task");
    } else if (paneSelection.kind === "file") {
      openFileTab(
        paneSelection.project,
        paneSelection.rel,
        undefined,
        paneSelection.accessToken,
      );
    } else {
      startProject(paneSelection.path);
    }
  };
  const paneStripFor = (leaf: PaneLeaf) => {
    // The empty workspace has no strip at all (VS Code/Orca): the guidance
    // screen owns the whole surface until the first task opens.
    if (leaf.tabs.length === 0) return null;
    const leafTabs = leaf.tabs.map((selection) => {
      const key = navigationKey(selection);
      return {
        key,
        title: stripTitleFor(key, selection),
        selection,
        preview: leaf.previewKey === key,
        pinned: leaf.previewKey !== key,
        dirty: dirtyFileKeys.has(key),
      };
    });
    const focused = leaf.id === paneWorkspace.focusedLeafId;
    // The context/remote cluster moved from the tab row into the TASK
    // surface's own 30px strip (user decision: surfaces keep a bottom strip
    // with icons on the right — File-breadcrumb grammar).
    return (
      <WorkspaceTabStrip
        tabs={leafTabs}
        activeKey={leaf.activeKey}
        activeBusy={focused && activeBusy}
        workingSessionIds={workingSessionIds}
        unreadSessionIds={unreadSessionIds}
        focused={focused}
        paneId={leaf.id}
        onSelectTab={(tab) => {
          paneWorkspace.focusLeaf(leaf.id);
          paneWorkspace.activateTab(leaf.id, tab.key);
          navigateTab(tab);
        }}
        onCloseTab={(tab) => closeTab(leaf.id, tab)}
        onReorderTab={(sourceKey, targetKey) =>
          paneWorkspace.reorderTab(leaf.id, sourceKey, targetKey)}
        onPinTab={(tab) => pinPaneTab(leaf.id, tab.key)}
        onNewTask={() => {
          paneWorkspace.focusLeaf(leaf.id);
          startTask();
        }}
      />
    );
  };
  // VS Code editor-group model: every chat pane keeps the SAME Conversation
  // tree mounted. Focus only selects the command/snapshot owner. Because the
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
  const focusedLiveWork = useMemo(() => (
    <SnapshotLiveWork snapshotStore={snapshotStore}
      frozenSnapshot={null} hidden={hideLiveSnapshot}
      sessionScope={conversationSessionScope} />
  ), [snapshotStore, hideLiveSnapshot, conversationSessionScope]);
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
    const paneFallback = paneSessionId
      ? frozenSeedFor(paneSessionId)
      : EMPTY_SNAPSHOT;
    const paneProjectPath = paneSessionId
      ? registeredProjectPath(
        sessionRow?.projectPath || paneFallback.currentProject || "",
      )
      : prefs.projectPath;
    const paneProjectLabel = projectChromeLabel(paneProjectPath);
    const paneTitle = paneSessionId && sessionRow
      ? sessionSummaryTitle(sessionRow)
      : "New task";
    const focusedDraft = focused && Boolean(draftKey);
    const focusedSession = focused && Boolean(paneSessionId);
    return (
      <div className="workspace"
        data-conversation-handoff={activeHandoff ? "true" : undefined}
        inert={activeHandoff ? true : undefined}
        aria-hidden={activeHandoff ? true : undefined}
        onPointerDownCapture={focused ? undefined : (event) => {
          if (event.button === 0) focusPane();
        }}>
        <header className="session-header" aria-label="Current task">
          <div className="session-header-content">
            <h1 data-tooltip={paneTitle}>
              {focusedSession && selectedSession
                ? <StableSessionTitle title={paneTitle}
                    editing={headerTitleEditingSessionId === selectedSession.id}
                    draft={headerTitleDraft} invalid={headerTitleInvalid}
                    onOpen={openHeaderTitleEditor}
                    onDraftChange={setHeaderTitleDraft}
                    onCommit={commitHeaderTitleEditor}
                    onCancel={closeHeaderTitleEditor} />
                : paneTitle}
            </h1>
            {paneSessionId && paneProjectLabel &&
              <span className="session-project-badge">{paneProjectLabel}</span>}
            {/* Context/remote cluster: right edge of the TASK strip, same
                placement grammar as the File breadcrumb actions. */}
            <div className="session-header-status">
              <PaneHeaderStatus focused={focused}
                sessionId={paneSessionId} fallback={paneFallback}
                snapshotStore={snapshotStore}
                frozenSnapshot={null}
                hidden={!paneSessionId && focused && hideLiveSnapshot}
                reconcileOnMount={paneSessionId !== requestedSessionId}
                sessionScope={focused ? conversationSessionScope : undefined}
                draftRemoteEnabled={focused && draftKey ? newTaskRemoteMode === "on" : undefined}
                onOpen={() => setCommandSurface("context")}
                onOpenAgents={desktopFeatureEnabled("agents")
                  ? () => openDockTab("agents")
                  : undefined}
                onRemoteChange={draftKey ? setNewTaskRemoteEnabled : setRemoteEnabled} />
            </div>
          </div>
        </header>
        <div className="pane-surface-body">
          <div className="pane-chat-surface" onClick={(event) => {
            if (!shouldFocusSurfaceInput(event)) return;
            if (!focused) focusPane();
            event.currentTarget
              .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Mixdog"]')
              ?.focus({ preventScroll: true });
          }}>
            <PaneConversation focused={focused}
            sessionId={paneSessionId} fallback={paneFallback}
            snapshotStore={snapshotStore}
            // Pane surfaces are pane-local: a session pane paints its OWN
            // lane (fallback: that session's cached seed) and a draft pane
            // must never be handed another session's transition frame. The
            // frozen transition frame belongs to the single-surface route.
            frozenSnapshot={null}
            // Only a draft/no-session pane follows the global draft hide.
            // A focused session pane keeps its own lane painted.
            hidden={!paneSessionId && focused && hideLiveSnapshot}
            transcriptPending={Boolean(paneSessionId) && paneTranscriptRendererPending}
            reconcileOnMount={paneSessionId !== requestedSessionId}
            sessionScope={focused ? conversationSessionScope : undefined}
            invokeResult={invokeResult}
            // Session panes always submit to THEIR session; only a draft pane
            // uses the selection-driven materialization path.
            errors={errors}
            submit={paneSessionId
              ? paneSubmitFor(paneSessionId)
              : presentedSelection.kind === "new"
                ? paneDraftSubmitFor(presentedSelection, leafId)
                : submit}
            applySnapshot={applySnapshot}
            // Pane focus is not a loading mode: the already-mounted surface
            // remains interactive while its engine route catches up.
            transitioning={false}
            composerFocusRequest={focused ? composerFocusRequest : 0}
            onNewTask={conversationNewTask}
            onClearToNewTask={conversationClearToNewTask}
            onClearProject={conversationClearProject}
            onResumeSession={conversationResumeSession}
            onOpenSessions={openSidebar}
            onOpenProjects={conversationOpenProjects}
            onOpenSettings={openSettings}
            projects={projects}
            showProjectSelector={Boolean(draftKey)}
            draftMode={Boolean(draftKey)}
            draftModelSelection={draftKey ? prefs.modelSelection : undefined}
            draftWorkflow={draftKey ? prefs.workflow : undefined}
            onDraftModelSelection={focusedDraft ? stageNewTaskModelSelection : undefined}
            onFastPreferenceApplied={rememberSessionFastForNextTask}
            onDraftWorkflow={focusedDraft ? stageNewTaskWorkflow : undefined}
            activeProjectPath={paneProjectPath}
            activeProjectLabel={paneProjectLabel}
            onSelectProject={conversationSelectProject}
            onChooseProject={conversationChooseProject}
            onOpenCommandSurface={openConversationCommandSurface} />
          </div>
        </div>
      </div>
    );
  };
  const paneAgentSessionSurface = (
    paneSelection: Extract<WorkspaceSelection, { kind: "agent-session" }>,
    focused: boolean,
    focusPane: () => void,
  ) => (
    <div className="workspace agent-session-workspace"
      data-agent-session-id={paneSelection.id}
      onPointerDownCapture={focused ? undefined : (event) => {
        if (event.button === 0) focusPane();
      }}>
      <header className="session-header" aria-label="Agent session">
        <div className="session-header-content">
          <h1 data-tooltip={paneSelection.title}>{paneSelection.title}</h1>
          <span className="session-project-badge">Read only</span>
        </div>
      </header>
      <div className="pane-surface-body">
        <div className="pane-chat-surface">
          <AgentSessionConversation sessionId={paneSelection.id} />
        </div>
      </div>
    </div>
  );
  const paneFileEditors = (
    leaf: PaneLeaf,
    focused: boolean,
    focusPane: () => void,
  ) => {
    const active = paneActiveSelection(leaf);
    const paneActiveFileKey = active?.kind === "file" ? navigationKey(active) : "";
    return leaf.tabs
      .filter((paneSelection): paneSelection is Extract<NavigationSelection, { kind: "file" }> => (
        paneSelection.kind === "file"
        && navigationKey(paneSelection) === paneActiveFileKey
      ))
      .map((fileSelection) => {
        const key = navigationKey(fileSelection);
        const fileActive = key === paneActiveFileKey;
        return <div key={key}
          className="schedules-pane editor-tab-pane stable-surface-preserved stable-pane-surface"
          data-surface-active={fileActive ? "true" : "false"}
          inert={fileActive ? undefined : true}
          aria-hidden={fileActive ? undefined : true}
          // Let Monaco own the complete pointer gesture before pane routing:
          // its text caret and scrollbar both capture on pointerdown. Moving
          // the pane after pointerup preserves first-click editing and allows
          // the first scrollbar gesture to drag instead of merely focusing.
          onPointerUpCapture={focused ? undefined : (event) => {
            if (event.button === 0) window.setTimeout(focusPane, 0);
          }}>
          <DeferredPersistentSurface active={fileActive}
              startupDelayMs={EDITOR_STARTUP_DELAY_MS}
              fallback={<DesktopLoadingSurface label="Loading editor…" />}>
            <ReadyEditorPane projectPath={fileSelection.project} relPath={fileSelection.rel}
                accessToken={fileSelection.accessToken}
                workspaceFile={workbenchWorkspace.workspace.workspaceFile}
                active={fileActive}
                focused={focused}
                onDirty={(dirty) => handleFileDirty(key, dirty)}
                onSaveHandle={(save) => registerEditorSaveHandle(key, save)}
                reveal={fileReveal && fileReveal.key === key ? fileReveal : null}
                codeGraph={fileSelection.accessToken ? undefined : (mode, symbol) =>
                  window.mixdogDesktop?.codeGraphQuery?.(fileSelection.project, mode, symbol)
                  ?? Promise.resolve("")}
                onOpenAt={fileSelection.accessToken ? undefined
                  : (rel, line) => openFileTab(fileSelection.project, rel, line)}
                onNavigationLocation={(rel, line) => {
                  if (!fileActive || !focused) return;
                  latestEditorLocation.current = {
                    project: fileSelection.project,
                    rel,
                    line,
                    ...(fileSelection.accessToken ? { accessToken: fileSelection.accessToken } : {}),
                  };
                }} />
          </DeferredPersistentSurface>
        </div>;
      });
  };
  // Utility surfaces (Studio/terminal/diff/PR) used to exist only while their
  // tab was the ACTIVE selection, so navigating away unmounted the whole pane
  // and coming back replayed the cold "Preparing …" cover (user: Studio가 백
  // 후 재진입마다 다시 로딩). Once a surface has been activated it stays
  // mounted — hidden and inert — for as long as its tab remains open; closing
  // the tab still disposes it.
  const activatedUtilitySurfaceKeys = useRef(new Set<string>());
  const paneUtilityTabs = (
    leaf: PaneLeaf,
    focused: boolean,
    focusPane: () => void,
  ) => {
    const active = paneActiveSelection(leaf);
    return leaf.tabs
      .filter((selection): selection is Extract<WorkspaceSelection, {
        kind: "studio" | "terminal" | "folder" | "diff" | "pull-request"
      }> =>
        (selection.kind === "studio" || selection.kind === "terminal"
        || selection.kind === "folder"
        || selection.kind === "diff" || selection.kind === "pull-request")
        && (Boolean(active && navigationKey(active) === navigationKey(selection))
          || activatedUtilitySurfaceKeys.current.has(navigationKey(selection))))
      .map((utilitySelection) => {
        const key = navigationKey(utilitySelection);
        const utilityActive = active ? navigationKey(active) === key : false;
        return <div key={key}
          id={paneUtilitySurfaceSlotId(leaf.id, key)}
          className={`workspace-utility-tab ${utilitySelection.kind}-tab-pane stable-surface-preserved stable-pane-surface`}
          data-surface-active={utilityActive ? "true" : "false"}
          inert={utilityActive ? undefined : true}
          aria-hidden={utilityActive ? undefined : true}
          onPointerDownCapture={focused ? undefined : (event) => {
            if (event.button === 0) focusPane();
          }}>
        </div>;
      });
  };
  const utilitySurfaceDescriptors = new Map<string, {
    key: string;
    leafId: string;
    focused: boolean;
    active: boolean;
    selection: Extract<WorkspaceSelection, {
      kind: "studio" | "terminal" | "folder" | "diff" | "pull-request"
    }>;
  }>();
  for (const leaf of paneWorkspace.leaves) {
    const active = paneActiveSelection(leaf);
    for (const selection of leaf.tabs) {
      if (selection.kind !== "studio" && selection.kind !== "terminal"
        && selection.kind !== "folder"
        && selection.kind !== "diff" && selection.kind !== "pull-request") continue;
      const key = navigationKey(selection);
      const selectionActive = Boolean(active && navigationKey(active) === key);
      // Idempotent render-time latch: by the time the user leaves this tab,
      // many committed renders have already recorded the activation.
      if (selectionActive) activatedUtilitySurfaceKeys.current.add(key);
      else if (!activatedUtilitySurfaceKeys.current.has(key)) continue;
      const descriptor = {
        key,
        leafId: leaf.id,
        focused: leaf.id === paneWorkspace.focusedLeafId,
        active: selectionActive,
        selection,
      };
      const previous = utilitySurfaceDescriptors.get(key);
      if (!previous || (descriptor.active && !previous.active)
        || (descriptor.active && descriptor.focused)) {
        utilitySurfaceDescriptors.set(key, descriptor);
      }
    }
  }
  {
    // Closing a tab must actually release its surface: drop latched keys whose
    // tab no longer exists in any leaf.
    const presentUtilityKeys = new Set<string>();
    for (const leaf of paneWorkspace.leaves) {
      for (const selection of leaf.tabs) {
        if (selection.kind === "studio" || selection.kind === "terminal"
          || selection.kind === "folder"
          || selection.kind === "diff" || selection.kind === "pull-request") {
          presentUtilityKeys.add(navigationKey(selection));
        }
      }
    }
    for (const key of [...activatedUtilitySurfaceKeys.current]) {
      if (!presentUtilityKeys.has(key)) activatedUtilitySurfaceKeys.current.delete(key);
    }
  }
  const paneUtilitySurfacePortals = [...utilitySurfaceDescriptors.values()].map((descriptor) => {
    const { key, leafId, selection: utilitySelection } = descriptor;
    const utilityActive = descriptor.active;
    const startupDelayMs = utilitySelection.kind === "studio"
      ? 0
      : utilitySelection.kind === "diff"
        ? DIFF_STARTUP_DELAY_MS
        : utilitySelection.kind === "terminal" ? TERMINAL_STARTUP_DELAY_MS : 0;
    const startupLabel = utilitySelection.kind === "studio"
      ? "Preparing Studio…"
      : utilitySelection.kind === "diff"
        ? "Loading diff…"
        : utilitySelection.kind === "terminal"
          ? "Loading terminal…"
          : utilitySelection.kind === "folder"
            ? "Loading folder…"
            : "Loading pull request…";
    return <PersistentPanePortal key={key}
      targetId={paneUtilitySurfaceSlotId(leafId, key)}
      className={`${utilitySelection.kind}-persistent-surface`}
      onPointerDownCapture={descriptor.focused ? undefined : (event) => {
        if (event.button === 0) paneWorkspace.focusLeaf(leafId);
      }}>
      <DeferredPersistentSurface
          active={utilityActive || activatedUtilitySurfaceKeys.current.has(key)}
          startupDelayMs={startupDelayMs}
          fallback={<DesktopLoadingSurface label={startupLabel} />}>
        {utilitySelection.kind === "studio"
          ? <ReadyStudioPane active={utilityActive}
              sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
          : utilitySelection.kind === "terminal"
            ? <ReadyTerminalPane cwd={utilitySelection.cwd || null}
                terminalId={utilitySelection.id} active={utilityActive} />
            : utilitySelection.kind === "folder"
              ? <Suspense fallback={null}>
                  <FolderPane paneId={utilitySelection.id}
                    root={utilitySelection.path} active={utilityActive}
                    onOpenTextFile={(path) => openDroppedPaths(leafId, [path])}
                    onTitleChange={(title) => setFolderPaneTitles((current) => {
                      if (current.get(key) === title) return current;
                      const next = new Map(current);
                      next.set(key, title);
                      return next;
                    })} />
                </Suspense>
            : utilitySelection.kind === "diff"
              ? <ReadyGitDiffPane selection={utilitySelection} active={utilityActive}
                  onOpenFile={openFileTab} />
              : <PullRequestEditor projectPath={utilitySelection.project}
                  number={utilitySelection.number} mode={utilitySelection.mode}
                  active={utilityActive} />}
      </DeferredPersistentSurface>
    </PersistentPanePortal>;
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
  // lane. requestSessionPeek dedupes (laned/in-flight sessions no-op) and
  // the lane store's byte budget still owns retention, so this only fronts
  // the disk read that the first click would otherwise pay behind a cover.
  useEffect(() => {
    if (!desktopBootReady) return undefined;
    const sessionIds = [...new Set(tabs
      .map((tab) => String(tab.key || ""))
      .filter((key) => key.startsWith("session:"))
      .map((key) => key.slice("session:".length)))];
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
      requestSessionPeek(next);
      // Spread the peeks so they never compete with a live interaction.
      stepTimer = window.setTimeout(step, 250);
    };
    const idle = host.requestIdleCallback?.(step, { timeout: 3_000 });
    if (idle === undefined) stepTimer = window.setTimeout(step, 1_000);
    return () => {
      cancelled = true;
      if (idle !== undefined) host.cancelIdleCallback?.(idle);
      window.clearTimeout(stepTimer);
    };
  }, [desktopBootReady, tabs]);
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
            if (dockOpenIntent.current) applyDockOpen(false);
            // With a rail panel showing, Sessions first reclaims the panel
            // area; a plain click keeps the VS Code expand/collapse toggle.
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
          remoteSessionId={sidebarSnapshot.remoteEnabled === true
            ? String(sidebarSnapshot.remoteSessionId || "")
            : ""}
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
            <LiveConversation snapshotStore={snapshotStore}
              frozenSnapshot={conversationFrozenSnapshot} hidden={hideLiveSnapshot}
              transcriptPending={transcriptRendererPending}
              sessionScope={conversationSessionScope}
              liveWork={focusedLiveWork}
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
              onFastPreferenceApplied={rememberSessionFastForNextTask}
              onDraftWorkflow={selection.kind === "new"
                ? stageNewTaskWorkflow
                : undefined}
              activeProjectPath={activeProjectPath}
              activeProjectLabel={activeProjectLabel}
              onSelectProject={conversationSelectProject}
              onChooseProject={conversationChooseProject}
              onOpenCommandSurface={openConversationCommandSurface} />
          </div>
            );
            return <PaneWorkspace
                  workspace={paneWorkspace}
                  renderStrip={paneStripFor}
                  renderConversation={paneConversationSurface}
                  renderAgentSession={paneAgentSessionSurface}
                  renderFileEditors={paneFileEditors}
                  renderUtilityTabs={paneUtilityTabs}
                  onFocusSelection={activatePaneSurface}
                  onOpenDroppedPaths={openDroppedPaths}
                  // An empty focused group renders the guidance screen — no
                  // composer, no chat chrome — until a task pane exists.
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
          frozenSnapshot={null} hidden={hideLiveSnapshot}
      open={dockOpen} width={dockWidth} tab={dockTab}
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
          onClose={() => setCommandSurface(null)} />}
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
