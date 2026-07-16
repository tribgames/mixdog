import React, {
  Component,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  Command,
  Copy,
  FileDiff,
  FileText,
  Layers3,
  LoaderCircle,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { createPortal } from "react-dom";
import type {
  DesktopCapability,
  DesktopModelOption,
  DesktopModelSelection,
  DesktopPromptAttachment,
  DesktopPromptContent,
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopSubmitOptions,
  EngineSnapshot,
} from "../shared/contract";
import {
  approvalInstanceKey,
  draftAfterSubmission,
  followAfterScroll,
  focusTrapIndex,
  isApprovalDismissKey,
  isScrollIntentKey,
  mergeModelCatalog,
  mergeTranscript,
  normalizeApplyPatch,
  parseUnifiedDiff,
  reconcileTurnFailures,
  shouldNavigatePromptHistory,
  transcriptTurnKeys,
} from "./renderer-logic.mjs";
import type { TurnFailureModel } from "./renderer-logic.mjs";
import { SettingsView } from "./settings/SettingsView";
import { OnboardingWizard } from "./settings/OnboardingWizard";
import {
  DesktopTitlebar,
  ProjectSwitcher,
  SessionSidebar,
  type NavigationSelection,
  type WorkspaceTab,
} from "./navigation";
import { applyDesktopTheme } from "./desktop-theme";
import { OpenSelect } from "./OpenSelect";
import {
  modelDisplayName,
  modelOptionDescription,
  normalizeModelOptions,
  ProviderIcon,
  providerDisplayName,
  providerDisplayRank,
} from "./provider-display";
import { TooltipLayer } from "./TooltipLayer";
import { CommandSurface } from "./CommandSurface";
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
  outputTokens?: number;
  errorCount?: number;
  callErrorCount?: number;
  exitErrorCount?: number;
};
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
};

const EMPTY_SNAPSHOT: Snapshot = { items: [], queued: [] };

function asRecord(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" ? value as RecordValue : null;
}

function displayProject(project: Project | null | undefined) {
  if (!project) return { name: "", path: "" };
  const chunks = project.replace(/[\\/]+$/, "").split(/[\\/]/);
  return { name: chunks.at(-1) || project, path: project };
}

