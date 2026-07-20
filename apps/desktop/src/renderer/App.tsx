import React, {
  Component,
  lazy,
  Suspense,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
// react-markdown and the remark/unified ecosystem are heavy; they load as a
// separate lazy chunk (MarkdownBody) so the first paint never pays for them.
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Command,
  FileDiff,
  Folder,
  GitCompare,
  Layers3,
  LoaderCircle,
  Mic,
  ArrowUp,
  PanelRight,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { OcIcon } from "./OcIcon";
import { ContextBody } from "./CommandSurface";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopPromptAttachment,
  DesktopPromptContent,
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  DesktopUpdaterState,
  EngineSnapshot,
} from "../shared/contract";
import {
  approvalInstanceKey,
  draftAfterSubmission,
  followAfterScroll,
  isApprovalDismissKey,
  isScrollIntentKey,
  mergeTranscript,
  normalizeApplyPatch,
  parseUnifiedDiff,
  reconcileTurnFailures,
  shouldNavigatePromptHistory,
  transcriptTurnKeys,
} from "./renderer-logic.mjs";
import type { TurnFailureModel } from "./renderer-logic.mjs";
import {
  DesktopTitlebar,
  ProjectSwitcher,
  SessionSidebar,
  type NavigationSelection,
  type WorkspaceTab,
} from "./navigation";
import {
  applyDesktopTheme,
  applyDesktopThemePreference,
  clearDesktopThemePreference,
  getDesktopThemePreference,
} from "./desktop-theme";
import { resolveContextUsage } from "./context-usage";
import { OpenSelect } from "./OpenSelect";
import { ModelPicker } from "./ModelPicker";
import { modelDisplayName } from "./provider-display";
import { readCachedModelCatalog, writeCachedModelCatalog } from "./model-catalog-cache";
import { TooltipLayer } from "./TooltipLayer";
import {
  SLASH_COMMANDS,
  type CommandSurface as CommandSurfaceName,
  type SettingsSection,
} from "./slash-commands";
import { promptTitle, sessionSummaryTitle } from "../shared/session-title.mjs";
// The desktop transcript deliberately consumes the same semantic tool labels,
// categories, and result summaries as the terminal UI. Keeping this import at
// the shared formatter boundary prevents the renderer from inventing a second
// (and inevitably divergent) tool vocabulary.
// @ts-expect-error The shared runtime module is plain ESM and has no declaration file.
import { classifyToolCategory, formatAggregateHeader, formatToolSurface, summarizeToolResult } from "../../../../src/runtime/shared/tool-surface.mjs";

type RecordValue = Record<string, unknown>;
type Project = string;
type TranscriptItem = RecordValue & {
  id?: string | number;
  kind?: string;
  text?: string;
  at?: number;
  model?: string;
  provider?: string;
  agent?: string;
  name?: string;
  args?: unknown;
  result?: unknown;
  rawResult?: unknown;
  isError?: boolean;
  streaming?: boolean;
  expanded?: boolean;
  count?: number;
  completedCount?: number;
  detail?: string;
  label?: string;
  status?: string;
  tone?: string;
  verb?: string;
  elapsedMs?: number;
  startedAt?: number;
  completedAt?: number;
  liveOutput?: string;
  outputTokens?: number;
  errorCount?: number;
  callErrorCount?: number;
  exitErrorCount?: number;
  images?: Array<{ id?: number | null; name?: string; mimeType?: string; bytes?: number }>;
};

// Session-lifetime preview cache for submitted image attachments. Transcript
// items carry byte-free metadata only (snapshot hygiene); the composer
// registers the data URL at submit time so the current window can render real
// thumbnails. After a restart the chip falls back to an icon + filename.
const MAX_IMAGE_PREVIEW_CACHE = 24;
const imagePreviewCache = new Map<string, string>();
function imagePreviewKey(id: number | null | undefined, bytes: number | undefined): string {
  return `${id ?? 'x'}:${bytes ?? 0}`;
}
function registerImagePreview(id: number, bytes: number, dataUrl: string) {
  const key = imagePreviewKey(id, bytes);
  imagePreviewCache.delete(key);
  imagePreviewCache.set(key, dataUrl);
  while (imagePreviewCache.size > MAX_IMAGE_PREVIEW_CACHE) {
    const oldest = imagePreviewCache.keys().next().value;
    if (oldest === undefined) break;
    imagePreviewCache.delete(oldest);
  }
}

// Perf: main-process timings show session switches settle in <80ms; the
// perceived lag is the renderer mounting every markdown/tool row at once.
// Virtualize much earlier so long sessions paint a window, not the world.
const TRANSCRIPT_VIRTUALIZE_THRESHOLD = 32;
const TRANSCRIPT_VIRTUAL_OVERSCAN = 12;

function estimatedTranscriptRowHeight(item: TranscriptItem | undefined): number {
  if (!item) return 40;
  // Streaming rows estimate by CURRENT text length: a fixed 160px reservation
  // left a phantom blank band under the growing text (user: "약간 떨어져서
  // 생성되는 느낌"), and an empty tail reserved a gap above the spinner.
  if (item.kind === "assistant") {
    const text = String(item.text || "").trim();
    if (!text) return 28;
    if (item.streaming) return Math.min(160, 28 + Math.ceil(text.length / 60) * 22);
    return 160;
  }
  if (item.kind === "user") return 72;
  if (item.kind === "tool") return item.expanded ? 180 : 56;
  return 40;
}
type Approval = RecordValue & {
  id?: string;
  name?: string;
  reason?: string;
  args?: unknown;
  cwd?: string;
};
type Toast = RecordValue & {
  id?: string | number;
  text?: string;
  message?: string;
  tone?: string;
};
type Snapshot = RecordValue & {
  items?: TranscriptItem[];
  streamingTail?: TranscriptItem | null;
  busy?: boolean;
  commandBusy?: boolean;
  queued?: unknown[];
  toolApproval?: Approval | null;
  cwd?: string;
  project?: Project | null;
  currentProject?: Project | null;
  recentProjects?: Project[];
  toasts?: Toast[];
  failedTurnKeys?: string[];
  sessionId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  fastCapable?: boolean;
  thinking?: unknown;
  spinner?: RecordValue | null;
  commandStatus?: RecordValue | null;
  promptHistoryList?: unknown[];
  desktopSessionTitle?: string;
  stats?: RecordValue;
  contextWindow?: number;
  displayContextWindow?: number;
  autoCompactTokenLimit?: number;
  agentWorkers?: RecordValue[];
  agentJobs?: RecordValue[];
  activeTools?: {
    explore?: { count?: number; startedAt?: number };
    search?: { count?: number; startedAt?: number };
  } | null;
  shellJobs?: { count?: number; elapsedLabel?: string };
  workflow?: RecordValue | null;
  remoteEnabled?: boolean;
};

const EMPTY_SNAPSHOT: Snapshot = { items: [], queued: [] };
const DOCK_STATE_KEY = 'mixdog.desktop-utility-dock.v1';
const SIDEBAR_OPEN_KEY = 'mixdog.desktop-sidebar-open.v1';
const LAST_PROJECT_KEY = 'mixdog.desktop-last-project.v1';
const REVIEW_DIFF_STYLE_KEY = 'mixdog.review-diff-style.v1';
type UtilityDockTab = 'agents' | 'terminal';
function clampDockWidth(value: number): number {
  return Math.min(560, Math.max(300, Math.round(Number.isFinite(value) ? value : 380)));
}
function readDockState(): { open: boolean; tab: UtilityDockTab; width: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_STATE_KEY) || '{}') as Record<string, unknown>;
    return {
      open: raw.open === true,
      tab: raw.tab === 'terminal' ? raw.tab : 'agents',
      width: clampDockWidth(Number(raw.width)),
    };
  } catch {
    return { open: false, tab: 'agents', width: 380 };
  }
}
let settingsViewModulePromise: Promise<typeof import("./settings/SettingsView")> | null = null;
function loadSettingsViewModule() {
  settingsViewModulePromise ||= import("./settings/SettingsView");
  return settingsViewModulePromise;
}
const SettingsView = lazy(() => loadSettingsViewModule()
  .then((module) => ({ default: module.SettingsView })));
const OnboardingWizard = lazy(() => import("./settings/OnboardingWizard")
  .then((module) => ({ default: module.OnboardingWizard })));
const CommandSurface = lazy(() => import("./CommandSurface")
  .then((module) => ({ default: module.CommandSurface })));
const DiffView = lazy(() => import("./DiffView.lazy"));
const TerminalPane = lazy(() => import("./TerminalPane"));
// SchedulesPane loads statically: a lazy chunk suspends the whole main pane
// on first entry, which flashes the New-task watermark before the page lands.
import { SchedulesPane } from "./SchedulesView";

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" ? value as RecordValue : null;
}

function displayProject(project: Project | null | undefined) {
  if (!project) return { name: "", path: "" };
  const chunks = project.replace(/[\\/]+$/, "").split(/[\\/]/);
  return { name: chunks.at(-1) || project, path: project };
}

function navigationKey(selection: NavigationSelection) {
  if (selection.kind === "new") return `new:${selection.draftId || "default"}`;
  if (selection.kind === "project") return `project:${selection.path}`;
  return `session:${selection.id}`;
}

// OpenCode-parity draft tabs: every + press opens an independent "New task"
// draft tab, so each draft needs its own stable key.
function newDraftSelection(): NavigationSelection {
  return { kind: "new", draftId: `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` };
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function publicThinkingSummary(value: unknown) {
  const record = asRecord(value);
  if (!record) return "";
  const text = record.publicSummary ?? record.publicReasoningSummary;
  return typeof text === "string" ? text.trim() : "";
}

function oneLine(value: unknown, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

function queueText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record?.displayText || record?.text || record?.prompt || "Queued request");
}

