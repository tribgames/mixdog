import {
  Files,
  GitBranch,
  GitCompare,
  Github,
  Search,
  X,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  DesktopGitBranch,
  DesktopGitStatus,
  DesktopProjectSummary,
  DesktopWorkspaceFolder,
  DesktopWorkspaceTextFileResult,
  DesktopWorkspaceTextSearchOptions,
} from "../shared/contract";
import { DESKTOP_UTILITY_DOCK_MIN_WIDTH } from "../shared/window-layout";
import { AgentActivityPane, liveTaskCount } from "./AgentActivityPane";
import { OpenSelect } from "./OpenSelect";
import { DesktopLoadingSurface } from "./RendererRecovery";
import type { PullRequestOpenHandler } from "./PullRequestsPane";
import { SourceControlDock, type SourceControlDiffRequest } from "./SourceControlDock";
import { SurfaceActiveContext } from "./surface-activity";
import { findPatch } from "./TranscriptView";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import { EMPTY_TRANSCRIPT_ITEMS, type Snapshot, type TranscriptItem } from "./desktop-types";
import { desktopUtilityDockTabEnabled } from "./desktop-feature-config";
import { FilesRootPane, SetiFileIcon } from "./ExplorerTree";
import { t } from "./i18n";
import {
  cancelLayoutFrame,
  flushLayoutFrame,
  scheduleLayoutFrame,
} from "./interaction-frame-scheduler";
import { scheduleEditorPanePrefetch } from "./lazy-widgets";
import { parseUnifiedDiff } from "./renderer-logic.mjs";

const MemoSourceControlDock = memo(SourceControlDock);

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

export const DOCK_STATE_KEY = 'mixdog.desktop-utility-dock.v1';
export const DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH = 320;
export const DESKTOP_UTILITY_DOCK_MAX_WIDTH = 560;
// Search stays folded INTO Explorer (user: 통합해서 간단하게 — Orca grammar);
// the pane is named Explorer while the id stays 'files' for
// persisted-state compatibility. 'pull-requests' is the PR-only surface split
// out of Source Control (Orca grammar: Changes|History / Pull Requests).
export type UtilityDockTab = 'tasks' | 'files' | 'source-control' | 'pull-requests';
export function clampDockWidth(value: number): number {
  return Math.min(DESKTOP_UTILITY_DOCK_MAX_WIDTH, Math.max(
    DESKTOP_UTILITY_DOCK_MIN_WIDTH,
    Math.round(Number.isFinite(value) ? value : DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH),
  ));
}
export function readDockState(): { open: boolean; tab: UtilityDockTab; width: number } {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DOCK_STATE_KEY) || '{}') as Record<string, unknown>;
    return {
      open: raw.open === true,
      // `agents` is the legacy first-tab key; migrate it to the broader Tasks
      // surface without invalidating the rest of the persisted dock state.
      // `terminal` and `agents` are legacy Dock tabs. Standalone Terminal
      // workspace tabs replace the former, while Agents folded into Tasks.
      tab: raw.tab === 'files' || raw.tab === 'search' || raw.tab === 'source-control' || raw.tab === 'pull-requests'
        ? (raw.tab === 'search' ? 'files' : raw.tab) : 'tasks',
      width: clampDockWidth(Number(raw.width)),
    };
  } catch {
    return { open: false, tab: 'tasks', width: DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH };
  }
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

