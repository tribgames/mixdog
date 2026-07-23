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
  useSyncExternalStore,
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
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { MxIcon } from "./MxIcon";
import { createPortal } from "react-dom";
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual";
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
  toolInputRows,
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
import { acquireModalLayer } from "./modal-layer";
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

import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { imagePreviewCache, imagePreviewKey, registerImagePreview, lastVisibleTranscriptItemIndex, estimatedTranscriptRowHeight, TRANSCRIPT_VIRTUALIZE_THRESHOLD, TRANSCRIPT_VIRTUAL_OVERSCAN } from "./transcript-metrics";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { LiveWorkStatus, ContextUsageIndicator, LiveActivity, TextShimmer, CompletionStatus, completionTone, CopyControl, MarkdownResponse, preloadMarkdownBody, transcriptItemSignature, messageMetadata, TranscriptRow, ToolCard, DiffBoundary, CodeDiff, findPatch, toolIcon, toolResultText, isHookApprovalDenialToolItem, shouldSuppressFullyFailedToolItem, boundedTextOf } from "./TranscriptView";
import { ApprovalCard } from "./ApprovalCard";
import { TurnReviewBar } from "./TurnReview";
import { UtilityDock, type UtilityDockTab, clampDockWidth, readDockState, DOCK_STATE_KEY } from "./UtilityDock";
import { ReviewPane } from "./ReviewPane";
import { Composer, ProjectContextSelector, PROJECT_CONTEXT_LOCAL, PROJECT_CONTEXT_OPEN, WorkflowSelect, ModelSelector, queuedFollowupPreview, readPromptHistory, promptHistoryStorageKey } from "./Composer";

import { DesktopUpdateDialog, DesktopToastRegion, InlineErrors } from "./notifications";
import { Conversation } from "./Conversation";
import {
  createDesktopSnapshotStore,
  desktopChromeSnapshotsEqual,
  desktopConversationSnapshotsEqual,
  desktopDockSnapshotsEqual,
  desktopHeaderSnapshotsEqual,
  desktopSidebarSnapshotsEqual,
  type DesktopSnapshotStore,
} from "./desktop-snapshot-store";

const SESSION_SNAPSHOT_CACHE_LIMIT = 6;
const SIDEBAR_OPEN_KEY = 'mixdog.desktop-sidebar-open.v1';
const LAST_PROJECT_KEY = 'mixdog.desktop-last-project.v1';
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
// SchedulesPane loads statically: a lazy chunk suspends the whole main pane
// on first entry, which flashes the New-task watermark before the page lands.
import { SchedulesPane } from "./SchedulesView";
import { WebhooksPane } from "./WebhooksView";

function schedulePostInteractionIdle(
  task: () => void,
  fallbackMs = 5_000,
  idleTimeout = 1_500,
): () => void {
  let stopped = false;
  let armed = false;
  let fallback: number | undefined;
  let startupFallback: number | undefined;
  let idleHandle: number | undefined;
  const host = window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
    __mixdogStartupSettled?: boolean;
  };
  const removeInteractionListeners = () => {
    window.removeEventListener("pointerdown", queueIdle);
    window.removeEventListener("keydown", queueIdle);
  };
  const run = () => {
    if (!stopped) task();
  };
  const queueIdle = () => {
    removeInteractionListeners();
    window.clearTimeout(fallback);
    fallback = undefined;
    if (typeof host.requestIdleCallback === "function") {
      idleHandle = host.requestIdleCallback(run, { timeout: idleTimeout });
    } else {
      idleHandle = window.setTimeout(run, Math.min(idleTimeout, 250));
    }
  };
  const arm = () => {
    if (stopped || armed) return;
    armed = true;
    window.clearTimeout(startupFallback);
    window.addEventListener("pointerdown", queueIdle, { once: true });
    window.addEventListener("keydown", queueIdle, { once: true });
    fallback = window.setTimeout(queueIdle, fallbackMs);
  };
  if (host.__mixdogStartupSettled) arm();
  else {
    window.addEventListener("mixdog:startup-settled", arm, { once: true });
    startupFallback = window.setTimeout(arm, 1_200);
  }
  return () => {
    stopped = true;
    removeInteractionListeners();
    window.removeEventListener("mixdog:startup-settled", arm);
    window.clearTimeout(fallback);
    window.clearTimeout(startupFallback);
    if (idleHandle !== undefined) {
      if (typeof host.cancelIdleCallback === "function") host.cancelIdleCallback(idleHandle);
      else window.clearTimeout(idleHandle);
    }
  };
}