function formatElapsed(value: unknown): string {
  const elapsedMs = Math.max(0, Number(value) || 0);
  if (elapsedMs < 1_000) return "";
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatIdleDuration(value: unknown): string {
  const milliseconds = Math.max(0, Number(value) || 0);
  if (!milliseconds) return "provider default";
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

const TURN_LOCKED_SLASH_COMMANDS = new Set([
  "clear",
  "compact",
  "resume",
  "outputstyle",
  "effort",
  "fast",
]);

async function copyTextToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function useDesktopState() {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [connected, setConnected] = useState(Boolean(window.mixdogDesktop));
  const [error, setError] = useState("");
  const failureModel = useRef<TurnFailureModel>({
    scope: "",
    failedTurnKeys: [],
    activeToastTurns: {},
  });
  const applySnapshot = useCallback((next: EngineSnapshot | null) => {
    const state = next && typeof next === "object" ? next as Snapshot : EMPTY_SNAPSHOT;
    const scope = String(state.currentProject || state.project || state.cwd || "");
    failureModel.current = reconcileTurnFailures(
      failureModel.current,
      state.items,
      state.toasts,
      scope,
    );
    setSnapshot({ ...state, failedTurnKeys: failureModel.current.failedTurnKeys });
  }, []);

  useEffect(() => {
    const host = window.mixdogDesktop;
    if (!host) {
      setConnected(false);
      return;
    }
    let live = true;
    const update = (next: EngineSnapshot | null) => {
      if (live) applySnapshot(next);
    };
    Promise.resolve(host.getSnapshot()).then(update).catch((reason) => {
      if (live) setError(reason instanceof Error ? reason.message : String(reason));
    });
    const unsubscribe = host.subscribeState(update);
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [applySnapshot]);

  return { snapshot, connected, error, setError, setSnapshot, applySnapshot };
}

export function App() {
  const { snapshot, connected, error, setError, applySnapshot } = useDesktopState();
  // Layout persists across launches (user decision); a FRESH install opens
  // with the sidebar visible and the dock closed.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false"; }
    catch { return true; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen)); }
    catch { /* layout persistence is a convenience only */ }
  }, [sidebarOpen]);
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Settings stays MOUNTED after first use (hidden via display:none): the
  // dialog tree costs ~330ms to mount (measured), so reopen must not repay
  // it. An idle prewarm absorbs the first-open cost too.
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [commandSurface, setCommandSurface] = useState<CommandSurfaceName | null>(null);
  // Right utility dock (Cursor-style side panel): open/tab/width persist.
  const [dockOpen, setDockOpen] = useState<boolean>(() => readDockState().open);
  const [dockTab, setDockTab] = useState<UtilityDockTab>(() => readDockState().tab);
  const [dockWidth, setDockWidth] = useState<number>(() => readDockState().width);
  // Review takes over the MAIN area (opencode session review-tab grammar):
  // a full-width pane, not a squeezed side dock. Resets per selection.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Scheduled-tasks page (sidebar → Schedules): takes over the main pane the
  // same way Review does, and closes on any navigation-selection change.
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  // Keep-mounted after first use (settings-dialog pattern): re-entry must not
  // repay mount/load, and the hidden workspace keeps its transcript state.
  const [schedulesMounted, setSchedulesMounted] = useState(false);
  const openSchedules = useCallback(() => {
    setSchedulesMounted(true);
    setSchedulesOpen(true);
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(DOCK_STATE_KEY, JSON.stringify({ open: dockOpen, tab: dockTab, width: dockWidth }));
    } catch { /* dock state is a convenience only */ }
  }, [dockOpen, dockTab, dockWidth]);
  // Reopening the dock starts fresh on the first tab (user decision, same
  // grammar as the settings dialog reset).
  useEffect(() => {
    if (dockOpen) setDockTab("agents");
  }, [dockOpen]);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [updaterState, setUpdaterState] = useState<DesktopUpdaterState>({ status: "disabled" });
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>([]);
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [selection, setSelection] = useState<NavigationSelection>({ kind: "new" });
  useEffect(() => {
    setReviewOpen(false);
    setSchedulesOpen(false);
  }, [selection]);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { key: "new:default", title: "New task", selection: { kind: "new" } },
  ]);
  const [headerTitleEditingSessionId, setHeaderTitleEditingSessionId] = useState("");
  const [headerTitleDraft, setHeaderTitleDraft] = useState("");
  const [headerTitleInvalid, setHeaderTitleInvalid] = useState(false);
  const [newTaskActive, setNewTaskActive] = useState(false);
  const [switchingSessionId, setSwitchingSessionId] = useState("");
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const frozenSessionSnapshot = useRef<Snapshot | null>(null);
  const newTaskReady = useRef(false);
  // Callback-safe view of the active selection for tab-promotion decisions.
  const selectionRef = useRef<NavigationSelection>({ kind: "new" });
  const sessionRefresh = useRef({
    submitInFlight: false,
    accepted: false,
    sawBusy: false,
    sawSettlement: false,
  });
  const sessionRefreshVersion = useRef(0);
  const pendingSessionRenames = useRef(new Map<string, { title: string }>());
  const pendingSessionDeletes = useRef(new Set<string>());
  const isBusy = Boolean(snapshot.busy || snapshot.commandBusy);
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
  useEffect(() => {
    const api = window.mixdogDesktop;
    if (!api?.readCapabilities) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void loadSettingsViewModule()
        .then((module) => live ? module.preloadSettings(api) : undefined)
        .catch(() => {});
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const host = window.mixdogDesktop;
    let live = true;
    void host?.getUpdaterState?.().then((next) => {
      if (live) setUpdaterState(next);
    }).catch(() => {});
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
    if (!applyStoredPreference()) applyDesktopTheme('basic');
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
    if (!invoke) return () => { live = false; };
    void invoke<RecordValue>({ capability: 'getOnboardingStatus' })
      .then((result) => {
        if (live && asRecord(result.value)?.completed === false) setOnboardingOpen(true);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  const errors = [
    error || (!connected ? "Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop." : ""),
  ].filter(Boolean);

  const activateSelection = useCallback((
    nextSelection: NavigationSelection,
    title: string,
    replaceKey = "",
  ) => {
    const key = navigationKey(nextSelection);
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
    setTabs((current) => {
      const existing = current.findIndex((tab) => tab.key === key);
      if (existing >= 0) {
        const next = [...current];
        next[existing] = { key, title, selection: nextSelection };
        return next;
      }
      if (replaceKey) {
        const replaced = current.findIndex((tab) => tab.key === replaceKey);
        if (replaced >= 0) {
          const next = [...current];
          next[replaced] = { key, title, selection: nextSelection };
          return next;
        }
      }
      return [...current, { key, title, selection: nextSelection }].slice(-10);
    });
  }, []);
  const closeProjectPanel = useCallback(() => setProjectPanelOpen(false), []);
  // Last-project restore (user decision): a fresh launch that lands on an
  // empty engine re-enters the most recent project context automatically.
  const restoredLastProject = useRef(false);
  useEffect(() => {
    if (restoredLastProject.current || snapshot === EMPTY_SNAPSHOT) return;
    restoredLastProject.current = true;
    // The window reveal waits for this decision (main.tsx): restoring the
    // last project AFTER first paint made the welcome block and tab strip
    // visibly jump on launch.
    const settleStartup = () => {
      (window as { __mixdogStartupSettled?: boolean }).__mixdogStartupSettled = true;
      window.dispatchEvent(new Event("mixdog:startup-settled"));
    };
    if (String(snapshot.currentProject || snapshot.project || "") || String(snapshot.sessionId || "")) {
      settleStartup();
      return;
    }
    let stored = "";
    try { stored = window.localStorage.getItem(LAST_PROJECT_KEY) || ""; } catch { /* fall through */ }
    if (!stored) {
      settleStartup();
      return;
    }
    void window.mixdogDesktop?.startProjectTask(stored).then((next) => {
      applySnapshot(next);
      activateSelection({ kind: "new" }, "New task");
      newTaskReady.current = true;
      setNewTaskActive(true);
    }).catch(() => {}).finally(settleStartup);
  }, [snapshot, applySnapshot, activateSelection]);

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
  const openDesktopUpdate = useCallback(() => {
    void invoke(async () => {
      const next = await window.mixdogDesktop.showDesktopUpdate();
      setUpdaterState(next);
    });
  }, [invoke]);
  const refreshSessions = useCallback(async () => {
    const host = window.mixdogDesktop;
    if (!host?.listSessions) return [];
    const version = ++sessionRefreshVersion.current;
    const next = await host.listSessions();
    const rows = (Array.isArray(next) ? next : [])
      .filter((session) => !pendingSessionDeletes.current.has(session.id))
      .map((session) => {
        const pending = pendingSessionRenames.current.get(session.id);
        return pending ? { ...session, title: pending.title } : session;
      });
    if (version === sessionRefreshVersion.current) setSessions(rows);
    return rows;
  }, []);
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
    void invoke(async () => {
      await Promise.all([refreshSessions(), refreshProjects()]);
    });
  }, [invoke, refreshProjects, refreshSessions]);
  const refreshSessionsBestEffort = useCallback((
    selectCurrent = false,
  ) => {
    void refreshSessions().then((rows) => {
      if (!selectCurrent) return;
      const current = rows.find((session) => session.currentSession);
      // A draft tab that just materialized its session PROMOTES in place
      // (OpenCode promoteDraft): the session tab replaces the draft tab at the
      // same position instead of appending a duplicate.
      const active = selectionRef.current;
      if (current) activateSelection(
        { kind: "session", id: current.id },
        sessionSummaryTitle(current),
        active.kind === "new" ? navigationKey(active) : "",
      );
    }).catch(() => undefined);
  }, [activateSelection, refreshSessions]);
  const refreshSettledSession = useCallback(() => {
    const pending = sessionRefresh.current;
    if (!pending.accepted || !pending.sawSettlement) return;
    sessionRefresh.current = {
      submitInFlight: false,
      accepted: false,
      sawBusy: false,
      sawSettlement: false,
    };
    refreshSessionsBestEffort(true);
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
  const canonicalProject = (value: EngineSnapshot, fallback: string) => {
    const state = value && typeof value === "object" ? value as Snapshot : null;
    return String(state?.currentProject || state?.project || fallback);
  };
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
      const active = selectionRef.current;
      activateSelection(
        { kind: "session", id: actualSessionId },
        sessionSummaryTitle(actualSession),
        active.kind === "new" ? navigationKey(active) : "",
      );
      newTaskReady.current = false;
      setNewTaskActive(false);
    } else if (actualProject) {
      const project = projects.find((item) => item.path === actualProject);
      activateSelection(
        { kind: "project", path: actualProject },
        project?.alias?.trim() || project?.name?.trim() || displayProject(actualProject).name || "Project",
      );
      newTaskReady.current = false;
      setNewTaskActive(false);
    } else if (actualSessionId) {
      activateSelection({ kind: "new" }, "New task");
      newTaskReady.current = true;
      setNewTaskActive(true);
    } else {
      activateSelection({ kind: "new" }, "New task");
      newTaskReady.current = false;
      setNewTaskActive(false);
    }
  };

  const closeSidebarForNavigation = () => {
    if (window.innerWidth <= 760) setSidebarOpen(false);
  };
  const chooseProject = () => invoke(async () => {
    const host = window.mixdogDesktop;
    if (!host) return;
    const selected = await host.chooseProject();
    if (selected) {
      closeSidebarForNavigation();
      try {
        const next = await host.startProject(selected);
        applySnapshot(next);
        const projectPath = canonicalProject(next, selected);
        activateSelection(
          { kind: "project", path: projectPath },
          displayProject(projectPath).name || "Project",
        );
        setNewTaskActive(false);
        await refreshProjects();
        refreshSessionsBestEffort();
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      }
    }
  });
  const startProject = (project: Project) => {
    closeSidebarForNavigation();
    void invoke(async () => {
      try {
        const next = await window.mixdogDesktop?.startProject(project);
        applySnapshot(next);
        const projectPath = canonicalProject(next, project);
        const summary = projects.find((item) => item.path === projectPath);
        activateSelection(
          { kind: "project", path: projectPath },
          summary?.alias?.trim() || summary?.name?.trim() || displayProject(projectPath).name || "Project",
        );
        setNewTaskActive(false);
        refreshSessionsBestEffort();
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      }
    });
  };
  const startProjectTask = (project: Project) => {
    closeSidebarForNavigation();
    void invoke(async () => {
      try {
        const next = await window.mixdogDesktop.startProjectTask(project);
        applySnapshot(next);
        const projectPath = canonicalProject(next, project);
        const summary = projects.find((item) => item.path === projectPath);
        activateSelection(
          { kind: "project", path: projectPath },
          summary?.alias?.trim() || summary?.name?.trim() || displayProject(projectPath).name || "Project",
        );
        setNewTaskActive(false);
        await refreshProjects();
        refreshSessionsBestEffort();
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      }
    });
  };
  const activateNewProjectContext = async (project: Project) => {
    const next = await window.mixdogDesktop.startProjectTask(project);
    applySnapshot(next);
    activateSelection({ kind: "new" }, "New task");
    newTaskReady.current = true;
    setNewTaskActive(true);
    setComposerFocusRequest((value) => value + 1);
    await refreshProjects();
    refreshSessionsBestEffort();
  };
  const selectNewTaskProject = (project: Project) => {
    closeSidebarForNavigation();
    void invoke(async () => {
      try {
        await activateNewProjectContext(project);
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      }
    });
  };
  const chooseNewTaskProject = () => {
    void invoke(async () => {
      const selected = await window.mixdogDesktop.chooseProject();
      if (!selected) return;
      try {
        await activateNewProjectContext(selected);
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      }
    });
  };
  const openProjectInExplorer = (project: Project) =>
    invoke(() => window.mixdogDesktop.openProjectInExplorer(project));
  const setProjectPinned = (project: Project, pinned: boolean) =>
    invoke(async () => {
      await window.mixdogDesktop.setProjectPinned(project, pinned);
      await refreshProjects();
    });
  const renameProject = (project: Project, alias: string) =>
    invoke(async () => {
      await window.mixdogDesktop.renameProject(project, alias);
      await refreshProjects();
    });
  const removeProject = (project: Project) =>
    invoke(async () => {
      await window.mixdogDesktop.removeProject(project);
      await refreshProjects();
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
      sessionRefreshVersion.current += 1;
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
  const deleteSession = useCallback(async (sessionId: string) => {
    const previousSession = sessions.find((session) => session.id === sessionId);
    if (!previousSession || pendingSessionDeletes.current.has(sessionId)) return;
    const deletingCurrent = previousSession.currentSession
      || (selection.kind === "session" && selection.id === sessionId)
      || String(snapshot.sessionId || "") === sessionId;
    pendingSessionDeletes.current.add(sessionId);
    setError("");
    let next: EngineSnapshot;
    try {
      next = await window.mixdogDesktop.deleteSession(sessionId);
    } catch (reason) {
      pendingSessionDeletes.current.delete(sessionId);
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
    sessionRefreshVersion.current += 1;
    pendingSessionRenames.current.delete(sessionId);
    applySnapshot(next);
    setSessions((current) => current.filter((session) => session.id !== sessionId));
    setTabs((current) => current.filter((tab) =>
      !(tab.selection.kind === "session" && tab.selection.id === sessionId)));
    if (deletingCurrent) {
      activateSelection({ kind: "new" }, "New task");
      newTaskReady.current = true;
      setNewTaskActive(true);
      setSwitchingSessionId("");
    }
    try {
      await refreshSessions();
    } catch {
      // The successful deletion remains authoritative if reconciliation is unavailable.
    } finally {
      pendingSessionDeletes.current.delete(sessionId);
    }
  }, [activateSelection, applySnapshot, refreshSessions, selection, sessions, setError, snapshot.sessionId]);
  const startTask = (draft?: NavigationSelection) => {
    closeSidebarForNavigation();
    void invoke(async () => {
      try {
        // Fresh tasks keep the LAST project preselected (user decision):
        // current project first, then the most recent one.
        const lastProject = String(snapshot.currentProject || snapshot.project ||
          (Array.isArray(snapshot.recentProjects) ? snapshot.recentProjects[0] : "") || "");
        const next = lastProject
          ? await window.mixdogDesktop.startProjectTask(lastProject)
          : await window.mixdogDesktop?.startTask();
        applySnapshot(next);
        activateSelection(draft?.kind === "new" ? draft : newDraftSelection(), "New task");
        newTaskReady.current = true;
        setNewTaskActive(true);
        setComposerFocusRequest((value) => value + 1);
        refreshSessionsBestEffort();
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      }
    });
  };
  const resumeSession = (sessionId: string) => {
    if ((selection.kind === "session" && selection.id === sessionId) || switchingSessionId) return;
    closeSidebarForNavigation();
    const switchStartedAt = performance.now();
    const session = sessions.find((item) => item.id === sessionId);
    frozenSessionSnapshot.current = selection.kind === "new" && !newTaskActive
      ? EMPTY_SNAPSHOT
      : snapshot;
    setSwitchingSessionId(sessionId);
    const timingStart = `mixdog:session-switch:${sessionId}:start`;
    if (import.meta.env?.DEV) performance.mark(timingStart);
    void invoke(async () => {
      try {
        const next = await window.mixdogDesktop?.resumeSession(sessionId);
        const resumedSessionId = String(asRecord(next)?.sessionId || "");
        if (resumedSessionId && resumedSessionId !== sessionId) {
          throw new Error("Session switch returned an unexpected session.");
        }
        const resumedTitle = session
          ? sessionSummaryTitle(session)
          : String(asRecord(next)?.desktopSessionTitle || "").trim() || "Untitled session";
        applySnapshot(next);
        activateSelection({ kind: "session", id: sessionId }, resumedTitle);
        setSessions((current) => {
          let changed = false;
          const updated = current.map((item) => {
            const currentSession = item.id === sessionId;
            if (item.currentSession === currentSession) return item;
            changed = true;
            return { ...item, currentSession };
          });
          return changed ? updated : current;
        });
        setNewTaskActive(false);
        if (import.meta.env?.DEV) {
          window.requestAnimationFrame(() => {
            const timingEnd = `mixdog:session-switch:${sessionId}:painted`;
            const timingMeasure = `mixdog:session-switch:${sessionId}`;
            performance.mark(timingEnd);
            performance.measure(timingMeasure, timingStart, timingEnd);
            const duration = performance.getEntriesByName(timingMeasure).at(-1)?.duration;
            console.info(`[perf] session switch ${sessionId}: ${duration?.toFixed(1) ?? "?"}ms`);
          });
        }
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      } finally {
        setSwitchingSessionId("");
        frozenSessionSnapshot.current = null;
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          window.mixdogDesktop?.perfLog?.(
            `session-switch-render id=${sessionId} paint=${(performance.now() - switchStartedAt).toFixed(0)}ms`,
          );
        }));
      }
    });
  };
  const openSettings = useCallback((section: SettingsSection | null = null) => {
    // Perf diagnostics: SettingsView's mount effect reports the request→paint
    // delta through the perf-log channel (no-op unless MIXDOG_DESKTOP_PERF=1).
    (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt = performance.now();
    setCommandSurface(null);
    setSettingsSection(section);
    setSettingsMounted(true);
    setSettingsOpen(true);
  }, []);
  useEffect(() => {
    // Early enough that even a hasty first open lands on the prewarmed tree.
    const timer = window.setTimeout(() => setSettingsMounted(true), 600);
    return () => window.clearTimeout(timer);
  }, []);
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
  const submit = useCallback(async (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ): Promise<unknown> => {
    const host = window.mixdogDesktop;
    if (!host) return false;
    let startedSessionId = "";
    if (selection.kind === "new" && !newTaskReady.current) {
      const started = await host.startTask();
      startedSessionId = String(asRecord(started)?.sessionId || "");
      newTaskReady.current = true;
      setNewTaskActive(true);
    } else if (selection.kind === "new") {
      startedSessionId = String(snapshot.sessionId || "");
    }
    const pending = sessionRefresh.current;
    pending.submitInFlight = true;
    pending.sawBusy ||= isBusy;
    let accepted: unknown;
    try {
      accepted = await host.submit(content, options);
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
      if (selection.kind === "new") {
        const activeSessionId = startedSessionId || String(
          asRecord(await host.getSnapshot())?.sessionId || "",
        );
        if (activeSessionId) {
          const title = promptTitle(content, options?.displayText || "") || "New task";
          activateSelection({ kind: "session", id: activeSessionId }, title, "new");
          setNewTaskActive(false);
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
  }, [activateSelection, isBusy, refreshSettledSession, selection.kind, snapshot.sessionId]);
  const selectedSnapshot = switchingSessionId && frozenSessionSnapshot.current
    ? frozenSessionSnapshot.current
    : snapshot;
  const visibleSnapshot = selection.kind === "new" && !newTaskActive
    ? EMPTY_SNAPSHOT
    : selectedSnapshot;
  const navigationSelection: NavigationSelection = switchingSessionId
    ? { kind: "session", id: switchingSessionId }
    : selection;
  const selectedSession = navigationSelection.kind === "session"
    ? sessions.find((session) => session.id === navigationSelection.id)
    : undefined;
  const currentSessionTitle = selectedSession ? sessionSummaryTitle(selectedSession) : "";
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
  const snapshotProjectPath = String(asRecord(visibleSnapshot)?.currentProject ||
    asRecord(visibleSnapshot)?.project || "");
  const activeProjectPath = navigationSelection.kind === "session"
    ? String(selectedSession?.projectPath || snapshotProjectPath)
    : navigationSelection.kind === "project" ? navigationSelection.path : snapshotProjectPath;
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
  const recentProjectPaths = Array.isArray(snapshot.recentProjects) ? snapshot.recentProjects : [];
  const selectedProjectPath = activeProjectPath ||
    String(recentProjectPaths[0] || "");
  useEffect(() => {
    if (!activeProjectPath) return;
    try { window.localStorage.setItem(LAST_PROJECT_KEY, activeProjectPath); }
    catch { /* persistence is a convenience only */ }
  }, [activeProjectPath]);
  const activeTabKey = navigationKey(navigationSelection);
  const navigateTab = (tab: WorkspaceTab) => {
    if (tab.key === activeTabKey) return;
    if (tab.selection.kind === "new") startTask(tab.selection);
    else if (tab.selection.kind === "project") startProject(tab.selection.path);
    else resumeSession(tab.selection.id);
  };
  const closeTab = (tab: WorkspaceTab) => {
    const index = tabs.findIndex((item) => item.key === tab.key);
    const nextTabs = tabs.filter((item) => item.key !== tab.key);
    setTabs(nextTabs);
    if (tab.key !== activeTabKey) return;
    const fallback = nextTabs[Math.min(index, nextTabs.length - 1)];
    if (fallback) navigateTab(fallback);
    else startTask();
  };
  const reorderTab = useCallback((sourceKey: string, targetKey: string) => {
    setTabs((current) => {
      const sourceIndex = current.findIndex((tab) => tab.key === sourceKey);
      const targetIndex = current.findIndex((tab) => tab.key === targetKey);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }, []);
  // Global workspace shortcuts (OpenCode desktop grammar + user requests):
  // mod+N new task · ctrl+Tab / mod+←→ cycle tabs (everywhere — user chose
  // tab switching over composer word-jump; shift+mod+←→ keeps word
  // selection) · mod+, settings · mod+B sidebar toggle.
  useEffect(() => {
    const cycleTab = (offset: number) => {
      if (tabs.length < 2) return;
      const index = tabs.findIndex((tab) => tab.key === activeTabKey);
      const next = tabs[(index + offset + tabs.length) % tabs.length];
      if (next) navigateTab(next);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "n" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        startTask();
        return;
      }
      if (key === "," && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        openSettings();
        return;
      }
      if (key === "b" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        setSidebarOpen((value) => !value);
        return;
      }
      if (key === "b" && event.shiftKey && !event.altKey) {
        event.preventDefault();
        setDockOpen((value) => !value);
        return;
      }
      if (key === "q" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        const active = tabs.find((tab) => tab.key === activeTabKey);
        if (active) closeTab(active);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        cycleTab(event.shiftKey ? -1 : 1);
        return;
      }
      if ((event.key === "ArrowRight" || event.key === "ArrowLeft")
        && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        cycleTab(event.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <DesktopTitlebar
        sidebarOpen={sidebarOpen}
        tabs={tabs}
        activeKey={activeTabKey}
        activeBusy={isBusy}
        updaterState={updaterState}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onSelectTab={navigateTab}
        onCloseTab={closeTab}
        onReorderTab={reorderTab}
        onNewTask={startTask}
        onOpenUpdate={openDesktopUpdate}
      />
      <div className="desktop-body">
        <SessionSidebar
          open={sidebarOpen}
          sessions={sessions}
          busySessionId={isBusy ? String(snapshot.sessionId || "") : ""}
          selection={navigationSelection}
          onNewTask={startTask}
          onOpenProjects={() => setProjectPanelOpen(true)}
          onOpenSchedules={openSchedules}
          onOpenSettings={() => openSettings()}
          onResumeSession={resumeSession}
          onRenameSession={renameSession}
          onDeleteSession={deleteSession}
        />
        {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)}
          aria-label="Close session sidebar" />}
        <main className="main-panel">
          {schedulesMounted && <SchedulesPane active={schedulesOpen} />}
          <div className={`workspace ${switchingSessionId ? "switching-session" : ""}`}
            style={schedulesOpen ? { display: "none" } : undefined}>
            <header className="session-header" aria-label="Current task">
              <div className="session-header-content">
                <h1 data-tooltip={visibleSessionTitle}>
                  {selectedSession && headerTitleEditingSessionId === selectedSession.id ? <input
                    className="session-header-title-input"
                    value={headerTitleDraft}
                    maxLength={160}
                    autoFocus
                    aria-label={`Rename ${visibleSessionTitle}`}
                    aria-invalid={headerTitleInvalid || undefined}
                    onFocus={(event) => event.currentTarget.select()}
                    onInput={(event) => setHeaderTitleDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitHeaderTitleEditor();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        closeHeaderTitleEditor();
                      }
                    }}
                    onBlur={() => commitHeaderTitleEditor(true)}
                  /> : selectedSession ? <button type="button" className="session-title-trigger"
                    onClick={openHeaderTitleEditor} aria-label={`Rename ${visibleSessionTitle}`}>
                    {visibleSessionTitle}
                  </button> : visibleSessionTitle}
                </h1>
                {navigationSelection.kind === "session" && activeProjectLabel &&
                  <span className="session-project-badge">{activeProjectLabel}</span>}
                {selectedSession && headerTitleEditingSessionId !== selectedSession.id && (
                  <button type="button" className="session-title-regenerate"
                    aria-label="Regenerate title" data-tooltip="Regenerate title"
                    onClick={() => {
                      const seed = ((visibleSnapshot.items || []) as TranscriptItem[]).find((entry) =>
                        entry?.kind === "user" && String(entry.text || "").trim());
                      if (seed) void renameSession(selectedSession.id, promptTitle(String(seed.text || "")));
                    }}>
                    <RotateCcw size={13} />
                  </button>
                )}
                <div className="session-header-status">
                  <LiveWorkStatus snapshot={visibleSnapshot} />
                  <ContextUsageIndicator snapshot={visibleSnapshot}
                    onOpen={() => setCommandSurface("context")} />
                  <button type="button" className="session-dock-toggle"
                    onClick={() => setReviewOpen((value) => !value)} aria-pressed={reviewOpen}
                    aria-label={reviewOpen ? "Back to chat" : "Review changes"}
                    data-tooltip={reviewOpen ? "Back to chat" : "Review"}>
                    <GitCompare size={18} aria-hidden="true" />
                  </button>
                  <button type="button" className="session-dock-toggle"
                    onClick={() => setDockOpen((value) => !value)} aria-pressed={dockOpen}
                    aria-label={dockOpen ? "Close utility panel" : "Open utility panel"}
                    data-tooltip={dockOpen ? "Close panel" : "Open panel"}>
                    <PanelRight size={18} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </header>
            {reviewOpen
              ? <ReviewPane cwd={String(visibleSnapshot.currentProject || visibleSnapshot.project || "") || null} />
              : <Conversation snapshot={visibleSnapshot} routeSnapshot={selectedSnapshot} invoke={invoke} invokeResult={invokeResult}
              errors={errors} submit={submit} applySnapshot={applySnapshot}
              transitioning={Boolean(switchingSessionId)}
              composerFocusRequest={composerFocusRequest}
              onNewTask={startTask}
              onStartProject={startProject}
              onResumeSession={resumeSession}
              onOpenProjects={() => setProjectPanelOpen(true)}
              onOpenSessions={() => setSidebarOpen(true)}
              onOpenSettings={openSettings}
              projects={projects}
              showProjectSelector={selection.kind === "new"}
              activeProjectPath={activeProjectPath}
              activeProjectLabel={activeProjectLabel}
              onSelectProject={selectNewTaskProject}
              onChooseProject={chooseNewTaskProject}
              onOpenCommandSurface={(surface) => {
                setSettingsOpen(false);
                if (surface === "schedules") {
                  openSchedules();
                  return;
                }
                setCommandSurface(surface);
              }} />}
            {switchingSessionId && <div className="session-switch-overlay" aria-hidden="true" />}
          </div>
        </main>
        {dockOpen && <UtilityDock width={dockWidth} tab={dockTab}
          onTab={setDockTab} onResize={(value) => setDockWidth(clampDockWidth(value))}
          items={(visibleSnapshot.items || []) as TranscriptItem[]} snapshot={visibleSnapshot} />}
      </div>
      <ProjectSwitcher
        open={projectPanelOpen}
        projects={projects}
        selectedProjectPath={selectedProjectPath}
        onClose={closeProjectPanel}
        onChooseProject={chooseProject}
        onStartProject={startProject}
        onStartProjectTask={startProjectTask}
        onOpenExplorer={openProjectInExplorer}
        onSetPinned={setProjectPinned}
        onRename={renameProject}
        onRemove={removeProject}
      />
      <Suspense fallback={null}>
        {settingsMounted && <SettingsView
          open={settingsOpen}
          initialSection={settingsSection}
          onCompose={(text) => {
            setSettingsOpen(false);
            window.dispatchEvent(new CustomEvent('mixdog:composer-draft', { detail: text }));
          }}
          onClose={() => setSettingsOpen(false)} />}
        {commandSurface && <CommandSurface surface={commandSurface}
          onOpen={(surface) => {
            if (surface === "schedules") {
              setCommandSurface(null);
              openSchedules();
            } else setCommandSurface(surface);
          }} onClose={() => setCommandSurface(null)} />}
        {onboardingOpen && <OnboardingWizard api={window.mixdogDesktop} onDone={() => setOnboardingOpen(false)} />}
      </Suspense>
      <DesktopToastRegion
        bridgeError={error || (!connected ? 'Desktop bridge is unavailable. Open this renderer inside Mixdog Desktop.' : '')}
        toasts={Array.isArray(snapshot.toasts) ? snapshot.toasts : []}
        onDismissBridgeError={() => setError('')}
      />
      <TooltipLayer />
    </div>
  );
}

function DesktopToastRegion({ bridgeError, toasts, onDismissBridgeError }: {
  bridgeError: string;
  toasts: Toast[];
  onDismissBridgeError: () => void;
}) {
  const [placement, setPlacement] = useState({
    right: 16,
    top: 54,
    width: 320,
    maxHeight: 400,
  });
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [dismissedErrorSignatures, setDismissedErrorSignatures] = useState<Set<string>>(() => new Set());
  const [retainedErrors, setRetainedErrors] = useState<Array<{
    key: string;
    signature: string;
    text: string;
    tone: string;
    bridge: boolean;
  }>>([]);
  const sourceEntries = toasts.map((toast, index) => {
    const text = String(toast.text || toast.message || '').trim();
    const tone = String(toast.tone || 'info').toLowerCase();
    return {
      key: String(toast.id ?? `${toast.tone || 'info'}:${toast.text || toast.message || ''}:${index}`),
      signature: `${tone}:${text}`,
      text,
      tone,
      bridge: false,
    };
  }).filter((entry) => entry.text);
  const sourceErrors = sourceEntries.filter((entry) => entry.tone === 'error');
  const sourceErrorToken = sourceErrors.map((entry) => entry.signature).join('\u0000');
  useEffect(() => {
    const active = new Set(sourceErrors.map((entry) => entry.signature));
    setDismissedErrorSignatures((current) => {
      const next = new Set([...current].filter((signature) => active.has(signature)));
      return next.size === current.size ? current : next;
    });
    setRetainedErrors((current) => {
      let next = current;
      for (const entry of sourceErrors) {
        if (dismissedErrorSignatures.has(entry.signature)) continue;
        next = [...next.filter((retained) => retained.signature !== entry.signature), entry];
      }
      return next.slice(-5);
    });
  }, [sourceErrorToken]);
  const currentErrors = retainedErrors
    .filter((entry) => !dismissedErrorSignatures.has(entry.signature));
  const candidates = [
    ...(bridgeError ? [{
      key: `bridge:${bridgeError}`,
      signature: `bridge:${bridgeError}`,
      text: bridgeError,
      tone: 'error',
      bridge: true,
    }] : []),
    ...sourceEntries.filter((entry) => entry.tone !== 'error'),
    ...currentErrors.slice(-5),
  ];
  const sourceKeys = candidates.map((entry) => entry.key).join('\u0000');
  const entries = candidates.filter((entry) => !dismissed.has(entry.key)).slice(-5);
  const expiringKeys = entries
    .filter((entry) => !entry.bridge && entry.tone !== 'error')
    .map((entry) => entry.key)
    .join('\u0000');
  useEffect(() => {
    const active = new Set(sourceKeys ? sourceKeys.split('\u0000') : []);
    setDismissed((current) => {
      const next = new Set([...current].filter((key) => active.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [sourceKeys]);
  useEffect(() => {
    if (!expiringKeys) return;
    const keys = expiringKeys.split('\u0000');
    const timer = window.setTimeout(() => {
      setDismissed((current) => new Set([...current, ...keys]));
    }, 6500);
    return () => window.clearTimeout(timer);
  }, [expiringKeys]);
  useLayoutEffect(() => {
    const measure = () => {
      const workspace = document.querySelector('.workspace');
      if (!(workspace instanceof HTMLElement)) return;
      const sheet = workspace.getBoundingClientRect();
      if (!sheet.width || !sheet.height) return;
      const margin = 16;
      const width = Math.min(320, Math.max(0, sheet.width - margin * 2));
      const right = Math.max(margin, window.innerWidth - sheet.right + margin);
      // User request: toasts anchor to the sheet's TOP-right and stack downward.
      const top = Math.max(margin, sheet.top + margin);
      const maxHeight = Math.max(0, sheet.bottom - top - margin);
      setPlacement((current) => current.right === right && current.top === top
        && current.width === width && current.maxHeight === maxHeight
        ? current : { right, top, width, maxHeight });
    };
    measure();
    window.addEventListener('resize', measure);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const workspace = document.querySelector('.workspace');
    if (resizeObserver && workspace instanceof HTMLElement) resizeObserver.observe(workspace);
    return () => {
      window.removeEventListener('resize', measure);
      resizeObserver?.disconnect();
    };
  }, []);
  if (!entries.length) return null;
  return createPortal(<section className="oc-toast-region" aria-label="Notifications" aria-live="polite"
    data-count={entries.length} style={placement}>
    {entries.map((entry) => {
      const title = entry.tone === 'error' ? 'Something went wrong'
        : entry.tone === 'success' ? 'Completed'
          : entry.tone === 'warn' || entry.tone === 'warning' ? 'Attention' : 'Mixdog';
      return <article className="oc-toast" data-tone={entry.tone} key={entry.key}
        role={entry.tone === 'error' ? 'alert' : 'status'}>
        {entry.tone === 'error' ? <ShieldAlert size={16} />
          : entry.tone === 'success' ? <Check size={16} /> : <Sparkles size={16} />}
        <span className="oc-toast-copy"><b>{title}</b><span>{entry.text}</span></span>
        <button type="button" className="oc-toast-close" aria-label="Dismiss notification" onClick={() => {
          if (entry.tone === 'error' && !entry.bridge) {
            setRetainedErrors((current) => current.filter((retained) => retained.signature !== entry.signature));
            setDismissedErrorSignatures((current) => new Set(current).add(entry.signature));
          } else {
            setDismissed((current) => new Set(current).add(entry.key));
          }
          if (entry.bridge) onDismissBridgeError();
        }}><X size={16} /></button>
      </article>;
    })}
  </section>, document.body);
}

function InlineErrors({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return <div className="inline-error" role="alert" aria-live="assertive">
    <ShieldAlert size={14} />
    <span>{messages.map((message, index) => <span key={`${message}-${index}`}>{message}</span>)}</span>
  </div>;
}

const STARTERS = [
  { icon: <Layers3 size={15} />, label: "Plan a feature", prompt: "Help me plan a new feature for this project." },
  { icon: <Code2 size={15} />, label: "Explain the code", prompt: "Explain how this codebase is structured." },
  { icon: <Sparkles size={15} />, label: "Fix a bug", prompt: "Find a meaningful bug in this project and propose a fix." },
  { icon: <Check size={15} />, label: "Improve tests", prompt: "Review this project's tests and suggest the highest-value improvements." },
];

function Conversation({
  snapshot,
  routeSnapshot,
  invoke,
  invokeResult,
  errors,
  submit,
  applySnapshot,
  transitioning,
  composerFocusRequest,
  onNewTask,
  onStartProject,
  onResumeSession,
  onOpenProjects,
  onOpenSessions,
  onOpenSettings,
  projects,
  showProjectSelector,
  activeProjectPath,
  activeProjectLabel,
  onSelectProject,
  onChooseProject,
  onOpenCommandSurface,
}: {
  snapshot: Snapshot;
  routeSnapshot: Snapshot;
  invoke: (action: () => unknown) => Promise<void>;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  errors: string[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  transitioning: boolean;
  composerFocusRequest: number;
  onNewTask: () => void;
  onStartProject: (path: string) => void;
  onResumeSession: (id: string) => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  projects: DesktopProjectSummary[];
  showProjectSelector: boolean;
  activeProjectPath: string;
  activeProjectLabel: string;
  onSelectProject: (path: string) => void;
  onChooseProject: () => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const programmaticScroll = useRef(false);
  const scrollTimer = useRef<number | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
  const sessionScrollPositions = useRef(new Map<string, { top: number; atEnd: boolean }>());
  const skipNextFollowFrame = useRef(false);
  const [starter, setStarter] = useState<{ id: number; text: string } | null>(null);
  const [following, setFollowing] = useState(true);
  const composerActions = useRef({
    submit, invokeResult, applySnapshot, onNewTask, onStartProject, onResumeSession,
    onOpenProjects, onOpenSessions, onOpenSettings, onOpenCommandSurface,
  });
  composerActions.current = {
    submit, invokeResult, applySnapshot, onNewTask, onStartProject, onResumeSession,
    onOpenProjects, onOpenSessions, onOpenSettings, onOpenCommandSurface,
  };
  const items = useMemo(
    () => mergeTranscript(snapshot.items, snapshot.streamingTail),
    [snapshot.items, snapshot.streamingTail],
  );
  const transcriptSessionKey = String(routeSnapshot.sessionId || 'new-task');
  const virtualizingTranscript = items.length > TRANSCRIPT_VIRTUALIZE_THRESHOLD;
  const failedTurns = useMemo(() => new Set(snapshot.failedTurnKeys || []), [snapshot.failedTurnKeys]);
  const turnMetadata = useMemo(() => {
    const current = mergeTranscript(snapshot.items, snapshot.streamingTail);
    const turnKeys = transcriptTurnKeys(current);
    const lastItemByTurn = new Map<string, number>();
    const lastCompletionByTurn = new Map<string, number>();
    const lastAssistantByTurn = new Map<string, number>();
    const completionByAssistant = new Map<number, TranscriptItem>();
    const attachedCompletionIndexes = new Set<number>();
    turnKeys.forEach((turnKey, index) => {
      lastItemByTurn.set(turnKey, index);
      if (current[index]?.kind === "assistant") lastAssistantByTurn.set(turnKey, index);
      if (current[index]?.kind === "statusdone" || current[index]?.kind === "turndone") {
        lastCompletionByTurn.set(turnKey, index);
      }
      const item = current[index];
      if (item?.kind !== "turndone" || failedTurns.has(turnKey) || completionTone(item) !== "complete") return;
      const assistantIndex = lastAssistantByTurn.get(turnKey);
      if (assistantIndex === undefined) return;
      completionByAssistant.set(assistantIndex, item);
      attachedCompletionIndexes.add(index);
    });
    return { turnKeys, lastItemByTurn, lastCompletionByTurn, completionByAssistant, attachedCompletionIndexes };
  }, [
    snapshot.items,
    snapshot.streamingTail?.id,
    snapshot.streamingTail?.kind,
    snapshot.streamingTail?.status,
    snapshot.streamingTail?.label,
    snapshot.streamingTail?.tone,
    snapshot.streamingTail?.verb,
    snapshot.streamingTail?.elapsedMs,
    snapshot.streamingTail?.id == null ? snapshot.streamingTail?.text : "",
    failedTurns,
  ]);
  const { turnKeys, lastItemByTurn, lastCompletionByTurn, completionByAssistant, attachedCompletionIndexes } = turnMetadata;
  const transcriptItemHidden = (index: number) => {
    if (attachedCompletionIndexes.has(index)) return true;
    const item = items[index];
    const completion = item?.kind === "statusdone" || item?.kind === "turndone";
    const turnKey = turnKeys[index];
    return Boolean(completion && failedTurns.has(turnKey) && index !== lastCompletionByTurn.get(turnKey));
  };
  const transcriptVirtualizer = useVirtualizer({
    count: virtualizingTranscript ? items.length : 0,
    enabled: virtualizingTranscript,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => transcriptItemHidden(index) ? 0 : estimatedTranscriptRowHeight(items[index]),
    getItemKey: (index) => `${String(routeSnapshot.sessionId || "new-task")}:${String(
      items[index]?.id ?? `${items[index]?.kind || "row"}-${index}`,
    )}:${index}`,
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    initialRect: { width: 800, height: 800 },
  });
  const transcriptVirtualSize = transcriptVirtualizer.getTotalSize();
  const jumpToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    followOutput.current = true;
    setFollowing(true);
    const element = viewport.current;
    if (!element) return;
    programmaticScroll.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior });
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => { programmaticScroll.current = false; }, 80);
  }, []);
  const composerSubmit = useCallback(async (
    content: DesktopPromptContent,
    options?: DesktopSubmitOptions,
  ) => {
    const accepted = await composerActions.current.invokeResult(
      () => composerActions.current.submit(content, options),
    );
    if (accepted === true) {
      followOutput.current = true;
      setFollowing(true);
    }
    return accepted;
  }, []);
  const composerAbort = useCallback(
    () => composerActions.current.invokeResult(() => window.mixdogDesktop.abort()),
    [],
  );
  const composerInvokeResult = useCallback(
    <T,>(action: () => T | Promise<T>) => composerActions.current.invokeResult(action),
    [],
  );
  const composerApplySnapshot = useCallback(
    (next: EngineSnapshot | null) => composerActions.current.applySnapshot(next),
    [],
  );
  const composerOnNewTask = useCallback(() => composerActions.current.onNewTask(), []);
  const composerOnStartProject = useCallback((path: string) => composerActions.current.onStartProject(path), []);
  const composerOnResumeSession = useCallback((id: string) => composerActions.current.onResumeSession(id), []);
  const composerOnOpenProjects = useCallback(() => composerActions.current.onOpenProjects(), []);
  const composerOnOpenSessions = useCallback(() => composerActions.current.onOpenSessions(), []);
  const composerOnOpenSettings = useCallback(
    (section?: SettingsSection | null) => composerActions.current.onOpenSettings(section),
    [],
  );
  const composerOnOpenCommandSurface = useCallback(
    (surface: CommandSurfaceName) => composerActions.current.onOpenCommandSurface(surface),
    [],
  );

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    skipNextFollowFrame.current = true;
    const saved = sessionScrollPositions.current.get(transcriptSessionKey);
    const atEnd = saved?.atEnd ?? true;
    followOutput.current = atEnd;
    setFollowing(atEnd);
    programmaticScroll.current = true;
    if (virtualizingTranscript) transcriptVirtualizer.measure();
    if (saved && !saved.atEnd) {
      if (virtualizingTranscript) transcriptVirtualizer.scrollToOffset(saved.top, { behavior: 'auto' });
      else element.scrollTo({ top: saved.top, behavior: 'auto' });
    } else if (virtualizingTranscript && items.length > 0) {
      transcriptVirtualizer.scrollToIndex(items.length - 1, { align: "end", behavior: "auto" });
    } else {
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    }
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => { programmaticScroll.current = false; }, 80);
  }, [transcriptSessionKey]);
  useLayoutEffect(() => {
    if (!transitioning) return;
    const element = viewport.current;
    if (!element) return;
    sessionScrollPositions.current.set(transcriptSessionKey, {
      top: element.scrollTop,
      atEnd: element.scrollHeight - element.scrollTop - element.clientHeight < 48,
    });
  }, [transitioning, transcriptSessionKey]);
  useEffect(() => {
    if (skipNextFollowFrame.current) {
      skipNextFollowFrame.current = false;
      return;
    }
    if (followOutput.current && scrollFrame.current === undefined) {
      const element = viewport.current;
      if (!element) return;
      const schedule = window.requestAnimationFrame?.bind(window)
        || ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
      scrollFrame.current = schedule(() => {
        scrollFrame.current = undefined;
        if (!followOutput.current) return;
        programmaticScroll.current = true;
        window.clearTimeout(scrollTimer.current);
        element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
        scrollTimer.current = window.setTimeout(() => { programmaticScroll.current = false; }, 80);
      });
    }
  }, [items.length, snapshot.streamingTail?.text]);
  useEffect(() => () => {
    window.clearTimeout(scrollTimer.current);
    if (scrollFrame.current !== undefined) {
      if (window.cancelAnimationFrame) window.cancelAnimationFrame(scrollFrame.current);
      else window.clearTimeout(scrollFrame.current);
    }
  }, []);
  // Bottom-follow across RESIZES (user): the queue tray mounting/composer
  // growth shrinks the viewport, and async markdown chunks GROW the content
  // after the turn settles — both must re-pin the reader who is at the
  // bottom. Off-bottom readers keep their position untouched.
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (!followOutput.current) return;
      programmaticScroll.current = true;
      window.clearTimeout(scrollTimer.current);
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      scrollTimer.current = window.setTimeout(() => { programmaticScroll.current = false; }, 80);
    });
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, []);

  const renderTranscriptItem = (item: TranscriptItem, index: number) => {
    const turnKey = turnKeys[index];
    const completion = item.kind === "statusdone" || item.kind === "turndone";
    // Session retry (OpenCode parity): resubmit the failed turn's original
    // user prompt through the normal composer submit path.
    const retryTurn = () => {
      for (let cursor = 0; cursor < items.length; cursor += 1) {
        if (turnKeys[cursor] !== turnKey || items[cursor]?.kind !== "user") continue;
        const text = String(items[cursor]?.text ?? "").trim();
        if (text) void composerSubmit(text);
        return;
      }
    };
    const retryDisabled = Boolean(snapshot.busy) || transitioning;
    const retryButton = <button type="button" className="turn-retry" disabled={retryDisabled}
      onClick={retryTurn} aria-label="Retry failed turn">
    <OcIcon name="reset" size={12} />Retry
    </button>;
    if (failedTurns.has(turnKey) && completion) {
      if (index !== lastCompletionByTurn.get(turnKey)) return null;
      return <div className="turn-status failed" role="status"
        key={`failed-${turnKey}`}>
        <X size={13} />Failed
        {retryButton}
      </div>;
    }
    if (attachedCompletionIndexes.has(index)) return null;
    const row = <TranscriptRow item={item} completion={completionByAssistant.get(index)}
      attachedUser={item.kind === "user" && items[index - 1]?.kind === "user"}
      key={`${String(routeSnapshot.sessionId || "new-task")}:${String(item.id ?? `${item.kind}-${index}`)}`} />;
    const pendingFailure = failedTurns.has(turnKey) &&
      !lastCompletionByTurn.has(turnKey) &&
      lastItemByTurn.get(turnKey) === index;
    if (!pendingFailure) return row;
    return <React.Fragment key={`pending-${turnKey}`}>
      {row}
      <div className="turn-status failed" role="status"><X size={13} />Failed{retryButton}</div>
    </React.Fragment>;
  };

  return (
    <section className="conversation">
      <div className="transcript" ref={viewport} role="log" aria-label="Conversation transcript"
        aria-live="polite" aria-relevant="additions" aria-atomic="false"
        aria-busy={Boolean(snapshot.busy || snapshot.commandBusy)} tabIndex={0}
        onScroll={(event) => {
        const nextFollowing = followAfterScroll(
          followOutput.current,
          programmaticScroll.current,
          event.currentTarget,
        );
        followOutput.current = nextFollowing;
        setFollowing(nextFollowing);
        sessionScrollPositions.current.set(transcriptSessionKey, {
          top: event.currentTarget.scrollTop,
          atEnd: nextFollowing,
        });
      }} onWheel={() => { programmaticScroll.current = false; }}
        onPointerDown={() => { programmaticScroll.current = false; }}
        onTouchStart={() => { programmaticScroll.current = false; }}
        onKeyDown={(event) => {
          if (isScrollIntentKey(event.key)) {
            programmaticScroll.current = false;
          }
        }}>
        <div className="thread">
          {items.length === 0 && !snapshot.busy && !snapshot.commandBusy && !snapshot.thinking
            && !snapshot.spinner && !snapshot.commandStatus && !snapshot.toolApproval && (
            <div className="thread-welcome">
              <span className="welcome-wordmark" aria-hidden="true">mixdog</span>
              <h1 className="sr-only">What can Mixdog help you build?</h1>
              <p>Describe what you would like Mixdog to help with.</p>
              <div className="starter-grid" aria-label="Starter actions">
                {STARTERS.map((action) => (
                  <button key={action.label} onClick={() => setStarter({ id: Date.now(), text: action.prompt })}>
                    {action.icon}<span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {virtualizingTranscript ? <div className="transcript-virtual-space" data-virtualized="true"
            style={{ height: `${transcriptVirtualSize}px` }}>
            {transcriptVirtualizer.getVirtualItems().map((virtualRow) => (
              <div className={`transcript-virtual-row ${transcriptItemHidden(virtualRow.index)
                ? "transcript-virtual-row--empty" : ""}`} key={virtualRow.key}
                data-index={virtualRow.index} ref={transcriptVirtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}>
                {renderTranscriptItem(items[virtualRow.index], virtualRow.index)}
              </div>
            ))}
          </div> : items.map(renderTranscriptItem)}
          <LiveActivity snapshot={snapshot} />
          {snapshot.toolApproval && (
            <ApprovalCard key={approvalInstanceKey(snapshot.toolApproval.id)}
              approval={snapshot.toolApproval}
              resolve={(approved) => window.mixdogDesktop.resolveToolApproval(
                String(snapshot.toolApproval?.id || ""), { approved },
              )} />
          )}
        </div>
      </div>
      {!following && <button type="button" className="jump-to-latest" onClick={() => jumpToLatest()}
        aria-label="Jump to latest message">
        <ArrowDown size={14} />Jump to latest
      </button>}
      <div className="composer-region">
        {Boolean(asRecord(snapshot.progressHint)?.text) && <div className="runtime-progress" role="status">
          {String(asRecord(snapshot.progressHint)?.text)}
        </div>}
        {showProjectSelector && <ProjectContextSelector projects={projects}
          activePath={activeProjectPath} activeLabel={activeProjectLabel}
          disabled={transitioning || Boolean(snapshot.busy)}
          onClear={onNewTask} onSelect={onSelectProject} onChoose={onChooseProject} />}
        <InlineErrors messages={errors} />
        <TurnReviewBar items={items} />
        <Composer
          turnBusy={Boolean(snapshot.busy)}
          commandBusy={Boolean(routeSnapshot.commandBusy)}
          transitioning={transitioning}
          focusRequest={composerFocusRequest}
          historyScope={String(routeSnapshot.sessionId || routeSnapshot.currentProject ||
            routeSnapshot.project || routeSnapshot.cwd || 'new-task')}
          projectScope={String(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd || '')}
          hasConversation={items.length > 0}
          hasProjectContext={Boolean(routeSnapshot.currentProject || routeSnapshot.project || routeSnapshot.cwd)}
          promptHistoryList={routeSnapshot.promptHistoryList}
          provider={String(routeSnapshot.provider || "")}
          model={String(routeSnapshot.model || "")}
          effort={String(routeSnapshot.effort || "")}
          fast={Boolean(routeSnapshot.fast)}
          fastCapable={Boolean(routeSnapshot.fastCapable)}
          workflow={(routeSnapshot.workflow as RecordValue | null) ?? null}
          starter={starter}
          queued={snapshot.queued}
          submit={composerSubmit}
          abort={composerAbort}
          invokeResult={composerInvokeResult}
          applySnapshot={composerApplySnapshot}
          onNewTask={composerOnNewTask}
          onStartProject={composerOnStartProject}
          onResumeSession={composerOnResumeSession}
          onOpenProjects={composerOnOpenProjects}
          onOpenSessions={composerOnOpenSessions}
          onOpenSettings={composerOnOpenSettings}
          onOpenCommandSurface={composerOnOpenCommandSurface} />
      </div>
    </section>
  );
}

const PROJECT_CONTEXT_LOCAL = "__mixdog_local__";
const PROJECT_CONTEXT_OPEN = "__mixdog_open__";

function ProjectContextSelector({ projects, activePath, activeLabel, disabled, onClear, onSelect, onChoose }: {
  projects: DesktopProjectSummary[];
  activePath: string;
  activeLabel: string;
  disabled: boolean;
  onClear(): void;
  onSelect(path: string): void;
  onChoose(): void;
}) {
  const normalized = activePath.replace(/[\\/]+/g, "/").toLocaleLowerCase();
  const known = projects.some((project) =>
    project.path.replace(/[\\/]+/g, "/").toLocaleLowerCase() === normalized);
  const options = [
    { value: PROJECT_CONTEXT_LOCAL, label: "No project" },
    ...(!activePath || known ? [] : [{ value: activePath, label: activeLabel || displayProject(activePath).name || "Project" }]),
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || displayProject(project.path).name || "Project",
    })),
    { value: PROJECT_CONTEXT_OPEN, label: "Open folder…" },
  ];
  const value = activePath || PROJECT_CONTEXT_LOCAL;
  return <div className="composer-context-bar">
    <div className="composer-project-context">
      <Folder size={13} />
      <OpenSelect className="project-context-select" ariaLabel="Project context"
        value={value} displayValue={activeLabel || "Project"} disabled={disabled}
        options={options} onChange={(next) => {
          if (next === PROJECT_CONTEXT_OPEN) onChoose();
          else if (next === PROJECT_CONTEXT_LOCAL) {
            if (activePath) onClear();
          } else if (next !== activePath) onSelect(next);
        }} />
    </div>
  </div>;
}

const TERMINAL_AGENT_STATUS = /idle|done|complete|success|closed|error|fail|cancel|killed|timeout/i;

function timeMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatWorkElapsed(value: unknown): string {
  const elapsed = Math.max(0, Number(value) || 0);
  if (!Number.isFinite(elapsed) || elapsed < 1_000) return "";
  const days = Math.floor(elapsed / 86_400_000);
  const hours = Math.floor((elapsed % 86_400_000) / 3_600_000);
  const minutes = Math.floor((elapsed % 3_600_000) / 60_000);
  const seconds = Math.floor((elapsed % 60_000) / 1_000);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function LiveWorkStatus({ snapshot, now: fixedNow }: { snapshot: Snapshot; now?: number }) {
  const [clock, setClock] = useState(() => fixedNow ?? Date.now());
  const workers = Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : [];
  const jobs = Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : [];
  const taggedRunningKeys = new Set<string>();
  let untaggedRunningCount = 0;
  let oldestAgentStart = Infinity;
  workers.forEach((worker) => {
    const tag = String(worker.tag || worker.agent || worker.name || "").trim();
    if (TERMINAL_AGENT_STATUS.test(String(worker.stage || worker.status || ""))) return;
    if (tag) taggedRunningKeys.add(tag);
    else untaggedRunningCount += 1;
    const startedAt = timeMs(worker.startedAt || worker.startTime || worker.createdAt);
    if (startedAt > 0) oldestAgentStart = Math.min(oldestAgentStart, startedAt);
  });
  jobs.forEach((job) => {
    if (!/running|pending|queued|starting/i.test(String(job.status || job.stage || ""))) return;
    const tag = String(job.tag || job.agent || job.type || job.task_id || job.taskId || "").trim();
    if (tag) taggedRunningKeys.add(tag);
    else untaggedRunningCount += 1;
    const startedAt = timeMs(job.startedAt);
    if (startedAt > 0) oldestAgentStart = Math.min(oldestAgentStart, startedAt);
  });
  const runningCount = taggedRunningKeys.size + untaggedRunningCount;
  const tools = snapshot.activeTools || {};
  const exploreCount = Math.max(0, Number(tools.explore?.count) || 0);
  const searchCount = Math.max(0, Number(tools.search?.count) || 0);
  const shellCount = Math.max(0, Number(snapshot.shellJobs?.count) || 0);
  const active = runningCount > 0 || exploreCount > 0 || searchCount > 0 || shellCount > 0;
  useEffect(() => {
    if (fixedNow !== undefined || !active) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, fixedNow]);
  if (!active) return null;
  // Aggregate chip (user decision): ONE quiet spinner+count left of the
  // context gauge; the per-activity breakdown lives in a hover popover.
  const total = runningCount + exploreCount + searchCount + shellCount;
  const row = (key: string, label: string, elapsed: string) => <div className="live-work-row" key={key}>
    <span>{label}</span>
    {elapsed && <small>{elapsed}</small>}
  </div>;
  return <div className="live-work-status" role="status" tabIndex={0}
    aria-label={`Background activity: ${total} running`}>
    {/* 16px matches the optical weight of the neighboring 18–20px controls;
        13px read as vertically off next to them (user). */}
    <LoaderCircle className="live-work-spinner" size={16} aria-hidden="true" />
    <span className="live-work-count">{total}</span>
    <div className="live-work-popover" role="tooltip">
      {runningCount > 0 && row("agents", `Agent${runningCount === 1 ? "" : "s"} ${runningCount}`,
        Number.isFinite(oldestAgentStart) ? formatWorkElapsed(clock - oldestAgentStart) : "")}
      {exploreCount > 0 && row("explore", "Explore",
        tools.explore?.startedAt ? formatWorkElapsed(clock - Number(tools.explore.startedAt)) : "")}
      {searchCount > 0 && row("search", "Web search",
        tools.search?.startedAt ? formatWorkElapsed(clock - Number(tools.search.startedAt)) : "")}
      {shellCount > 0 && row("shells", `Shell ${shellCount}`,
        String(snapshot.shellJobs?.elapsedLabel || ""))}
    </div>
  </div>;
}

function contextMetrics(snapshot: Snapshot) {
  const stats = asRecord(snapshot.stats);
  if (!String(snapshot.sessionId || "")) {
    const limit = Math.max(0, Number(
      snapshot.autoCompactTokenLimit || snapshot.displayContextWindow || snapshot.contextWindow || 0,
    ));
    return { used: 0, limit, percent: 0, estimated: false };
  }
  if (!stats) return null;
  const exact = Math.max(0, Number(stats.currentContextTokens || 0));
  const estimated = Math.max(0, Number(stats.currentEstimatedContextTokens || 0));
  const used = exact || estimated;
  const usage = resolveContextUsage({
    usedTokens: used,
    autoCompactTokenLimit: snapshot.autoCompactTokenLimit,
    displayContextWindow: snapshot.displayContextWindow,
    contextWindow: snapshot.contextWindow,
  });
  if (!usage) return null;
  return {
    ...usage,
    estimated: exact === 0 && estimated > 0,
  };
}

export function ContextUsageIndicator({ snapshot, onOpen }: {
  snapshot: Snapshot;
  onOpen(): void;
}) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const keyboardFocusIntent = useRef(false);
  const context = contextMetrics(snapshot);
  useEffect(() => {
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Tab") keyboardFocusIntent.current = true;
      if (event.key === "Escape") setPopoverOpen(false);
    };
    const pointerdown = () => { keyboardFocusIntent.current = false; };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", pointerdown, true);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", pointerdown, true);
    };
  }, []);
  if (!context) return null;
  const descriptionId = `context-usage-${String(snapshot.sessionId || "session")}`;
  return <div className="session-context-indicator" data-open={popoverOpen ? "true" : "false"}
    onMouseEnter={() => setPopoverOpen(true)} onMouseLeave={() => setPopoverOpen(false)}>
    <button type="button" onClick={() => {
      keyboardFocusIntent.current = false;
      setPopoverOpen(false);
      onOpen();
    }} onFocus={() => {
      if (keyboardFocusIntent.current) {
        keyboardFocusIntent.current = false;
        setPopoverOpen(true);
      }
    }} aria-label="Open context details"
      aria-describedby={descriptionId}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-usage-track" cx="10" cy="10" r="7" />
        <circle className="context-usage-value" cx="10" cy="10" r="7"
          pathLength="100" strokeDasharray={`${context.percent} 100`} />
      </svg>
    </button>
    <div className="session-context-popover" id={descriptionId} role="tooltip">
      <div><span>Usage</span><b>{context.percent}%</b></div>
      <div><span>{context.estimated ? "Tokens (est.)" : "Tokens"}</span><b>{context.limit > 0
        ? `${context.used.toLocaleString()} / ${context.limit.toLocaleString()}`
        : context.used.toLocaleString()}</b></div>
      {(() => {
        const cost = Math.max(0, Number(asRecord(snapshot.stats)?.costUsd || 0));
        return cost > 0
          ? <div><span>Cost</span><b>${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}</b></div>
          : null;
      })()}
      {/* Compact action removed from the hover popover by user decision —
          /compact and auto-compact remain the compaction paths. */}
    </div>
  </div>;
}

function LiveActivity({ snapshot }: { snapshot: Snapshot }) {
  const spinner = snapshot.spinner && snapshot.spinner.active !== false ? snapshot.spinner : null;
  const command = snapshot.commandStatus && snapshot.commandStatus.active !== false ? snapshot.commandStatus : null;
  const activity = spinner || command;
  const [now, setNow] = useState(Date.now());
  const startedAt = Number(activity?.startedAt || 0);
  // Stream events flip the activity mode (thinking→responding→tool-use)
  // several times a second; a status line that rewrites itself that fast
  // reads as flicker. Hold each verb for a minimum dwell before accepting
  // the next one — appearance/disappearance stays immediate.
  const heldVerb = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  useEffect(() => {
    if (!activity || !startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activity, startedAt]);
  if (!activity && !snapshot.thinking) {
    heldVerb.current = { text: "", at: 0 };
    return null;
  }
  const mode = String(activity?.mode || (snapshot.thinking ? "thinking" : "responding"));
  if (mode === "resuming") {
    heldVerb.current = { text: "", at: 0 };
    return null;
  }
  const canonicalVerb: Record<string, string> = {
    requesting: "Requesting",
    responding: "Responding",
    thinking: "Thinking",
    "tool-use": "Using tools",
    "tool-input": "Using tools",
    compacting: "Compacting conversation",
    "auto-clear": "Auto-clearing conversation",
  };
  // Mirror Spinner's MODE_VERBS boundary: only those modes have a stable
  // canonical first phrase. Other modes carry engine-authored status detail.
  const rawVerb = canonicalVerb[mode] || String(activity?.verb || "Working");
  const nowMs = Date.now();
  // Engine-authored statuses (retry countdowns, compaction detail) must break
  // through immediately; only the canonical stream verbs dwell.
  const canonicalMode = Boolean(canonicalVerb[mode]);
  if (!heldVerb.current.text
    || !canonicalMode
    || (rawVerb !== heldVerb.current.text && nowMs - heldVerb.current.at >= 3_000)) {
    heldVerb.current = { text: rawVerb, at: nowMs };
  }
  const verb = heldVerb.current.text;
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  const outputTokens = Math.max(0, Number(activity?.outputTokens || activity?.tokens || 0));
  const reasoning = publicThinkingSummary(snapshot.thinking);
  return <div className="live-activity" data-mode={mode}>
    <div className="live-activity-status" role="status" aria-live="polite">
      <TextShimmer text={verb} />
      {(elapsed || outputTokens > 0) && <small>
        {[elapsed, outputTokens > 0 ? `${outputTokens.toLocaleString()} tokens` : ""].filter(Boolean).join(" · ")}
      </small>}
    </div>
    {reasoning && <details className="thinking-disclosure">
      <summary>View reasoning</summary>
      <pre>{reasoning}</pre>
    </details>}
  </div>;
}

function TextShimmer({ text, active = true }: { text: string; active?: boolean }) {
  return <span data-component="text-shimmer" data-active={active ? "true" : "false"} aria-label={text}>
    <span data-slot="text-shimmer-char" data-run={active ? "true" : "false"}
      aria-hidden="true">{text}</span>
  </span>;
}

function completionTone(item: TranscriptItem): "complete" | "failed" | "interrupted" | "compaction" {
  const label = String(item.label || item.status || "").trim();
  const status = String(item.status || "").toLowerCase();
  if (status === "failed" || item.tone === "error" || /failed|error/i.test(label)) return "failed";
  if (/^(?:cancelled|canceled|aborted|interrupted)$/.test(status)
    || /cancelled|canceled|aborted|interrupted/i.test(label)) return "interrupted";
  if (item.kind === "statusdone" && /compact/i.test(label)) return "compaction";
  return "complete";
}

function CompletionStatus({ item }: { item: TranscriptItem }) {
  const tone = completionTone(item);
  const label = String(item.label || item.status || "");
  if (tone === "failed" || tone === "interrupted") {
    const elapsed = formatElapsed(item.elapsedMs);
    const fallback = tone === "failed" ? "Failed" : elapsed ? `Cancelled after ${elapsed}` : "Cancelled";
    const visible = tone === "failed" && !/^(done|complete|completed)$/i.test(label) ? label || fallback : fallback;
    return <div className={`turn-status ${tone}`} role="status">
      <X size={13} />{visible}
    </div>;
  }
  if (tone === "compaction") {
    return <div className="compaction-divider" role="status">
      <span>{label || "Conversation compacted"}</span>
      {item.detail && <small>{item.detail}</small>}
    </div>;
  }
  const elapsed = formatElapsed(item.elapsedMs);
  const completionLabel = item.kind === "turndone"
    ? [String(item.verb || item.label || "Thought"), elapsed ? `for ${elapsed}` : ""].filter(Boolean).join(" ")
    : label || "Complete";
  return <div className="turn-status complete" role="status">
    <Check size={13} />
    <span>{completionLabel}</span>
    {item.kind === "statusdone" && item.detail && <small>· {item.detail}</small>}
  </div>;
}

function CopyControl({ value, label, className, tooltipSide = "top" }: {
  value: string;
  label: string;
  className: string;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}) {
  const copiedTimer = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const copy = async () => {
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className={className} onClick={() => void copy()}
    aria-label={copied ? "Copied" : label} data-copied={copied || undefined}
    data-tooltip={copied ? "Copied" : "Copy"} data-tooltip-side={tooltipSide}>
    {copied ? <OcIcon name="check" size={13} /> : <OcIcon name="copy" size={13} />}
  </button>;
}

const MarkdownBody = lazy(() => import("./MarkdownBody"));

const MarkdownResponse = React.memo(function MarkdownResponse({ text, streaming }: {
  text: string;
  streaming: boolean;
}) {
  const [renderedText, setRenderedText] = useState(text);
  const pendingText = useRef(text);
  const parseTimer = useRef<number | undefined>(undefined);
  pendingText.current = text;
  useEffect(() => {
    if (!streaming) {
      window.clearTimeout(parseTimer.current);
      parseTimer.current = undefined;
      setRenderedText(text);
      return undefined;
    }
    if (parseTimer.current === undefined) {
      parseTimer.current = window.setTimeout(() => {
        parseTimer.current = undefined;
        setRenderedText(pendingText.current);
      }, 80);
    }
    return undefined;
  }, [text, streaming]);
  useEffect(() => () => window.clearTimeout(parseTimer.current), []);
  return <div className={`markdown ${streaming ? "streaming" : ""}`}>
    <Suspense fallback={<div className="markdown-plain">{renderedText}</div>}>
      <MarkdownBody text={renderedText} copyControl={CopyControl} />
    </Suspense>
    {streaming && <span className="stream-cursor" aria-hidden="true" />}
  </div>;
});

const transcriptItemSignatures = new WeakMap<object, string>();

function transcriptItemSignature(item: TranscriptItem | undefined): string {
  if (!item) return "";
  const cached = transcriptItemSignatures.get(item);
  if (cached !== undefined) return cached;
  let signature: string;
  try {
    signature = JSON.stringify(item);
  } catch {
    return "";
  }
  transcriptItemSignatures.set(item, signature);
  return signature;
}

function messageMetadata(item: TranscriptItem) {
  const agent = typeof item.agent === "string" ? item.agent.trim() : "";
  const model = typeof item.model === "string" ? item.model.trim() : "";
  const shortTime = typeof item.at === "number" && Number.isFinite(item.at) && item.at > 0
    ? new Date(item.at).toLocaleTimeString(undefined, { timeStyle: "short" })
    : "";
  return {
    details: [agent, model, shortTime].filter(Boolean),
    shortTime,
  };
}

// The transcript renders attached images as chips, so the raw composer token
// ("[Image #N: name]") in the message text is redundant noise there.
function stripImageTokens(text: string): string {
  return text
    .replace(/ ?\[Image #\d+(?::[^\]]*)?\] ?/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export const TranscriptRow = memo(function TranscriptRow({
  item,
  completion,
  attachedUser = false,
}: {
  item: TranscriptItem;
  completion?: TranscriptItem;
  attachedUser?: boolean;
}) {
  const previousStreaming = useRef(Boolean(item.streaming));
  const announceSettled = previousStreaming.current && !item.streaming;
  useEffect(() => {
    previousStreaming.current = Boolean(item.streaming);
  }, [item.streaming]);
  if (item.kind === "tool") {
    if (shouldSuppressFullyFailedToolItem(item)) return null;
    return <ToolCard item={item} />;
  }
  if (item.kind === "statusdone" || item.kind === "turndone") {
    return <CompletionStatus item={item} />;
  }
  if (item.kind === "notice") {
    return <div className={`notice ${item.tone === "error" ? "error" : ""}`}
      role={item.tone === "error" ? "alert" : "status"}>{item.text}</div>;
  }
  if (item.kind !== "user" && item.kind !== "assistant") return null;
  const user = item.kind === "user";
  const text = String(item.text || "");
  const metadata = messageMetadata(item);
  return (
    <>
      <article className={`message ${user ? "user" : "assistant"} ${item.streaming ? "streaming" : "settled"} ${user && attachedUser ? "attached-user" : ""}`}
        aria-live={item.streaming || announceSettled ? "off" : undefined}>
        <div className="message-body">
          {user ? <>
            {Array.isArray(item.images) && item.images.length > 0 && <div className="message-image-chips"
              aria-label="Attached images">
              {item.images.map((image, index) => {
                const preview = imagePreviewCache.get(imagePreviewKey(image.id, image.bytes));
                return <span className="message-image-chip" key={`${image.id ?? 'img'}-${index}`}
                  title={image.name || 'Attached image'}>
                  {preview
                    ? <img src={preview} alt={image.name || 'Attached image'} />
                    : <span className="message-image-fallback">
                <OcIcon name="photo" size={14} />
                      <span>{image.name || 'Image'}</span>
                    </span>}
                </span>;
              })}
            </div>}
            <p>{Array.isArray(item.images) && item.images.length > 0
              ? stripImageTokens(text)
              : item.text}</p>
          </> : (
            <MarkdownResponse text={text} streaming={Boolean(item.streaming)} />
          )}
        </div>
        {user && !item.streaming && text && <footer className="message-meta-line"
          aria-label="Message details">
          {metadata.details.length > 0 && <span className="message-meta">
            {metadata.details.join("\u00A0\u00B7\u00A0")}
          </span>}
          <CopyControl value={text} label="Copy message"
            className="message-actions user-copy" />
        </footer>}
        {!user && !item.streaming && (text || completion) && <footer className="response-footer"
          aria-label="Response details">
          {completion && <CompletionStatus item={completion} />}
          {metadata.shortTime && <time className="message-time">{metadata.shortTime}</time>}
          {text && <CopyControl value={text} label="Copy response"
            className="message-actions response-copy" />}
        </footer>}
      </article>
      {announceSettled && !completion && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Mixdog response complete.
      </p>}
    </>
  );
}, (previous, next) => (
  previous.item === next.item ||
  transcriptItemSignature(previous.item) === transcriptItemSignature(next.item)
) && (
  previous.completion === next.completion ||
  transcriptItemSignature(previous.completion) === transcriptItemSignature(next.completion)
  ) && previous.attachedUser === next.attachedUser);

function ToolCard({ item }: { item: TranscriptItem }) {
  const [open, setOpen] = useState(Boolean(item.expanded));
  const contentId = useId();
  useEffect(() => {
    if (typeof item.expanded === "boolean") setOpen(item.expanded);
  }, [item.expanded]);
  const done = item.completedAt != null || (item.completedCount === undefined
    ? item.result != null || item.rawResult != null
    : item.completedCount >= (item.count || 1));
  // Live elapsed readout for running cards (cline/zed timer grammar). Ticks
  // only while the card is unsettled; ≥3s threshold keeps fast tools quiet.
  const startedAt = Number(item.startedAt || 0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (done || !startedAt) return;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [done, startedAt]);
  const elapsedSeconds = !done && startedAt > 0 ? Math.floor((nowTick - startedAt) / 1000) : 0;
  const elapsedLabel = elapsedSeconds >= 3
    ? elapsedSeconds >= 60 ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s` : `${elapsedSeconds}s`
    : "";
  const failedCount = Math.max(0, Number(item.errorCount || 0));
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const denied = isHookApprovalDenialToolItem(item);
  const failed = Boolean(item.isError || failedCount > 0 || callFailedCount > 0);
  const exited = !failed && exitFailedCount > 0;
  const surface = formatToolSurface(item.name, item.args);
  const category = classifyToolCategory(item.name, surface.args);
  const activeCategories = asRecord(item.categories) || {};
  const doneCategories = asRecord(item.doneCategories);
  const categories = done && doneCategories && Object.keys(doneCategories).length ? doneCategories : activeCategories;
  const aggregateOrder = Array.isArray(asRecord(item.args)?.categoryOrder)
    ? asRecord(item.args)?.categoryOrder as string[] : undefined;
  const aggregateTitle = item.aggregate
    ? formatAggregateHeader(categories, { pending: !done, order: aggregateOrder }) : "";
  const parsedArgs = asRecord(surface.args);
  const shellCommand = category === "Shell"
    ? String(parsedArgs?.command || parsedArgs?.cmd || parsedArgs?.script || "").trim()
    : "";
  const shellDescription = category === "Shell" ? String(parsedArgs?.description || "").trim() : "";
  const title = aggregateTitle || (item.aggregate
    ? `${item.count || 1} tool operations`
    : category === "Shell" ? "Shell" : surface.label);
  // Shell cards mirror cline/zed: the header names the command itself when no
  // human description exists, so running/failed rows are identifiable unopened.
  const argumentSummary = item.aggregate ? ""
    : category === "Shell" ? (shellDescription || shellCommand) : surface.summary;
  const monoSummary = category === "Shell" && !shellDescription && Boolean(shellCommand);
  const rawResult = item.result ?? item.rawResult;
  const patch = findPatch(item);
  const hasInput = !item.aggregate && category !== "Shell"
    && (parsedArgs ? Object.keys(parsedArgs).length > 0 : Boolean(surface.args));
  const hasResult = typeof rawResult === "string" ? Boolean(rawResult.trim()) : rawResult != null;
  const hasDetails = hasInput || patch != null || hasResult || Boolean(shellCommand);
  const count = Math.max(1, Math.round(Number(item.count || 1)));
  const errorCard = (failed || denied) && hasResult;
  const exceptionalState = denied ? "Denied" : failed ? "Failed" : exited ? "Exit" : "";
  // Streamed tail from the running command (engine liveOutput plumbing).
  // Only meaningful pre-settlement; the settled result supersedes it.
  const liveOutput = !done && typeof item.liveOutput === "string" ? item.liveOutput : "";
  return (
    <article className={`tool-card ${failed || denied ? "failed" : ""} ${exited ? "exited" : ""} ${done ? "settled" : ""}`}
      data-category={category} data-kind={errorCard ? "tool-error-card" : undefined}
      data-open={open ? "true" : "false"}>
      <button className="tool-header" disabled={!hasDetails}
        onClick={() => setOpen((value) => !value)} aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? contentId : undefined}>
        <span className="tool-icon">{failed || denied ? <X size={15} /> : toolIcon(category)}</span>
        <span className="tool-title">
          <b data-component={item.aggregate ? "tool-count-summary" : "tool-status-title"}
            data-active={!done ? "true" : "false"}>
            <TextShimmer text={title} active={!done} />
          </b>
          {!item.aggregate && count > 1 && <span className="tool-count-label"
            data-component="tool-count-label">{count} calls</span>}
          {argumentSummary && <small className={monoSummary ? "tool-command-inline" : undefined}>{argumentSummary}</small>}
        </span>
        {exceptionalState && <span className={`tool-state ${failed || denied ? "failed" : ""} ${exited ? "exited" : ""}`} role="status">
          <X size={13} />{exceptionalState}
        </span>}
        {elapsedLabel && !exceptionalState && <span className="tool-elapsed" role="timer">{elapsedLabel}</span>}
        {!done && !exceptionalState && <span className="sr-only" role="status">Running</span>}
        {hasDetails && <span className="tool-chevron" aria-hidden="true"><ChevronRight size={16} /></span>}
      </button>
      {liveOutput && (
        <div className="tool-content" id={contentId} data-live="true">
          <ToolOutput value={liveOutput} command={shellCommand} follow />
        </div>
      )}
      {!liveOutput && hasDetails && open && (
        <div className="tool-content" id={contentId}>
          {/* A rendered diff already communicates the edit; raw args JSON on
              top of it is noise no reference client shows. */}
          {hasInput && patch == null && <DetailBlock label="Input" value={surface.args} />}
          {patch ? <CodeDiff patch={patch} /> :
            category === "Shell"
              ? <ToolOutput value={rawResult} command={shellCommand} copyLabel="Copy command output" />
              : hasResult && <ToolOutput value={rawResult}
                copyLabel={failed || denied ? "Copy tool error" : undefined} />}
        </div>
      )}
    </article>
  );
}

function ToolOutput({ value, command = "", copyLabel, follow = false }: {
  value: unknown;
  command?: string;
  copyLabel?: string;
  follow?: boolean;
}) {
  const output = boundedTextOf(value);
  const text = command ? `$ ${command}${output.trim() ? `\n\n${output}` : ""}` : output;
  const scroller = useRef<HTMLDivElement>(null);
  // Live tails append at the bottom; keep the capped viewport pinned there
  // (reference clients' terminal-follow behavior). Static outputs never jump.
  useEffect(() => {
    if (follow && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [follow, text]);
  if (!text.trim()) return null;
  return <div className={`tool-output ${command ? "shell-output" : ""}`}>
    {copyLabel && <CopyControl value={text} label={copyLabel}
      className="tool-detail-copy tool-output-copy" />}
    <div className="tool-output-scroll" ref={scroller}>
      <pre><code>{text}</code></pre>
    </div>
  </div>;
}

function DetailBlock({ label, value, copyLabel }: { label: string; value: unknown; copyLabel?: string }) {
  const text = boundedTextOf(value);
  if (!text.trim()) return null;
  return <div className="detail-block">
    <div className="detail-block-heading"><span>{label}</span>
      {copyLabel && text && <CopyControl value={text} label={copyLabel} className="tool-detail-copy" />}
    </div>
    <pre>{text}</pre>
  </div>;
}

function boundedTextOf(value: unknown, maxLength = 100_000) {
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}\n…truncated` : value;
  let visited = 0;
  try {
    const text = JSON.stringify(value, (_key, nested) => {
      visited += 1;
      if (visited > 2_000) return "…truncated";
      if (typeof nested === "string" && nested.length > 20_000) return `${nested.slice(0, 20_000)}…`;
      return nested;
    }, 2) || "";
    return text.length > maxLength ? `${text.slice(0, maxLength)}\n…truncated` : text;
  } catch {
    return oneLine(String(value), maxLength);
  }
}

function toolResultText(item: TranscriptItem) {
  return [item.result, item.rawResult]
    .filter((value, index, values) => value != null && (index === 0 || value !== values[0]))
    .map(String).join("\n").trim();
}

function isHookApprovalDenialToolItem(item: TranscriptItem) {
  if (!item.isError) return false;
  const text = toolResultText(item);
  return /^Error:\s*tool\s*"[^"]*"\s*denied by hook\b/im.test(text)
    || /denied by hook:\s*approval required but no approval UI is available/i.test(text);
}

function shouldSuppressFullyFailedToolItem(item: TranscriptItem) {
  const args = asRecord(item.args);
  const status = String(args?.status || "").toLowerCase();
  if ((args?.task_id || args?.taskId) && /^(failed|error|timeout|cancelled|canceled|killed)$/.test(status)) return false;
  const count = Math.max(1, Number(item.count || 1));
  const completed = Math.max(0, Math.min(count, Number(item.completedCount || (item.result == null ? 0 : count))));
  const explicit = Number(item.errorCount);
  const errors = Number.isFinite(explicit) ? Math.max(0, Math.min(count, Math.floor(explicit))) : item.isError ? count : 0;
  return completed >= count && errors >= count && !isHookApprovalDenialToolItem(item) && !toolResultText(item);
}

function toolIcon(category: unknown) {
  if (category === "Patch") return <Code2 size={16} />;
  if (category === "Read") return <OcIcon name="open-file" size={16} />;
  if (category === "Search" || category === "Web Research") return <OcIcon name="magnifying-glass" size={16} />;
  if (category === "Shell") return <OcIcon name="terminal" size={16} />;
  return <Layers3 size={16} />;
}

function findPatch(item: TranscriptItem) {
  const args = asRecord(item.args);
  const result = asRecord(item.result);
  const candidates = [args?.patch, args?.diff, result?.patch, result?.diff, item.result, item.rawResult];
  const candidate = candidates.find((value) => typeof value === "string" &&
    (/^@@/m.test(value) || /^diff --git/m.test(value) || /^\*\*\* (?:Begin Patch|Add File:|Delete File:)/m.test(value)));
  return typeof candidate === "string" ? normalizeApplyPatch(candidate) : undefined;
}

class DiffBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function CodeDiff({ patch }: { patch: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = patch.split("\n").length;
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const fallback = <pre className="diff-fallback">{patch}</pre>;
  return (
    <section className="code-diff">
      <div className={expanded ? "" : "diff-collapsed"}>
        <DiffBoundary key={patch} fallback={fallback}>
          {files.map((file, index) => {
            const additions = file.hunks.join("\n").split("\n")
              .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
            const deletions = file.hunks.join("\n").split("\n")
              .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
            return <div className="diff-file" key={`${file.newFile.fileName}-${index}`}>
              <header><FileDiff size={15} /><b>{file.newFile.fileName}</b>
                <span className="diff-stats"><i>+{additions}</i><em>-{deletions}</em></span>
                <CopyControl value={file.patch} label={`Copy diff for ${file.newFile.fileName}`}
                  className="tool-detail-copy diff-copy" />
              </header>
              {file.renderable ? (
                <Suspense fallback={<div className="diff-loading" aria-hidden="true">Loading diff…</div>}>
                  {/* The library's parser requires the ---/+++ header in each
                      hunk entry; header-less @@ hunks parse as an EMPTY diff.
                      Feed the full per-file patch instead. */}
                  <DiffView data={{ oldFile: file.oldFile, newFile: file.newFile, hunks: [file.patch] }} />
                </Suspense>
              ) : <pre className="diff-fallback">{file.patch}</pre>}
            </div>;
          })}
        </DiffBoundary>
      </div>
      {lineCount > 14 && (
        <button type="button" className="diff-toggle" onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}>
          {expanded ? "Collapse diff" : "Show full diff"}
        </button>
      )}
    </section>
  );
}

export function ApprovalCard({ approval, resolve }: {
  approval: Approval;
  resolve: (approved: boolean) => Promise<unknown>;
}) {
  const [resolving, setResolving] = useState(false);
  const [approvalError, setApprovalError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const resolvingRef = useRef(false);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const decide = useCallback(async (approved: boolean) => {
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setApprovalError("");
    setResolving(true);
    try {
      const accepted = await resolveRef.current(approved);
      if (accepted === true) return;
      setApprovalError("Mixdog could not record this decision. Please try again.");
      resolvingRef.current = false;
      setResolving(false);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason || "");
      setApprovalError(detail
        ? `Mixdog could not record this decision: ${detail}`
        : "Mixdog could not record this decision. Please try again.");
      resolvingRef.current = false;
      setResolving(false);
    }
  }, []);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []);
    (focusable()[0] || dialog.current)?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)) return;
      const shortcut = event.key.toLowerCase();
      if (shortcut === "a" || shortcut === "y" || shortcut === "d" || shortcut === "n") {
        event.preventDefault();
        event.stopPropagation();
        void decide(shortcut === "a" || shortcut === "y");
        return;
      }
      if (isApprovalDismissKey(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        void decide(false);
        return;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previousFocus?.focus();
    };
  }, [decide]);
  // Inline approval (goose/cline convention): the request renders in the
  // transcript flow with a warning ring instead of a modal overlay, so the
  // user can keep reading and typing while deciding.
  return (
    <article ref={dialog} className="approval-card approval-card--inline" role="group"
      aria-labelledby="approval-title" aria-describedby="approval-description"
      >
      <div className="approval-heading"><span><ShieldAlert size={19} /></span>
        <div><b id="approval-title">Tool approval required</b>
          <small>{String(approval.name || "Tool")} wants to run</small></div>
      </div>
      <p id="approval-description">{approval.reason || "Review this tool request before continuing."}</p>
      <dl>
        {approval.cwd && <><dt>Folder</dt><dd>{approval.cwd}</dd></>}
        {approval.args != null && <><dt>Arguments</dt><dd><code>{textOf(approval.args)}</code></dd></>}
      </dl>
      {approvalError && <p className="approval-error" role="alert" aria-live="assertive">
        {approvalError}
      </p>}
      <div className="approval-actions">
        <button disabled={resolving} onClick={() => void decide(false)}><X size={15} /> Deny</button>
        <button disabled={resolving} className="allow" onClick={() => void decide(true)}>
          <Check size={15} /> Allow once</button>
      </div>
    </article>
  );
}