const FilesPane = memo(function FilesPane({
  projectPath,
  gitStatus,
  gitStatusReady,
  changed,
  activeFileKey,
  active,
  readinessKey,
  onReadyChange,
  onOpenFile,
  onOpenFileAt,
  showRootHeader = false,
  headerSlot,
}: {
  projectPath: string;
  gitStatus: DesktopGitStatus | null;
  gitStatusReady: boolean;
  changed: Set<string>;
  activeFileKey: string;
  active: boolean;
  readinessKey: string;
  onReadyChange(key: string, ready: boolean): void;
  onOpenFile?(project: string, rel: string, mode?: "preview" | "pinned"): void;
  onOpenFileAt?(project: string, rel: string, line?: number): void;
  showRootHeader?: boolean;
  headerSlot?: HTMLElement | null;
}) {
  const folders = useMemo<DesktopWorkspaceFolder[]>(
    () => projectPath ? [{ path: projectPath }] : [],
    [projectPath],
  );
  const rootKeys = useMemo(
    () => folders.map((folder) => `${readinessKey}:${folder.path}`),
    [folders, readinessKey],
  );
  const [readyRoots, setReadyRoots] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setReadyRoots(new Set()), [readinessKey]);
  useEffect(() => {
    onReadyChange(
      readinessKey,
      gitStatusReady && (rootKeys.length === 0 || rootKeys.every((key) => readyRoots.has(key))),
    );
  }, [gitStatusReady, onReadyChange, readinessKey, readyRoots, rootKeys]);
  const onRootReady = useCallback((key: string, ready: boolean) => {
    setReadyRoots((current) => {
      if (current.has(key) === ready) return current;
      const next = new Set(current);
      if (ready) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  // Orca explorer grammar (user: 통합해서 간단하게): search lives INSIDE the
  // file tree — Names filters paths, Contents runs full-text search with
  // the same plain query field. An empty query keeps the plain tree.
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
    window.addEventListener("mixdog:focus-explorer-search", focusSearch);
    return () => window.removeEventListener("mixdog:focus-explorer-search", focusSearch);
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
        ONE Project concept — no VS Code multi-root workspace UI (user:
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
      <div className="workbench-search-mode" role="tablist" aria-label={t("Explorer search mode")}>
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
    ) : <>
    {folders.length === 0
      ? <p className="utility-dock-empty">{t("Open a project to browse files.")}</p>
      : folders.map((folder) => {
        const key = `${readinessKey}:${folder.path}`;
        return <FilesRootPane key={folder.path}
          projectPath={folder.path}
          gitStatus={gitStatus}
          changed={changed}
          activeFileKey={activeFileKey}
          active={active}
          showRootHeader={showRootHeader || folders.length > 1}
          rootLabel={folder.name}
          headerSlot={headerSlot}
          readinessKey={key}
          onReadyChange={onRootReady}
          onOpenFile={onOpenFile}
 />;
      })}
    </>}
  </div>;
});


export const UtilityDock = memo(function UtilityDock({
  open,
  width,
  tab,
  onTab,
  onResize,
  onClose,
  snapshot,
  projectPath = "",
  workspaceFolders,
  onSelectProject,
  activeFileKey = "",
  onOpenFile,
  onOpenDiff,
  onOpenPullRequest,
  onOpenFileAt,
  onOpenAgentSession,
  entering = false,
  contentReady = true,
  side = "right",
  showTabs = true,
  title,
  metricSurface = side === "left" ? "sidebar" : "dock",
}: {
  open: boolean;
  width: number;
  tab: UtilityDockTab;
  onTab(tab: UtilityDockTab): void;
  onResize(width: number): void;
  onClose?(): void;
  snapshot: Snapshot;
  projectPath?: string;
  workspaceFolders?: readonly DesktopWorkspaceFolder[];
  /** Main App owns the shared Explorer / Source Control / Pull Requests
   *  project cache. Standalone hosts omit this and keep a local override. */
  onSelectProject?(projectPath: string): void;
  activeFileKey?: string;
  onOpenFile?(project: string, rel: string, mode?: "preview" | "pinned"): void;
  onOpenDiff?(project: string, rel: string, request: SourceControlDiffRequest): void;
  onOpenPullRequest?: PullRequestOpenHandler;
  onOpenFileAt?(project: string, rel: string, line?: number): void;
  onOpenAgentSession?(sessionId: string, title: string, ownerSessionId: string): void;
  /** Surface re-entry: render already-open, without the slide-in replay. */
  entering?: boolean;
  /** The shell may pre-mount at width 0; defer the expensive selected body. */
  contentReady?: boolean;
  /** VS Code workbench uses this surface as a left Primary Side Bar. */
  side?: "left" | "right";
  /** Activity Bar owns view selection in the coding workbench. */
  showTabs?: boolean;
  title?: string;
  metricSurface?: "sidebar" | "dock";
}) {
  const resolvedOpenFileAt = onOpenFileAt
    ?? onOpenFile as ((project: string, rel: string, line?: number) => void) | undefined;
  // A controlled App shares one selection across Explorer / Source Control /
  // Pull Requests. Standalone mounts retain the historical local override.
  const [localProjectOverride, setLocalProjectOverride] = useState("");
  const [knownProjects, setKnownProjects] = useState<DesktopProjectSummary[]>([]);
  const [filesHeaderActionsSlot, setFilesHeaderActionsSlot] = useState<HTMLSpanElement | null>(null);
  const [headerActionsSlot, setHeaderActionsSlot] = useState<HTMLSpanElement | null>(null);
  const [reviewHeaderActionsSlot, setReviewHeaderActionsSlot] = useState<HTMLSpanElement | null>(null);
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
  // Files owns its project toolbar inside the stable Files layer, but the
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
    tasks: `tasks:${String(snapshot.sessionId || "draft")}`,
    files: `files:${projectKey}`,
    "source-control": `source-control:${dockProjectPath}`,
    "pull-requests": `pull-requests:${dockProjectPath}`,
  };
  const gitRequestEpoch = useRef(0);
  const [dockGitState, setDockGitState] = useState<{
    projectPath: string;
    status: DesktopGitStatus | null;
    loading: boolean;
    ready: boolean;
    error: string;
  }>({
    projectPath: "",
    status: null,
    loading: false,
    ready: false,
    error: "",
  });
  const refreshDockGitStatus = useCallback(async (showLoading = false) => {
    const currentProject = dockProjectPath;
    const epoch = ++gitRequestEpoch.current;
    if (!currentProject) {
      setDockGitState({
        projectPath: "",
        status: null,
        loading: false,
        ready: true,
        error: "",
      });
      return;
    }
    if (showLoading) {
      setDockGitState((current) => ({
        projectPath: currentProject,
        status: current.projectPath === currentProject ? current.status : null,
        loading: true,
        // A visible/cached snapshot remains authoritative while its silent
        // refresh runs. Invalidating it here replayed the full Preparing
        // Source Control cover on every tab re-entry.
        ready: current.projectPath === currentProject && current.ready,
        error: current.projectPath === currentProject ? current.error : "",
      }));
    }
    const gitStatus = window.mixdogDesktop?.gitStatus;
    if (typeof gitStatus !== "function") {
      setDockGitState({
        projectPath: currentProject,
        status: null,
        loading: false,
        ready: true,
        error: "",
      });
      return;
    }
    try {
      const status = await gitStatus(currentProject) ?? null;
      if (epoch !== gitRequestEpoch.current) return;
      setDockGitState({
        projectPath: currentProject,
        status,
        loading: false,
        ready: true,
        error: "",
      });
    } catch (reason) {
      if (epoch !== gitRequestEpoch.current) return;
      setDockGitState({
        projectPath: currentProject,
        status: null,
        loading: false,
        ready: true,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }, [dockProjectPath]);
  // Git I/O follows INTENT, not mere dock presence: while Agents is selected
  // (or a Git surface was never opened) the dock issues no gitStatus at all.
  // The first Git tab selection loads it, and the silent 2s poll runs only
  // while a Git surface is the presented one. The cached snapshot survives in
  // dockGitState, so re-entry stays instant without background traffic.
  const gitSurfaceSelected = tab === "files" || tab === "source-control"
    || tab === "pull-requests";
  useEffect(() => {
    if (!open || !contentReady || !dockProjectPath || !gitSurfaceSelected) return undefined;
    void refreshDockGitStatus(true);
    const refresh = () => void refreshDockGitStatus();
    const timer = window.setInterval(refresh, 2_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("mixdog:git-changed", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("mixdog:git-changed", refresh);
    };
  }, [contentReady, dockProjectPath, gitSurfaceSelected, open, refreshDockGitStatus]);
  // Boot preload (user: 호버 말고 부트 프리로드는 백그라운드에서): the intent
  // rule above still owns live polling, but ONE idle-time gitStatus per
  // project warms dockGitState before the first Git tab entry, so Search /
  // Source Control / Pull Requests reveal without the Preparing… cover. The
  // root listing rides along to heat the Search tree's first listProjectDir;
  // no interval, and nothing runs while a Git surface is already selected.
  const warmedGitProject = useRef("");
  useEffect(() => {
    if (!dockProjectPath || gitSurfaceSelected) return undefined;
    if (warmedGitProject.current === dockProjectPath) return undefined;
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
      void window.mixdogDesktop?.listProjectDir?.(dockProjectPath, "")
        .catch(() => undefined);
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
  const dockGitMatchesProject = dockGitState.projectPath === dockProjectPath;
  const dockGitStatus = dockGitMatchesProject ? dockGitState.status : null;
  const dockGitStatusReady = !dockProjectPath || (dockGitMatchesProject && dockGitState.ready);
  const dockGitLoading = dockGitMatchesProject && dockGitState.loading;
  const dockGitError = dockGitMatchesProject ? dockGitState.error : "";
  // PR context-row branch switcher (user: 저기서도 브랜치 바꿀 수 있어야):
  // local branches load with the PR tab and refresh when the checked-out
  // branch moves; checkout rides the same status refresh path as SCM.
  const [prBranches, setPrBranches] = useState<DesktopGitBranch[]>([]);
  useEffect(() => {
    if (!open || tab !== "pull-requests" || !dockProjectPath) return undefined;
    let live = true;
    void window.mixdogDesktop?.gitBranches?.(dockProjectPath)
      .then((rows) => { if (live) setPrBranches(rows ?? []); })
      .catch(() => { /* the row simply keeps the current branch only */ });
    return () => { live = false; };
  }, [open, tab, dockProjectPath, dockGitStatus?.branch]);
  const prBranchOptions = useMemo(() => {
    const names = prBranches.filter((branch) => !branch.remote).map((branch) => branch.name);
    const current = dockGitStatus?.branch || "";
    const all = current && !names.includes(current) ? [current, ...names] : names;
    return all.map((name) => ({ value: name, label: name }));
  }, [prBranches, dockGitStatus?.branch]);
  const checkoutPrBranch = useCallback((branch: string) => {
    if (!dockProjectPath || !branch || branch === dockGitStatus?.branch) return;
    void window.mixdogDesktop?.gitCheckoutBranch?.(dockProjectPath, branch)
      .catch(() => undefined)
      .then(() => refreshDockGitStatus(true));
  }, [dockProjectPath, dockGitStatus?.branch, refreshDockGitStatus]);
  const [readyPaneKeys, setReadyPaneKeys] = useState<Partial<Record<UtilityDockTab, string>>>({});
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
  const setFilesReady = useCallback(
    (key: string, ready: boolean) => setPaneReady("files", key, ready),
    [setPaneReady],
  );
  const setSourceControlReady = useCallback(
    (key: string, ready: boolean) => setPaneReady("source-control", key, ready),
    [setPaneReady],
  );
  const setSourceGraphReady = useCallback(
    (key: string, ready: boolean) => setPaneReady("pull-requests", key, ready),
    [setPaneReady],
  );
  const selectedSurfaceKey = surfaceKeys[tab];
  // Source Control is synchronous once the shared Git snapshot is ready.
  // Waiting for its post-commit child effect manufactured a cold transition
  // even when Files had already populated that exact project snapshot.
  const selectedSurfaceReady = contentReady && (tab === "files"
    ? readyPaneKeys.files === selectedSurfaceKey
    : tab === "source-control" || tab === "pull-requests" ? dockGitStatusReady : true);
  // Visited/revealed state is DERIVED during render and committed in an
  // effect: a render that React throws away (interrupted concurrent work,
  // StrictMode double invoke) must not poison the set, while the selected tab
  // still mounts and reveals in its FIRST paint.
  const [committedRevealed, setCommittedRevealed] =
    useState<ReadonlySet<UtilityDockTab>>(() => new Set());
  const revealedTabs = useMemo(() => {
    if (!selectedSurfaceReady || committedRevealed.has(tab)) return committedRevealed;
    return new Set([...committedRevealed, tab]);
  }, [committedRevealed, selectedSurfaceReady, tab]);
  useEffect(() => {
    if (revealedTabs !== committedRevealed) setCommittedRevealed(revealedTabs);
  }, [committedRevealed, revealedTabs]);
  const selectedSurfaceVisible = contentReady
    && (selectedSurfaceReady || revealedTabs.has(tab));
  useEffect(() => {
    if (!open || !contentReady) return;
    beginBootSurface(metricSurface, tab);
    reportBootSurfaceStage(metricSurface, tab, "module");
    if (!selectedSurfaceReady) return;
    reportBootSurfaceStage(metricSurface, tab, "data");
    reportBootSurfaceReady(metricSurface, tab);
  }, [contentReady, metricSurface, open, selectedSurfaceReady, tab]);
  const loadingLabel = tab === "files" ? t("Preparing Search…")
    : tab === "source-control" ? t("Preparing Source Control…")
      : tab === "pull-requests" ? t("Preparing Pull Requests…")
        : t("Preparing Agents…");
  const presentedTab = tab;
  const taskCount = liveTaskCount(snapshot);
  useEffect(() => {
    if (open && presentedTab === "tasks" && taskCount === 0) onClose?.();
  }, [onClose, open, presentedTab, taskCount]);
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
    if (!open || !contentReady || committedTabs.has(tab)) return committedTabs;
    return new Set([...committedTabs, tab]);
  }, [committedTabs, contentReady, open, tab]);
  useEffect(() => {
    if (mountedTabs !== committedTabs) setCommittedTabs(mountedTabs);
  }, [committedTabs, mountedTabs]);
  const paneMounted = (pane: UtilityDockTab) => contentReady && mountedTabs.has(pane);
  const paneActive = (pane: UtilityDockTab) => open && presentedTab === pane;
  // Files tab: session-changed files marked with a dot (A/M markers reduced
  // to one changed indicator).
  const changedFileNames = useMemo(() => contentReady ? new Set(
    sessionFileChanges((snapshot.items as TranscriptItem[]) || EMPTY_TRANSCRIPT_ITEMS)
      .map((file) => file.name.replace(/^[ab]\//, "").replace(/\\/g, "/")),
  ) : new Set<string>(), [contentReady, snapshot.items]);
  const dockNode = useRef<HTMLElement | null>(null);
  const resizeWidth = useRef(width);
  const resizeActive = useRef(false);
  const resizeCleanup = useRef<(() => void) | null>(null);
  const resizeFrameKey = useRef({});
  // Floor-overlap (restored after a concurrent-edit clobber): once the
  // workspace column is at its min-width floor, a wider dock must OVERLAY the
  // workspace instead of pushing the workbench into horizontal scroll (user
  // decision). The negative margin on the workspace-adjacent edge re-fits the
  // flex row exactly at the floor; reset-then-measure keeps it idempotent.
  const syncDockOverlay = useCallback(() => {
    const dock = dockNode.current;
    const parent = dock?.parentElement;
    if (!dock || !parent) return;
    const marginProp = side === "left" ? "marginRight" : "marginLeft";
    dock.style.marginLeft = "";
    dock.style.marginRight = "";
    if (dock.dataset.state !== "open") {
      delete dock.dataset.overlaying;
      return;
    }
    const shortage = Math.max(0, parent.scrollWidth - parent.clientWidth);
    const overlap = Math.min(shortage, dock.offsetWidth);
    if (overlap > 0) {
      dock.style[marginProp] = `-${overlap}px`;
      dock.dataset.overlaying = "true";
    } else {
      delete dock.dataset.overlaying;
    }
  }, [side]);
  useLayoutEffect(() => {
    syncDockOverlay();
  }, [open, width, side, syncDockOverlay]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const parent = dockNode.current?.parentElement;
    if (!parent) return undefined;
    // Parent size never derives from this dock's margin, so no feedback loop.
    const observer = new ResizeObserver(() => syncDockOverlay());
    observer.observe(parent);
    return () => observer.disconnect();
  }, [syncDockOverlay]);
  if (!resizeActive.current) resizeWidth.current = width;
  useEffect(() => () => resizeCleanup.current?.(), []);
  useEffect(() => {
    if (resizeActive.current && width === resizeWidth.current) {
      resizeActive.current = false;
    }
  }, [width]);
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = width;
    let pendingWidth = width;
    resizeCleanup.current?.();
    resizeActive.current = true;
    resizeWidth.current = width;
    const applyWidth = (value: number) => {
      pendingWidth = clampDockWidth(value);
      resizeWidth.current = pendingWidth;
      const dock = dockNode.current;
      if (!dock) return;
      dock.style.setProperty("--utility-dock-width", `${pendingWidth}px`);
      dock.style.width = `${pendingWidth}px`;
      dock.style.flexBasis = `${pendingWidth}px`;
      syncDockOverlay();
    };
    const move = (moveEvent: PointerEvent) => {
      pendingWidth = clampDockWidth(startWidth + (
        side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX
      ));
      scheduleLayoutFrame(resizeFrameKey.current, () => applyWidth(pendingWidth));
    };
    let cleaned = false;
    const cleanup = (commit: boolean) => {
      if (cleaned) return;
      cleaned = true;
      if (commit) flushLayoutFrame(resizeFrameKey.current);
      else cancelLayoutFrame(resizeFrameKey.current);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      try {
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      } catch { /* capture already released */ }
      if (resizeCleanup.current === dispose) resizeCleanup.current = null;
      if (commit && pendingWidth !== width) onResize(pendingWidth);
      else {
        resizeActive.current = false;
        syncDockOverlay();
      }
    };
    const stop = () => cleanup(true);
    const dispose = () => cleanup(false);
    // Capture keeps move/up events flowing when the pointer leaves the
    // window; pointercancel/blur reap the drag when the up never arrives
    // (release outside the window, alt-tab) — otherwise the listeners leak
    // and the dock keeps resizing on bare mouse moves (zombie drag).
    try { handle.setPointerCapture?.(pointerId); } catch { /* best-effort */ }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    resizeCleanup.current = dispose;
  };
  const displayedWidth = resizeActive.current ? resizeWidth.current : width;
  const dockTitle = title || (presentedTab === "tasks" ? "Tasks"
    : presentedTab === "files" ? "Explorer"
    : presentedTab === "pull-requests" ? "Pull Requests"
        : "Source Control");
  if (!open || !desktopUtilityDockTabEnabled(tab)) return null;
  return <aside ref={dockNode}
    className="utility-dock utility-dock--persistent"
    data-state="open" data-entering={entering ? "true" : undefined}
    data-side={side} data-show-tabs={showTabs ? "true" : "false"}
    style={{
      "--utility-dock-width": `${displayedWidth}px`,
      "--utility-dock-min-width": `${DESKTOP_UTILITY_DOCK_MIN_WIDTH}px`,
      "--utility-dock-max-width": `${DESKTOP_UTILITY_DOCK_MAX_WIDTH}px`,
      width: open ? displayedWidth : 0,
      flexBasis: open ? displayedWidth : 0,
      minWidth: open ? DESKTOP_UTILITY_DOCK_MIN_WIDTH : 0,
      maxWidth: open ? DESKTOP_UTILITY_DOCK_MAX_WIDTH : 0,
      // The stored width is a preference, not permission to push the desktop
      // beyond its viewport. The right Dock yields down to its 300px floor
      // and naturally returns to the preferred width when space comes back.
      flexShrink: open && showTabs && side === "right" ? 1 : 0,
    } as React.CSSProperties}
    aria-label={t("Utility panel")}>
    <div className="utility-dock-resize" role="separator" aria-orientation="vertical"
      aria-label={t("Resize utility panel")} onPointerDown={startResize} />
    {showTabs && <header className="utility-dock-tabs-header" data-active-tab={presentedTab}>
      <nav className="utility-dock-tabs" aria-label={t("Utility panel tabs")}>
        {desktopUtilityDockTabEnabled("files") && <button type="button" className={presentedTab === "files" ? "active" : ""}
          aria-label={t("Explorer")} aria-current={presentedTab === "files" ? "page" : undefined}
          data-tooltip={t("Explorer")}
          onClick={() => onTab("files")}><Files size={18} aria-hidden="true" /></button>}
        {desktopUtilityDockTabEnabled("source-control") && <button type="button" className={presentedTab === "source-control" ? "active" : ""}
          aria-label={t("Source Control")}
          aria-current={presentedTab === "source-control" ? "page" : undefined}
          data-tooltip={t("Source Control")}
          onClick={() => onTab("source-control")}><GitCompare size={18} aria-hidden="true" /></button>}
        {desktopUtilityDockTabEnabled("pull-requests") && <button type="button" className={presentedTab === "pull-requests" ? "active" : ""}
          aria-label={t("GitHub Pull Requests")}
          aria-current={presentedTab === "pull-requests" ? "page" : undefined}
          data-tooltip={t("GitHub Pull Requests")}
          onClick={() => onTab("pull-requests")}><Github size={18} aria-hidden="true" /></button>}
      </nav>
    </header>}
    {!showTabs && <header className="utility-dock-header"><b>{dockTitle}</b></header>}
    <div className="stable-surface-switch utility-dock-body"
      data-ready={selectedSurfaceVisible ? "true" : "false"}
      data-transitioning="false">
      {desktopUtilityDockTabEnabled("tasks") && paneMounted("tasks") && <DockPane tab="tasks" active={paneActive("tasks")}>
      {showTabs && <header className="utility-dock-header" data-panel-header="tasks">
        <div className="utility-dock-title"><b>{t(title || "Tasks")}</b></div>
      </header>}
      <AgentActivityPane active={paneActive("tasks")}
        snapshot={snapshot}
        onOpenSession={onOpenAgentSession} />
      </DockPane>}
      {desktopUtilityDockTabEnabled("files") && paneMounted("files") && <DockPane tab="files" active={paneActive("files")}>
      {showTabs && <header className="utility-dock-header" data-panel-header="files">
        <div className="utility-dock-title"><b>{t(title || "Explorer")}</b></div>
        <span className="utility-dock-header-actions utility-dock-file-actions"
          ref={setFilesHeaderActionsSlot} />
      </header>}
      {showTabs && dockProjectOptions.length > 0 && <div className="utility-dock-project-row"
        title={dockProjectPath || t("Select project")}>
        {projectSelectControl}
      </div>}
      <FilesPane
        projectPath={dockProjectPath}
        gitStatus={dockGitStatus}
        gitStatusReady={dockGitStatusReady}
        changed={changedFileNames} activeFileKey={activeFileKey}
        active={paneActive("files")}
        showRootHeader={!showTabs}
        headerSlot={showTabs ? filesHeaderActionsSlot : null}
        readinessKey={surfaceKeys.files} onReadyChange={setFilesReady}
        onOpenFile={onOpenFile} onOpenFileAt={resolvedOpenFileAt} />
      </DockPane>}
      {desktopUtilityDockTabEnabled("source-control") && paneMounted("source-control")
        && <DockPane tab="source-control" active={paneActive("source-control")}>
      {showTabs && <header className="utility-dock-header" data-panel-header="source-control">
        <div className="utility-dock-title"><b>{t(title || "Source Control")}</b></div>
        <span className="utility-dock-header-actions utility-dock-scm-actions"
          ref={setHeaderActionsSlot} />
      </header>}
      {/* The project picker is the Source Control toolbar's repository
          section now (GitHub Desktop: repository | branch | push-pull), so it
          is handed to the dock instead of sitting in its own row. */}
      <MemoSourceControlDock
        projectPath={dockProjectPath}
        projectSelect={showTabs ? projectSelectControl : null}
        status={dockGitStatus}
        statusReady={dockGitStatusReady}
        loading={dockGitLoading}
        statusError={dockGitError}
        onRefreshStatus={refreshDockGitStatus}
        headerSlot={showTabs ? headerActionsSlot : null}
        active={paneActive("source-control")}
        readinessKey={surfaceKeys["source-control"]}
        onReadyChange={setSourceControlReady}
        onOpenFile={onOpenFile}
        onOpenDiff={onOpenDiff} />
      </DockPane>}
      {desktopUtilityDockTabEnabled("pull-requests") && paneMounted("pull-requests")
        && <DockPane tab="pull-requests" active={paneActive("pull-requests")}>
      {showTabs && <header className="utility-dock-header" data-panel-header="pull-requests">
        <div className="utility-dock-title"><b>{t(title || "Pull Requests")}</b></div>
        <span className="utility-dock-header-actions utility-dock-scm-actions"
          ref={setReviewHeaderActionsSlot} />
      </header>}
      {/* SAME GitHub-Desktop context-row grammar as Source Control (user:
          풀리퀘만 프로젝트 영역이 다름): repository + branch sections on the
          shared toolbar band, and the branch slot switches branches too
          (user: 저기서도 브랜치 바꿀 수 있어야). */}
      {showTabs && dockProjectOptions.length > 0 && <div
        className="dock-scm-toolbar dock-pr-context-toolbar"
        title={dockProjectPath || t("Select project")}>
        <div className="dock-scm-toolbar-section dock-scm-toolbar-project">
          {projectSelectControl}
        </div>
        {dockGitStatus?.branch && <div
          className="dock-scm-toolbar-section dock-scm-toolbar-branch dock-pr-branch-section"
          title={dockGitStatus.upstreamName || dockGitStatus.branch}>
          <GitBranch className="dock-pr-branch-glyph" size={12} aria-hidden="true" />
          <OpenSelect ariaLabel={t("Switch branch")}
            className="dock-project-select dock-pr-branch-select"
            value={dockGitStatus.branch}
            options={prBranchOptions}
            onChange={checkoutPrBranch} />
        </div>}
      </div>}
      <MemoSourceControlDock
        surface="prs"
        projectPath={dockProjectPath}
        status={dockGitStatus}
        statusReady={dockGitStatusReady}
        loading={dockGitLoading}
        statusError={dockGitError}
        onRefreshStatus={refreshDockGitStatus}
        headerSlot={showTabs ? reviewHeaderActionsSlot : null}
        active={paneActive("pull-requests")}
        readinessKey={surfaceKeys["pull-requests"]}
        onReadyChange={setSourceGraphReady}
        onOpenFile={onOpenFile}
        onOpenPullRequest={onOpenPullRequest}
        onOpenDiff={onOpenDiff} />
      </DockPane>}
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