function navigationKey(selection: NavigationSelection) {
  if (selection.kind === "new") return "new";
  if (selection.kind === "project") return `project:${selection.path}`;
  return `session:${selection.id}`;
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('profile');
  const [commandSurface, setCommandSurface] = useState<CommandSurfaceName | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [sessions, setSessions] = useState<DesktopSessionSummary[]>([]);
  const [projects, setProjects] = useState<DesktopProjectSummary[]>([]);
  const [selection, setSelection] = useState<NavigationSelection>({ kind: "new" });
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { key: "new", title: "New task", selection: { kind: "new" } },
  ]);
  const [newTaskActive, setNewTaskActive] = useState(false);
  const [switchingSessionId, setSwitchingSessionId] = useState("");
  const newTaskReady = useRef(false);
  const sessionRefresh = useRef({
    submitInFlight: false,
    accepted: false,
    sawBusy: false,
    sawSettlement: false,
  });
  const isBusy = Boolean(snapshot.busy || snapshot.commandBusy);

  useEffect(() => {
    let live = true;
    const readTheme = window.mixdogDesktop?.invokeCapability;
    if (!readTheme) {
      applyDesktopTheme('basic');
      return () => { live = false; };
    }
    void readTheme<string>({ capability: 'getTheme' })
      .then((result) => { if (live) applyDesktopTheme(result.value); })
      .catch(() => { if (live) applyDesktopTheme('basic'); });
    return () => { live = false; };
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
  const refreshSessions = useCallback(async () => {
    const host = window.mixdogDesktop;
    if (!host?.listSessions) return [];
    const next = await host.listSessions();
    const rows = Array.isArray(next) ? next : [];
    setSessions(rows);
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
      if (current) activateSelection(
        { kind: "session", id: current.id },
        sessionSummaryTitle(current),
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
      activateSelection(
        { kind: "session", id: actualSessionId },
        sessionSummaryTitle(actualSession),
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
  const openProjectInExplorer = (project: Project) =>
    invoke(() => window.mixdogDesktop.openProjectInExplorer(project));
  const renameProject = (project: Project, alias: string) =>
    invoke(async () => {
      await window.mixdogDesktop.renameProject(project, alias);
      await refreshProjects();
    });
  const setProjectPinned = (project: Project, pinned: boolean) =>
    invoke(async () => {
      await window.mixdogDesktop.setProjectPinned(project, pinned);
      await refreshProjects();
    });
  const removeProject = (project: Project) =>
    invoke(async () => {
      await window.mixdogDesktop.removeProject(project);
      await refreshProjects();
    });
  const startTask = () => {
    closeSidebarForNavigation();
    void invoke(async () => {
      try {
        const next = await window.mixdogDesktop?.startTask();
        applySnapshot(next);
        activateSelection({ kind: "new" }, "New task");
        newTaskReady.current = true;
        setNewTaskActive(true);
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
    const session = sessions.find((item) => item.id === sessionId);
    activateSelection({ kind: "session", id: sessionId }, sessionSummaryTitle(session));
    setSessions((current) => current.map((item) => ({
      ...item,
      currentSession: item.id === sessionId,
    })));
    setNewTaskActive(false);
    setSwitchingSessionId(sessionId);
    void invoke(async () => {
      try {
        const next = await window.mixdogDesktop?.resumeSession(sessionId);
        applySnapshot(next);
        const stableTitle = String(asRecord(next)?.desktopSessionTitle || '').trim();
        if (stableTitle) {
          setSessions((current) => current.map((item) => item.id === sessionId
            ? { ...item, title: stableTitle }
            : item));
          activateSelection({ kind: "session", id: sessionId }, stableTitle);
        }
      } catch (reason) {
        await synchronizeActualHost();
        throw reason;
      } finally {
        setSwitchingSessionId("");
      }
    });
  };
  const openSettings = useCallback((section: SettingsSection = 'profile') => {
    setCommandSurface(null);
    setSettingsSection(section);
    setSettingsOpen(true);
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
      if (selection.kind === "new" && startedSessionId) {
        const title = promptTitle(content, options?.displayText || "") || "New task";
        activateSelection({ kind: "session", id: startedSessionId }, title, "new");
        setNewTaskActive(false);
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
  const visibleSnapshot = selection.kind === "new" && !newTaskActive
    ? EMPTY_SNAPSHOT
    : snapshot;
  const selectedSession = selection.kind === "session"
    ? sessions.find((session) => session.id === selection.id)
    : undefined;
  const currentSessionTitle = selectedSession ? sessionSummaryTitle(selectedSession) : "";
  const activeTabKey = navigationKey(selection);
  const navigateTab = (tab: WorkspaceTab) => {
    if (tab.key === activeTabKey) return;
    if (tab.selection.kind === "new") startTask();
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

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <DesktopTitlebar
        sidebarOpen={sidebarOpen}
        tabs={tabs}
        activeKey={activeTabKey}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onSelectTab={navigateTab}
        onCloseTab={closeTab}
        onNewTask={startTask}
      />
      <div className="desktop-body">
        <SessionSidebar
          open={sidebarOpen}
          projects={projects}
          sessions={sessions}
          selection={selection}
          onNewTask={startTask}
          onChooseProject={chooseProject}
          onOpenProjects={() => setProjectPanelOpen(true)}
          onStartProjectTask={startProjectTask}
          onOpenSettings={() => openSettings('profile')}
          onResumeSession={resumeSession}
        />
        {sidebarOpen && <button className="sidebar-backdrop" onClick={() => setSidebarOpen(false)}
          aria-label="Close session sidebar" />}
        <main className="main-panel">
          <div className={`workspace ${switchingSessionId ? "switching-session" : ""}`}>
            <header className="session-header" aria-label="Current task">
              <div className="session-progress" aria-hidden="true">
                {isBusy && <span />}
              </div>
              <div className="session-header-content">
                {isBusy && <LoaderCircle className="spin session-spinner" size={14} aria-hidden="true" />}
                <h1 data-tooltip={currentSessionTitle || tabs.find((tab) => tab.key === activeTabKey)?.title || "New task"}>
                  {currentSessionTitle || tabs.find((tab) => tab.key === activeTabKey)?.title || "New task"}
                </h1>
              </div>
            </header>
            <Conversation snapshot={visibleSnapshot} routeSnapshot={snapshot} invoke={invoke} invokeResult={invokeResult}
              errors={errors} submit={submit} applySnapshot={applySnapshot}
              transitioning={Boolean(switchingSessionId)}
              onNewTask={startTask}
              onStartProject={startProject}
              onResumeSession={resumeSession}
              onOpenProjects={() => setProjectPanelOpen(true)}
              onOpenSessions={() => setSidebarOpen(true)}
              onOpenSettings={openSettings}
              onOpenCommandSurface={(surface) => {
                setSettingsOpen(false);
                setCommandSurface(surface);
              }} />
            {switchingSessionId && <div className="session-switch-overlay" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={16} /><span>Opening session…</span>
            </div>}
          </div>
        </main>
      </div>
      <ProjectSwitcher
        open={projectPanelOpen}
        projects={projects}
        selection={selection}
        onClose={closeProjectPanel}
        onChooseProject={chooseProject}
        onStartProject={startProject}
        onStartProjectTask={startProjectTask}
        onOpenExplorer={openProjectInExplorer}
        onRename={renameProject}
        onSetPinned={setProjectPinned}
        onRemove={removeProject}
      />
      {settingsOpen && <SettingsView
        initialSection={settingsSection as React.ComponentProps<typeof SettingsView>['initialSection']}
        onCompose={(text) => {
          setSettingsOpen(false);
          window.dispatchEvent(new CustomEvent('mixdog:composer-draft', { detail: text }));
        }}
        onClose={() => setSettingsOpen(false)} />}
      {commandSurface && <CommandSurface surface={commandSurface}
        onOpen={setCommandSurface} onClose={() => setCommandSurface(null)} />}
      {onboardingOpen && <OnboardingWizard api={window.mixdogDesktop} onDone={() => setOnboardingOpen(false)} />}
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
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const entries = [
    ...(bridgeError ? [{ key: `bridge:${bridgeError}`, text: bridgeError, tone: 'error', bridge: true }] : []),
    ...toasts.map((toast, index) => ({
      key: String(toast.id ?? `${toast.tone || 'info'}:${toast.text || toast.message || ''}:${index}`),
      text: String(toast.text || toast.message || '').trim(),
      tone: String(toast.tone || 'info').toLowerCase(),
      bridge: false,
    })),
  ].filter((entry) => entry.text && !dismissed.has(entry.key)).slice(-4);
  if (!entries.length) return null;
  return <section className="oc-toast-region" aria-label="Notifications" aria-live="polite">
    {entries.map((entry) => {
      const title = entry.tone === 'error' ? 'Something went wrong'
        : entry.tone === 'success' ? 'Completed'
          : entry.tone === 'warn' || entry.tone === 'warning' ? 'Attention' : 'Mixdog';
      return <article className="oc-toast" data-tone={entry.tone} key={entry.key} role="status">
        {entry.tone === 'error' ? <ShieldAlert size={16} />
          : entry.tone === 'success' ? <Check size={16} /> : <Sparkles size={16} />}
        <span className="oc-toast-copy"><b>{title}</b><span>{entry.text}</span></span>
        <button type="button" className="oc-toast-close" aria-label="Dismiss notification" onClick={() => {
          setDismissed((current) => new Set(current).add(entry.key));
          if (entry.bridge) onDismissBridgeError();
        }}><X size={16} /></button>
      </article>;
    })}
  </section>;
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
  onNewTask,
  onStartProject,
  onResumeSession,
  onOpenProjects,
  onOpenSessions,
  onOpenSettings,
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
  onNewTask: () => void;
  onStartProject: (path: string) => void;
  onResumeSession: (id: string) => void;
  onOpenProjects: () => void;
  onOpenSessions: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const programmaticScroll = useRef(false);
  const scrollTimer = useRef<number | undefined>(undefined);
  const scrollFrame = useRef<number | undefined>(undefined);
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
    (section?: SettingsSection) => composerActions.current.onOpenSettings(section),
    [],
  );
  const composerOnOpenCommandSurface = useCallback(
    (surface: CommandSurfaceName) => composerActions.current.onOpenCommandSurface(surface),
    [],
  );

  useLayoutEffect(() => {
    followOutput.current = true;
    setFollowing(true);
    const element = viewport.current;
    if (!element) return;
    programmaticScroll.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => { programmaticScroll.current = false; }, 80);
  }, [routeSnapshot.sessionId]);
  useEffect(() => {
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
      }} onWheel={() => { programmaticScroll.current = false; }}
        onPointerDown={() => { programmaticScroll.current = false; }}
        onTouchStart={() => { programmaticScroll.current = false; }}
        onKeyDown={(event) => {
          if (isScrollIntentKey(event.key)) programmaticScroll.current = false;
        }}>
        <div className="thread">
          {items.length === 0 && (
            <div className="thread-welcome">
              <span className="welcome-mark">M</span>
              <h1>What can Mixdog help you build?</h1>
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
          {items.map((item, index) => {
            const turnKey = turnKeys[index];
            const completion = item.kind === "statusdone" || item.kind === "turndone";
            if (failedTurns.has(turnKey) && completion) {
              if (index !== lastCompletionByTurn.get(turnKey)) return null;
              return <div className="turn-status failed" role="status"
                key={`failed-${turnKey}`}>
                <X size={13} />Failed
              </div>;
            }
            if (attachedCompletionIndexes.has(index)) return null;
            const row = <TranscriptRow item={item} completion={completionByAssistant.get(index)}
              key={`${String(routeSnapshot.sessionId || "new-task")}:${String(item.id ?? `${item.kind}-${index}`)}`} />;
            const pendingFailure = failedTurns.has(turnKey) &&
              !lastCompletionByTurn.has(turnKey) &&
              lastItemByTurn.get(turnKey) === index;
            if (!pendingFailure) return row;
            return <React.Fragment key={`pending-${turnKey}`}>
              {row}
              <div className="turn-status failed" role="status"><X size={13} />Failed</div>
            </React.Fragment>;
          })}
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
        <InlineErrors messages={errors} />
        <Composer key={String(routeSnapshot.sessionId || 'new-task')}
          turnBusy={Boolean(snapshot.busy)}
          commandBusy={Boolean(routeSnapshot.commandBusy)}
          transitioning={transitioning}
          promptHistoryList={routeSnapshot.promptHistoryList}
          provider={String(routeSnapshot.provider || "")}
          model={String(routeSnapshot.model || "")}
          effort={String(routeSnapshot.effort || "")}
          fast={Boolean(routeSnapshot.fast)}
          fastCapable={Boolean(routeSnapshot.fastCapable)}
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

function LiveActivity({ snapshot }: { snapshot: Snapshot }) {
  const spinner = snapshot.spinner && snapshot.spinner.active !== false ? snapshot.spinner : null;
  const command = snapshot.commandStatus && snapshot.commandStatus.active !== false ? snapshot.commandStatus : null;
  const activity = spinner || command;
  const [now, setNow] = useState(Date.now());
  const startedAt = Number(activity?.startedAt || 0);
  useEffect(() => {
    if (!activity || !startedAt) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activity, startedAt]);
  if (!activity && !snapshot.thinking) return null;
  const mode = String(activity?.mode || (snapshot.thinking ? "thinking" : "responding"));
  const canonicalVerb: Record<string, string> = {
    requesting: "Requesting",
    responding: "Responding",
    thinking: "Thinking",
    "tool-use": "Using tools",
    "tool-input": "Using tools",
    compacting: "Compacting conversation",
    resuming: "Resuming conversation",
    "auto-clear": "Auto-clearing conversation",
  };
  // Mirror Spinner's MODE_VERBS boundary: only those modes have a stable
  // canonical first phrase. Other modes carry engine-authored status detail.
  const verb = canonicalVerb[mode] || String(activity?.verb || "Working");
  const elapsed = startedAt ? formatElapsed(now - startedAt) : "";
  const outputTokens = Math.max(0, Number(activity?.outputTokens || activity?.tokens || 0));
  const reasoning = publicThinkingSummary(snapshot.thinking);
  return <div className="live-activity" data-mode={mode}>
    <div className="live-activity-status" role="status" aria-live="polite">
      <span>{verb}</span>
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
    {copied ? <Check size={13} /> : <Copy size={13} />}
  </button>;
}

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
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre({ children }) {
      const child = React.Children.count(children) === 1 ? React.Children.only(children) : null;
      if (!React.isValidElement(child)) return <pre>{children}</pre>;
      const props = child.props as { className?: string; children?: ReactNode };
      const language = props.className?.match(/language-([^\s]+)/)?.[1] || "";
      const code = String(props.children ?? "").replace(/\n$/, "");
      return <div className="markdown-code">
        <header><span>{language || "code"}</span>
          <CopyControl value={code} label="Copy code" className="markdown-code-copy" /></header>
        <pre><code className={props.className}>{code}</code></pre>
      </div>;
    },
  }}>{renderedText}</ReactMarkdown>
    {streaming && <span className="stream-cursor" />}
  </div>;
});

export function TranscriptRow({ item, completion }: { item: TranscriptItem; completion?: TranscriptItem }) {
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
  return (
    <>
      <article className={`message ${user ? "user" : "assistant"} ${item.streaming ? "streaming" : "settled"}`}
        aria-live={item.streaming || announceSettled ? "off" : undefined}>
        <div className="message-body">
          {user ? <p>{item.text}</p> : (
            <MarkdownResponse text={text} streaming={Boolean(item.streaming)} />
          )}
        </div>
        {user && !item.streaming && text && <CopyControl value={text} label="Copy message"
          className="message-actions user-copy" />}
        {!user && !item.streaming && (text || completion) && <footer className="response-footer"
          aria-label="Response details">
          {completion && <CompletionStatus item={completion} />}
          {text && <CopyControl value={text} label="Copy response"
            className="message-actions response-copy" />}
        </footer>}
      </article>
      {announceSettled && !completion && <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Mixdog response complete.
      </p>}
    </>
  );
}

function ToolCard({ item }: { item: TranscriptItem }) {
  const [open, setOpen] = useState(Boolean(item.expanded));
  const done = item.completedAt != null || (item.completedCount === undefined
    ? item.result != null || item.rawResult != null
    : item.completedCount >= (item.count || 1));
  const failedCount = Math.max(0, Number(item.errorCount || 0));
  const callFailedCount = Math.max(0, Number(item.callErrorCount || 0));
  const exitFailedCount = Math.max(0, Number(item.exitErrorCount || 0));
  const denied = isHookApprovalDenialToolItem(item);
  const failed = Boolean(item.isError || failedCount > 0 || callFailedCount > 0);
  const exited = !failed && exitFailedCount > 0;
  const stateLabel = denied ? "Denied" : failed ? "Failed" : exited ? "Exit" : done ? "Done" : "Running";
  const surface = formatToolSurface(item.name, item.args);
  const category = classifyToolCategory(item.name, surface.args);
  const activeCategories = asRecord(item.categories) || {};
  const doneCategories = asRecord(item.doneCategories);
  const categories = done && doneCategories && Object.keys(doneCategories).length ? doneCategories : activeCategories;
  const aggregateOrder = Array.isArray(asRecord(item.args)?.categoryOrder)
    ? asRecord(item.args)?.categoryOrder as string[] : undefined;
  const aggregateTitle = item.aggregate
    ? formatAggregateHeader(categories, { pending: !done, order: aggregateOrder }) : "";
  const title = aggregateTitle || (item.aggregate ? `${item.count || 1} tool operations` : surface.label);
  const argumentSummary = item.aggregate ? "" : surface.summary;
  const rawResult = item.result ?? item.rawResult;
  const resultText = typeof rawResult === "string" ? rawResult.trim() : "";
  const resultSummary = done && resultText
    ? oneLine(item.aggregate
      ? resultText
      : summarizeToolResult(item.name, surface.args, resultText, failed))
    : "";
  const patch = findPatch(item);
  const parsedArgs = asRecord(surface.args);
  const hasInput = !item.aggregate && (parsedArgs ? Object.keys(parsedArgs).length > 0 : Boolean(surface.args));
  const hasResult = typeof rawResult === "string" ? Boolean(rawResult.trim()) : rawResult != null;
  const hasDetails = hasInput || patch != null || hasResult;
  return (
    <article className={`tool-card ${failed || denied ? "failed" : ""} ${exited ? "exited" : ""} ${done ? "settled" : ""}`}
      data-category={category}>
      <button className="tool-header" disabled={!hasDetails}
        onClick={() => setOpen((value) => !value)} aria-expanded={hasDetails ? open : undefined}>
        <span className="tool-icon">{toolIcon(category)}</span>
        <span className="tool-title"><b>{title}</b>{argumentSummary && <small>{argumentSummary}</small>}</span>
        <span className={`tool-state ${done ? "done" : ""} ${failed || denied ? "failed" : ""} ${exited ? "exited" : ""}`} role="status">
          {failed || denied ? <X size={13} /> : done ? <Check size={13} /> : <LoaderCircle className="spin" size={13} />}
          {stateLabel}
        </span>
        {hasDetails && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </button>
      {resultSummary && !open && <div className="tool-result-summary">{resultSummary}</div>}
      {hasDetails && open && (
        <div className="tool-content">
          {hasInput && <DetailBlock label="Input" value={surface.args} />}
          {patch ? <CodeDiff patch={patch} /> :
            hasResult &&
              <DetailBlock label={failed || denied ? "Error" : "Result"} value={rawResult}
                copyLabel={category === "Shell" ? "Copy command output" : undefined} />}
        </div>
      )}
    </article>
  );
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
  if (category === "Read") return <FileText size={16} />;
  if (category === "Search" || category === "Web Research") return <Search size={16} />;
  if (category === "Shell") return <Terminal size={16} />;
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
  const previewPatch = useMemo(() => lineCount > 14 ? patch.split("\n").slice(0, 14).join("\n") : patch, [lineCount, patch]);
  const visiblePatch = expanded ? patch : previewPatch;
  const files = useMemo(() => parseUnifiedDiff(visiblePatch), [visiblePatch]);
  const fallback = <pre className="diff-fallback">{visiblePatch}</pre>;
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
                <DiffView data={file} diffViewMode={DiffModeEnum.Unified}
                  diffViewTheme="dark" diffViewWrap diffViewFontSize={12} />
              ) : <pre className="diff-fallback">{file.patch}</pre>}
            </div>;
          })}
        </DiffBoundary>
      </div>
      {lineCount > 14 && (
        <button className="diff-toggle" onClick={() => setExpanded((value) => !value)}>
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
    const background = document.querySelector<HTMLElement>(".app-shell");
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousAriaHidden = background?.getAttribute("aria-hidden");
    const previousInert = background?.inert;
    if (background) {
      background.inert = true;
      background.setAttribute("aria-hidden", "true");
    }
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
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        dialog.current?.focus();
        return;
      }
      const currentIndex = controls.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      controls[focusTrapIndex(currentIndex, controls.length, event.shiftKey)]?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (background) {
        background.inert = previousInert ?? false;
        if (previousAriaHidden == null) background.removeAttribute("aria-hidden");
        else background.setAttribute("aria-hidden", previousAriaHidden);
      }
      previousFocus?.focus();
    };
  }, [decide]);
  return createPortal(
    <div className="approval-layer">
      <article ref={dialog} className="approval-card" role="dialog" aria-modal="true" tabIndex={-1}
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
    </div>,
    document.body,
  );
}

type ComposerAttachment = {
  id: number;
  name: string;
  kind: 'image' | 'text';
  mimeType: string;
  data: string;
  token: string;
  source?: 'file' | 'paste';
};

const MAX_COMPOSER_ATTACHMENTS = 8;
const MAX_INLINE_FILE_BYTES = 750_000;
const MAX_INLINE_TEXT_TOTAL = 850_000;
const MAX_INLINE_IMAGE_BASE64_TOTAL = 30_000_000;
const MAX_SUBMIT_TEXT_LENGTH = 950_000;

function QueueList({ queued, restoring, onRestore }: {
  queued?: unknown[];
  restoring: boolean;
  onRestore: () => void;
}) {
  if (!Array.isArray(queued) || queued.length === 0) return null;
  return (
    <div className="queue-list" role="list" aria-label={`${queued.length} queued request${queued.length === 1 ? "" : "s"}`}>
      {queued.map((entry, index) => <div role="listitem" key={String(asRecord(entry)?.id || index)}>
        <Clock3 size={13} /><span>{queueText(entry)}</span><small>Queued</small></div>)}
      <button type="button" className="queue-restore" disabled={restoring} onClick={onRestore}>
        <RotateCcw size={13} />{restoring ? 'Restoring…' : 'Restore queue to editor'}
      </button>
    </div>
  );
}

const Composer = memo(function Composer({
  turnBusy,
  commandBusy,
  transitioning,
  promptHistoryList,
  provider,
  model,
  effort,
  fast,
  fastCapable,
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
  promptHistoryList?: unknown[];
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
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
  onOpenSettings: (section?: SettingsSection) => void;
  onOpenCommandSurface: (surface: CommandSurfaceName) => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedDraft, setSlashDismissedDraft] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const slashPalette = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attachmentSequence = useRef(1);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const dragDepth = useRef(0);
  const wasTransitioning = useRef(transitioning);
  const historyNavigation = useRef({ index: -1, seed: '' });
  const history = useMemo(() => (Array.isArray(promptHistoryList)
    ? promptHistoryList.map((entry) => typeof entry === 'string'
      ? entry : String(asRecord(entry)?.text || asRecord(entry)?.displayText || '')).filter(Boolean)
    : []), [promptHistoryList]);
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
  const paletteCommandToken = (command: (typeof SLASH_COMMANDS)[number] | undefined) => {
    if (!command) return '';
    const typedToken = draft.slice(1).trim().toLowerCase();
    return typedToken && (typedToken === command.name || command.aliases?.includes(typedToken))
      ? typedToken
      : command.name;
  };
  const resizeTextarea = useCallback(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    const contentHeight = element.scrollHeight;
    element.style.height = `${Math.min(180, Math.max(52, contentHeight))}px`;
    element.style.overflowY = contentHeight > 180 ? "auto" : "hidden";
  }, []);
  useLayoutEffect(resizeTextarea, [draft, resizeTextarea]);
  useEffect(() => {
    window.addEventListener("resize", resizeTextarea);
    return () => window.removeEventListener("resize", resizeTextarea);
  }, [resizeTextarea]);
  useEffect(() => {
    if (!starter) return;
    setDraft(starter.text);
    historyNavigation.current = { index: -1, seed: '' };
    textarea.current?.focus();
  }, [starter]);
  useEffect(() => {
    if (wasTransitioning.current && !transitioning) {
      window.setTimeout(() => textarea.current?.focus({ preventScroll: true }), 0);
    }
    wasTransitioning.current = transitioning;
  }, [transitioning]);

  useEffect(() => setSlashIndex(0), [slashQuery]);
  useEffect(() => {
    if (!slashOpen) return;
    slashPalette.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [slashIndex, slashOpen, slashQuery]);
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
      sum + (item.kind === 'image' ? item.data.length : 0), 0) +
      (attachment.kind === 'image' ? attachment.data.length : 0);
    if (imageTotal > MAX_INLINE_IMAGE_BASE64_TOTAL) {
      return 'Attached images are too large together. Remove an image or use smaller files.';
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
          const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
          insertAttachment({ id, name: displayName, kind: 'image', mimeType: file.type, data,
            token: `[Image #${id}: ${displayName}]` });
          continue;
        }
        const textLike = file.type.startsWith('text/') ||
          /\.(?:md|mdx|txt|json|jsonl|ya?ml|toml|xml|csv|tsv|[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|cs|cpp|c|h|hpp|sh|ps1|sql|css|scss|html|vue|svelte|log)$/i.test(displayName);
        if (!textLike || file.size > MAX_INLINE_FILE_BYTES) {
          throw new Error(`${displayName}: only text/code files under 750 KB can be attached inline.`);
        }
        const text = await file.text();
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
        data: image.content, token });
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

  const restoreQueue = async () => {
    if (restoring) return;
    setRestoring(true);
    const value = await invokeCapability<RecordValue>('restoreQueued', [draft]);
    if (value) {
      const restored = restoredAttachments(value, String(value.text || draft));
      setDraft(mergeRestoredAttachments(restored.attachments, restored.text));
      textarea.current?.focus();
    }
    setRestoring(false);
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
      if (!value || value === 'status') onOpenSettings('autoclear');
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
      if (!argument || ['status', 'current', 'show'].includes(argument.toLowerCase())) onOpenSettings('output-style');
      else await commandCapability('setOutputStyle', [argument]);
    } else if (name === 'theme') {
      if (!argument || ['status', 'current', 'show'].includes(argument.toLowerCase())) onOpenSettings('theme');
      else {
        const themes = await commandCapability<unknown[]>('listThemes') || [];
        const normalized = argument.toLowerCase();
        const theme = themes.map(asRecord).find((entry) =>
          String(entry?.id || '').toLowerCase() === normalized || String(entry?.label || '').toLowerCase() === normalized);
        if (!theme) {
          setAttachmentError(`Theme not found: ${argument}`);
          return false;
        }
        await commandCapability('setTheme', [theme.id, { persist: true }]);
        if (invocationFailed) return false;
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
        } else {
          pastedImages[String(attachment.id)] = {
            id: attachment.id,
            type: 'image',
            content: attachment.data,
            mediaType: attachment.mimeType,
            filename: attachment.name,
          };
        }
      }
      const imageAttachments = used.filter((attachment) => attachment.kind === 'image');
      if (expandedText.length > MAX_SUBMIT_TEXT_LENGTH) {
        setAttachmentError('This prompt is too large to send. Remove or shorten an inline text attachment.');
        return;
      }
      const content: DesktopPromptContent = imageAttachments.length
        ? [
          { type: 'text', text: expandedText },
          ...imageAttachments.map((attachment) => ({
            type: 'image' as const,
            data: attachment.data,
            mimeType: attachment.mimeType,
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
    if (composing && (event.key === 'Enter' || event.key.startsWith('Arrow'))) return;
    if (event.key === 'Enter' && event.repeat) return;
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
        setSlashDismissedDraft(draft);
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
      setDraft(history[navigation.index] || '');
      return;
    }
    if (event.key === 'ArrowDown' && historyIntent && historyNavigation.current.index >= 0) {
      event.preventDefault();
      const navigation = historyNavigation.current;
      navigation.index -= 1;
      setDraft(navigation.index < 0 ? navigation.seed : history[navigation.index] || '');
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
      <QueueList queued={queued} restoring={restoring} onRestore={() => void restoreQueue()} />
      <form className={`composer ${draggingFiles ? 'dragging-files' : ''}`} onSubmit={onSubmit}
        aria-busy={transitioning} onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          dragDepth.current += 1;
          setDraggingFiles(true);
        }} onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
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
          const itemFiles = Array.from(event.dataTransfer.items)
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          void attachFiles(itemFiles.length ? itemFiles : event.dataTransfer.files);
        }}>
      {draggingFiles && <div className="composer-drop-overlay" role="status">
        <Paperclip size={16} /><span>Drop images or text files</span>
      </div>}
      {slashOpen && (
        <div ref={slashPalette} className="slash-palette" role="listbox" aria-label="Slash commands">
          <header><Command size={13} /><span>Commands</span></header>
          {slashCommands.length ? slashCommands.map((command, index) => (
            <button type="button" role="option" aria-selected={index === slashIndex} key={command.name}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => { void send(`/${paletteCommandToken(command)}`); }}>
              <code>{command.usage || `/${command.name}`}{command.params ? ` ${command.params}` : ''}</code>
              <span>{command.description}</span>
            </button>
          )) : <p>No matching command.</p>}
        </div>
      )}
      {attachments.length > 0 && <div className="composer-attachments" aria-label="Attachments">
        {attachments.map((attachment) => <div className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
          {attachment.kind === 'image'
            ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" />
            : <span><FileText size={15} /></span>}
          <span data-tooltip={attachment.name}>{attachment.name}</span>
          <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => {
            setAttachments((current) => {
              const next = current.filter((entry) => entry.id !== attachment.id);
              attachmentsRef.current = next;
              return next;
            });
            setDraft((current) => current.replace(attachment.token, '').replace(/ {2,}/g, ' '));
          }}><Trash2 size={13} /></button>
        </div>)}
      </div>}
      {(attachmentError) && <p className="composer-error" role="alert">{attachmentError}</p>}
      <textarea ref={textarea} value={draft} onInput={(event) => {
        setDraft(event.currentTarget.value);
        setSlashDismissedDraft('');
        historyNavigation.current = { index: -1, seed: '' };
      }} onKeyDown={onKeyDown}
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
        rows={1} placeholder={turnBusy ? "Steer the active turn or queue a follow-up…" :
          commandBusy ? "Queue a message after the current command…" : "Ask Mixdog anything…"}
        disabled={transitioning}
        aria-label="Message Mixdog" />
      <div className="composer-footer">
        <input ref={fileInput} type="file" hidden multiple
          accept="image/png,image/jpeg,image/gif,image/webp,text/*,.md,.json,.yaml,.yml,.toml,.xml,.csv,.tsv,.js,.jsx,.ts,.tsx,.py,.rb,.rs,.go,.java,.kt,.swift,.cs,.cpp,.c,.h,.hpp,.sh,.ps1,.sql,.css,.scss,.html,.vue,.svelte"
          onChange={(event) => { if (event.currentTarget.files) void attachFiles(event.currentTarget.files); event.currentTarget.value = ''; }} />
        <button type="button" className="composer-tool" disabled={transitioning} aria-label="Attach files" data-tooltip="Attach images or text files" data-tooltip-side="top"
          onClick={() => fileInput.current?.click()}><Paperclip size={15} /></button>
        <ModelSelector provider={provider} model={model} effort={effort} fast={fast} fastCapable={fastCapable}
          disabled={turnBusy || commandBusy || transitioning}
          invokeResult={invokeResult} applySnapshot={applySnapshot}
          onOpenSettings={onOpenSettings} />
        {turnBusy && !draft.trim() ? (
          <button type="button" className="send-button stop" onClick={() => void stop()}
            aria-label="Stop generation" data-tooltip="Stop" data-tooltip-side="top">
            <Square size={11} fill="currentColor" />
          </button>
        ) : (
          <button className="send-button" disabled={!draft.trim() || submitting || transitioning}
            aria-label={turnBusy ? "Queue or steer active turn" : commandBusy ? "Queue after current command" : "Send message"}
            data-tooltip={turnBusy ? "Queue or steer · Enter" : commandBusy ? "Queue after command · Enter" : "Send · Enter"}
            data-tooltip-side="top">
            <ArrowUp size={16} />
          </button>
        )}
      </div>
      </form>
    </>
  );
});