type ComposerAttachment = {
  id: number;
  name: string;
  kind: 'image' | 'text' | 'pdf';
  mimeType: string;
  data: string;
  token: string;
  source?: 'file' | 'paste';
  metadataText?: string;
};

const MAX_COMPOSER_ATTACHMENTS = 8;
const MAX_INLINE_FILE_BYTES = 750_000;
const MAX_INLINE_TEXT_TOTAL = 850_000;
const MAX_INLINE_IMAGE_BASE64_TOTAL = 30_000_000;
// opencode parity: PDFs attach as provider document blocks, 20 MiB per file.
const MAX_PDF_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SUBMIT_TEXT_LENGTH = 950_000;
const MAX_PERSISTED_PROMPT_HISTORY = 100;
const PROMPT_HISTORY_STORAGE_PREFIX = 'mixdog.desktop.prompt-history.v1:';
const COMPOSER_PLACEHOLDERS = [
  // One quiet line (user decision): no rotating tips, no syntax lecture.
  'Ask anything…',
] as const;

function promptHistoryStorageKey(scope: string) {
  return `${PROMPT_HISTORY_STORAGE_PREFIX}${encodeURIComponent(scope || 'new-task')}`;
}

// opencode-parity text sniffing: accept any file whose first 4 KB contains no
// NUL byte and a low control-character ratio, instead of trusting only the
// extension whitelist (.env, .ini, extension-less logs, …).
async function fileLooksLikeText(file: File): Promise<boolean> {
  try {
    const bytes = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    if (bytes.length === 0) return true;
    let control = 0;
    for (const byte of bytes) {
      if (byte === 0) return false;
      if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
    }
    return control / bytes.length <= 0.3;
  } catch {
    return false;
  }
}

