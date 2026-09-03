import {
  Search,
  X,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DesktopGitStatus,
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopWorkspaceFolder,
  DesktopWorkspaceTextFileResult,
  DesktopWorkspaceTextSearchOptions,
} from "../shared/contract";
import { AgentActivityPane } from "./AgentActivityPane";
import { OpenSelect } from "./OpenSelect";
import { DesktopLoadingSurface } from "./RendererRecovery";
import type { PullRequestOpenHandler } from "./PullRequestsPane";
import { SourceControlDock, type SourceControlDiffRequest } from "./SourceControlDock";
import { SurfaceActiveContext } from "./surface-activity";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import type { Snapshot } from "./desktop-types";
import {
  desktopUtilityDockTabEnabled,
  type DesktopUtilityDockTab,
} from "./desktop-feature-config";
import { FilesRootPane, SetiFileIcon } from "./ExplorerTree";
import { t } from "./i18n";
import { createGitRefreshScheduler } from "./git-refresh-scheduler";
import { scheduleEditorPanePrefetch } from "./lazy-widgets";
import { subscribeProjectFileChanges } from "./project-file-changes";

export type UtilityDockTab = DesktopUtilityDockTab;

const MemoSourceControlDock = memo(SourceControlDock);
const EMPTY_CHANGED_FILES = new Set<string>();
const ignoreFilesReadyChange = () => {};

/** One retained Dock layer. The provider is the bounded lifecycle signal every
 *  escaping body portal (menus, selects) and every background loader inside
 *  the pane subscribes to, so `inert` can never leave an interactive orphan
 *  attached to document.body. */
function DockPane({
  tab,
  active,
  children,
}: {
  tab: UtilityDockTab;
  active: boolean;
  children: ReactNode;
}) {
  return <SurfaceActiveContext.Provider value={active}>
    <div className="utility-dock-pane stable-surface-layer" data-tab={tab}
      data-surface-active={active ? "true" : "false"}
      aria-hidden={active ? undefined : "true"}
      inert={!active}>
      {children}
    </div>
  </SurfaceActiveContext.Provider>;
}

type DockGitState = {
  projectPath: string;
  status: DesktopGitStatus | null;
  loading: boolean;
  ready: boolean;
  error: string;
};

/** Git status outlives each movable Dock view. Workbench categories are
 * separate component instances, so a module cache lets the idle Agents/Search
 * preload become Source Control's first paint instead of another blank wait. */
const dockGitCache = new Map<string, DockGitState>();
const dockGitRequests = new Map<string, Promise<DockGitState>>();

function readCachedDockGitState(projectPath: string): DockGitState {
  if (!projectPath) {
    return { projectPath: "", status: null, loading: false, ready: true, error: "" };
  }
  return dockGitCache.get(projectPath) ?? {
    projectPath,
    status: null,
    loading: false,
    ready: false,
    error: "",
  };
}

function requestDockGitState(
  projectPath: string,
): Promise<DockGitState> {
  const pending = dockGitRequests.get(projectPath);
  if (pending) return pending;
  const gitStatus = window.mixdogDesktop?.gitStatus;
  const request = (typeof gitStatus !== "function"
    ? Promise.resolve({
      projectPath,
      status: null,
      loading: false,
      ready: true,
      error: "",
    } satisfies DockGitState)
    // Source Control/Search only consume repository, branch and changed-file
    // shape. Line totals belong to Review surfaces, so making this dock wait
    // for two numstat passes and every untracked file read was pure latency.
    : gitStatus(projectPath, { skipLineStats: true }).then((status) => ({
      projectPath,
      status: status ?? null,
      loading: false,
      ready: true,
      error: "",
    } satisfies DockGitState), (reason) => ({
      projectPath,
      status: null,
      loading: false,
      ready: true,
      error: reason instanceof Error ? reason.message : String(reason),
    } satisfies DockGitState)))
    .then((state) => {
      dockGitCache.set(projectPath, state);
      return state;
    });
  dockGitRequests.set(projectPath, request);
  void request.finally(() => {
    if (dockGitRequests.get(projectPath) === request) dockGitRequests.delete(projectPath);
  });
  return request;
}