function ModelSelector({ provider, model, effort, fast, fastCapable, disabled, invokeResult, applySnapshot, onOpenSettings }: {
  provider: string;
  model: string;
  effort: string;
  fast: boolean;
  fastCapable: boolean;
  disabled: boolean;
  invokeResult: <T>(action: () => T | Promise<T>) => Promise<T | undefined>;
  applySnapshot: (snapshot: EngineSnapshot | null) => void;
  onOpenSettings: (section?: SettingsSection) => void;
}) {
  const [models, setModels] = useState<DesktopModelOption[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogStarted, setCatalogStarted] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [open, setOpen] = useState(false);
  const [routing, setRouting] = useState(false);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<"providers" | "models">("providers");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [activeRowKey, setActiveRowKey] = useState("");
  const automaticCatalogAttempted = useRef(false);
  const catalogInFlight = useRef<Promise<void> | null>(null);
  const catalogLoadedAt = useRef(0);
  const routingGuard = useRef(false);
  const restoreAfterRoute = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const effortControl = useRef<HTMLDivElement>(null);
  const fastButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const modelList = useRef<HTMLDivElement>(null);
  const unavailable = disabled || routing;
  const selected = models.find((option) =>
    option.provider === provider && option.model === model);
  const normalizedModels = useMemo(() => normalizeModelOptions(models), [models]);
  const providerEntries = useMemo(() => {
    const entries = new Map<string, DesktopModelOption[]>();
    for (const option of normalizedModels) {
      const options = entries.get(option.provider) || [];
      options.push(option);
      entries.set(option.provider, options);
    }
    return [...entries].sort(([left], [right]) =>
      providerDisplayRank(left) - providerDisplayRank(right) ||
      providerDisplayName(left).localeCompare(providerDisplayName(right)));
  }, [normalizedModels]);
  const selectedEffort = selected?.effortOptions.find((option) => option.value === effort);
  const triggerModel = modelDisplayName(
    selected?.model || model,
    selected?.provider || provider,
    selected?.display || "",
  ) ||
    (catalogStarted && !catalogLoaded ? "Loading models…" : "Select model");
  const triggerProvider = selected?.provider || provider;

  const loadCatalog = useCallback(async (force = false) => {
    if (catalogInFlight.current) return catalogInFlight.current;
    setCatalogStarted(true);
    const listModels = window.mixdogDesktop?.listProviderModels;
    if (!listModels) {
      setCatalogLoaded(true);
      return;
    }
    const request = (async () => {
      try {
        setCatalogRefreshing(true);
        const quick = await invokeResult(() => listModels({ quick: true }));
        if (Array.isArray(quick)) setModels((current) => mergeModelCatalog(current, quick));
        // EngineHost seeds its authoritative full request before servicing the
        // advisory quick read. Await quick here so the picker remains instant;
        // the host-side seed protects the catalog from the warmup race.
        const full = await invokeResult(() => listModels(force
          ? { force: true, quick: false }
          : { quick: false }));
        if (Array.isArray(full)) {
          setModels((current) => mergeModelCatalog(current, full));
          catalogLoadedAt.current = Date.now();
        }
      } finally {
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

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setStage("providers");
    setSelectedProvider("");
    setActiveRowKey("");
    if (restoreFocus) {
      window.setTimeout(() => trigger.current?.focus({ preventScroll: true }), 0);
    }
  }, []);

  const backToProviders = useCallback(() => {
    setStage("providers");
    setSelectedProvider("");
    setQuery("");
    setActiveRowKey("");
    window.setTimeout(() => search.current?.focus({ preventScroll: true }), 0);
  }, []);

  const showProviderModels = useCallback((provider: string) => {
    setSelectedProvider(provider);
    setStage("models");
    setQuery("");
    setActiveRowKey("");
    window.setTimeout(() => search.current?.focus({ preventScroll: true }), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !popover.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = popover.current.offsetWidth || 296;
      const edge = 8;
      popover.current.style.left = `${Math.min(
        Math.max(edge, anchor.left),
        Math.max(edge, window.innerWidth - width - edge),
      )}px`;
      popover.current.style.bottom = `${Math.max(edge, window.innerHeight - anchor.top + 4)}px`;
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popover.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (stage === "models") backToProviders();
      else close(true);
    };
    place();
    search.current?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", place);
    };
  }, [backToProviders, close, open, stage]);

  useLayoutEffect(() => {
    if (!open || !modelList.current) return;
    modelList.current.scrollTop = 0;
  }, [open, stage, selectedProvider]);

  useEffect(() => {
    if (unavailable && open) close();
  }, [close, open, unavailable]);
  useEffect(() => {
    if (routing || !restoreAfterRoute.current) return;
    const target = restoreAfterRoute.current;
    restoreAfterRoute.current = null;
    target.focus({ preventScroll: true });
  }, [routing]);

  const route = async (selection: DesktopModelSelection, restoreTarget: HTMLElement | null = trigger.current) => {
    if (unavailable || routingGuard.current) return;
    routingGuard.current = true;
    restoreAfterRoute.current = restoreTarget;
    setRouting(true);
    close();
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setModelRoute(selection));
      if (next !== undefined) {
        applySnapshot(next);
      }
    } finally {
      routingGuard.current = false;
      setRouting(false);
    }
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
        ? fast
        : typeof option.savedFast === 'boolean'
          ? option.savedFast
          : option.fastPreferred
      : undefined;
    void route({
      provider: option.provider,
      model: option.model,
      ...(nextEffort ? { effort: nextEffort } : {}),
      ...(nextFast === undefined ? {} : { fast: nextFast }),
    });
  };
  const toggleFast = async () => {
    if (unavailable || routingGuard.current) return;
    routingGuard.current = true;
    restoreAfterRoute.current = fastButton.current;
    setRouting(true);
    const enabled = !fast;
    try {
      const next = await invokeResult(() => window.mixdogDesktop.setFast(enabled));
      if (next !== undefined) applySnapshot(next);
    } finally {
      routingGuard.current = false;
      setRouting(false);
    }
  };
  const changeEffort = async (effort: string) => {
    if (unavailable || routingGuard.current) return;
    routingGuard.current = true;
    restoreAfterRoute.current = effortControl.current?.querySelector('button') || trigger.current;
    setRouting(true);
    const result = await invokeResult(() => window.mixdogDesktop.invokeCapability<string>({
      capability: 'setEffort',
      args: [effort],
    }));
    if (result !== undefined) applySnapshot(result.snapshot);
    routingGuard.current = false;
    setRouting(false);
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProviders = providerEntries.filter(([provider, options]) => !normalizedQuery ||
    `${provider} ${providerDisplayName(provider)} ${options.map((option) =>
      `${option.model} ${option.display} ${modelDisplayName(option.model, option.provider, option.display)}`).join(" ")}`
      .toLocaleLowerCase().includes(normalizedQuery));
  const providerModels = providerEntries.find(([provider]) => provider === selectedProvider)?.[1] || [];
  const visibleModels = providerModels.filter((option) => !normalizedQuery ||
    `${option.model} ${option.display} ${modelDisplayName(option.model, option.provider, option.display)} ${modelOptionDescription(option)}`
      .toLocaleLowerCase().includes(normalizedQuery));
  const providerKey = (provider: string) => `provider:${provider}`;
  const modelKey = (option: DesktopModelOption) => `model:${option.provider}:${option.model}`;
  useEffect(() => {
    if (!open) return;
    if (stage === "providers") {
      const preferred = visibleProviders.find(([entryProvider]) => entryProvider === provider) || visibleProviders[0];
      setActiveRowKey(preferred ? providerKey(preferred[0]) : "");
      return;
    }
    const preferred = visibleModels.find((option) =>
      option.provider === provider && option.model === model) || visibleModels[0];
    setActiveRowKey(preferred ? modelKey(preferred) : "");
  }, [model, open, normalizedQuery, provider, providerEntries, selectedProvider, stage]);
  const focusRow = (index: number) => {
    const options = Array.from(popover.current?.querySelectorAll<HTMLButtonElement>(
      '.model-list [role="option"]',
    ) || []);
    const target = options[Math.max(0, Math.min(index, options.length - 1))];
    if (!target) return;
    setActiveRowKey(target.dataset.rowKey || "");
    target.focus({ preventScroll: true });
  };
  const navigateRows = (event: React.KeyboardEvent, fromSearch = false) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = Array.from(popover.current?.querySelectorAll<HTMLButtonElement>(
      '.model-list [role="option"]',
    ) || []);
    if (options.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") return focusRow(0);
    if (event.key === "End") return focusRow(options.length - 1);
    if (fromSearch) {
      const initialized = options.findIndex((option) => option.dataset.rowKey === activeRowKey);
      return focusRow(initialized >= 0 ? initialized : event.key === "ArrowDown" ? 0 : options.length - 1);
    }
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    focusRow(current + (event.key === "ArrowDown" ? 1 : -1));
  };
  const triggerDisabled = unavailable;

  return <div className="route-controls">
    <button ref={trigger} type="button" className="model-trigger"
      disabled={triggerDisabled} aria-haspopup="dialog" aria-expanded={open}
      aria-controls="model-selector-popover"
      data-tooltip={catalogLoaded && models.length === 0 ? "Connect a provider or refresh models" : "Choose model"}
      data-tooltip-side="top"
      onClick={() => {
        if (!catalogLoaded || Date.now() - catalogLoadedAt.current > 300_000) void loadCatalog(catalogLoaded);
        if (open) close();
        else {
          setStage("providers");
          setSelectedProvider("");
          setQuery("");
          setActiveRowKey("");
          setOpen(true);
        }
      }}>
      {triggerProvider && <ProviderIcon className="provider-icon" provider={triggerProvider} />}
      <span>{triggerModel}</span>
      <ChevronDown size={13} />
    </button>
    {selected && selected.effortOptions.length > 0 && (
      <div ref={effortControl} className="effort-control">
        <OpenSelect ariaLabel="Reasoning effort" disabled={unavailable} value={selectedEffort?.value || ""}
          onChange={(value) => void changeEffort(value)} options={[
            ...(!selectedEffort ? [{ value: '', label: 'Effort', disabled: true }] : []),
            ...selected.effortOptions,
          ]} />
      </div>
    )}
    {fastCapable && (
      <button ref={fastButton} type="button" className="fast-control"
        disabled={unavailable} aria-label={`${fast ? 'Disable' : 'Enable'} Fast mode`}
        aria-pressed={fast} aria-busy={routing || undefined}
        data-tooltip={routing ? 'Updating Fast mode…' : `${fast ? 'Disable' : 'Enable'} Fast mode`}
        data-tooltip-side="top"
        onClick={() => void toggleFast()}>
        Fast
      </button>
    )}
    {open && createPortal(
      <div ref={popover} id="model-selector-popover" className="model-popover"
        role="dialog" aria-label="Model selector">
        <div className="model-search">
          {stage === "models" ? (
            <button type="button" className="model-back" aria-label="Back to providers"
              data-tooltip="Back to providers" data-tooltip-side="top" onClick={backToProviders}>
              <ChevronLeft size={15} />
            </button>
          ) : <Search size={14} aria-hidden="true" />}
          <span className="sr-only">{stage === "providers" ? "Search providers" : "Search models"}</span>
          <input ref={search} type="search" value={query}
            placeholder={stage === "providers" ? "Search providers…" : `Search ${providerDisplayName(selectedProvider)}…`}
            aria-label={stage === "providers" ? "Search providers" : "Search models"}
            onInput={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => navigateRows(event, true)} />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear picker search">
            <X size={13} />
          </button>}
          <button type="button" aria-label="Connect provider" data-tooltip="Connect provider" data-tooltip-side="top"
            onClick={() => { close(); onOpenSettings('providers'); }}><Plus size={14} /></button>
          <button type="button" aria-label="Manage models" data-tooltip="Manage models" data-tooltip-side="top"
            onClick={() => { close(); onOpenSettings('model'); }}><SlidersHorizontal size={14} /></button>
        </div>
        <div ref={modelList} className="model-list" role="listbox"
          aria-label={stage === "providers" ? "Available providers" : `Models from ${providerDisplayName(selectedProvider)}`}>
          {stage === "providers" ? (
            <>
              {visibleProviders.length === 0 && <p className="model-empty">
                {catalogRefreshing ? "Loading providers…" : "No providers with matching models."}
              </p>}
              {visibleProviders.map(([entryProvider, options]) => {
                const active = entryProvider === provider;
                const key = providerKey(entryProvider);
                const current = active
                  ? options.find((option) => option.model === model)
                  : undefined;
                const preview = current || options[0];
                return <button type="button" className="model-provider-row" role="option"
                  aria-selected={active} key={key} data-row-key={key}
                  tabIndex={activeRowKey === key ? 0 : -1}
                  onKeyDown={(event) => navigateRows(event)}
                  onClick={() => showProviderModels(entryProvider)}>
                  <ProviderIcon className="provider-icon" provider={entryProvider} />
                  <span className="model-row-copy">
                    <strong>{providerDisplayName(entryProvider)}</strong>
                    <small>{active && current ? "Current" : "Latest"} · {modelDisplayName(
                      preview.model, preview.provider, preview.display,
                    )}</small>
                  </span>
                  <span className="model-count">{options.length}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>;
              })}
            </>
          ) : (
            <>
              <div className="model-list-heading" aria-hidden="true">
                <ProviderIcon className="provider-icon" provider={selectedProvider} />
                <span>{providerDisplayName(selectedProvider)}</span>
                <small>{providerModels.length} {providerModels.length === 1 ? "model" : "models"}</small>
              </div>
              {visibleModels.length === 0 && <p className="model-empty">No matching models.</p>}
              {visibleModels.map((option) => {
                const active = option.provider === provider && option.model === model;
                const key = modelKey(option);
                return <button type="button" className="model-option-row" role="option"
                  aria-selected={active} key={key} data-row-key={key}
                  tabIndex={activeRowKey === key ? 0 : -1}
                  onKeyDown={(event) => navigateRows(event)}
                  onClick={() => chooseModel(option)}>
                  <span className="model-row-copy">
                    <strong>{modelDisplayName(option.model, option.provider, option.display)}</strong>
                    <small>{modelOptionDescription(option)}</small>
                  </span>
                  {active && <Check size={15} aria-hidden="true" />}
                </button>;
              })}
            </>
          )}
          {catalogRefreshing && (visibleProviders.length > 0 || visibleModels.length > 0) && (
            <p className="model-loading" role="status">Updating model catalog…</p>
          )}
        </div>
      </div>,
      document.body,
    )}
  </div>;
}