function readPromptHistory(scope: string) {
  try {
    const value = JSON.parse(window.localStorage.getItem(promptHistoryStorageKey(scope)) || '[]');
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry] : [])
      .slice(0, MAX_PERSISTED_PROMPT_HISTORY);
  } catch {
    return [];
  }
}

function queuedFollowupPreview(entry: unknown) {
  return queueText(entry).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "[Attachment]";
}

// Zed "Review Changes" parity: an accordion above the composer summarizing the
// files the current turn edited (count + line delta), expandable per file.
function TurnReviewBar({ items }: { items: TranscriptItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => {
    let lastUser = -1;
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "user") { lastUser = index; break; }
    }
    const files = new Map<string, { additions: number; deletions: number }>();
    for (let index = lastUser + 1; index < items.length; index++) {
      const item = items[index];
      if (!item || item.kind !== "tool") continue;
      const patch = findPatch(item);
      if (typeof patch !== "string" || !patch) continue;
      try {
        for (const file of parseUnifiedDiff(patch)) {
          const name = String(file.newFile?.fileName || "");
          if (!name) continue;
          const body = file.hunks.join("\n").split("\n");
          const entry = files.get(name) || { additions: 0, deletions: 0 };
          entry.additions += body.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
          entry.deletions += body.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
          files.set(name, entry);
        }
      } catch { /* non-diff payload — skip */ }
    }
    let additions = 0;
    let deletions = 0;
    for (const entry of files.values()) { additions += entry.additions; deletions += entry.deletions; }
    return { files, additions, deletions };
  }, [items]);
  if (summary.files.size === 0) return null;
  return (
    <section className="turn-review-bar" aria-label="Files changed this turn"
      data-expanded={expanded ? "true" : "false"}>
      <button type="button" className="turn-review-summary" aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}>
        <FileDiff size={14} aria-hidden="true" />
        <strong>{summary.files.size} file{summary.files.size === 1 ? "" : "s"} changed</strong>
        <span className="diff-stats"><i>+{summary.additions}</i><em>-{summary.deletions}</em></span>
        <ChevronDown className="turn-review-chevron" size={14} aria-hidden="true" />
      </button>
      {expanded && <ul className="turn-review-files">
        {[...summary.files.entries()].map(([name, entry]) => (
          <li key={name}><code>{name}</code>
            <span className="diff-stats"><i>+{entry.additions}</i><em>-{entry.deletions}</em></span></li>
        ))}
      </ul>}
    </section>
  );
}