// Warm Markdown immediately after the first usable frame: delaying this until
// the first session click made assistant strings appear row-by-row while the
// virtualizer was already correcting their heights. The much heavier diff
// surface remains behind post-interaction idle.
// chunk made a freshly opened session paint user bubbles (plain text) first
// and then trickle the styled assistant/tool rows in as the chunk landed
// (user: "유저 메세지 몇 개만 나왔다가 딸려서 나옴"). The old fixed 250ms
// timer often landed the eval INSIDE the reveal window — the Shiki diff
// chunk alone is ~1.7MB of main-thread eval and read as a launch hitch
// (user: "프리징 유사하게 로딩"). Stage both AFTER startup settles, on idle:
// markdown promptly (first session open needs it), the diff chunk well clear
// of the reveal (only an expanded diff needs it).
if (typeof window !== "undefined") {
  const warmMarkdown = () => {
    const host = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      __mixdogStartupSettled?: boolean;
    };
    if (typeof host.requestIdleCallback === "function") {
      host.requestIdleCallback(() => { void preloadMarkdownBody(); }, { timeout: 600 });
    } else {
      window.setTimeout(() => { void preloadMarkdownBody(); }, 120);
    }
  };
  const host = window as typeof window & { __mixdogStartupSettled?: boolean };
  if (host.__mixdogStartupSettled) warmMarkdown();
  else {
    window.addEventListener("mixdog:startup-settled", warmMarkdown, { once: true });
    window.setTimeout(warmMarkdown, 1_200);
  }
  schedulePostInteractionIdle(() => {
    window.setTimeout(() => void import("./DiffView.lazy"), 2_500);
  });
}

const selectDesktopSnapshot = (snapshot: Snapshot) => snapshot;

function useDesktopSnapshotSelector<T>(
  store: DesktopSnapshotStore,
  selector: (snapshot: Snapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const cached = useRef<{ value: T } | null>(null);
  const getSelection = useCallback(() => {
    const next = selector(store.getSnapshot());
    const previous = cached.current;
    if (previous && isEqual(previous.value, next)) return previous.value;
    cached.current = { value: next };
    return next;
  }, [isEqual, selector, store]);
  return useSyncExternalStore(store.subscribe, getSelection, getSelection);
}

function useSelectedDesktopSnapshot(
  store: DesktopSnapshotStore,
  frozenSnapshot: Snapshot | null,
  isEqual: (left: Snapshot, right: Snapshot) => boolean = Object.is,
): Snapshot {
  const selector = useCallback(
    (live: Snapshot) => frozenSnapshot || live,
    [frozenSnapshot],
  );
  return useDesktopSnapshotSelector(store, selector, isEqual);
}

type LiveConversationProps = Omit<React.ComponentProps<typeof Conversation>, "snapshot" | "routeSnapshot"> & {
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
};

const LiveConversation = memo(function LiveConversation({
  snapshotStore,
  frozenSnapshot,
  hidden,
  ...props
}: LiveConversationProps) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    frozenSnapshot,
    desktopConversationSnapshotsEqual,
  );
  const visibleSnapshot = hidden ? EMPTY_SNAPSHOT : selectedSnapshot;
  return <Conversation snapshot={visibleSnapshot} routeSnapshot={selectedSnapshot} {...props} />;
});

function SnapshotHeaderStatus({
  snapshotStore,
  frozenSnapshot,
  hidden,
  onOpen,
}: {
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
  onOpen(): void;
}) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    frozenSnapshot,
    desktopHeaderSnapshotsEqual,
  );
  const visibleSnapshot = hidden ? EMPTY_SNAPSHOT : selectedSnapshot;
  return <>
    <LiveWorkStatus snapshot={visibleSnapshot} />
    <ContextUsageIndicator snapshot={visibleSnapshot} onOpen={onOpen} />
  </>;
}

function SnapshotUtilityDock({
  snapshotStore,
  frozenSnapshot,
  hidden,
  ...props
}: Omit<React.ComponentProps<typeof UtilityDock>, "snapshot"> & {
  snapshotStore: DesktopSnapshotStore;
  frozenSnapshot: Snapshot | null;
  hidden: boolean;
}) {
  const selectedSnapshot = useSelectedDesktopSnapshot(
    snapshotStore,
    frozenSnapshot,
    desktopDockSnapshotsEqual,
  );
  return <UtilityDock {...props} snapshot={hidden ? EMPTY_SNAPSHOT : selectedSnapshot} />;
}

function useDesktopState() {
  const snapshotStoreRef = useRef<DesktopSnapshotStore | null>(null);
  snapshotStoreRef.current ||= createDesktopSnapshotStore();
  const snapshotStore = snapshotStoreRef.current;
  const snapshotRef = useRef<Snapshot>(EMPTY_SNAPSHOT);
  const [connected, setConnected] = useState(Boolean(window.mixdogDesktop));
  const [error, setError] = useState("");
  const failureModel = useRef<TurnFailureModel>({
    scope: "",
    failedTurnKeys: [],
    activeToastTurns: {},
    turnKeys: [],
  });
  const failureInput = useRef<{ items: TranscriptItem[] | undefined; scope: string } | null>(null);
  const applySnapshot = useCallback((next: EngineSnapshot | null) => {
    const state = next && typeof next === "object" ? next as Snapshot : EMPTY_SNAPSHOT;
    const scope = `${String(state.currentProject || state.project || state.cwd || "")}\n${String(state.sessionId || "")}`;
    const previousInput = failureInput.current;
    if (!previousInput || previousInput.items !== state.items || previousInput.scope !== scope) {
      failureModel.current = reconcileTurnFailures(
        failureModel.current,
        state.items,
        state.toasts,
        scope,
      );
      failureInput.current = { items: state.items, scope };
    }
    const decorated = {
      ...state,
      failedTurnKeys: failureModel.current.failedTurnKeys,
      transcriptTurnKeys: failureModel.current.turnKeys,
    };
    snapshotRef.current = decorated;
    snapshotStore.publish(decorated);
  }, [snapshotStore]);

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

  return { snapshotStore, snapshotRef, connected, error, setError, applySnapshot };
}