export async function prewarmUtilityDockGitState(projectPath: string): Promise<void> {
  if (!projectPath) return;
  const cached = readCachedDockGitState(projectPath);
  if (cached.ready && !cached.error) return;
  await requestDockGitState(projectPath);
}

/** One retained view layer. Inactive layers stay mounted (tree, scroll and
 *  draft state survive a round trip) but are hidden and inert. */
function UtilityDockViewSection({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return <section className="utility-dock-view-section"
    data-active={active ? "true" : "false"}>
    <div className="utility-dock-view-section-body"
      inert={active ? undefined : true}
      aria-hidden={active ? undefined : true}>
      {children}
    </div>
  </section>;
}


// ── Pane side-dock views (Agents / Search / Source Control / PRs) ─────────
const SearchPane = memo(function SearchPane({
  projectPath,
  gitStatus,
  active,
  onOpenFile,
  onOpenFileAt,
}: {
  projectPath: string;
  gitStatus: DesktopGitStatus | null;
  active: boolean;
  onOpenFile?(project: string, rel: string, mode?: "preview" | "pinned"): void;
  onOpenFileAt?(project: string, rel: string, line?: number): void;
}) {
  const folders = useMemo<DesktopWorkspaceFolder[]>(
    () => projectPath ? [{ path: projectPath }] : [],
    [projectPath],
  );
  // Names filters paths; Contents runs full-text search with the same field.
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"names" | "contents">("names");
  const [nameResults, setNameResults] = useState<Array<{ project: string; paths: string[] }>>([]);
  const [contentResults, setContentResults] = useState<Array<{
    project: string;
    files: DesktopWorkspaceTextFileResult[];
    matchCount: number;
    limitHit: boolean;
  }>>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchGeneration = useRef(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchProjects = useMemo(() => folders.map((folder) => folder.path), [folders]);
  const searchProjectsKey = searchProjects.join("\u0000");
  const searchOptions = useMemo<DesktopWorkspaceTextSearchOptions>(() => ({
    query: query.trim(),
    maxResults: 2_000,
  }), [query]);
  // Ctrl+Shift+F lands here: switch to Contents and focus the field.
  useEffect(() => {
    const focusSearch = () => {
      setSearchMode("contents");
      window.requestAnimationFrame(() => {
        const input = searchInputRef.current;
        if (input && !input.closest("[inert]")) {
          input.focus({ preventScroll: true });
          input.select();
        }
      });
    };
    window.addEventListener("mixdog:focus-dock-search", focusSearch);
    return () => window.removeEventListener("mixdog:focus-dock-search", focusSearch);
  }, []);
  useEffect(() => {
    const current = ++searchGeneration.current;
    const trimmed = query.trim();
    if (!active || !trimmed || searchProjects.length === 0) {
      setNameResults([]);
      setContentResults([]);
      setSearchLoading(false);
      setSearchError("");
      return undefined;
    }
    setSearchLoading(true);
    setSearchError("");
    const timer = window.setTimeout(() => {
      if (searchMode === "names") {
        void Promise.allSettled(searchProjects.map(async (project) => ({
          project,
          paths: await window.mixdogDesktop.searchProjectFiles(project, trimmed, 200),
        })))
          .then((settled) => {
            if (searchGeneration.current !== current) return;
            setNameResults(settled.flatMap((result) =>
              result.status === "fulfilled" ? result.value : []));
            setSearchLoading(false);
          });
        return;
      }
      void Promise.allSettled(searchProjects.map(async (project) => {
        if (window.mixdogDesktop.searchWorkspaceText) {
          return { project, ...await window.mixdogDesktop.searchWorkspaceText(project, searchOptions) };
        }
        const paths = await window.mixdogDesktop.searchProjectFiles(project, trimmed, 200);
        return {
          project,
          matchCount: paths.length,
          limitHit: false,
          files: paths.map((relPath) => ({
            relPath,
            matches: [{ line: 1, column: 1, endColumn: 1, preview: relPath, matchText: "" }],
          })),
        };
      }))
        .then((settled) => {
          if (searchGeneration.current !== current) return;
          const rows = settled.flatMap((result) =>
            result.status === "fulfilled" ? result.value : []);
          if (!rows.length && settled.every((result) => result.status === "rejected")) {
            const rejected = settled.find((result) => result.status === "rejected");
            throw rejected && rejected.status === "rejected" ? rejected.reason : new Error("Search failed.");
          }
          setContentResults(rows);
          setSearchLoading(false);
        })
        .catch((reason) => {
          if (searchGeneration.current !== current) return;
          setContentResults([]);
          setSearchLoading(false);
          setSearchError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [active, query, searchMode, searchOptions, searchProjects, searchProjectsKey]);
  const searching = Boolean(query.trim());
  const contentsMode = searchMode === "contents";
  const totalNameHits = nameResults.reduce((sum, result) => sum + result.paths.length, 0);
  const totalMatches = contentResults.reduce((sum, result) => sum + result.matchCount, 0);
  return <div className="workbench-explorer">
    {/* Workspace open/add/save toolbar removed on purpose: Mixdog exposes
        ONE Project concept — no multi-root workspace UI (user:
        Project 개념만 있고 워크트리 격리가 없는데 혼용돼 헷갈린다). */}
    <div className="workbench-explorer-search">
      <label className="workbench-search-input">
        <Search size={14} aria-hidden="true" />
        <input ref={searchInputRef} value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={contentsMode ? t("Search text") : t("Search files")}
          aria-label={contentsMode ? t("Search text in project files") : t("Search project files by name")} />
        {query && <button type="button" aria-label={t("Clear search")}
          onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button>}
      </label>
      <div className="workbench-search-mode" role="tablist" aria-label={t("Search mode")}>
        <button type="button" role="tab" aria-selected={!contentsMode}
          onClick={() => setSearchMode("names")}>{t("Names")}</button>
        <button type="button" role="tab" aria-selected={contentsMode}
          onClick={() => setSearchMode("contents")}>{t("Contents")}</button>
      </div>
    </div>
    {searching ? (
      searchLoading
        ? <p className="utility-dock-empty">{t("Searching…")}</p>
        : searchError
          ? <p className="utility-dock-empty">{searchError}</p>
          : !contentsMode
            ? (totalNameHits === 0
              ? <p className="utility-dock-empty">{t("No matching files.")}</p>
              : <div className="workbench-search-results" role="tree" aria-label={t("File name results")}>
                <p className="workbench-search-summary">{totalNameHits === 1 ? t("1 file") : t("{{count}} files", { count: totalNameHits })}</p>
                {nameResults.flatMap(({ project, paths }) => paths.map((relPath) => {
                  const normalized = relPath.replace(/\\/g, "/");
                  const split = normalized.lastIndexOf("/");
                  const name = split >= 0 ? normalized.slice(split + 1) : normalized;
                  const parent = split >= 0 ? normalized.slice(0, split) : "";
                  return <button type="button" role="treeitem" className="workbench-search-name-row"
                    key={`${project}:${relPath}`}
                    onPointerEnter={scheduleEditorPanePrefetch}
                    onFocus={scheduleEditorPanePrefetch}
                    onClick={() => onOpenFile?.(project, relPath, "preview")}>
                    <SetiFileIcon name={name} />
                    <b>{name}</b>
                    <small>{parent}</small>
                  </button>;
                }))}
              </div>)
            : (contentResults.length === 0
              ? <p className="utility-dock-empty">{t("No results found.")}</p>
              : <div className="workbench-search-results" role="tree" aria-label={t("Search results")}>
                <p className="workbench-search-summary">{totalMatches === 1 ? t("1 result") : t("{{count}} results", { count: totalMatches })}</p>
                {contentResults.flatMap(({ project, files, limitHit }) => files.map((file) => {
                  const normalized = file.relPath.replace(/\\/g, "/");
                  const split = normalized.lastIndexOf("/");
                  const name = split >= 0 ? normalized.slice(split + 1) : normalized;
                  const parent = split >= 0 ? normalized.slice(0, split) : "";
                  return <details open className="workbench-search-file" key={`${project}:${file.relPath}`}>
                    <summary><SetiFileIcon name={name} />
                      <b>{name}</b><small>{parent}</small><i>{file.matches.length}</i>
                    </summary>
                    {file.matches.map((match, index) => <button type="button" role="treeitem"
                      key={`${match.line}:${match.column}:${index}`}
                      onPointerEnter={scheduleEditorPanePrefetch}
                      onFocus={scheduleEditorPanePrefetch}
                      onClick={() => onOpenFileAt
                        ? onOpenFileAt(project, file.relPath, match.line)
                        : onOpenFile?.(project, file.relPath, "preview")}>
                      <span>{match.line}</span><code>{match.preview || match.matchText}</code>
                    </button>)}
                    {limitHit && <p className="utility-dock-empty">{t("Result limit reached.")}</p>}
                  </details>;
                }))}
              </div>)
    ) : contentsMode
      ? <p className="utility-dock-empty">
        {folders.length === 0
          ? t("Open a project to search files.")
          : t("Search project files by name or contents.")}
      </p>
      : folders.length === 0
        ? <p className="utility-dock-empty">{t("Open a project to browse its files.")}</p>
        : <FilesRootPane
          projectPath={projectPath}
          gitStatus={gitStatus}
          changed={EMPTY_CHANGED_FILES}
          activeFileKey=""
          active={active}
          readinessKey={`search-files:${projectPath}`}
          onReadyChange={ignoreFilesReadyChange}
          onOpenFile={onOpenFile} />
    }
  </div>;
});


export const UtilityDock = memo(function UtilityDock({
  open,
  tab,
  snapshot,
  projectPath = "",
  workspaceFolders,
  onSelectProject,
  onOpenFile,
  onOpenDiff,
  onOpenPullRequest,
  onOpenFileAt,
  sessions = [],
  activeSessionIds = [],
  unreadSessionIds,
  onPrefetchSession,
  onOpenLeadSession,
  onOpenAgentSession,
  entering = false,
  contentReady = true,
  prewarm = false,
  showTitle = true,
  title,
  titleDragProps,
  metricSurface = "dock",
}: {
  /** The hosting side section is expanded. Closed docks keep their layers
   *  mounted (prewarm) but run no polling or reads. */
  open: boolean;
  tab: UtilityDockTab;
  snapshot: Snapshot;
  sessions?: readonly DesktopSessionSummary[];
  activeSessionIds?: readonly string[];
  /** Recent-list unread sessions: the Agents pane shows their idle rows as
   *  completed work instead of plain rest. */
  unreadSessionIds?: ReadonlySet<string>;
  onPrefetchSession?(sessionId: string): void;
  projectPath?: string;
  workspaceFolders?: readonly DesktopWorkspaceFolder[];
  /** Main App owns the shared Search / Source Control / Pull Requests
   *  project cache. Standalone hosts omit this and keep a local override. */
  onSelectProject?(projectPath: string): void;
  onOpenFile?(project: string, rel: string, mode?: "preview" | "pinned"): void;
  onOpenDiff?(project: string, rel: string, request: SourceControlDiffRequest): void;
  onOpenPullRequest?: PullRequestOpenHandler;
  onOpenFileAt?(project: string, rel: string, line?: number): void;
  onOpenLeadSession?(sessionId: string): void;
  onOpenAgentSession?(sessionId: string, title: string, ownerSessionId: string): void;
  /** Surface re-entry: render already-open, without the slide-in replay. */
  entering?: boolean;
  /** The shell may pre-mount at width 0; defer the expensive selected body. */
  contentReady?: boolean;
  /** Mount the selected body while CLOSED (user: 사이드탭 즉시 열리게): the
   *  pane dock hidden-mounts its remembered view after boot, so the first
   *  expand toggles `hidden` on a live tree instead of mounting Source
   *  Control — toolbar, windowed rows, commit box — behind the click. Open-
   *  gated effects (refresh scheduler, project list) still wait for `open`. */
  prewarm?: boolean;
  /** Pane docks drop the tool-title row so content tops align with the
   *  shared unit header (user: 소스 제어 타이틀 줄 제거). */
  showTitle?: boolean;
  title?: string;
  titleDragProps?: React.HTMLAttributes<HTMLElement>;
  metricSurface?: "sidebar" | "dock";
}) {
  const resolvedOpenFileAt = onOpenFileAt
    ?? onOpenFile as ((project: string, rel: string, line?: number) => void) | undefined;
  // One view per host section: the workbench side layout owns grouping and
  // ordering, so this dock only ever presents the tab it was given.
  const presentedTab = tab;
  const presentedGroup = useMemo(() => [tab], [tab]);
  // A controlled App shares one selection across Search / Source Control /
  // Pull Requests. Standalone mounts retain the historical local override.
  const [localProjectOverride, setLocalProjectOverride] = useState("");
  const [knownProjects, setKnownProjects] = useState<DesktopProjectSummary[]>([]);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void window.mixdogDesktop?.listProjects?.()
      .then((rows) => { if (live) setKnownProjects(rows ?? []); })
      .catch(() => { /* the switcher simply lists fewer options */ });
    return () => { live = false; };
  }, [open]);
  const baseFolders = useMemo(() => workspaceFolders?.length
    ? workspaceFolders
    : projectPath ? [{ path: projectPath }] : [], [projectPath, workspaceFolders]);
  const baseProjectPath = projectPath || baseFolders[0]?.path
    || String(snapshot.currentProject || snapshot.project || "");
  const dockProjectPath = onSelectProject
    ? baseProjectPath
    : localProjectOverride || baseProjectPath;
  const selectDockProject = useCallback((path: string) => {
    if (onSelectProject) onSelectProject(path);
    else setLocalProjectOverride(path);
  }, [onSelectProject]);
  // Search owns its project toolbar inside the stable Search layer, but the
  // project options remain dock-scoped so switching surfaces preserves them.
  const dockRootName =
    dockProjectPath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "";
  const dockProjectOptions = useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ path: string; name: string }> = [];
    const push = (path: string, name?: string | null) => {
      const key = path.replace(/[\\/]+/g, "/").toLocaleLowerCase();
      if (!path || seen.has(key)) return;
      seen.add(key);
      rows.push({
        path,
        name: name || path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path,
      });
    };
    push(dockProjectPath, dockRootName);
    for (const folder of baseFolders) push(folder.path, (folder as { name?: string }).name);
    for (const project of knownProjects) push(project.path, project.alias || project.name);
    return rows;
  }, [baseFolders, dockProjectPath, dockRootName, knownProjects]);
  // Stable project-picker element: this JSX is a MemoSourceControlDock prop.
  // Rebuilt inline it re-rendered the entire SCM tree on every dock commit
  // (profiled during fast tab switches — the dock never changed).
  const dockProjectSelectOptions = useMemo(
    () => dockProjectOptions.map((option) => ({ value: option.path, label: option.name })),
    [dockProjectOptions],
  );
  const projectSelectControl = useMemo(() => dockProjectOptions.length > 0
    ? <OpenSelect ariaLabel={t("Switch project")}
      className="dock-project-select"
      value={dockProjectPath}
      displayValue={dockProjectPath ? undefined : t("Select project")}
      options={dockProjectSelectOptions}
      onChange={selectDockProject} />
    : null, [dockProjectOptions.length, dockProjectPath, dockProjectSelectOptions, selectDockProject]);
  const projectKey = dockProjectPath;
  const surfaceKeys: Record<UtilityDockTab, string> = {
    agents: "agents",
    search: `search:${projectKey}`,
    "source-control": `source-control:${dockProjectPath}`,
    "pull-requests": `pull-requests:${dockProjectPath}`,
  };
  const gitRequestEpoch = useRef(0);
  const [dockGitState, setDockGitState] = useState<DockGitState>(
    () => readCachedDockGitState(dockProjectPath),
  );
  const refreshDockGitStatus = useCallback(async (
    showLoading = false,
  ) => {
    const currentProject = dockProjectPath;
    const epoch = ++gitRequestEpoch.current;
    if (!currentProject) {
      setDockGitState(readCachedDockGitState(""));
      return;
    }
    if (showLoading) {
      setDockGitState((current) => ({
        ...(current.projectPath === currentProject
          ? current
          : readCachedDockGitState(currentProject)),
        projectPath: currentProject,
        loading: true,
        // A visible/cached snapshot remains authoritative while its silent
        // refresh runs. Invalidating it here replayed the full Preparing
        // Source Control cover on every tab re-entry.
      }));
    }
    const next = await requestDockGitState(currentProject);
    if (epoch !== gitRequestEpoch.current) return;
    setDockGitState(next);
  }, [dockProjectPath]);
  // Git I/O follows intent and evidence. A recursive project watcher plus
  // explicit Git actions drive refreshes; the slow safety lane only protects
  // platforms where native watch delivery is unavailable or overflowed.
  const gitSurfaceSelected = presentedGroup.includes("source-control")
    || presentedGroup.includes("pull-requests");
  useEffect(() => {
    if (!open || !contentReady || !dockProjectPath || !gitSurfaceSelected) return undefined;
    let first = true;
    const scheduler = createGitRefreshScheduler(async () => {
      const showLoading = first;
      first = false;
      await refreshDockGitStatus(showLoading);
    }, {
      safetyIntervalMs: 30_000,
      activityDebounceMs: 125,
      activityMinGapMs: 3_000,
      slowTaskMultiplier: 5,
    });
    const signal = () => scheduler.signal();
    const refreshNow = () => scheduler.refreshNow();
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") scheduler.pause();
      else scheduler.resume();
    };
    const unsubscribeProject = subscribeProjectFileChanges(dockProjectPath, signal);
    window.addEventListener("focus", refreshNow);
    window.addEventListener("mixdog:git-changed", signal);
    document.addEventListener("visibilitychange", visibilityChanged);
    if (document.visibilityState !== "hidden") scheduler.resume();
    return () => {
      scheduler.dispose();
      unsubscribeProject();
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("mixdog:git-changed", signal);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [contentReady, dockProjectPath, gitSurfaceSelected, open, refreshDockGitStatus]);
  // Boot preload (user: 호버 말고 부트 프리로드는 백그라운드에서): the intent
  // rule above still owns live polling, but ONE idle-time gitStatus per
  // project warms dockGitState before the first Git tab entry, so Source
  // Control / Pull Requests reveal without the Preparing… cover. No interval
  // runs while a Git surface is not selected.
  const warmedGitProject = useRef("");
  useEffect(() => {
    if (!dockProjectPath || gitSurfaceSelected) return undefined;
    if (warmedGitProject.current === dockProjectPath) return undefined;
    if (readCachedDockGitState(dockProjectPath).ready) {
      warmedGitProject.current = dockProjectPath;
      return undefined;
    }
    const host = window as typeof window & {
      requestIdleCallback?(callback: () => void, options?: { timeout: number }): number;
      cancelIdleCallback?(handle: number): void;
    };
    let idle = 0;
    let timer = 0;
    const warm = () => {
      idle = 0;
      timer = 0;
      warmedGitProject.current = dockProjectPath;
      void refreshDockGitStatus();
    };
    if (typeof host.requestIdleCallback === "function") {
      idle = host.requestIdleCallback(warm, { timeout: 2_000 });
    } else {
      timer = window.setTimeout(warm, 250);
    }
    return () => {
      if (idle) host.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, [dockProjectPath, gitSurfaceSelected, refreshDockGitStatus]);
  const effectiveDockGitState = dockGitState.projectPath === dockProjectPath
    ? dockGitState
    : readCachedDockGitState(dockProjectPath);
  const dockGitStatus = effectiveDockGitState.status;
  const dockGitStatusReady = !dockProjectPath || effectiveDockGitState.ready;
  const dockGitLoading = effectiveDockGitState.loading;
  const dockGitError = effectiveDockGitState.error;
  const [, setReadyPaneKeys] = useState<Partial<Record<UtilityDockTab, string>>>({});
  const setPaneReady = useCallback((
    pane: UtilityDockTab,
    key: string,
    ready: boolean,
  ) => {
    setReadyPaneKeys((current) => {
      if (ready) {
        if (current[pane] === key) return current;
        return { ...current, [pane]: key };
      }
      if (current[pane] !== key) return current;
      const next = { ...current };
      delete next[pane];
      return next;
    });
  }, []);
  const setSourceControlReady = useCallback(
    (key: string, ready: boolean) => setPaneReady("source-control", key, ready),
    [setPaneReady],
  );
  const setSourceGraphReady = useCallback(
    (key: string, ready: boolean) => setPaneReady("pull-requests", key, ready),
    [setPaneReady],
  );
  const selectedSurfaceReady = contentReady;
  const selectedSurfaceDataReady = contentReady
    && (gitSurfaceSelected ? dockGitStatusReady : true);
  // Visited/revealed state is DERIVED during render and committed in an
  // effect: a render that React throws away (interrupted concurrent work,
  // StrictMode double invoke) must not poison the set, while the selected tab
  // still mounts and reveals in its FIRST paint.
  const [committedRevealed, setCommittedRevealed] =
    useState<ReadonlySet<UtilityDockTab>>(() => new Set());
  const revealedTabs = useMemo(() => {
    if (!selectedSurfaceReady
      || presentedGroup.every((pane) => committedRevealed.has(pane))) return committedRevealed;
    return new Set([...committedRevealed, ...presentedGroup]);
  }, [committedRevealed, presentedGroup, selectedSurfaceReady]);
  useEffect(() => {
    if (revealedTabs !== committedRevealed) setCommittedRevealed(revealedTabs);
  }, [committedRevealed, revealedTabs]);
  const selectedSurfaceVisible = contentReady
    && (selectedSurfaceReady || presentedGroup.every((pane) => revealedTabs.has(pane)));
  useEffect(() => {
    if (!open || !contentReady) return;
    beginBootSurface(metricSurface, presentedTab);
    reportBootSurfaceStage(metricSurface, presentedTab, "module");
    reportBootSurfaceReady(metricSurface, presentedTab, "shell");
    if (!selectedSurfaceDataReady) return;
    reportBootSurfaceStage(metricSurface, presentedTab, "data");
  }, [contentReady, metricSurface, open, presentedTab, selectedSurfaceDataReady]);
  const loadingLabel = presentedTab === "search" ? t("Preparing Search…")
    : presentedTab === "source-control" ? t("Preparing Source Control…")
      : presentedTab === "pull-requests" ? t("Preparing Pull Requests…")
        : t("Preparing Agents…");
  // Instant switching (user: 탭 전환이 즉시 되어야 한다): a tab the user has
  // actually opened keeps its layer mounted for the life of the dock, so a
  // round trip re-presents the SAME DOM with its tree/SCM/PR expansion,
  // scroll and draft state intact instead of rebuilding it. Layers mount
  // lazily on first selection, so an unopened surface still allocates no DOM
  // and starts no background reads; every retained-but-inactive layer is
  // presentation-only (inert + aria-hidden) and passes active=false down, so
  // no second surface polls, fetches or duplicates the active effects.
  const [committedTabs, setCommittedTabs] =
    useState<ReadonlySet<UtilityDockTab>>(() => new Set());
  const mountedTabs = useMemo(() => {
    if ((!open && !prewarm) || !contentReady
      || presentedGroup.every((pane) => committedTabs.has(pane))) return committedTabs;
    return new Set([...committedTabs, ...presentedGroup]);
  }, [committedTabs, contentReady, open, presentedGroup, prewarm]);
  useEffect(() => {
    if (mountedTabs !== committedTabs) setCommittedTabs(mountedTabs);
  }, [committedTabs, mountedTabs]);
  const paneMounted = (pane: UtilityDockTab) => contentReady && mountedTabs.has(pane);
  const paneActive = (pane: UtilityDockTab) => open && presentedGroup.includes(pane);
  const dockTitle = title || (presentedTab === "agents" ? "Agents"
    : presentedTab === "search" ? "Search"
    : presentedTab === "pull-requests" ? "Pull Requests"
        : "Source Control");
  if (!desktopUtilityDockTabEnabled(tab)) return null;
  return <aside
    className="utility-dock"
    data-state={open ? "open" : "closed"} data-entering={entering ? "true" : undefined}
    aria-hidden={open ? undefined : true}
    inert={open ? undefined : true}
    aria-label={t("Utility panel")}>
    {showTitle && <header {...titleDragProps} className="utility-dock-header">
      <b>{dockTitle}</b>
    </header>}
    <div className="stable-surface-switch utility-dock-body"
      data-ready={selectedSurfaceVisible ? "true" : "false"}
      data-transitioning="false">
      {desktopUtilityDockTabEnabled("agents") && paneMounted("agents") &&
      <UtilityDockViewSection active={paneActive("agents")}>
      <DockPane tab="agents" active={paneActive("agents")}>
      <AgentActivityPane active={paneActive("agents")}
        sessions={sessions}
        activeSessionIds={activeSessionIds}
        unreadSessionIds={unreadSessionIds}
        onPrefetchSession={onPrefetchSession}
        onOpenLeadSession={onOpenLeadSession}
        onOpenSession={onOpenAgentSession} />
      </DockPane>
      </UtilityDockViewSection>}
      {desktopUtilityDockTabEnabled("search") && paneMounted("search") &&
      <UtilityDockViewSection active={paneActive("search")}>
      <DockPane tab="search" active={paneActive("search")}>
      {/* The project switcher rides above the search field and its filters
          (user: 검색창 필터 위에 프로젝트 선택이 사라짐). */}
      {dockProjectOptions.length > 0 && <div className="utility-dock-project-row"
        title={dockProjectPath || t("Select project")}>
        {projectSelectControl}
      </div>}
      <SearchPane
        projectPath={dockProjectPath}
        gitStatus={dockGitStatus}
        active={paneActive("search")}
        onOpenFile={onOpenFile} onOpenFileAt={resolvedOpenFileAt} />
      </DockPane>
      </UtilityDockViewSection>}
      {desktopUtilityDockTabEnabled("source-control") && paneMounted("source-control")
        && <UtilityDockViewSection active={paneActive("source-control")}>
      <DockPane tab="source-control" active={paneActive("source-control")}>
      <MemoSourceControlDock
        projectPath={dockProjectPath}
        projectSelect={null}
        status={dockGitStatus}
        statusReady={dockGitStatusReady}
        loading={dockGitLoading}
        statusError={dockGitError}
        onRefreshStatus={refreshDockGitStatus}
        headerSlot={null}
        active={paneActive("source-control")}
        readinessKey={surfaceKeys["source-control"]}
        onReadyChange={setSourceControlReady}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff} />
      </DockPane>
      </UtilityDockViewSection>}
      {desktopUtilityDockTabEnabled("pull-requests") && paneMounted("pull-requests")
        && <UtilityDockViewSection active={paneActive("pull-requests")}>
      <DockPane tab="pull-requests" active={paneActive("pull-requests")}>
      <MemoSourceControlDock
        surface="prs"
        projectPath={dockProjectPath}
        status={dockGitStatus}
        statusReady={dockGitStatusReady}
        loading={dockGitLoading}
        statusError={dockGitError}
        onRefreshStatus={refreshDockGitStatus}
        headerSlot={null}
        active={paneActive("pull-requests")}
        readinessKey={surfaceKeys["pull-requests"]}
        onReadyChange={setSourceGraphReady}
        onOpenFile={onOpenFile}
        onOpenPullRequest={onOpenPullRequest}
        onOpenDiff={onOpenDiff} />
      </DockPane>
      </UtilityDockViewSection>}
      {!selectedSurfaceVisible && <div className="pane-surface-cover"
        role={tab === "source-control" ? "status" : undefined}
        aria-label={tab === "source-control" ? loadingLabel : undefined}>
        {/* A genuinely uncached project gets an opaque target shell, not a
            spinner that appears briefly and makes the final body pop. */}
        {tab !== "source-control" && <DesktopLoadingSurface label={loadingLabel} />}
      </div>}
    </div>
  </aside>;
});