// ── Right utility dock (Cursor-style side panel) ─────────────────────────
// Changes: session-wide file edits (every tool patch), expandable per file.
// Context: the live context surface (same body as the modal), polled while
// the tab is visible.
interface SessionFileChange {
  name: string;
  additions: number;
  deletions: number;
  patches: string[];
}
interface DockAgentRow {
  key: string;
  name: string;
  status: string;
  detail: string;
  startedAt: number;
  done: boolean;
  failed: boolean;
  readArgs: RecordValue | null;
}
// Reused-session workers can surface without a startedAt (round-2 spawns);
// anchor their elapsed timer to first sight so the dock shows a ticking
// duration instead of the literal word "running".
const agentRowFirstSeen = new Map<string, number>();
function dockAgentRows(snapshot: Snapshot): DockAgentRow[] {
  const workers = Array.isArray(snapshot.agentWorkers) ? snapshot.agentWorkers : [];
  const jobs = Array.isArray(snapshot.agentJobs) ? snapshot.agentJobs : [];
  // The dock lists CURRENT spawns only (user decision): terminal runs drop
  // off, and a spawn reported both as a worker AND a job merges into ONE row
  // (task id → tag → name identity) so nothing shows twice.
  const rows = new Map<string, DockAgentRow>();
  [...workers, ...jobs].forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) return;
    const name = String(record.tag || record.agent || record.name || record.role || record.id || "agent").trim() || "agent";
    const status = String(record.stage || record.status || "running").trim() || "running";
    const startedAt = timeMs(record.startedAt || record.startTime || record.createdAt);
    const done = TERMINAL_AGENT_STATUS.test(status);
    if (done) return;
    const failed = /error|fail|killed|timeout|cancel/i.test(status);
    const detail = String(record.task || record.description || record.summary || record.model || "").trim();
    const tag = String(record.tag || "").trim();
    const taskId = String(record.task_id || record.taskId || record.jobId || "").trim();
    const readArgs: RecordValue | null = taskId
      ? { type: "read", task_id: taskId }
      : tag ? { type: "read", tag } : null;
    // Tag FIRST: one spawn often reports as a tagged worker AND a task-id
    // job; the tag is the stable spawn handle, so both collapse into it.
    const identity = tag || taskId || `${name}-${String(record.id ?? index)}`;
    const existing = rows.get(identity);
    if (!existing) {
      rows.set(identity, { key: identity, name, status, detail, startedAt, done, failed, readArgs });
      return;
    }
    rows.set(identity, {
      ...existing,
      detail: existing.detail || detail,
      startedAt: existing.startedAt || startedAt,
      failed: existing.failed || failed,
      readArgs: existing.readArgs || readArgs,
    });
  });
  const result = [...rows.values()];
  for (const row of result) {
    if (!row.startedAt) {
      const seen = agentRowFirstSeen.get(row.key) ?? Date.now();
      agentRowFirstSeen.set(row.key, seen);
      row.startedAt = seen;
    }
  }
  for (const key of agentRowFirstSeen.keys()) {
    if (!rows.has(key)) agentRowFirstSeen.delete(key);
  }
  return result.sort((left, right) => left.startedAt - right.startedAt);
}
function sessionFileChanges(items: TranscriptItem[]): SessionFileChange[] {
  const files = new Map<string, SessionFileChange>();
  for (const item of items) {
    if (item?.kind !== "tool") continue;
    const patch = findPatch(item);
    if (!patch) continue;
    try {
      for (const file of parseUnifiedDiff(patch)) {
        const name = file.newFile.fileName || file.oldFile?.fileName || "unknown file";
        const entry = files.get(name) || { name, additions: 0, deletions: 0, patches: [] };
        const body = file.hunks.join("\n").split("\n");
        entry.additions += body.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
        entry.deletions += body.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
        if (!entry.patches.includes(patch)) entry.patches.push(patch);
        files.set(name, entry);
      }
    } catch { /* non-diff payload — skip */ }
  }
  return [...files.values()];
}