export function App() {
  const { snapshotStore, snapshotRef, connected, error, setError, applySnapshot } = useDesktopState();
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
  // Layout persists across launches (user decision); a FRESH install opens
  // with the sidebar visible and the dock closed.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      // Phone-width sessions (remote bridge in a mobile browser) start with
      // the drawer closed so the conversation is the first thing on screen.
      if (window.matchMedia?.("(max-width: 760px)").matches) return false;
      return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
    }
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
  // Dock enter/exit animation (mirrors the left sidebar's 180ms slide): keep
  // the panel mounted briefly after close so the width transition can play.
  const [dockRender, setDockRender] = useState<boolean>(() => readDockState().open);
  useEffect(() => {
    if (dockOpen) { setDockRender(true); return undefined; }
    const timer = window.setTimeout(() => setDockRender(false), 200);
    return () => window.clearTimeout(timer);
  }, [dockOpen]);
  // Review takes over the MAIN area:
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
    setWebhooksOpen(false);
  }, []);
  // Inbound-webhooks page: same main-pane takeover concept as Schedules
  // (user decision — moved out of the settings dialog).
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [webhooksMounted, setWebhooksMounted] = useState(false);
  const openWebhooks = useCallback(() => {
    setWebhooksMounted(true);
    setWebhooksOpen(true);
    setSchedulesOpen(false);
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
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  useEffect(() => {
    if (updaterState.status !== "ready") setUpdateDialogOpen(false);
  }, [updaterState.status]);
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>([]);
  // Recent-list unread dots: session ids whose stored updatedAt advanced while
  // the session was not the viewed selection (Claude-style activity marker).
  const [unreadSessionIds, setUnreadSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [selection, setSelection] = useState<NavigationSelection>({ kind: "new" });
  useEffect(() => {
    setReviewOpen(false);
    setSchedulesOpen(false);
    setWebhooksOpen(false);
  }, [selection]);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { key: "new:default", title: "New task", selection: { kind: "new" } },
  ]);
  const [headerTitleEditingSessionId, setHeaderTitleEditingSessionId] = useState("");
  const [headerTitleDraft, setHeaderTitleDraft] = useState("");
  const [headerTitleInvalid, setHeaderTitleInvalid] = useState(false);
  const [newTaskActive, setNewTaskActive] = useState(false);
  const [switchingSessionId, setSwitchingSessionId] = useState("");
  const transitionSessionId = switchingSessionId;
  // Latest session clicked while another switch was still in flight.
  const pendingResumeTarget = useRef("");
  const activeResumeTarget = useRef("");
  // Set when the ACTIVE tab is being closed: the outgoing snapshot belongs to
  // a closed session and must not be frozen into the next tab's transition.
  const discardOutgoingSnapshot = useRef(false);
  const resumeSessionRef = useRef<(sessionId: string, force?: boolean) => void>(() => {});
  // Monotonic navigation stamp: an async switch completion may only activate
  // its target while no NEWER navigation happened in flight (user: + during a
  // settling session switch resurrected the old transcript in the new draft).
  const navigationEpoch = useRef(0);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const frozenSessionSnapshot = useRef<Snapshot | null>(null);
  const sessionSnapshotCache = useRef(new Map<string, Snapshot>());
  const rememberSessionSnapshot = useCallback((next: EngineSnapshot | Snapshot | null | undefined) => {
    const value = next && typeof next === "object" ? next as Snapshot : null;
    if (!value) return;
    const sessionId = String(value?.sessionId || "");
    if (!sessionId) return;
    const cache = sessionSnapshotCache.current;
    cache.delete(sessionId);
    cache.set(sessionId, value);
    while (cache.size > SESSION_SNAPSHOT_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }, []);
  const cachedSessionSnapshot = useCallback((sessionId: string): Snapshot | null => {
    const cache = sessionSnapshotCache.current;
    const cached = cache.get(sessionId) || null;
    if (cached) {
      cache.delete(sessionId);
      cache.set(sessionId, cached);
    }
    return cached;
  }, []);
  useEffect(() => {
    const rememberCurrent = () => rememberSessionSnapshot(snapshotStore.getSnapshot());
    rememberCurrent();
    return snapshotStore.subscribe(rememberCurrent);
  }, [rememberSessionSnapshot, snapshotStore]);
  const newTaskReady = useRef(false);
  const newTaskSetup = useRef<{
    key: string;
    promise: Promise<EngineSnapshot>;
  } | null>(null);
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
  useEffect(() => {
    // Warm only the renderer chunk. Hydrating capability/model/memory data in
    // the background occupied EngineHost.exclusive for seconds and made a
    // foreground session click wait behind settings work.
    return schedulePostInteractionIdle(() => {
      void loadSettingsViewModule().catch(() => {});
    });
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

  // Android hardware back (dispatched by remote-shim in the native shell):
  // close the topmost mobile layer; unconsumed events minimize the app.
  useEffect(() => {
    const onHardwareBack = (event: Event) => {
      if (sidebarOpen && window.innerWidth <= 760) {
        setSidebarOpen(false);
        event.preventDefault();
        return;
      }
      if (dockOpen) {
        setDockOpen(false);
        event.preventDefault();
      }
    };
    window.addEventListener("mixdog:hardware-back", onHardwareBack);
    return () => window.removeEventListener("mixdog:hardware-back", onHardwareBack);
  }, [dockOpen, sidebarOpen]);

  // Mobile WEB: Chrome's back / left-edge swipe navigated the SPA away and
  // reloaded it (user: opening the drawer "showed a refresh"). A sentinel
  // history entry absorbs the gesture and routes it through the same
  // hardware-back path, so it closes the topmost layer instead.
  useEffect(() => {
    if (!document.documentElement.dataset.mixdogMobile) return;
    // The native shell owns hardware back via the Capacitor App plugin.
    if ((window as unknown as { Capacitor?: unknown }).Capacitor) return;
    try { window.history.pushState({ mixdogShell: true }, ""); } catch { return; }
    const onPopState = () => {
      try { window.history.pushState({ mixdogShell: true }, ""); } catch { /* keep the app alive regardless */ }
      window.dispatchEvent(new CustomEvent("mixdog:hardware-back", { cancelable: true }));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
  const sessionLastSeen = useRef<Map<string, number> | null>(null);
  // The session currently on screen (selection or in-flight switch target):
  // reconcile must never dot it, and selectionRef lags behind a switch.
  const viewedSessionRef = useRef("");
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
  const loadSessionLastSeen = useCallback(() => {
    if (sessionLastSeen.current) return sessionLastSeen.current;
    const map = new Map<string, number>();
    try {
      // v2: values are SEEN MESSAGE COUNTS (not timestamps) — the legacy
      // timestamp key is dropped so old values cannot masquerade as counts.
      window.localStorage.removeItem("mixdog.desktop.session-last-seen");
      const raw = window.localStorage.getItem("mixdog.desktop.session-seen-counts");
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      for (const [id, at] of Object.entries(parsed || {})) {
        // Sanitize poisoned v2 rows: a timestamp mistakenly stored as a seen
        // COUNT (~1.7e12) suppresses unread dots forever. Counts are small;
        // anything absurd is dropped and re-baselined on next sight.
        const value = Number(at);
        if (Number.isFinite(value) && value >= 0 && value < 1e7) map.set(id, value);
      }
    } catch {
      // Unread markers degrade to in-memory tracking without persistent storage.
    }
    sessionLastSeen.current = map;
    return map;
  }, []);
  const persistSessionLastSeen = useCallback((map: Map<string, number>) => {
    try {
      window.localStorage.setItem(
        "mixdog.desktop.session-seen-counts",
        JSON.stringify(Object.fromEntries(map)),
      );
    } catch {
      // Unread markers degrade to in-memory tracking without persistent storage.
    }
  }, []);
  const reconcileUnreadSessions = useCallback((rows: DesktopSessionSummary[]) => {
    const seen = loadSessionLastSeen();
    const activeId = viewedSessionRef.current;
    const liveIds = new Set(rows.map((row) => row.id));
    let dirty = false;
    for (const id of [...seen.keys()]) {
      if (liveIds.has(id)) continue;
      seen.delete(id);
      dirty = true;
    }
    const unread = new Set<string>();
    for (const row of rows) {
      const count = Math.max(0, Number(row.messageCount) || 0);
      const last = seen.get(row.id);
      // First sighting (own new tasks included) and the viewed session are
      // read by definition. Only MESSAGE GROWTH earns the dot afterwards —
      // housekeeping saves (resume/switch/turn bookkeeping) bump updatedAt
      // without new messages and must never re-dot a checked session.
      // "Viewed" means the window is actually on screen (visibilityState
      // tracks native occlusion): an unfocused-but-visible desktop rendering
      // the live transcript beside the terminal IS being watched — dotting it
      // read as noise (user report). Only growth that lands while the window
      // is hidden/occluded earns the dot.
      const engaged = document.visibilityState === "visible";
      if (last === undefined || (row.id === activeId && engaged)) {
        if (last !== count) {
          seen.set(row.id, count);
          dirty = true;
        }
        continue;
      }
      if (count > last) unread.add(row.id);
    }
    if (dirty) persistSessionLastSeen(seen);
    setUnreadSessionIds((current) => {
      if (current.size === unread.size && [...unread].every((id) => current.has(id))) {
        return current;
      }
      return unread;
    });
  }, [loadSessionLastSeen, persistSessionLastSeen]);
  const projectSessionRows = useCallback((next: DesktopSessionSummary[] | null | undefined) => {
    return (Array.isArray(next) ? next : [])
      .filter((session) => !pendingSessionDeletes.current.has(session.id))
      .map((session) => {
        const pending = pendingSessionRenames.current.get(session.id);
        return pending ? { ...session, title: pending.title } : session;
      });
  }, []);
  const refreshSessions = useCallback(async () => {
    const host = window.mixdogDesktop;
    if (!host?.listSessions) return [];
    const version = ++sessionRefreshVersion.current;
    const next = await host.listSessions();
    const rows = projectSessionRows(next);
    if (version === sessionRefreshVersion.current) {
      setSessions(rows);
      reconcileUnreadSessions(rows);
    }
    return rows;
  }, [projectSessionRows, reconcileUnreadSessions]);
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
  // Background sessions (channel/schedule runs) only surface through the
  // cached session catalog. The push subscription below is the primary
  // freshness path; this poll is a safety net (fast only when push is
  // unavailable, e.g. the remote browser shim).
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void refreshSessions().catch(() => undefined);
    };
    const pushCapable = typeof window.mixdogDesktop?.subscribeSessions === "function";
    const timer = window.setInterval(refresh, pushCapable ? 60_000 : 15_000);
    document.addEventListener("visibilitychange", refresh);
    // Schedule surfaces (Run now / save) announce new background sessions
    // immediately instead of waiting out the poll interval.
    window.addEventListener("mixdog:sessions-refresh", refresh as EventListener);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("mixdog:sessions-refresh", refresh as EventListener);
    };
  }, [refreshSessions]);
  // Instant sidebar: main watches the on-disk session store and pushes fresh
  // catalogs (~0.5s debounce), so activity from any mixdog process lands here
  // without waiting for a poll tick or an extra list round-trip.
  // NOTE: the old renderer-driven attached re-resume loop is gone. The engine
  // now owns viewer sync (live-share pipe when up, store-mtime re-resume when
  // down, owner-gone promotion). Re-resuming from HERE on every store push
  // swapped the transcript to the DISK state (in-flight turn missing) and the
  // pipe frame swapped it back — a ~2s tall/short oscillation the user saw as
  // violent up-down shaking when entering a session mid-turn.
  useEffect(() => {
    const host = window.mixdogDesktop;
    if (typeof host?.subscribeSessions !== "function") return;
    return host.subscribeSessions((next) => {
      sessionRefreshVersion.current += 1; // in-flight polls must not overwrite
      const rows = projectSessionRows(next);
      setSessions(rows);
      reconcileUnreadSessions(rows);
    });
  }, [projectSessionRows, reconcileUnreadSessions]);
  const refreshSessionsBestEffort = useCallback((
    selectCurrent = false,
  ) => {
    void refreshSessions().then((rows) => {
      if (!selectCurrent) return;
      const current = rows.find((session) => session.currentSession);
      // A draft tab that just materialized its session PROMOTES in place
      // (promote-in-place): the session tab replaces the draft tab at the
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
      navigationEpoch.current += 1;
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
    navigationEpoch.current += 1;
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
    navigationEpoch.current += 1;
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
    navigationEpoch.current += 1;
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
  // Archive: hide from Recent without touching the on-disk file.
  // Optimistic flip moves the row immediately; the sessions push reconciles.
  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    setError("");
    try {
      await window.mixdogDesktop.setSessionArchived?.(sessionId, archived);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
    setSessions((current) => current.map((session) => session.id === sessionId
      ? { ...session, archived }
      : session));
  }, [setError]);
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
      navigationEpoch.current += 1;
      activateSelection({ kind: "new" }, "New task");
      newTaskReady.current = true;
      setNewTaskActive(true);
      setSwitchingSessionId("");
      activeResumeTarget.current = "";
      frozenSessionSnapshot.current = null;
      pendingResumeTarget.current = "";
      sessionSnapshotCache.current.delete(sessionId);
    }
    try {
      await refreshSessions();
    } catch {
      // The successful deletion remains authoritative if reconciliation is unavailable.
    } finally {
      pendingSessionDeletes.current.delete(sessionId);
    }
  }, [activateSelection, applySnapshot, refreshSessions, selection, sessions, setError, snapshot.sessionId]);
  const drainPendingResume = (completedSessionId: string) => {
    const pending = pendingResumeTarget.current;
    pendingResumeTarget.current = "";
    if (pending && pending !== completedSessionId) {
      window.setTimeout(() => resumeSessionRef.current(pending, true), 0);
    }
  };
  const startTask = (draft?: NavigationSelection) => {
    closeSidebarForNavigation();
    navigationEpoch.current += 1;
    const nextSelection = draft?.kind === "new" ? draft : newDraftSelection();
    const nextKey = navigationKey(nextSelection);
    // A blank task is a renderer draft until the first submit. Show its tab,
    // welcome surface, and composer immediately while the cold engine/context
    // setup continues in the background.
    activateSelection(nextSelection, "New task");
    newTaskReady.current = false;
    setNewTaskActive(false);
    setComposerFocusRequest((value) => value + 1);
    const lastProject = String(snapshot.currentProject || snapshot.project ||
      (Array.isArray(snapshot.recentProjects) ? snapshot.recentProjects[0] : "") || "");
    const setupPromise = (async (): Promise<EngineSnapshot> => (
      lastProject
        ? window.mixdogDesktop.startProjectTask(lastProject)
        : window.mixdogDesktop.startTask()
    ))();
    const pendingSetup = { key: nextKey, promise: setupPromise };
    newTaskSetup.current = pendingSetup;
    void invoke(async () => {
      try {
        const next = await setupPromise;
        if (newTaskSetup.current !== pendingSetup ||
          navigationKey(selectionRef.current) !== nextKey) return;
        // Defense-in-depth (measured bug class): a task setup must NEVER
        // paint a snapshot that still carries the OUTGOING session's
        // transcript (attached engines settle late). Blank the draft instead;
        // the settled state event that follows supersedes it.
        const nextRecord = asRecord(next);
        const staleSetup = Array.isArray(nextRecord?.items)
          && (nextRecord?.items as unknown[]).length > 0
          && Boolean(nextRecord?.sessionId);
        applySnapshot(staleSetup ? null : next);
        newTaskReady.current = true;
        setNewTaskActive(true);
        refreshSessionsBestEffort();
      } catch (reason) {
        if (navigationKey(selectionRef.current) === nextKey) await synchronizeActualHost();
        throw reason;
      } finally {
        if (newTaskSetup.current === pendingSetup) newTaskSetup.current = null;
      }
    });
  };
  const resumeSession = (sessionId: string, force = false) => {
    const inFlight = activeResumeTarget.current;
    if (inFlight) {
      // Last target wins. A cached target is painted immediately while the
      // unavoidable in-flight host transition finishes in the background.
      if (sessionId !== inFlight) {
        pendingResumeTarget.current = sessionId;
        frozenSessionSnapshot.current = cachedSessionSnapshot(sessionId)
          || frozenSessionSnapshot.current;
        setSwitchingSessionId(sessionId);
      }
      return;
    }
    if (!force && selection.kind === "session" && selection.id === sessionId
      && String(snapshot.sessionId || "") === sessionId) return;
    const epoch = ++navigationEpoch.current;
    // Start the shared Markdown chunk before the cached target is mounted.
    // The transcript reveal below waits for this promise or a short deadline.
    void preloadMarkdownBody().catch(() => {});
    closeSidebarForNavigation();
    const switchStartedAt = performance.now();
    const session = sessions.find((item) => item.id === sessionId);
    // Uncached target: freezing the OUTGOING snapshot keeps the old
    // transcript up during a normal tab click, but after closing the active
    // tab that outgoing content belongs to a CLOSED session — it must never
    // flash inside the next tab (user report). Blank transition instead.
    frozenSessionSnapshot.current = cachedSessionSnapshot(sessionId)
      || (selection.kind === "new" && !newTaskActive ? EMPTY_SNAPSHOT
        : discardOutgoingSnapshot.current ? EMPTY_SNAPSHOT : snapshot);
    discardOutgoingSnapshot.current = false;
    activeResumeTarget.current = sessionId;
    setSwitchingSessionId(sessionId);
    const timingStart = `mixdog:session-switch:${sessionId}:start`;
    if (import.meta.env?.DEV) performance.mark(timingStart);
    void invoke(async () => {
      try {
        const response = await window.mixdogDesktop?.resumeSession(sessionId);
        const resumedSessionId = String(asRecord(response)?.sessionId || "");
        const resumedForkedFrom = String(asRecord(response)?.sessionForkedFrom || "");
        // A fork-on-resume (live session opened as a copy) legitimately comes
        // back under a fresh id whose sessionForkedFrom names the clicked row.
        if (resumedSessionId && resumedSessionId !== sessionId && resumedForkedFrom !== sessionId) {
          throw new Error("Session switch returned an unexpected session.");
        }
        const effectiveSessionId = resumedSessionId || sessionId;
        let next: EngineSnapshot | Snapshot | null | undefined = response;
        if (!Array.isArray(asRecord(next)?.items)) {
          const published = snapshotRef.current;
          if (String(published.sessionId || "") === effectiveSessionId) {
            next = published;
          } else {
            // Remote/older hosts may acknowledge before their state event.
            // Normal local resumes never take this fallback.
            const fallback = await window.mixdogDesktop?.getSnapshot();
            if (String(asRecord(fallback)?.sessionId || "") === effectiveSessionId) next = fallback;
          }
        }
        const resumedTitle = session
          ? sessionSummaryTitle(session)
          : String(asRecord(response)?.desktopSessionTitle || asRecord(next)?.desktopSessionTitle || "").trim()
            || "Untitled session";
        rememberSessionSnapshot(next);
        const superseded = Boolean(
          pendingResumeTarget.current && pendingResumeTarget.current !== effectiveSessionId,
        ) || navigationEpoch.current !== epoch;
        if (!superseded) {
          frozenSessionSnapshot.current = null;
          // resumeSession publishes the same state before its IPC result
          // resolves. Do not apply that long transcript twice; remote shims
          // without a state publication still fall back to the returned value.
          if (String(snapshotRef.current.sessionId || "") !== effectiveSessionId) {
            applySnapshot(next as EngineSnapshot);
          }
          activateSelection({ kind: "session", id: effectiveSessionId }, resumedTitle);
          setSessions((current) => {
            let changed = false;
            const updated = current.map((item) => {
              const currentSession = item.id === effectiveSessionId;
              if (item.currentSession === currentSession) return item;
              changed = true;
              return { ...item, currentSession };
            });
            return changed ? updated : current;
          });
          setNewTaskActive(false);
          if (resumedSessionId && resumedSessionId !== sessionId) refreshSessionsBestEffort();
        }
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
        if (!pendingResumeTarget.current
          && navigationEpoch.current === epoch) await synchronizeActualHost();
        throw reason;
      } finally {
        activeResumeTarget.current = "";
        const pending = pendingResumeTarget.current;
        if (pending && pending !== sessionId) {
          frozenSessionSnapshot.current = cachedSessionSnapshot(pending)
            || frozenSessionSnapshot.current;
          setSwitchingSessionId(pending);
        } else {
          frozenSessionSnapshot.current = null;
          setSwitchingSessionId("");
        }
        drainPendingResume(sessionId);
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          window.mixdogDesktop?.perfLog?.(
            `session-switch-render id=${sessionId} paint=${(performance.now() - switchStartedAt).toFixed(0)}ms`,
          );
        }));
      }
    });
  };
  resumeSessionRef.current = resumeSession;
  const prefetchSession = useCallback((sessionId: string) => (
    window.mixdogDesktop?.prefetchSession?.(sessionId) ?? Promise.resolve(false)
  ), []);
  const openSettings = useCallback((section: SettingsSection | null = null) => {
    // Perf diagnostics: SettingsView's mount effect reports the request→paint
    // delta through the perf-log channel (no-op unless MIXDOG_DESKTOP_PERF=1).
    (window as unknown as Record<string, unknown>).__mixdogSettingsOpenAt = performance.now();
    setCommandSurface(null);
    setSettingsSection(section);
    setSettingsMounted(true);
    setSettingsOpen(true);
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
      const activeKey = navigationKey(selectionRef.current);
      const pendingSetup = newTaskSetup.current?.key === activeKey
        ? newTaskSetup.current.promise
        : null;
      const started = pendingSetup ? await pendingSetup : await host.startTask();
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
          navigationEpoch.current += 1;
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
  const navigationSelection: NavigationSelection = transitionSessionId
    ? { kind: "session", id: transitionSessionId }
    : selection;
  const selectedSession = navigationSelection.kind === "session"
    ? sessions.find((session) => session.id === navigationSelection.id)
    : undefined;
  const currentSessionTitle = selectedSession ? sessionSummaryTitle(selectedSession) : "";
  const workingSessionIds = useMemo(() => {
    const activeSessionId = String(sidebarSnapshot.sessionId || "");
    return workingSessionIdsForSnapshot(sessions, activeSessionId, activeBusy);
  }, [activeBusy, sessions, sidebarSnapshot.sessionId]);
  // Viewing a session consumes its unread marker.
  const viewedSessionId = navigationSelection.kind === "session" ? navigationSelection.id : "";
  useEffect(() => {
    if (!viewedSessionId) return;
    // Consuming the unread marker requires the window to be on screen — a
    // selected session in a hidden/occluded window keeps its dot until the
    // window is revealed (visibilitychange re-runs this via focusTick).
    // Focus is deliberately NOT required: a visible desktop mirroring a
    // terminal-owned turn counts as being watched (user report).
    if (document.visibilityState !== "visible") return;
    const seen = loadSessionLastSeen();
    const row = sessions.find((session) => session.id === viewedSessionId);
    // Seen map holds MESSAGE COUNTS (v2): viewing consumes growth by
    // recording the current count — never updatedAt, whose epoch value would
    // permanently outrank any future count and kill the dot for this session.
    const count = Math.max(Number(row?.messageCount) || 0, seen.get(viewedSessionId) || 0);
    if (count > 0 && seen.get(viewedSessionId) !== count) {
      seen.set(viewedSessionId, count);
      persistSessionLastSeen(seen);
    }
    setUnreadSessionIds((current) => {
      if (!current.has(viewedSessionId)) return current;
      const next = new Set(current);
      next.delete(viewedSessionId);
      return next;
    });
  }, [loadSessionLastSeen, persistSessionLastSeen, sessions, viewedSessionId, windowFocusTick]);
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
  const frozenSnapshot = switchingSessionId && frozenSessionSnapshot.current
    ? frozenSessionSnapshot.current
    : null;
  const hideLiveSnapshot = selection.kind === "new" && !newTaskActive;
  const navigateTab = (tab: WorkspaceTab) => {
    if (tab.key === activeTabKey) {
      // Re-selecting the current tab while the Schedules pane owns the main
      // area returns to the workspace (the tab reads as unselected then).
      setSchedulesOpen(false);
      setWebhooksOpen(false);
      return;
    }
    if (tab.selection.kind === "new") startTask(tab.selection);
    else if (tab.selection.kind === "project") startProject(tab.selection.path);
    else resumeSession(tab.selection.id);
  };
  const closeTab = (tab: WorkspaceTab) => {
    const index = tabs.findIndex((item) => item.key === tab.key);
    const nextTabs = tabs.filter((item) => item.key !== tab.key);
    setTabs(nextTabs);
    if (tab.key !== activeTabKey) return;
    discardOutgoingSnapshot.current = true;
    const fallback = nextTabs[Math.min(index, nextTabs.length - 1)];
    if (fallback) navigateTab(fallback);
    else startTask();
    discardOutgoingSnapshot.current = false;
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
  // Global workspace shortcuts (user-tuned):
  // mod+N new task · ctrl+Tab / mod+←→ cycle tabs (everywhere — user chose
  // tab switching over composer word-jump; shift+mod+←→ keeps word
  // selection) · mod+, settings · mod+B sidebar toggle.
  const shortcutActionsRef = useRef({
    tabs,
    activeTabKey,
    navigateTab,
    startTask,
    openSettings,
    closeTab,
  });
  shortcutActionsRef.current = {
    tabs,
    activeTabKey,
    navigateTab,
    startTask,
    openSettings,
    closeTab,
  };
  useEffect(() => {
    const cycleTab = (offset: number) => {
      const { tabs, activeTabKey, navigateTab } = shortcutActionsRef.current;
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
        shortcutActionsRef.current.startTask();
        return;
      }
      if (key === "," && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        shortcutActionsRef.current.openSettings();
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
        const { tabs, activeTabKey, closeTab } = shortcutActionsRef.current;
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
  }, []);

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <DesktopTitlebar
        sidebarOpen={sidebarOpen}
        tabs={tabs}
        // Schedules takes over the main pane: no workspace tab is the visible
        // surface, so none may render as selected (user request).
        activeKey={schedulesOpen || webhooksOpen ? "" : activeTabKey}
        activeBusy={activeBusy}
        workingSessionIds={workingSessionIds}
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
          workingSessionIds={workingSessionIds}
          unreadSessionIds={unreadSessionIds}
          // Schedules takeover: the sidebar must not keep a session row
          // highlighted while the main pane shows Schedules (matches the tab
          // strip deselection).
          selection={schedulesOpen || webhooksOpen ? { kind: "new" } : navigationSelection}
          // Primary-nav selection mirror (user request): the button for the
          // surface that owns the screen reads as selected — New task stays a
          // plain action.
          activeSurface={settingsOpen ? "settings"
            : schedulesOpen ? "schedules"
            : webhooksOpen ? "webhooks"
            : projectPanelOpen ? "projects"
            : null}
          // Re-selecting the CURRENT session/new-task while Schedules or
          // Webhooks owns the main pane leaves `selection` unchanged, so the
          // close-on-selection effect never fires — close the takeover panes
          // here explicitly (user report: list click appeared dead).
          onNewTask={(draft?: NavigationSelection) => {
            closeSidebarForNavigation();
            setSchedulesOpen(false);
            setWebhooksOpen(false);
            startTask(draft);
          }}
          onOpenProjects={() => { closeSidebarForNavigation(); setProjectPanelOpen(true); }}
          onOpenSchedules={() => { closeSidebarForNavigation(); openSchedules(); }}
          onOpenWebhooks={() => { closeSidebarForNavigation(); openWebhooks(); }}
          onOpenSettings={() => { closeSidebarForNavigation(); openSettings(); }}
          onPrefetchSession={window.mixdogDesktop?.prefetchSession ? prefetchSession : undefined}
          onResumeSession={(sessionId: string) => {
            closeSidebarForNavigation();
            setSchedulesOpen(false);
            setWebhooksOpen(false);
            resumeSession(sessionId);
          }}
          onRenameSession={renameSession}
          onArchiveSession={archiveSession}
          onDeleteSession={deleteSession}
        />
        {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)}
          aria-label="Close session sidebar" />}
        <main className="main-panel">
          {schedulesMounted && <SchedulesPane active={schedulesOpen} />}
          {webhooksMounted && <WebhooksPane active={webhooksOpen} />}
          <div className={`workspace ${transitionSessionId ? "switching-session" : ""}`
            + (schedulesOpen || webhooksOpen ? " schedules-open" : "")}>
            <header className="session-header" aria-label="Current task">
              <div className="session-header-content">
                <button type="button" className="toolbar-sidebar session-header-menu"
                  aria-label="Toggle session list" aria-expanded={sidebarOpen}
                  onClick={() => setSidebarOpen((open) => !open)}>
                  <PanelLeft className="sidebar-toggle-icon" size={18} aria-hidden="true" />
                </button>
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
                      const actionSnapshot = frozenSnapshot || snapshotRef.current;
                      const seed = ((actionSnapshot.items || []) as TranscriptItem[]).find((entry) =>
                        entry?.kind === "user" && String(entry.text || "").trim());
                      if (seed) void renameSession(selectedSession.id, promptTitle(String(seed.text || "")));
                    }}>
                    <RotateCcw size={13} />
                  </button>
                )}
                <div className="session-header-status">
                  <SnapshotHeaderStatus snapshotStore={snapshotStore}
                    frozenSnapshot={frozenSnapshot} hidden={hideLiveSnapshot}
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
              : <LiveConversation snapshotStore={snapshotStore}
              frozenSnapshot={frozenSnapshot} hidden={hideLiveSnapshot}
              invoke={invoke} invokeResult={invokeResult}
              errors={errors} submit={submit} applySnapshot={applySnapshot}
              transitioning={Boolean(transitionSessionId)}
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
                if (surface === "webhooks") {
                  openWebhooks();
                  return;
                }
                setCommandSurface(surface);
              }} />}
          </div>
        </main>
        {/* Phone: the dock floats over the thread, so give it the same
            outside-tap dismiss scrim as the left drawer (CSS shows it only
            on narrow viewports). */}
        {dockOpen && <button className="dock-backdrop" onClick={() => setDockOpen(false)}
          aria-label="Close utility panel" />}
        {dockRender && <SnapshotUtilityDock snapshotStore={snapshotStore}
          frozenSnapshot={frozenSnapshot} hidden={hideLiveSnapshot}
          open={dockOpen} width={dockWidth} tab={dockTab}
          onTab={setDockTab} onResize={(value) => setDockWidth(clampDockWidth(value))}
        />}
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
            } else if (surface === "webhooks") {
              setCommandSurface(null);
              openWebhooks();
            } else setCommandSurface(surface);
          }} onClose={() => setCommandSurface(null)} />}
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
  );
}

export { ApprovalCard } from "./ApprovalCard";
export { ContextUsageIndicator, LiveWorkStatus, TranscriptRow } from "./TranscriptView";
export { lastVisibleTranscriptItemIndex } from "./transcript-metrics";
export { DesktopUpdateDialog } from "./notifications";