function UtilityDock({ width, tab, onTab, onResize, items, snapshot }: {
  width: number;
  tab: UtilityDockTab;
  onTab(tab: UtilityDockTab): void;
  onResize(width: number): void;
  items: TranscriptItem[];
  snapshot: Snapshot;
}) {
  // Elapsed readouts for running agents tick once a second while visible.
  const [agentClock, setAgentClock] = useState(() => Date.now());
  useEffect(() => {
    if (tab !== "agents") return undefined;
    const timer = window.setInterval(() => setAgentClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [tab]);
  const agents = useMemo(() => dockAgentRows(snapshot), [snapshot.agentWorkers, snapshot.agentJobs]);
  // Agent output viewer (opcode AgentRunOutputViewer grammar): click a row →
  // fetch its rendered output via the SILENT agentControl read; refresh every
  // 3s while the run is still live.
  const [agentView, setAgentView] = useState<DockAgentRow | null>(null);
  const [agentOutput, setAgentOutput] = useState<string>("");
  useEffect(() => {
    if (tab !== "agents" && agentView) setAgentView(null);
  }, [tab, agentView]);
  useEffect(() => {
    if (!agentView?.readArgs) return undefined;
    let live = true;
    const load = () => void window.mixdogDesktop.invokeCapability?.({
      capability: 'agentControl',
      args: [agentView.readArgs, { silent: true }],
    }).then((result) => {
      if (live) setAgentOutput(String(result?.value ?? "").trim() || "No output yet.");
    }).catch((reason) => {
      if (live) setAgentOutput(`Error: ${reason instanceof Error ? reason.message : String(reason)}`);
    });
    setAgentOutput("Loading…");
    load();
    const timer = agentView.done ? 0 : window.setInterval(load, 3_000);
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [agentView]);
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const move = (moveEvent: PointerEvent) => onResize(startWidth + (startX - moveEvent.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <aside className="utility-dock" style={{ width, flexBasis: width }} aria-label="Utility panel">
    <div className="utility-dock-resize" role="separator" aria-orientation="vertical"
      aria-label="Resize utility panel" onPointerDown={startResize} />
    <nav className="utility-dock-tabs" aria-label="Utility panel tabs">
      <button type="button" className={tab === "agents" ? "active" : ""}
        onClick={() => onTab("agents")}>Agents</button>
      <button type="button" className={tab === "terminal" ? "active" : ""}
        onClick={() => onTab("terminal")}>Terminal</button>
    </nav>
    <div className="utility-dock-body" data-tab={tab}>
      {tab === "agents" && agentView && (
        <div className="dock-agent-view">
          <header>
            <button type="button" className="dock-agent-back" onClick={() => setAgentView(null)}
              aria-label="Back to agent list"><ChevronRight size={14} style={{ transform: "rotate(180deg)" }} /></button>
            <b>{agentView.name}</b>
            <span data-state={agentView.failed ? "failed" : agentView.done ? "done" : "running"}>
              {agentView.status}
            </span>
          </header>
          <pre>{agentOutput}</pre>
        </div>
      )}
      {tab === "agents" && !agentView && (agents.length
        ? <div className="dock-agent-list" role="list">
          {agents.map((agent) => <button type="button" className="dock-agent-row" role="listitem" key={agent.key}
            data-state={agent.failed ? "failed" : agent.done ? "done" : "running"}
            disabled={!agent.readArgs}
            onClick={() => agent.readArgs && setAgentView(agent)}>
            <i aria-hidden="true" />
            <div className="dock-agent-copy">
              <b>{agent.name}</b>
              {agent.detail && <small title={agent.detail}>{agent.detail}</small>}
            </div>
            <span>{agent.done || !agent.startedAt ? agent.status : formatWorkElapsed(agentClock - agent.startedAt)}</span>
          </button>)}
        </div>
        : <p className="utility-dock-empty">No agent activity in this session yet.</p>)}
      {tab === "terminal" && <Suspense fallback={null}>
        <TerminalPane cwd={String(snapshot.currentProject || snapshot.project || "") || null} />
      </Suspense>}
    </div>
  </aside>;
}

// ── Dock Git panel (claudecodeui git-panel grammar) ───────────────────────
interface GitPanelStatus {
  repository: boolean;
  branch: string;
  ahead: number;
  behind: number;
  upstream: boolean;
  files: Array<{ path: string; index: string; worktree: string; untracked: boolean; additions: number; deletions: number }>;
}
// Review pane (Codex/opencode grammar): cumulative diff of the working tree
// vs merge-base(origin default branch, HEAD) — committed + uncommitted +
// untracked read as ONE change set.
interface GitReviewFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  untracked: boolean;
  uncommitted: boolean;
}
interface GitReviewInfo {
  base: string;
  files: GitReviewFile[];
}
// Bare diff bodies: CodeDiff brings its own file header + expand chrome,
// which duplicates the accordion/row that already names the file. Render the
// bare diff body (Shiki DiffView) only — no second header, no height cap.
function GitDiffBody({ file, mode }: { file: ReturnType<typeof parseUnifiedDiff>[number]; mode?: "unified" | "split" }) {
  const fallback = <pre className="diff-fallback">{file.patch}</pre>;
  if (!file.renderable) return fallback;
  return <DiffBoundary fallback={fallback}>
    <Suspense fallback={<div className="diff-loading" aria-hidden="true">Loading diff…</div>}>
      <DiffView data={{ oldFile: file.oldFile, newFile: file.newFile, hunks: [file.patch] }} mode={mode} />
    </Suspense>
  </DiffBoundary>;
}
// Working-tree file diff (single file): the row already names the file, so
// the body renders hunks only.
function GitFileDiff({ patch, mode }: { patch: string; mode?: "unified" | "split" }) {
  const files = useMemo(() => {
    try { return parseUnifiedDiff(patch); } catch { return []; }
  }, [patch]);
  if (!files.length) return <pre className="diff-fallback">{patch}</pre>;
  return <>{files.map((file, index) => <GitDiffBody file={file} mode={mode} key={index} />)}</>;
}
function ReviewPane({ cwd }: { cwd: string | null }) {
  const [status, setStatus] = useState<GitPanelStatus | null>(null);
  const [review, setReview] = useState<GitReviewInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Single-open accordion (user decision): opening a file closes the rest
  // and snaps the opened card flush under the sticky header.
  const [openFile, setOpenFile] = useState("");
  // Right-click context menu (Codex review grammar): open / reveal / copy
  // path, plus a confirm-dialog revert for uncommitted files.
  const [menu, setMenu] = useState<{ x: number; y: number; file: GitReviewFile } | null>(null);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".review-context-menu")) return;
      setMenu(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const [forced, setForced] = useState<string[]>([]);
  const [diffs, setDiffs] = useState<Record<string, string | null>>({});
  // No manual refresh control: the 4s poll owns freshness, so cached diffs
  // must self-invalidate when a file's stats change under it.
  const reviewRef = useRef<GitReviewInfo | null>(null);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() => {
    try { return window.localStorage.getItem(REVIEW_DIFF_STYLE_KEY) === "split" ? "split" : "unified"; }
    catch { return "unified"; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(REVIEW_DIFF_STYLE_KEY, diffStyle); } catch { /* persistence only */ }
  }, [diffStyle]);
  const refresh = useCallback(async () => {
    if (!cwd) { setStatus(null); return; }
    if (!window.mixdogDesktop.gitStatus || !window.mixdogDesktop.gitReview) {
      setError("Review needs an app restart to finish updating.");
      return;
    }
    try {
      const [next, nextReview] = await Promise.all([
        window.mixdogDesktop.gitStatus(cwd),
        window.mixdogDesktop.gitReview(cwd),
      ]);
      setStatus(next ?? null);
      setReview(nextReview ?? null);
      const prev = reviewRef.current;
      reviewRef.current = nextReview ?? null;
      if (prev && nextReview) {
        const signature = (file: GitReviewFile) => `${file.additions}:${file.deletions}:${file.uncommitted}`;
        const before = new Map(prev.files.map((file) => [file.path, signature(file)]));
        setDiffs((current) => {
          let dirty = false;
          const draft = { ...current };
          for (const file of nextReview.files) {
            if (draft[file.path] !== undefined && before.get(file.path) !== signature(file)) {
              delete draft[file.path];
              dirty = true;
            }
          }
          return dirty ? draft : current;
        });
      }
      setError("");
    } catch (reason) {
      setStatus(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [cwd]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, 4_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  // Lazy diff loads for open files that are not cached yet.
  useEffect(() => {
    if (!cwd || !review) return;
    for (const file of review.files) {
      if (file.path !== openFile || diffs[file.path] !== undefined) continue;
      setDiffs((current) => ({ ...current, [file.path]: null }));
      void window.mixdogDesktop.gitReviewDiff?.(cwd, file.path, file.untracked)
        .then((patch) => setDiffs((current) => ({ ...current, [file.path]: patch || "" })))
        .catch((reason) => setDiffs((current) => ({
          ...current,
          [file.path]: `Error: ${reason instanceof Error ? reason.message : String(reason)}`,
        })));
    }
  }, [cwd, review, openFile, diffs]);
  const act = async (action: () => Promise<unknown> | undefined) => {
    setBusy(true);
    try {
      await action();
      setDiffs({});
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  if (!cwd) return <div className="review-pane"><p className="review-empty">Select a project to review changes.</p></div>;
  if (error) return <div className="review-pane"><p className="review-empty">{error}</p></div>;
  if (!status) return <div className="review-pane"><p className="review-empty">Loading review…</p></div>;
  if (!status.repository) return <div className="review-pane"><p className="review-empty">Not a git repository.</p></div>;
  const changed = review?.files ?? [];
  const base = review?.base || "HEAD";
  const totalAdditions = changed.reduce((sum, file) => sum + (file.additions || 0), 0);
  const totalDeletions = changed.reduce((sum, file) => sum + (file.deletions || 0), 0);
  const showPush = status.ahead > 0 || (!status.upstream && changed.length === 0);
  const toggleFile = (path: string, trigger: HTMLElement) => {
    const opening = openFile !== path;
    setOpenFile(opening ? path : "");
    if (!opening) return;
    // Snap the opened card flush under the sticky header.
    const pane = trigger.closest(".review-scroll");
    const section = trigger.closest(".review-file");
    if (!(pane instanceof HTMLElement) || !(section instanceof HTMLElement)) return;
    requestAnimationFrame(() => {
      pane.scrollTop += section.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    });
  };
  return <div className="review-pane">
    <header className="review-header">
      <div className="review-title">
        <h2>Review</h2>
        <span className="review-branch"><b>{status.branch}</b>{base !== "HEAD" ? ` → ${base}` : ""}</span>
        {(totalAdditions > 0 || totalDeletions > 0) && <span className="diff-stats review-total">
          <i>+{totalAdditions}</i><em>-{totalDeletions}</em>
        </span>}
        {status.ahead > 0 && <button type="button" className="dock-git-sync" disabled={busy}
          title={`Push ${status.ahead} commit${status.ahead === 1 ? "" : "s"}`}
          onClick={() => void act(() => window.mixdogDesktop.gitPush?.(cwd))}>
          ↑{status.ahead}
        </button>}
      </div>
      <div className="review-actions">
        {changed.length > 0 && <div className="review-style-toggle" role="radiogroup" aria-label="Diff style">
          <button type="button" aria-pressed={diffStyle === "unified"}
            onClick={() => setDiffStyle("unified")}>Unified</button>
          <button type="button" aria-pressed={diffStyle === "split"}
            onClick={() => setDiffStyle("split")}>Split</button>
        </div>}
      </div>
    </header>
    <div className="review-scroll">
    {changed.length === 0 && <div className="review-empty-state">
      <p className="review-empty">{base === "HEAD" ? "Working tree clean." : `No changes vs ${base}.`}</p>
      {showPush && <button type="button" className="dock-git-clean-push" disabled={busy}
        onClick={() => void act(() => window.mixdogDesktop.gitPush?.(cwd))}>
        {status.upstream ? `Push ${status.ahead ? `↑${status.ahead}` : ""}`.trim() : "Publish Branch"}
      </button>}
    </div>}
    <div className="review-list">
      {changed.map((file) => {
        const open = openFile === file.path;
        const slash = file.path.lastIndexOf("/");
        const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
        const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
        const added = file.untracked || file.status === "A";
        const deleted = file.status === "D";
        const tooLarge = file.additions + file.deletions > 500 && !forced.includes(file.path);
        const patch = diffs[file.path];
        return <section className="review-file" data-open={open || undefined} key={file.path}>
          <div className="review-file-header"
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({
                x: Math.min(event.clientX, window.innerWidth - 208),
                y: Math.min(event.clientY, window.innerHeight - 168),
                file,
              });
            }}>
            <button type="button" className="review-file-trigger" aria-expanded={open}
              onClick={(event) => toggleFile(file.path, event.currentTarget)}>
              <FileDiff size={14} aria-hidden="true" />
              <span className="review-file-name">
                {dir && <small>{dir}</small>}
                <b>{name}</b>
              </span>
              <span className="review-file-meta">
                {added && <em className="review-change-label" data-type="added">Added</em>}
                {deleted && <em className="review-change-label" data-type="removed">Removed</em>}
                {(file.additions > 0 || file.deletions > 0) && <span className="diff-stats">
                  <i>+{file.additions}</i><em>-{file.deletions}</em>
                </span>}
              </span>
              <ChevronDown size={14} className="review-chevron" aria-hidden="true" />
            </button>
          </div>
          {open && <div className="review-file-body">
            {tooLarge
              ? <div className="review-large-diff">
                <b>Large diff</b>
                <span>{(file.additions + file.deletions).toLocaleString()} changed lines exceed the 500-line render limit.</span>
                <button type="button" onClick={() => setForced((current) => [...current, file.path])}>
                  Render anyway
                </button>
              </div>
              : patch === undefined || patch === null
                ? <p className="review-empty">Loading diff…</p>
                : patch.startsWith("Error:")
                  ? <p className="review-empty">{patch}</p>
                  : patch
                    ? <GitFileDiff patch={patch} mode={diffStyle} />
                    : <p className="review-empty">No textual diff for this file.</p>}
          </div>}
        </section>;
      })}
    </div>
    </div>
    {menu && <div className="review-context-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" onClick={() => {
        setMenu(null);
        void window.mixdogDesktop.openFilePath?.(cwd, menu.file.path).catch(() => {});
      }}>Open file</button>
      <button type="button" role="menuitem" onClick={() => {
        setMenu(null);
        void window.mixdogDesktop.revealFile?.(cwd, menu.file.path).catch(() => {});
      }}>Reveal in Explorer</button>
      <button type="button" role="menuitem" onClick={() => {
        setMenu(null);
        const sep = cwd.includes("\\") ? "\\" : "/";
        void copyTextToClipboard(cwd.replace(/[\\/]+$/, "") + sep + menu.file.path.split("/").join(sep));
      }}>Copy path</button>
      {menu.file.uncommitted && <button type="button" role="menuitem" data-danger
        onClick={() => {
          const target = menu.file;
          setMenu(null);
          const warning = target.untracked
            ? `Delete untracked file "${target.path}"? This cannot be undone.`
            : `Discard uncommitted changes to "${target.path}"? This cannot be undone.`;
          if (!window.confirm(warning)) return;
          if (openFile === target.path) setOpenFile("");
          void act(() => window.mixdogDesktop.gitRevert?.(cwd, target.path, target.untracked));
        }}>
        {menu.file.untracked ? "Delete file" : "Revert changes"}
      </button>}
    </div>}
  </div>;
}

function QueueList({ queued, restoring, onEdit, onRemove }: {
  queued?: unknown[];
  restoring: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const itemsId = useId();
  if (!Array.isArray(queued) || queued.length === 0) return null;
  const label = `${queued.length} queued follow-up${queued.length === 1 ? "" : "s"}`;
  const preview = queuedFollowupPreview(queued[0]);
  return (
    <section className="queue-list" data-collapsed={collapsed ? "true" : "false"}
      aria-label={label}>
      <button type="button" className="queue-summary" aria-expanded={!collapsed}
        aria-controls={itemsId} onClick={() => setCollapsed((value) => !value)}>
        <strong>{label}</strong>
        {collapsed && <span className="queue-collapsed-preview">{preview}</span>}
        <ChevronDown className="queue-chevron" size={15} aria-hidden="true" />
      </button>
      {!collapsed && <div className="queue-items" id={itemsId} role="list">
        {queued.map((entry, index) => {
          const id = String(asRecord(entry)?.id || "");
          const text = queuedFollowupPreview(entry);
          return <div className="queue-item" role="listitem" key={id || index}>
            <span className="queue-item-text" title={text}>{text}</span>
            <small>Next boundary</small>
            <button type="button" className="queue-edit" disabled={restoring || !id}
              onClick={() => onEdit(id)} aria-label={`Edit queued follow-up: ${text}`}>
              {restoring ? "Editing…" : "Edit"}
            </button>
            <button type="button" className="queue-remove" disabled={restoring || !id}
              onClick={() => onRemove(id)} aria-label={`Remove queued follow-up: ${text}`}
              data-tooltip="Remove">
              <X size={13} />
            </button>
          </div>;
        })}
      </div>}
    </section>
  );
}

const Composer = memo(function Composer({
  turnBusy,
  commandBusy,
  transitioning,
  focusRequest,
  historyScope,
  projectScope,
  hasConversation,
  hasProjectContext,
  promptHistoryList,
  provider,
  model,
  effort,
  fast,
  fastCapable,
  workflow,
  starter,
  queued,
  submit,
  abort,
  invokeResult,
  applySnapshot,
  onNewTask,
  onStartProject,
  onResumeSession,
  onOpenProjects,
  onOpenSessions,
  onOpenSettings,
  onOpenCommandSurface,
}: {
  turnBusy: boolean;
  commandBusy: boolean;
  transitioning: boolean;
  focusRequest: number;
  historyScope: string;
  projectScope: string;
  hasConversation: boolean;
  hasProjectContext: boolean;
  promptHistoryList?: unknown[];
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  workflow?: RecordValue | null;
  starter: { id: number; text: string } | null;
  queued?: unknown[];
  submit: (content: DesktopPromptContent, options?: DesktopSubmitOptions) => Promise<unknown>;
  abort: () => Promise<unknown>;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  onNewTask: () => void;
  onStartProject: (path: string) => void;
  onResumeSession: (id: string) => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [dictationState, setDictationState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const dictationSession = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    cancelled: boolean;
    stopTimer: number;
  } | null>(null);
  const [composerNotice, setComposerNotice] = useState('');
  // Composer notices are transient helpers (mic errors, etc.): auto-dismiss
  // after a beat instead of pinning to the composer forever (user-flagged).
  const composerNoticeTimer = useRef(0);
  const showComposerNotice = useCallback((message: string) => {
    window.clearTimeout(composerNoticeTimer.current);
    setComposerNotice(message);
    if (message) {
      composerNoticeTimer.current = window.setTimeout(() => setComposerNotice(''), 6_000);
    }
  }, []);
  useEffect(() => () => window.clearTimeout(composerNoticeTimer.current), []);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedDraft, setSlashDismissedDraft] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [caretOffset, setCaretOffset] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [persistedHistory, setPersistedHistory] = useState(() => readPromptHistory(historyScope));
  const activeHistoryScope = useRef(historyScope);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const slashPalette = useRef<HTMLDivElement>(null);
  const mentionPalette = useRef<HTMLDivElement>(null);
  const mentionSearchGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentSequence = useRef(1);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const dragDepth = useRef(0);
  const transitioningRef = useRef(transitioning);
  transitioningRef.current = transitioning;
  const wasTransitioning = useRef(transitioning);
  const historyNavigation = useRef({ index: -1, seed: '' });
  useLayoutEffect(() => {
    if (activeHistoryScope.current === historyScope) return;
    activeHistoryScope.current = historyScope;
    attachmentsRef.current = [];
    dragDepth.current = 0;
    mentionSearchGeneration.current += 1;
    // Scope settles ASYNC after a session switch/promotion; when the user is
    // ALREADY typing in the composer, the in-flight text carries over instead
    // of being wiped (user bug: draft vanished + scroll jumped mid-sentence).
    const typingLive = document.activeElement === textarea.current;
    setDraft((current) => (typingLive && current.trim() ? current : ''));
    setAttachments([]);
    setAttachmentError('');
    setComposerNotice('');
    setSlashIndex(0);
    setSlashDismissedDraft('');
    setComposerFocused(false);
    setCaretOffset(0);
    setMentionIndex(0);
    setMentionResults([]);
    setMentionLoading(false);
    setMentionDismissed('');
    setRestoring(false);
    setDraggingFiles(false);
    setPersistedHistory(readPromptHistory(historyScope));
    historyNavigation.current = { index: -1, seed: '' };
  }, [historyScope]);
  const history = useMemo(() => {
    const engineHistory = Array.isArray(promptHistoryList)
      ? promptHistoryList.map((entry) => typeof entry === 'string'
        ? entry : String(asRecord(entry)?.text || asRecord(entry)?.displayText || '')).filter(Boolean)
      : [];
    return [...new Set([...persistedHistory, ...engineHistory])].slice(0, MAX_PERSISTED_PROMPT_HISTORY);
  }, [persistedHistory, promptHistoryList]);
  const rememberPrompt = useCallback((value: string) => {
    const prompt = value.trim();
    if (!prompt) return;
    setPersistedHistory((current) => {
      const next = [prompt, ...current.filter((entry) => entry !== prompt)]
        .slice(0, MAX_PERSISTED_PROMPT_HISTORY);
      try {
        window.localStorage.setItem(promptHistoryStorageKey(historyScope), JSON.stringify(next));
      } catch {
        // The engine-provided history remains available when browser storage is unavailable.
      }
      return next;
    });
  }, [historyScope]);
  // User request: one stable placeholder — no rotating variants.
  // User request: once a session has content, the composer shows NO hint copy
  // at all — instructional placeholders belong to the empty new-task state.
  const placeholder = hasConversation ? ''
    : turnBusy ? 'Steer the active turn or queue a follow-up…'
      : commandBusy ? 'Queue a message after the current command…'
        : COMPOSER_PLACEHOLDERS[0];
  // Match the TUI palette: it only owns a single, argument-free /token.
  // Once whitespace is entered the composer returns to normal editing and the
  // argument hint/submit path owns the draft.
  const slashMatch = /^\/([^\s]*)$/.exec(draft);
  const slashQuery = slashMatch?.[1]?.toLowerCase() || '';
  const slashCommands = slashMatch
    ? SLASH_COMMANDS.filter((command) => command.name.startsWith(slashQuery) ||
      command.aliases?.some((alias) => alias.startsWith(slashQuery)))
      .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }))
      .slice(0, 10)
    : [];
  const slashOpen = Boolean(!commandBusy && slashMatch && slashDismissedDraft !== draft);
  const mentionMatch = useMemo(() => {
    const beforeCaret = draft.slice(0, Math.max(0, Math.min(caretOffset, draft.length)));
    const match = /(^|[\s([{"'])@([^\s@]*)$/.exec(beforeCaret);
    if (!match) return null;
    const start = match.index + match[1].length;
    return { start, end: beforeCaret.length, query: match[2] || '' };
  }, [caretOffset, draft]);
  const mentionSignature = mentionMatch
    ? `${mentionMatch.start}:${mentionMatch.end}:${mentionMatch.query}`
    : '';
  const mentionOpen = Boolean(composerFocused && projectScope && mentionMatch && !transitioning &&
    mentionDismissed !== mentionSignature);
  const paletteCommandToken = (command: (typeof SLASH_COMMANDS)[number] | undefined) => {
    if (!command) return '';
    const typedToken = draft.slice(1).trim().toLowerCase();
    return typedToken && (typedToken === command.name || command.aliases?.includes(typedToken))
      ? typedToken
      : command.name;
  };
  // Autosize is CSS-native now (field-sizing: content). The old layout-effect
  // path forced TWO whole-document synchronous reflows per keystroke
  // (height:auto → scrollHeight read) — the measured source of typing lag on
  // long transcripts.
  useEffect(() => {
    if (!transitioning) return;
    dragDepth.current = 0;
    setDraggingFiles(false);
  }, [transitioning]);
  useEffect(() => {
    if (!starter) return;
    setDraft(starter.text);
    historyNavigation.current = { index: -1, seed: '' };
    textarea.current?.focus();
  }, [starter]);
  useEffect(() => {
    if (wasTransitioning.current && !transitioning) {
      window.setTimeout(() => {
        if (document.activeElement?.classList.contains("session-header-title-input")) return;
        textarea.current?.focus({ preventScroll: true });
      }, 0);
    }
    wasTransitioning.current = transitioning;
  }, [transitioning]);
  useEffect(() => {
    if (focusRequest <= 0 || transitioning) return undefined;
    const timer = window.setTimeout(() => {
      if (document.activeElement?.classList.contains("session-header-title-input")) return;
      textarea.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusRequest, transitioning]);

  useEffect(() => setSlashIndex(0), [slashQuery]);
  useEffect(() => setMentionIndex(0), [mentionMatch?.query]);
  useEffect(() => {
    if (!mentionOpen || !mentionMatch) {
      mentionSearchGeneration.current += 1;
      setMentionResults([]);
      setMentionLoading(false);
      return;
    }
    const generation = ++mentionSearchGeneration.current;
    setMentionResults([]);
    setMentionLoading(true);
    const timer = window.setTimeout(() => {
      void window.mixdogDesktop.searchProjectFiles(projectScope, mentionMatch.query, 20)
        .then((paths) => {
          if (mentionSearchGeneration.current !== generation) return;
          setMentionResults(paths);
          setMentionLoading(false);
        })
        .catch(() => {
          if (mentionSearchGeneration.current !== generation) return;
          setMentionResults([]);
          setMentionLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      if (mentionSearchGeneration.current === generation) mentionSearchGeneration.current += 1;
    };
  }, [mentionMatch?.end, mentionMatch?.query, mentionMatch?.start, mentionOpen, projectScope]);
  useEffect(() => {
    if (!slashOpen) return;
    slashPalette.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [slashIndex, slashOpen, slashQuery]);
  useEffect(() => {
    if (!mentionOpen) return;
    mentionPalette.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [mentionIndex, mentionOpen, mentionResults]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => {
    const receiveDraft = (event: Event) => {
      const text = String((event as CustomEvent<unknown>).detail || '');
      if (!text) return;
      setDraft((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`);
      historyNavigation.current = { index: -1, seed: '' };
      window.setTimeout(() => textarea.current?.focus(), 0);
    };
    window.addEventListener('mixdog:composer-draft', receiveDraft);
    return () => window.removeEventListener('mixdog:composer-draft', receiveDraft);
  }, []);

  const invokeCapability = useCallback(async <T,>(capability: DesktopCapability, args: unknown[] = []) => {
    const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<T>({ capability, args }));
    if (result?.snapshot !== undefined) applySnapshot(result.snapshot);
    return result?.value;
  }, [applySnapshot, invokeResult]);

  const attachmentPolicyError = useCallback((
    currentAttachments: ComposerAttachment[],
    attachment: ComposerAttachment,
  ) => {
    if (currentAttachments.length >= MAX_COMPOSER_ATTACHMENTS) {
      return `Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`;
    }
    const textTotal = currentAttachments.reduce((sum, item) =>
      sum + (item.kind === 'text' ? item.data.length : 0), 0) +
      (attachment.kind === 'text' ? attachment.data.length : 0);
    if (textTotal > MAX_INLINE_TEXT_TOTAL) {
      return 'Inline text attachments are too large together. Keep the total under 850 KB.';
    }
    const imageTotal = currentAttachments.reduce((sum, item) =>
      sum + (item.kind === 'image' || item.kind === 'pdf' ? item.data.length : 0), 0) +
      (attachment.kind === 'image' || attachment.kind === 'pdf' ? attachment.data.length : 0);
    if (imageTotal > MAX_INLINE_IMAGE_BASE64_TOTAL) {
      return 'Attached images and PDFs are too large together. Remove one or use smaller files.';
    }
    return '';
  }, []);
  const insertAttachment = useCallback((attachment: ComposerAttachment) => {
    const currentAttachments = attachmentsRef.current;
    const policyError = attachmentPolicyError(currentAttachments, attachment);
    if (policyError) {
      setAttachmentError(policyError);
      return false;
    }
    const nextAttachments = [...currentAttachments, attachment];
    attachmentsRef.current = nextAttachments;
    setAttachments(nextAttachments);
    const element = textarea.current;
    setDraft((current) => {
      const rawStart = element?.selectionStart ?? current.length;
      const rawEnd = element?.selectionEnd ?? rawStart;
      const start = Math.max(0, Math.min(rawStart, current.length));
      const end = Math.max(start, Math.min(rawEnd, current.length));
      const before = current.slice(0, start);
      const after = current.slice(end);
      const leading = before && !/\s$/.test(before) ? ' ' : '';
      const trailing = after && !/^\s/.test(after) ? ' ' : ' ';
      const inserted = `${leading}${attachment.token}${trailing}`;
      const caret = before.length + inserted.length;
      window.setTimeout(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(caret, caret);
      }, 0);
      return `${before}${inserted}${after}`;
    });
    historyNavigation.current = { index: -1, seed: '' };
    return true;
  }, [attachmentPolicyError]);
  const clearAttachments = useCallback(() => {
    attachmentsRef.current = [];
    setAttachments([]);
  }, []);
  const removeAttachments = useCallback((ids: Set<number>) => {
    if (ids.size === 0) return;
    const next = attachmentsRef.current.filter((attachment) => !ids.has(attachment.id));
    attachmentsRef.current = next;
    setAttachments(next);
  }, []);

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    if (transitioningRef.current) return;
    setAttachmentError('');
    const available = Math.max(0, MAX_COMPOSER_ATTACHMENTS - attachmentsRef.current.length);
    if (available === 0) {
      setAttachmentError(`Attach up to ${MAX_COMPOSER_ATTACHMENTS} items at a time.`);
      return;
    }
    const incoming = Array.from(files);
    if (incoming.length > available) {
      setAttachmentError(`Only the first ${available} item${available === 1 ? '' : 's'} fit; remove an attachment to add more.`);
    }
    for (const file of incoming.slice(0, available)) {
      if (transitioningRef.current) return;
      try {
        const id = attachmentSequence.current++;
        const displayName = file.name || (file.type.startsWith('image/') ? 'Pasted image' : 'Pasted file');
        if (file.type.startsWith('image/')) {
          if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(file.type) || file.size > 12_000_000) {
            throw new Error(`${displayName}: use PNG, JPEG, GIF, or WebP under 12 MB.`);
          }
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`${displayName}: could not read image.`));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(file);
          });
          if (transitioningRef.current) return;
          const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
          // TUI parity: route the attachment through the engine's optional-
          // sharp resize pipeline so desktop submits the same downscaled
          // payload the terminal client would. Hosts without the capability
          // (older engines, test stubs) keep the legacy raw attach.
          let imageData = data;
          let imageMime = file.type;
          let metadataText = '';
          const invokeResize = window.mixdogDesktop?.invokeCapability;
          if (typeof invokeResize === 'function') {
            try {
              const result = await invokeResize<RecordValue>({
                capability: 'resizeImage',
                args: [{ data, mimeType: file.type, filename: displayName }],
              });
              const value = asRecord(result?.value);
              if (typeof value?.data === 'string' && value.data) {
                imageData = value.data;
                imageMime = String(value.mimeType || file.type);
                metadataText = String(value.metadataText || '');
              }
            } catch (reason) {
              const message = reason instanceof Error ? reason.message : String(reason);
              // Real resize failures (e.g. oversized image without sharp)
              // block the attach exactly like the TUI paste path does.
              if (!/does not support|capability is unavailable/i.test(message)) {
                throw new Error(`${displayName}: ${message}`);
              }
            }
          }
          if (transitioningRef.current) return;
          insertAttachment({ id, name: displayName, kind: 'image', mimeType: imageMime, data: imageData,
            ...(metadataText ? { metadataText } : {}),
            token: `[Image #${id}: ${displayName}]` });
          continue;
        }
        const mimeKind = (file.type || '').split(';', 1)[0].trim().toLowerCase();
        if (mimeKind === 'application/pdf' || /\.pdf$/i.test(displayName)) {
          if (file.size > MAX_PDF_FILE_BYTES) {
            throw new Error(`${displayName}: PDFs must be under 20 MB.`);
          }
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(new Error(`${displayName}: could not read PDF.`));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(file);
          });
          if (transitioningRef.current) return;
          insertAttachment({ id, name: displayName, kind: 'pdf', mimeType: 'application/pdf',
            data: dataUrl.slice(dataUrl.indexOf(',') + 1), token: `[PDF #${id}: ${displayName}]` });
          continue;
        }
        const textLike = mimeKind.startsWith('text/') ||
          /^application\/(?:json|ld\+json|toml|x-toml|yaml|x-yaml|xml)$/.test(mimeKind) ||
          mimeKind.endsWith('+json') || mimeKind.endsWith('+xml') ||
          /\.(?:md|mdx|txt|json|jsonl|ya?ml|toml|xml|csv|tsv|[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|cs|cpp|cc|c|h|hh|hpp|sh|zsh|ps1|bat|cmd|sql|css|scss|sass|html|htm|vue|svelte|log|env|ini|conf|cfg|gql|graphql)$/i.test(displayName) ||
          await fileLooksLikeText(file);
        if (!textLike || file.size > MAX_INLINE_FILE_BYTES) {
          throw new Error(`${displayName}: attach images, PDFs, or text files under 750 KB.`);
        }
        const text = await file.text();
        if (transitioningRef.current) return;
        if (text.length > MAX_INLINE_FILE_BYTES) {
          throw new Error(`${displayName}: inline text is too large after decoding.`);
        }
        insertAttachment({ id, name: displayName, kind: 'text', mimeType: file.type || 'text/plain', data: text,
          token: `[File #${id}: ${displayName}]`, source: 'file' });
      } catch (reason) {
        setAttachmentError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [insertAttachment]);

  // Push-to-talk dictation: record locally, transcribe through the engine's
  // managed whisper.cpp runtime, and append the transcript to the draft.
  const toggleDictation = useCallback(async () => {
    if (dictationState === 'transcribing' || transitioningRef.current) return;
    const active = dictationSession.current;
    if (active) {
      try { active.recorder.stop(); } catch { /* recorder already stopped */ }
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (!devices.some((device) => device.kind === 'audioinput')) {
        showComposerNotice('No microphone was detected. Connect one and try again.');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      const session = { recorder, stream, chunks: [] as Blob[], cancelled: false, stopTimer: 0 };
      dictationSession.current = session;
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) session.chunks.push(event.data);
      };
      recorder.onstop = () => {
        void (async () => {
          window.clearTimeout(session.stopTimer);
          dictationSession.current = null;
          for (const track of session.stream.getTracks()) track.stop();
          if (session.cancelled || session.chunks.length === 0) {
            setDictationState('idle');
            return;
          }
          setDictationState('transcribing');
          try {
            const blob = new Blob(session.chunks, { type: recorder.mimeType || 'audio/webm' });
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error || new Error('Recorded audio could not be read.'));
              reader.onload = () => resolve(String(reader.result || ''));
              reader.readAsDataURL(blob);
            });
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
              capability: 'transcribeAudio',
              args: [{ data: base64, mimeType: blob.type }],
            }));
            const text = String(result?.value ?? '').trim();
            if (text) {
              setDraft((current) => current
                ? `${current}${/\s$/.test(current) ? '' : ' '}${text}`
                : text);
              window.setTimeout(() => textarea.current?.focus(), 0);
            }
          } finally {
            setDictationState('idle');
          }
        })();
      };
      recorder.start();
      // Dictation is sentence-scale; bound runaway recordings.
      session.stopTimer = window.setTimeout(() => {
        try { recorder.stop(); } catch { /* already stopped */ }
      }, 120_000);
      setDictationState('recording');
    } catch (reason) {
      // Raw DOMException names ("NotAllowedError") read as broken UI; map the
      // three real-world failures to actionable notices (goose keeps the same
      // taxonomy for its dictation errors).
      const name = reason instanceof DOMException ? reason.name : '';
      showComposerNotice(name === 'NotAllowedError'
        ? 'Microphone access is blocked. Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? 'No microphone was detected. Connect one and try again.'
          : name === 'NotReadableError'
            ? 'The microphone is busy in another app. Close it and try again.'
            : reason instanceof Error ? reason.message : String(reason));
      setDictationState('idle');
    }
  }, [dictationState, invokeResult, showComposerNotice]);
  useEffect(() => () => {
    const session = dictationSession.current;
    if (!session) return;
    session.cancelled = true;
    try { session.recorder.stop(); } catch { /* teardown */ }
    for (const track of session.stream.getTracks()) track.stop();
  }, []);

  const restoredAttachments = useCallback((value: RecordValue, restoredText: string): {
    attachments: ComposerAttachment[];
    text: string;
  } => {
    const restored: ComposerAttachment[] = [];
    const reserved = new Set(attachmentsRef.current.map((attachment) => attachment.id));
    let textValue = restoredText;
    const uniqueId = (rawId: number) => {
      let id = rawId > 0 ? rawId : attachmentSequence.current;
      while (reserved.has(id)) id = Math.max(id + 1, attachmentSequence.current++);
      reserved.add(id);
      attachmentSequence.current = Math.max(attachmentSequence.current, id + 1);
      return id;
    };
    for (const [key, raw] of Object.entries(asRecord(value.pastedImages) || {})) {
      const image = asRecord(raw);
      if (!image || typeof image.content !== 'string') continue;
      const rawId = Number(image.id || key) || 0;
      const name = String(image.filename || `Image ${rawId || attachmentSequence.current}`);
      const namedToken = `[Image #${rawId}: ${name}]`;
      const plainToken = `[Image #${rawId}]`;
      const sourceToken = textValue.includes(namedToken) ? namedToken : textValue.includes(plainToken) ? plainToken : '';
      if (!sourceToken) continue;
      const id = uniqueId(rawId);
      const token = id === rawId ? sourceToken : sourceToken.replace(`#${rawId}`, `#${id}`);
      if (token !== sourceToken) textValue = textValue.replace(sourceToken, token);
      restored.push({ id, name, kind: 'image', mimeType: String(image.mediaType || 'image/png'),
        data: image.content, token,
        ...(typeof image.metadataText === 'string' && image.metadataText
          ? { metadataText: image.metadataText }
          : {}) });
    }
    for (const [key, raw] of Object.entries(asRecord(value.pastedTexts) || {})) {
      const text = asRecord(raw);
      if (!text || typeof text.text !== 'string') continue;
      const rawId = Number(text.id || key) || 0;
      const match = textValue.match(new RegExp(`\\[Pasted text #${rawId}(?: \\+\\d+ lines)?\\]`));
      if (!match) continue;
      const id = uniqueId(rawId);
      const token = id === rawId ? match[0] : match[0].replace(`#${rawId}`, `#${id}`);
      if (token !== match[0]) textValue = textValue.replace(match[0], token);
      restored.push({ id, name: `Pasted text ${id}`, kind: 'text', mimeType: 'text/plain', data: text.text,
        token, source: 'paste' });
    }
    return { attachments: restored, text: textValue };
  }, []);

  const mergeRestoredAttachments = useCallback((restored: ComposerAttachment[], restoredText: string) => {
    if (!restored.length) return restoredText;
    const next = [...attachmentsRef.current];
    let nextText = restoredText;
    let firstError = '';
    for (const attachment of restored) {
      const index = next.findIndex((entry) => entry.id === attachment.id && entry.kind === attachment.kind);
      if (index >= 0) {
        next[index] = attachment;
        continue;
      }
      const policyError = attachmentPolicyError(next, attachment);
      if (policyError) {
        firstError ||= policyError;
        nextText = nextText.replace(attachment.token, '').replace(/ {2,}/g, ' ').trim();
        continue;
      }
      next.push(attachment);
    }
    if (firstError) setAttachmentError(firstError);
    attachmentsRef.current = next;
    setAttachments(next);
    return nextText;
  }, [attachmentPolicyError]);

  const restoreQueue = async (currentText = draft, queuedId = '') => {
    if (restoring) return undefined;
    setRestoring(true);
    try {
      const args = queuedId ? [currentText, queuedId] : [currentText];
      const value = await invokeCapability<RecordValue>('restoreQueued', args);
      if (value) {
        const restored = restoredAttachments(value, String(value.text || currentText));
        setDraft(mergeRestoredAttachments(restored.attachments, restored.text));
        textarea.current?.focus();
      }
      return value;
    } finally {
      setRestoring(false);
    }
  };

  // Zed queue parity: discard a queued follow-up in place. restoreQueued
  // removes the entry from the engine queue; the merged text it returns is
  // intentionally ignored so the current draft is untouched.
  const discardQueued = async (queuedId: string) => {
    if (restoring || !queuedId) return;
    setRestoring(true);
    try {
      await invokeCapability<RecordValue>('restoreQueued', [draft, queuedId]);
    } finally {
      setRestoring(false);
    }
  };

  const executeSlash = async (raw: string): Promise<boolean> => {
    let invocationFailed = false;
    const commandCapability = async <T,>(capability: DesktopCapability, args: unknown[] = []) => {
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<T>({ capability, args }));
      if (result === undefined) {
        invocationFailed = true;
        return undefined;
      }
      if (result.snapshot !== undefined) applySnapshot(result.snapshot);
      return result.value;
    };
    const [token, ...tail] = raw.trim().slice(1).split(/\s+/);
    const rawName = token.toLowerCase();
    const argument = tail.join(' ').trim();
    const command = SLASH_COMMANDS.find((entry) => entry.name === rawName || entry.aliases?.includes(rawName));
    if (!command) {
      setAttachmentError(`Unknown command: /${rawName}`);
      return false;
    }
    const name = command.name;
    setAttachmentError('');
    setComposerNotice('');
    if (turnBusy && TURN_LOCKED_SLASH_COMMANDS.has(name)) {
      setAttachmentError(`Wait for the current turn to finish before /${rawName}.`);
      return false;
    }
    if (rawName === 'new') onNewTask();
    else if (name === 'project') argument ? onStartProject(argument) : onOpenProjects();
    else if (name === 'resume') argument ? onResumeSession(argument) : onOpenSessions();
    else if (name === 'quit') {
      const quit = window.mixdogDesktop.quit;
      if (typeof quit === 'function') await invokeResult(() => quit());
      else window.close();
    }
    else if (name === 'clear') await commandCapability('clear');
    else if (name === 'compact') await commandCapability('compact');
    else if (name === 'doctor') onOpenCommandSurface('doctor');
    else if (name === 'remote') await commandCapability('claimRemote');
    else if (name === 'settings') onOpenSettings(null);
    else if (name === 'fast') {
      const value = argument.toLowerCase();
      const enabled = value
        ? ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(value) ? true
          : ['0', 'false', 'no', 'off', 'disable', 'disabled'].includes(value) ? false : null
        : !fast;
      if (enabled === null) {
        setAttachmentError('Usage: /fast [on|off]');
        return false;
      }
      const next = await invokeResult(() => window.mixdogDesktop.setFast(enabled));
      if (next === undefined) return false;
      applySnapshot(next);
    } else if (name === 'autoclear') {
      const value = argument.toLowerCase();
      if (!value) onOpenSettings('autoclear');
      else if (value === 'status') {
        const status = asRecord(await commandCapability('getAutoClear'));
        if (invocationFailed) return false;
        if (!status) showComposerNotice('Auto-clear unavailable.');
        else showComposerNotice(`Auto-clear ${status.enabled ? 'on' : 'off'} · idle ${formatIdleDuration(status.idleMs)}`);
      }
      else if (['on', 'enable', 'enabled'].includes(value)) await commandCapability('setAutoClear', [{ enabled: true }]);
      else if (['off', 'disable', 'disabled'].includes(value)) await commandCapability('setAutoClear', [{ enabled: false }]);
      else await commandCapability('setAutoClear', [{ duration: argument }]);
    } else if (name === 'effort') {
      if (argument) await commandCapability('setEffort', [argument]);
      else onOpenCommandSurface('effort');
    } else if (name === 'workflow') {
      if (argument) await commandCapability('setWorkflow', [argument]);
      else onOpenSettings('workflow');
    } else if (name === 'outputstyle') {
      if (!argument) onOpenSettings('output-style');
      else if (['status', 'current', 'show'].includes(argument.toLowerCase())) {
        const status = asRecord(await commandCapability('getOutputStyle'));
        if (invocationFailed) return false;
        const current = asRecord(status?.current);
        showComposerNotice(`Output style: ${String(current?.label || current?.id || status?.configured || 'Default')}`);
      }
      else await commandCapability('setOutputStyle', [argument]);
    } else if (name === 'theme') {
      if (!argument) onOpenSettings('theme');
      else {
        const themes = await commandCapability<unknown[]>('listThemes') || [];
        const normalized = argument.toLowerCase();
        if (['status', 'current', 'show'].includes(normalized)) {
          const value = await commandCapability<unknown>('getTheme');
          if (invocationFailed) return false;
          const current = typeof value === 'string' ? value : String(asRecord(value)?.id || 'default');
          const entry = themes.map(asRecord).find((theme) => String(theme?.id || '') === current);
          showComposerNotice(`Theme: ${String(entry?.label || current || 'default')}`);
          return true;
        }
        const theme = themes.map(asRecord).find((entry) =>
          String(entry?.id || '').toLowerCase() === normalized || String(entry?.label || '').toLowerCase() === normalized);
        if (!theme) {
          setAttachmentError(`Theme not found: ${argument}`);
          return false;
        }
        await commandCapability('setTheme', [theme.id, { persist: true }]);
        if (invocationFailed) return false;
        clearDesktopThemePreference();
        applyDesktopTheme(theme.id);
      }
    }
    else if (name === 'model' && argument) {
      if (argument.toLowerCase() === 'refresh') {
        const models = await invokeResult(() => window.mixdogDesktop.listProviderModels({ force: true }));
        if (models === undefined) return false;
        onOpenSettings('model');
        return true;
      }
      const presetValue = await commandCapability<unknown>('listPresets');
      const presetSource = Array.isArray(presetValue)
        ? presetValue
        : (Array.isArray(asRecord(presetValue)?.presets) ? asRecord(presetValue)?.presets as unknown[] : []);
      const preset = presetSource.map(asRecord).find((entry) => entry && (
        String(entry.id || '').toLowerCase() === argument.toLowerCase() ||
        String(entry.name || '').toLowerCase() === argument.toLowerCase()));
      if (preset) {
        await commandCapability('setModel', [preset.id || preset.name]);
        if (invocationFailed) return false;
        return true;
      }
      const models = await invokeResult(() => window.mixdogDesktop.listProviderModels({ quick: false })) || [];
      const normalized = argument.toLowerCase();
      const model = models.find((entry) => `${entry.provider}:${entry.model}`.toLowerCase() === normalized ||
        entry.model.toLowerCase() === normalized || entry.display.toLowerCase() === normalized);
      if (!model) {
        setAttachmentError(`Model not found: ${argument}`);
        return false;
      }
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute({
        provider: model.provider,
        model: model.model,
      }));
      if (next === undefined) return false;
      applySnapshot(next);
    } else if (name === 'model') {
      onOpenSettings('model');
    } else if (name === 'search') {
      if (argument) {
        setAttachmentError('/search sets the search provider/model; the search tool uses that model when called.');
      }
      onOpenSettings('search');
    } else if (name === 'agents') {
      if (argument.toLowerCase() === 'refresh') {
        const models = await invokeResult(() => window.mixdogDesktop.listProviderModels({ force: true }));
        if (models === undefined) return false;
      }
      onOpenCommandSurface('agents');
    } else if (name === 'usage') {
      if (['refresh', '--refresh', '-r', 'true'].includes(argument.toLowerCase())) {
        await commandCapability('getUsageDashboard', [{ refresh: true }]);
      }
      onOpenCommandSurface('usage');
    } else if (name === 'memory' && argument) {
      const parts = argument.split(/\s+/).filter(Boolean);
      const input: RecordValue = { action: parts[0] || 'status' };
      for (const part of parts.slice(1)) {
        const separator = part.indexOf('=');
        if (separator <= 0) continue;
        const key = part.slice(0, separator);
        const rawValue = part.slice(separator + 1);
        const numeric = Number(rawValue);
        input[key] = rawValue && Number.isFinite(numeric) ? numeric : rawValue;
      }
      await commandCapability('memoryControl', [input]);
    } else if (name === 'memory') onOpenCommandSurface('memory');
    else if (command.surface) onOpenCommandSurface(command.surface);
    else if (command.settingsRow) onOpenSettings(command.settingsRow);
    if (invocationFailed) return false;
    return true;
  };

  const send = async (slashOverride = '') => {
    const text = (slashOverride || draft).trim();
    if (!text || submitting || transitioning) return;
    setSubmitting(true);
    try {
      setComposerNotice('');
      if (text.startsWith('/')) {
        if (commandBusy) {
          setAttachmentError('Wait for the current command to finish. Your command is still in the editor.');
          return;
        }
        const submittedDraft = draft;
        const submittedAttachments = [...attachmentsRef.current];
        setDraft((current) => current === submittedDraft ? '' : current);
        removeAttachments(new Set(submittedAttachments.map((attachment) => attachment.id)));
        historyNavigation.current = { index: -1, seed: '' };
        const accepted = await executeSlash(text);
        if (!accepted) {
          setDraft((current) => current ? current : submittedDraft);
          mergeRestoredAttachments(submittedAttachments, submittedDraft);
        } else {
          rememberPrompt(text);
        }
        return;
      }
      setAttachmentError('');
      const used = attachments.filter((attachment) => draft.includes(attachment.token));
      let expandedText = draft;
      const pastedImages: Record<string, DesktopPromptAttachment> = {};
      const pastedTexts: Record<string, { id: number; text: string }> = {};
      for (const attachment of used) {
        if (attachment.kind === 'text') {
          const safeName = attachment.name.replace(/[<>"']/g, '_');
          const expanded = attachment.source === 'paste'
            ? attachment.data
            : `<file name="${safeName}">\n${attachment.data}\n</file>`;
          expandedText = expandedText.replaceAll(attachment.token, expanded);
          pastedTexts[String(attachment.id)] = { id: attachment.id, text: attachment.data };
        } else if (attachment.kind === 'image') {
          pastedImages[String(attachment.id)] = {
            id: attachment.id,
            type: 'image',
            content: attachment.data,
            mediaType: attachment.mimeType,
            filename: attachment.name,
            ...(attachment.metadataText ? { metadataText: attachment.metadataText } : {}),
          };
        }
      }
      const imageAttachments = used.filter((attachment) => attachment.kind === 'image');
      const pdfAttachments = used.filter((attachment) => attachment.kind === 'pdf');
      // Register byte-free preview sources for the transcript chips this
      // submit will produce. The transcript item itself carries metadata only.
      for (const attachment of imageAttachments) {
        registerImagePreview(attachment.id, attachment.data.length,
          `data:${attachment.mimeType};base64,${attachment.data}`);
      }
      if (expandedText.length > MAX_SUBMIT_TEXT_LENGTH) {
        setAttachmentError('This prompt is too large to send. Remove or shorten an inline text attachment.');
        return;
      }
      const content: DesktopPromptContent = imageAttachments.length || pdfAttachments.length
        ? [
          { type: 'text', text: expandedText },
          // TUI parity: each image carries its "[Image: WxH, displayed at …]"
          // metadata text part directly before the image block.
          ...imageAttachments.flatMap((attachment) => [
            ...(attachment.metadataText
              ? [{ type: 'text' as const, text: attachment.metadataText }]
              : []),
            {
              type: 'image' as const,
              data: attachment.data,
              mimeType: attachment.mimeType,
            },
          ]),
          ...pdfAttachments.map((attachment) => ({
            type: 'file' as const,
            data: attachment.data,
            mimeType: attachment.mimeType,
            filename: attachment.name,
          })),
        ]
        : expandedText;
      const accepted = await submit(content, {
        displayText: expandedText,
        ...(Object.keys(pastedImages).length ? { pastedImages } : {}),
        ...(Object.keys(pastedTexts).length ? { pastedTexts } : {}),
      });
      setDraft((current) => draftAfterSubmission(current, draft, accepted));
      if (accepted === true) {
        rememberPrompt(text);
        removeAttachments(new Set(used.map((attachment) => attachment.id)));
        historyNavigation.current = { index: -1, seed: '' };
      }
    } finally {
      setSubmitting(false);
    }
  };
  const onSubmit = (event: FormEvent) => { event.preventDefault(); void send(); };
  const insertNewline = (element: HTMLTextAreaElement) => {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    setDraft((current) => `${current.slice(0, start)}\n${current.slice(end)}`);
    window.setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(start + 1, start + 1);
    }, 0);
  };
  const selectMention = (path: string | undefined) => {
    if (!path || !mentionMatch) return;
    const before = draft.slice(0, mentionMatch.start);
    const after = draft.slice(mentionMatch.end);
    const inserted = `@${path}${after && /^\s/.test(after) ? '' : ' '}`;
    const next = `${before}${inserted}${after}`;
    const caret = before.length + inserted.length;
    setDraft(next);
    setCaretOffset(caret);
    setMentionDismissed('');
    setMentionResults([]);
    historyNavigation.current = { index: -1, seed: '' };
    window.setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(caret, caret);
    }, 0);
  };
  const navigateMentionPalette = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!mentionOpen) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMentionDismissed(mentionSignature);
      return true;
    }
    if (!mentionResults.length) return false;
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      selectMention(mentionResults[mentionIndex] || mentionResults[0]);
      return true;
    }
    const last = mentionResults.length - 1;
    const moves: Record<string, (index: number) => number> = {
      ArrowDown: (index) => (index + 1) % mentionResults.length,
      ArrowUp: (index) => (index - 1 + mentionResults.length) % mentionResults.length,
      Home: () => 0,
      End: () => last,
      PageUp: (index) => Math.max(0, index - 8),
      PageDown: (index) => Math.min(last, index + 8),
    };
    const move = moves[event.key];
    if (!move) return false;
    event.preventDefault();
    setMentionIndex(move);
    return true;
  };
  const navigateSlashPalette = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!slashOpen || slashCommands.length === 0) return false;
    const last = slashCommands.length - 1;
    if (event.key === 'Tab') {
      event.preventDefault();
      setDraft(`/${paletteCommandToken(slashCommands[slashIndex])} `);
      return true;
    }
    const moves: Record<string, (index: number) => number> = {
      ArrowDown: (index) => (index + 1) % slashCommands.length,
      ArrowRight: (index) => (index + 1) % slashCommands.length,
      ArrowUp: (index) => (index - 1 + slashCommands.length) % slashCommands.length,
      ArrowLeft: (index) => (index - 1 + slashCommands.length) % slashCommands.length,
      Home: () => 0,
      End: () => last,
      PageUp: (index) => Math.max(0, index - slashCommands.length),
      PageDown: (index) => Math.min(last, index + slashCommands.length),
    };
    const move = moves[event.key];
    if (!move) return false;
    event.preventDefault();
    setSlashIndex(move);
    return true;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (composing && (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Tab' ||
      event.key.startsWith('Arrow'))) return;
    if (event.key === 'Enter' && event.repeat) return;
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'u') {
      event.preventDefault();
      const element = event.currentTarget;
      const selectionStart = element.selectionStart;
      const selectionEnd = element.selectionEnd;
      const lineStart = draft.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
      const removeStart = selectionStart === selectionEnd ? lineStart : selectionStart;
      setDraft((current) => `${current.slice(0, removeStart)}${current.slice(selectionEnd)}`);
      window.setTimeout(() => textarea.current?.setSelectionRange(removeStart, removeStart), 0);
      return;
    }
    if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      insertNewline(event.currentTarget);
      return;
    }
    if (navigateMentionPalette(event)) return;
    if (navigateSlashPalette(event)) return;
    if (slashOpen && slashCommands.length && event.key === 'Enter' &&
      !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const command = slashCommands[slashIndex];
      void send(`/${paletteCommandToken(command)}`);
      return;
    }
    if (event.key === 'Escape') {
      if (slashOpen) {
        event.preventDefault();
        setDraft('');
        setSlashDismissedDraft('');
        return;
      }
      const element = event.currentTarget;
      if (element.selectionStart !== element.selectionEnd) {
        event.preventDefault();
        const end = element.selectionEnd;
        window.setTimeout(() => element.setSelectionRange(end, end), 0);
        return;
      }
      if (draft || attachments.length) {
        event.preventDefault();
        setDraft('');
        clearAttachments();
        historyNavigation.current = { index: -1, seed: '' };
        return;
      }
      if (turnBusy) {
        event.preventDefault();
        void stop();
        return;
      }
      if (Array.isArray(queued) && queued.length) {
        event.preventDefault();
        void restoreQueue();
      }
      return;
    }
    const historyIntent = shouldNavigatePromptHistory({
      key: event.key,
      value: draft,
      selectionStart: event.currentTarget.selectionStart,
      selectionEnd: event.currentTarget.selectionEnd,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      historyActive: historyNavigation.current.index >= 0,
    });
    if (event.key === 'ArrowUp' && historyIntent && !event.altKey && !draft.trim() &&
      Array.isArray(queued) && queued.length) {
      event.preventDefault();
      void restoreQueue();
      return;
    }
    if (event.key === 'ArrowUp' && historyIntent && history.length) {
      event.preventDefault();
      const navigation = historyNavigation.current;
      if (navigation.index < 0) navigation.seed = draft;
      navigation.index = Math.min(history.length - 1, navigation.index + 1);
      const value = history[navigation.index] || '';
      setDraft(value);
      window.setTimeout(() => textarea.current?.setSelectionRange(value.length, value.length), 0);
      return;
    }
    if (event.key === 'ArrowDown' && historyIntent && historyNavigation.current.index >= 0) {
      event.preventDefault();
      const navigation = historyNavigation.current;
      navigation.index -= 1;
      const value = navigation.index < 0 ? navigation.seed : history[navigation.index] || '';
      setDraft(value);
      window.setTimeout(() => textarea.current?.setSelectionRange(value.length, value.length), 0);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        insertNewline(event.currentTarget);
      } else if (!event.altKey) {
        void send();
      }
    }
  };
  const stop = async () => {
    const result = asRecord(await abort());
    if (result?.restoreText) {
      const restoredText = String(result.restoreText);
      const restored = restoredAttachments(result, restoredText);
      const acceptedText = mergeRestoredAttachments(restored.attachments, restored.text);
      setDraft((current) => [acceptedText, current.trim()].filter(Boolean).join('\n'));
      window.setTimeout(() => textarea.current?.focus(), 0);
    }
  };
  return (
    <>
      <QueueList queued={queued} restoring={restoring}
        onEdit={(id) => void restoreQueue(draft, id)}
        onRemove={(id) => void discardQueued(id)} />
      {/* Error/notice banners float ABOVE the input card (user-flagged: they
          previously rendered inside the pill and read as composer content). */}
      {(attachmentError) && <p className="composer-error" role="alert">{attachmentError}</p>}
      {composerNotice && <p className="composer-notice" role="status">{composerNotice}</p>}
      <form className={`composer ${draggingFiles && !transitioning ? 'dragging-files' : ''}`} onSubmit={onSubmit}
        aria-busy={transitioning} onMouseDown={(event) => {
          const target = event.target as HTMLElement;
          if (!target.closest('button, input, textarea, [role="listbox"]')) textarea.current?.focus();
        }} onDragEnter={(event) => {
          if (transitioning || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDraggingFiles(true);
        }} onDragOver={(event) => {
          if (transitioning || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }} onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDraggingFiles(false);
        }} onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDraggingFiles(false);
          if (transitioning) return;
          const itemFiles = Array.from(event.dataTransfer.items)
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          void attachFiles(itemFiles.length ? itemFiles : event.dataTransfer.files);
        }}>
      {draggingFiles && !transitioning && <div className="composer-drop-overlay" role="status">
        <OcIcon name="photo" size={16} /><span>Drop images, PDFs, or text files</span>
      </div>}
      {slashOpen && (
        <div ref={slashPalette} id="composer-slash-palette" className="slash-palette" role="listbox" aria-label="Slash commands">
          <header><Command size={13} /><span>Commands</span></header>
          {slashCommands.length ? slashCommands.map((command, index) => (
            <button type="button" role="option" aria-selected={index === slashIndex} key={command.name}
              id={`composer-slash-option-${index}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => { void send(`/${paletteCommandToken(command)}`); }}>
              <code>{command.usage || `/${command.name}`}{command.params ? ` ${command.params}` : ''}</code>
              <span>{command.description}</span>
            </button>
          )) : <p>No matching command.</p>}
        </div>
      )}
      {mentionOpen && (
        <div ref={mentionPalette} id="composer-mention-palette"
          className="slash-palette mention-palette" role="listbox" aria-label="Project files">
          <header><OcIcon name="open-file" size={13} /><span>Files</span></header>
          {mentionResults.length ? mentionResults.map((path, index) => {
            const separator = path.lastIndexOf('/');
            const directory = separator >= 0 ? path.slice(0, separator + 1) : '';
            const filename = separator >= 0 ? path.slice(separator + 1) : path;
            return (
              <button type="button" role="option" aria-selected={index === mentionIndex} key={path}
                id={`composer-mention-option-${index}`} title={path}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => selectMention(path)}>
                <OcIcon name="open-file" size={14} />
                <span className="mention-path"><span>{directory}</span><strong>{filename}</strong></span>
              </button>
            );
          }) : <p role="status">{mentionLoading ? 'Searching project files…' : 'No matching files.'}</p>}
        </div>
      )}
      {attachments.length > 0 && <div className="composer-attachments" aria-label="Attachments">
        {attachments.map((attachment) => <div className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
          {attachment.kind === 'image'
            ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
            : <span><OcIcon name="open-file" size={15} /></span>}
          <span data-tooltip={attachment.name}>{attachment.name}</span>
          <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => {
            setAttachments((current) => {
              const next = current.filter((entry) => entry.id !== attachment.id);
              attachmentsRef.current = next;
              return next;
            });
            setDraft((current) => current.replace(attachment.token, '').replace(/ {2,}/g, ' '));
          }}><OcIcon name="close-small" size={13} /></button>
        </div>)}
      </div>}
      <textarea ref={textarea} value={draft} onInput={(event) => {
        // Perf diagnostics (MIXDOG_DESKTOP_PERF=1): keystroke→paint latency,
        // logged only when a frame is actually slow.
        if (window.mixdogDesktop?.perfLog) {
          const inputAt = performance.now();
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            const ms = performance.now() - inputAt;
            if (ms >= 25) window.mixdogDesktop?.perfLog?.(`composer-keystroke paint=${ms.toFixed(0)}ms`);
          }));
        }
        setDraft(event.currentTarget.value);
        setAttachmentError('');
        setComposerNotice('');
        setCaretOffset(event.currentTarget.selectionStart);
        setSlashDismissedDraft('');
        setMentionDismissed('');
        historyNavigation.current = { index: -1, seed: '' };
      }} onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)}
        onSelect={(event) => setCaretOffset(event.currentTarget.selectionStart)} onKeyDown={onKeyDown}
        onPaste={(event) => {
          const itemFiles = Array.from(event.clipboardData.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          const files = itemFiles.length ? itemFiles : Array.from(event.clipboardData.files);
          if (files.length) {
            event.preventDefault();
            void attachFiles(files);
            return;
          }
          const text = event.clipboardData.getData('text/plain');
          if (text.length > 200 || text.split(/\r?\n/).length >= 3) {
            const id = attachmentSequence.current++;
            const lines = text.replace(/\r\n?/g, '\n').split('\n').length;
            const inserted = insertAttachment({
              id, name: `Pasted text · ${lines} lines`, kind: 'text', mimeType: 'text/plain', data: text,
              token: `[Pasted text #${id} +${lines} lines]`, source: 'paste',
            });
            if (inserted) event.preventDefault();
          }
        }}
        rows={1} placeholder={placeholder}
        disabled={transitioning}
        aria-controls={mentionOpen ? 'composer-mention-palette' : slashOpen ? 'composer-slash-palette' : undefined}
        aria-expanded={mentionOpen || slashOpen}
        aria-activedescendant={mentionOpen && mentionResults.length
          ? `composer-mention-option-${mentionIndex}`
          : slashOpen && slashCommands.length ? `composer-slash-option-${slashIndex}` : undefined}
        aria-label="Message Mixdog" />
      <div className="composer-footer">
        <input ref={fileInput} type="file" hidden multiple
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.pdf,text/*,.md,.mdx,.txt,.log,.json,.jsonl,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.mjs,.cjs,.ts,.tsx,.mts,.cts,.py,.rb,.rs,.go,.java,.kt,.swift,.cs,.cpp,.cc,.c,.h,.hh,.hpp,.sh,.zsh,.ps1,.bat,.cmd,.sql,.css,.scss,.sass,.html,.htm,.vue,.svelte,.env,.ini,.conf,.cfg,.gql,.graphql"
          onChange={(event) => { if (event.currentTarget.files) void attachFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
        <button type="button" className="composer-tool" disabled={transitioning} aria-label="Attach files" data-tooltip="Attach images, PDFs, or text files" data-tooltip-side="top"
        onClick={() => fileInput.current?.click()}><OcIcon name="plus" size={16} /></button>
        <ModelSelector provider={provider} model={model} effort={effort} fast={fast} fastCapable={fastCapable}
          modelDisabled={commandBusy || transitioning}
          tuningDisabled={turnBusy || commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot}
          onOpenSettings={onOpenSettings} />
        <WorkflowSelect workflow={workflow}
          disabled={turnBusy || commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot} />
        <button type="button"
          className={`composer-tool composer-mic ${dictationState !== 'idle' ? `is-${dictationState}` : ''}`.trim()}
          disabled={transitioning || dictationState === 'transcribing'}
          aria-label={dictationState === 'recording' ? 'Stop dictation' : 'Dictate with voice'}
          aria-pressed={dictationState === 'recording'}
          data-tooltip={dictationState === 'recording' ? 'Stop and transcribe'
            : dictationState === 'transcribing' ? 'Transcribing…' : 'Dictate (local Whisper)'}
          data-tooltip-side="top"
          onClick={() => void toggleDictation()}>
          {dictationState === 'transcribing' ? <LoaderCircle className="composer-mic-spinner" size={15} /> : <Mic size={15} />}
        </button>
        {turnBusy && !draft.trim() ? (
          <button type="button" className="send-button stop" onClick={() => void stop()}
            aria-label="Stop generation" data-tooltip="Stop" data-tooltip-side="top">
            <OcIcon name="stop" size={16} />
          </button>
        ) : (
          <button className="send-button" disabled={!draft.trim() || submitting || transitioning}
            aria-label={turnBusy ? "Queue or steer active turn" : commandBusy ? "Queue after current command" : "Send message"}
            data-tooltip={turnBusy ? "Queue or steer · Enter" : commandBusy ? "Queue after command · Enter" : "Send · Enter"}
            data-tooltip-side="top">
            <ArrowUp size={15} />
          </button>
        )}
      </div>
      </form>
    </>
  );
});

// The terminal picker's normalizeModelOptions is the authority for WHICH
// models surface (family grouping/limits, recency ordering). The desktop
// modal only owns presentation. Shapes differ: desktop uses `model`, the
// TUI uses `id`.
// @ts-ignore -- shared TUI source has no declaration file.
// eslint-disable-next-line import/no-relative-packages
import { normalizeModelOptions as normalizeTuiModelOptions } from "../../../../src/tui/app/model-options.mjs";

function providerSetupEntries(value: unknown): Array<RecordValue & { group: "api" | "oauth" | "local" }> {
  const setup = asRecord(value);
  return (["api", "oauth", "local"] as const).flatMap((group) => {
    const rows = setup?.[group];
    return Array.isArray(rows) ? rows.map(asRecord)
      .filter((row): row is RecordValue => Boolean(row))
      .map((row) => ({ ...row, group } as RecordValue & { group: typeof group })) : [];
  });
}

function providerSetupState(value: unknown, provider: string) {
  const entry = providerSetupEntries(value)
    .find((row) => String(row.id || row.provider || "") === provider);
  if (!entry) return { known: false, configured: false };
  const configured = entry.group === "local"
    ? entry.detected === true && entry.enabled === true
    : entry.authenticated === true;
  return {
    known: true,
    configured,
  };
}

// Workflow packs change rarely; share one fetched option list across composer
// remounts (session/tab switches) with a short TTL.
let workflowOptionsCache: { at: number; options: Array<{ value: string; label: string }> } | null = null;

// Right-aligned composer group: the workflow (mode) picker sits with the Send
// button while model/effort/fast stay left-aligned.
const WorkflowSelect = memo(function WorkflowSelect({ workflow, disabled, invokeResult, applySnapshot }: {
  workflow?: RecordValue | null;
  disabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
}) {
  const [options, setOptions] = useState<Array<{ value: string; label: string }>>(
    workflowOptionsCache?.options || [],
  );
  const [switching, setSwitching] = useState(false);
  const switchGuard = useRef(false);
  useEffect(() => {
    if (workflowOptionsCache && Date.now() - workflowOptionsCache.at < 300_000) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.mixdogDesktop.invokeCapability<RecordValue[]>({
          capability: 'listWorkflows',
          args: [],
        });
        const rows = Array.isArray(result?.value) ? result.value : [];
        const loaded = rows
          .map((row) => ({
            value: String(row?.id || ''),
            label: String(row?.name || row?.label || row?.id || ''),
          }))
          .filter((option) => option.value);
        if (!cancelled && loaded.length) {
          workflowOptionsCache = { at: Date.now(), options: loaded };
          setOptions(loaded);
        }
      } catch { /* the workflow picker is optional chrome; the settings panel remains the fallback */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const changeWorkflow = async (id: string) => {
    if (disabled || switchGuard.current || !id || id === String(workflow?.id || '')) return;
    switchGuard.current = true;
    setSwitching(true);
    try {
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
        capability: 'setWorkflow',
        args: [id],
      }));
      if (result !== undefined) applySnapshot(result.snapshot);
    } finally {
      switchGuard.current = false;
      setSwitching(false);
    }
  };
  if (options.length === 0) return null;
  return <div className="effort-control workflow-control">
    <OpenSelect ariaLabel="Workflow" disabled={disabled || switching}
      value={String(workflow?.id || '')}
      displayValue={String(workflow?.name || workflow?.id || 'Workflow')}
      onChange={(value) => void changeWorkflow(value)}
      options={[
        ...(!workflow?.id ? [{ value: '', label: 'Workflow', disabled: true }] : []),
        ...options,
      ]} />
  </div>;
});

const ModelSelector = memo(function ModelSelector({ provider, model, effort, fast, fastCapable, modelDisabled, tuningDisabled, invokeResult, applySnapshot, onOpenSettings }: {
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  modelDisabled: boolean;
  tuningDisabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  onOpenSettings: (section?: SettingsSection | null) => void;
}) {
  const [cachedCatalog] = useState(readCachedModelCatalog);
  const [models, setModels] = useState<DesktopModelOption[]>(cachedCatalog.models);
  const [providerSetup, setProviderSetup] = useState<unknown>(null);
  const [catalogError, setCatalogError] = useState("");
  const [providerSetupError, setProviderSetupError] = useState("");
  const [catalogLoaded, setCatalogLoaded] = useState(cachedCatalog.models.length > 0);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [routing, setRouting] = useState(false);
  const [optimisticFast, setOptimisticFast] = useState<boolean | null>(null);
  const automaticCatalogAttempted = useRef(false);
  const catalogInFlight = useRef<Promise<void> | null>(null);
  const catalogLoadedAt = useRef(cachedCatalog.updatedAt);
  const routingGuard = useRef(false);
  const restoreAfterRoute = useRef<HTMLElement | null>(null);
  const restoreFastAfterDisabled = useRef(false);
  const fastWasDisabled = useRef(false);
  const fastFocusMovedWhileDisabled = useRef(false);
  const effortControl = useRef<HTMLDivElement>(null);
  const fastControl = useRef<HTMLButtonElement>(null);
  const modelUnavailable = modelDisabled || routing;
  const tuningUnavailable = tuningDisabled || routing;
  const displayedFast = optimisticFast ?? fast;
  const catalogModels = useMemo(() => {
    const unique = new Map<string, DesktopModelOption>();
    for (const option of models) {
      if (option?.provider && option?.model) unique.set(`${option.provider}:${option.model}`, option);
    }
    const normalized = normalizeTuiModelOptions(
      [...unique.values()].map((option) => ({ ...option, id: option.model })),
    ) as Array<DesktopModelOption & { id?: string }>;
    return normalized.map((entry) => {
      const { id: _id, ...option } = entry;
      return option as DesktopModelOption;
    });
  }, [models]);
  const selected = catalogModels.find((option) =>
    option.provider === provider && option.model === model);
  const selectableModels = useMemo(() => {
    if (providerSetup == null || providerSetupError) return catalogModels;
    return catalogModels.filter((option) => providerSetupState(providerSetup, option.provider).configured);
  }, [catalogModels, providerSetup, providerSetupError]);
  const selectedEffort = selected?.effortOptions.find((option) => option.value === effort);
  const triggerModel = selected
    ? modelDisplayName(selected.model, selected.provider, selected.display || "")
    : "Select model";

  const loadCatalog = useCallback(async (force = false) => {
    if (catalogInFlight.current) return catalogInFlight.current;
    const listModels = window.mixdogDesktop?.listProviderModels;
    if (!listModels) {
      setCatalogLoaded(true);
      return;
    }
    const request = (async () => {
      const failures: string[] = [];
      try {
        setCatalogRefreshing(true);
        setCatalogError("");
        setProviderSetupError("");
        const setupRequest = window.mixdogDesktop?.invokeCapability
          ? window.mixdogDesktop.invokeCapability<unknown>({
              capability: "getProviderSetup",
              args: force ? [{ refresh: true }] : [],
            })
            .then((setup) => { setProviderSetup(setup.value); })
            .catch((reason) => {
              setProviderSetupError(reason instanceof Error
                ? reason.message
                : String(reason || "Provider status is unavailable."));
            })
          : Promise.resolve();
        try {
          const quick = await listModels({ quick: true });
          if (Array.isArray(quick) && quick.length > 0) {
            setModels(quick);
            setCatalogLoaded(true);
          }
        } catch (reason) {
          failures.push(reason instanceof Error ? reason.message : String(reason || "Quick model catalog failed."));
        }
        // EngineHost seeds its authoritative full request before servicing the
        // advisory quick read. Await quick here so the picker remains instant;
        // the host-side seed protects the catalog from the warmup race.
        try {
          const full = await listModels(force
            ? { force: true, quick: false }
            : { quick: false });
          if (Array.isArray(full)) {
            // The full catalog is authoritative. Replacing the advisory quick
            // rows prevents retired or disconnected models from surviving a
            // refresh forever; an open picker freezes its first rendered set.
            const catalog = writeCachedModelCatalog(full);
            setModels(catalog.models);
            catalogLoadedAt.current = catalog.updatedAt;
          }
        } catch (reason) {
          failures.push(reason instanceof Error ? reason.message : String(reason || "Model catalog failed."));
        }
        await setupRequest;
      } finally {
        setCatalogError([...new Set(failures)].join(" "));
        setCatalogLoaded(true);
        setCatalogRefreshing(false);
      }
    })().finally(() => { catalogInFlight.current = null; });
    catalogInFlight.current = request;
    return request;
  }, [invokeResult]);

  useEffect(() => {
    if (!automaticCatalogAttempted.current && (provider || model)) {
      automaticCatalogAttempted.current = true;
      void loadCatalog();
    }
  }, [loadCatalog, model, provider]);

  useEffect(() => {
    if (optimisticFast !== null && optimisticFast === fast) setOptimisticFast(null);
  }, [fast, optimisticFast]);

  useEffect(() => {
    if (routing || !restoreAfterRoute.current) return;
    const target = restoreAfterRoute.current;
    restoreAfterRoute.current = null;
    target.focus({ preventScroll: true });
  }, [routing]);

  useEffect(() => {
    if (tuningDisabled) {
      fastWasDisabled.current = true;
      fastFocusMovedWhileDisabled.current = false;
      const trackFocus = (event: FocusEvent) => {
        if (event.target !== fastControl.current) fastFocusMovedWhileDisabled.current = true;
      };
      document.addEventListener('focusin', trackFocus, true);
      return () => document.removeEventListener('focusin', trackFocus, true);
    }
    if (!fastWasDisabled.current) return;
    fastWasDisabled.current = false;
    if (!restoreFastAfterDisabled.current) return;
    if (!fastFocusMovedWhileDisabled.current) {
      fastControl.current?.focus({ preventScroll: true });
    }
    restoreFastAfterDisabled.current = false;
  }, [tuningDisabled]);

  const route = async (selection: DesktopModelSelection, restoreTarget: HTMLElement | null = null) => {
    if (modelUnavailable || routingGuard.current) return false;
    routingGuard.current = true;
    restoreAfterRoute.current = restoreTarget;
    setRouting(true);
    let applied = false;
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute(selection));
      if (next !== undefined) {
        applySnapshot(next);
        applied = true;
      }
    } finally {
      routingGuard.current = false;
      setRouting(false);
    }
    return applied;
  };
  const chooseModel = (option: DesktopModelOption) => {
    const values = option.effortOptions.map((entry) => entry.value);
    const sameModel = option.provider === provider && option.model === model;
    const nextEffort = sameModel && effort && values.includes(effort)
      ? effort
      : option.savedEffort && values.includes(option.savedEffort)
        ? option.savedEffort
        : ['high', 'medium', 'low', 'none', 'xhigh', 'max', 'ultra'].find((value) => values.includes(value)) || values[0];
    const nextFast = option.fastCapable
      ? sameModel
        ? displayedFast
        : typeof option.savedFast === 'boolean'
          ? option.savedFast
          : option.fastPreferred
      : undefined;
    return route({
      provider: option.provider,
      model: option.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(nextFast === undefined ? {} : { fast: nextFast }),
    });
  };
  const changeFast = async (enabled: boolean) => {
    if (tuningUnavailable || routingGuard.current) return;
    setOptimisticFast(enabled);
    routingGuard.current = true;
    restoreFastAfterDisabled.current = true;
    restoreAfterRoute.current = fastControl.current;
    setRouting(true);
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setFast(enabled));
      if (next !== undefined) applySnapshot(next);
    } finally {
      setOptimisticFast(null);
      routingGuard.current = false;
      setRouting(false);
    }
  };
  const changeEffort = async (effort: string) => {
    if (tuningUnavailable || routingGuard.current) return;
    routingGuard.current = true;
    restoreAfterRoute.current = effortControl.current?.querySelector('button') || null;
    setRouting(true);
    try {
      const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
        capability: 'setEffort',
        args: [effort],
      }));
      if (result !== undefined) applySnapshot(result.snapshot);
    } finally {
      routingGuard.current = false;
      setRouting(false);
    }
  };

  return <div className="route-controls">
    <ModelPicker models={selectableModels} provider={provider} model={model}
      triggerLabel={triggerModel} disabled={modelUnavailable}
      popoverId="model-selector-popover"
      catalogLoaded={catalogLoaded} catalogRefreshing={catalogRefreshing}
      catalogError={catalogError} providerSetupError={providerSetupError}
      tooltip={catalogLoaded && selectableModels.length === 0 ? "Add a provider to load models" : "Choose model"}
      onOpen={() => {
        if (!catalogLoaded || Date.now() - catalogLoadedAt.current > 300_000) void loadCatalog(catalogLoaded);
      }}
      onSelect={chooseModel}
      onOpenProviders={() => onOpenSettings("providers")} />
    {selected && selected.effortOptions.length > 0 && (
      <div ref={effortControl} className="effort-control">
        <OpenSelect ariaLabel="Reasoning effort" disabled={tuningUnavailable} value={selectedEffort?.value || ""}
          onChange={(value) => void changeEffort(value)} options={[
            ...(!selectedEffort ? [{ value: '', label: 'Effort', disabled: true }] : []),
            ...selected.effortOptions,
          ]} />
      </div>
    )}
    {fastCapable && (
      <button ref={fastControl} type="button" className="fast-control" aria-label="Fast mode"
        aria-pressed={displayedFast} aria-busy={routing || undefined} disabled={tuningUnavailable}
        onFocus={() => { restoreFastAfterDisabled.current = true; }}
        onClick={() => void changeFast(!displayedFast)}>{displayedFast ? "Fast On" : "Fast Off"}</button>
    )}
  </div>;
});
