import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronLeft,
  CloudUpload,
  Copy,
  FileText,
  GitBranch,
  GitCommit,
  GitMerge,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Undo2,
  X
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ProgressSpinner } from "./ProgressSpinner";
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from "./immediate-overlay";
import {
  anchoredPanelGeometry,
  intersectRects,
  rectFrom,
  viewportRect,
} from "./anchored-panel";
import type {
  DesktopGitBranch,
  DesktopGitCommitDetails,
  DesktopGitCommitFile,
  DesktopGitFile,
  DesktopGitLogEntry,
  DesktopGitStatus,
} from "../shared/contract";
import {
  PullRequestsPane,
  type PullRequestOpenHandler,
} from "./PullRequestsPane";
import { GitFileDiff } from "./ReviewPane";
import {
  ScmContextMenu,
  elementMenuPoint,
  isContextMenuKey,
  pointerMenuPoint,
  type ScmContextMenuItem,
  type ScmContextMenuState,
} from "./ScmContextMenu";
import { ScmPathText } from "./ScmPathText";
import { ScmStatusIcon, scmStatusKind, type ScmStatusKind } from "./ScmStatusIcon";
import { useSurfaceActive } from "./surface-activity";

export interface SourceControlDiffRequest {
  source: "staged" | "unstaged" | "commit";
  hash?: string;
  untracked?: boolean;
}

/** The index already carries this file and the worktree has nothing further
 *  to add, so its diff is the STAGED one — the only place the index survives
 *  as a concept now that the list speaks GitHub Desktop's checkbox grammar. */
const indexOnly = (file: DesktopGitFile): boolean =>
  !file.conflicted && file.index !== " " && file.index !== "?" && file.worktree === " ";
/** The index already carries (part of) this file. Conflicted entries are
 *  deliberately excluded: their index slots are the conflict stages, and
 *  `git reset -- <path>` on them silently resolves the file to the HEAD side. */
const stagedInIndex = (file: DesktopGitFile): boolean =>
  !file.conflicted && file.index !== " " && file.index !== "?";
/** Staged content that differs from the working tree — committing through the
 *  checkbox model would replace it with the full working-tree version. */
const partiallyStaged = (file: DesktopGitFile): boolean =>
  stagedInIndex(file) && !file.untracked && file.worktree !== " ";
const HISTORY_PAGE_SIZE = 40;
/** The two dock lists are WINDOWED (see `useRowWindow`), which only works
 *  because both row grammars own a FIXED band: the changed-file row is
 *  GitHub Desktop's 29px band (desktop.css `.dock-scm-file`, height
 *  `--dock-scm-file-row`) and the history row the 46px commit band
 *  (`.dock-scm-commit-row`, `--dock-scm-commit-row`). Change either number
 *  here and in desktop.css together — the probe
 *  (scripts/scm-geometry-probe) measures the rendered band against them. */
const SCM_FILE_ROW_HEIGHT = 29;
const SCM_COMMIT_ROW_HEIGHT = 46;
/** Rows mounted beyond each viewport edge, so a wheel tick never paints a
 *  gap and keyboard focus keeps a row to move onto. */
const SCM_ROW_OVERSCAN = 6;
/** How close to the end of the LOADED commits the window has to come before
 *  the next `gitLog` page is fetched — scrolling replaced the Load more
 *  button, so the fetch has to start before the user reaches the bottom. */
const HISTORY_PREFETCH_ROWS = 8;
/** Last-resort default-branch names. The real one is derived from the remote
 *  HEAD (see `loadDefaultBranch`); these only stand in when the repository has
 *  no remote HEAD to resolve. */
const DEFAULT_BRANCH_NAMES = ["main", "master", "trunk"];

/** The `code` the main side puts on a REFUSED dirty `--mixed` reset
 *  (main/git-cli.ts `GIT_RESET_DIRTY_CODE`). A custom Error property does not
 *  always survive the IPC boundary, so the message that refusal always carries
 *  is matched as well — it is the same refusal either way. */
const GIT_RESET_DIRTY_CODE = "git-reset-dirty-worktree";
export function isDirtyResetRefusal(reason: unknown): boolean {
  if (typeof reason === "object" && reason !== null
    && (reason as { code?: unknown }).code === GIT_RESET_DIRTY_CODE) return true;
  const message = reason instanceof Error ? reason.message : String(reason);
  return /--mixed reset rewrites the index/.test(message);
}

/** Actions that can CHANGE the repository and only THEN reject: a conflicted
 *  revert / cherry-pick / merge stops mid-way and leaves the operation state,
 *  the index and the file list behind, an interrupted pull, sync or stash pop
 *  does the same, and a multi-file discard can fail after discarding some of
 *  them. Their FAILURE has to re-read the surface exactly like their success,
 *  or the file list, the history and the Continue/Abort banner stay stale
 *  until the next poll. */
function leavesStateBehind(key: string): boolean {
  return /^(revert-commit|cherry-pick|reset|revert:|discard-all|resolve:|continue|abort-operation|branch-merge|pull|sync|stash)/
    .test(key);
}

/** Orca-style hosted-review link: derive the web repo URL from a git remote. */
export function gitRemoteWebUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  if (!trimmed) return "";
  const ssh = /^(?:ssh:\/\/)?(?:git@)?([^:/]+)[:/](.+)$/i.exec(trimmed);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (ssh && !trimmed.includes("://")) return `https://${ssh[1]}/${ssh[2]}`;
  return "";
}

/** Create-PR compare URL for hosted GitHub/GitLab-style remotes. */
export function pullRequestUrl(remoteUrl: string, branch: string): string {
  const base = gitRemoteWebUrl(remoteUrl);
  if (!base || !branch) return "";
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  if (/gitlab/i.test(base)) {
    return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
  }
  return `${base}/compare/${encoded}?expand=1`;
}

/** One status per row — GitHub Desktop's changed-file grammar
 *  (changed-file.tsx:54-55 `mapStatus`): the file's OVERALL state, never a
 *  separate index/worktree pair. The state is rendered as the reference's
 *  status ICON (ScmStatusIcon / status.ts:16-37), not a letter. */
function statusKind(file: DesktopGitFile): ScmStatusKind {
  if (file.conflicted) return "conflicted";
  if (file.untracked) return "new";
  const value = file.index !== " " && file.index !== "?" ? file.index : file.worktree;
  return scmStatusKind(value);
}

function pathsFor(file: DesktopGitFile): string[] {
  return file.oldPath ? [file.oldPath, file.path] : [file.path];
}

const SCM_SORT_KEY = "mixdog.desktop.scm-sort-key.v1";
type ScmSortKey = "path" | "name" | "status";

/** The select-all row's label, verbatim from GitHub Desktop's
 *  filter-changes-list.tsx:1263-1266 (`M of N changed files` while filtered). */
export function changedFilesLabel(total: number, visible: number): string {
  const prefix = visible !== total ? `${visible} of ` : "";
  return `${prefix}${total} changed file${total === 1 ? "" : "s"}`;
}

/** commit-list-item.tsx:127-134 labels an empty commit message instead of
 *  rendering a blank line — which also keeps it distinct from "still loading". */
const EMPTY_SUMMARY = "Empty commit message";
const UNKNOWN_AUTHOR = "Unknown author";

/** Pins an overlay to its trigger and clamps it into the allowed bounds.
 *  The dock is only DESKTOP_UTILITY_DOCK_MIN_WIDTH wide and hugs the window
 *  edge, so a CSS-anchored panel runs straight off-screen; geometry is
 *  measured instead (anchored-panel.ts). */
function useAnchoredPanel(
  open: boolean,
  trigger: React.RefObject<HTMLElement | null>,
  panel: React.RefObject<HTMLElement | null>,
  options: {
    preferredWidth: number;
    minWidth?: number;
    align?: "start" | "end";
    placement?: "below" | "above";
    boundary?: React.RefObject<HTMLElement | null>;
  },
): React.CSSProperties {
  const { preferredWidth, minWidth, align, placement, boundary } = options;
  const [style, setStyle] = useState<React.CSSProperties>({ position: "fixed" });
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = () => {
      const anchor = trigger.current;
      const surface = panel.current;
      if (!anchor || !surface) return;
      const viewport = viewportRect();
      const boundaryElement = boundary?.current;
      const bounds = boundaryElement
        ? intersectRects(rectFrom(boundaryElement), viewport)
        : viewport;
      const geometry = anchoredPanelGeometry({
        trigger: rectFrom(anchor),
        bounds,
        preferredWidth,
        minWidth,
        naturalHeight: surface.scrollHeight || surface.offsetHeight,
        align,
        placement,
      });
      setStyle({
        position: "fixed",
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        maxHeight: geometry.maxHeight,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [align, boundary, minWidth, open, panel, placement, preferredWidth, trigger]);
  return style;
}

/** The band of a fixed-height list the viewport can actually show.
 *  `leading`/`trailing` are the heights of everything NOT mounted, so the
 *  scroll container keeps the full list's scroll height and the scrollbar
 *  (and every scroll position) stays truthful. */
export interface ScmRowWindow {
  start: number;
  end: number;
  leading: number;
  trailing: number;
  /** A real viewport was measured — false under a layout-less DOM (jsdom) or
   *  while the list is not mounted, where the whole list renders instead. */
  measured: boolean;
}

/** Windowed rendering for the dock's FIXED-height lists (changed files at
 *  29px, commits at 46px). Only the rows intersecting the viewport plus
 *  `SCM_ROW_OVERSCAN` are mounted; two spacers carry the rest of the height.
 *  Rows keep their identity keys (path / hash), so recycling never moves
 *  focus or selection off the row the user is on.
 *
 *  Hand-rolled instead of the repo's @tanstack/react-virtual (Conversation's
 *  transcript): that virtualizer measures VARIABLE rows through a
 *  ResizeObserver, which this fixed 29/46px grammar does not need and which
 *  the layout-less DOM suites do not provide — here a missing measurement
 *  degrades to "render every row" instead of to an empty list. */
function useRowWindow(
  viewport: React.RefObject<HTMLElement | null>,
  rowHeight: number,
  count: number,
  active: boolean,
  /** Anything that returns the list to its top (project, filter, sort, the
   *  commit search): the window is read FROM the container, so the container
   *  is what has to move back. */
  resetKey: string,
): ScmRowWindow {
  const [metrics, setMetrics] = useState({ top: 0, height: 0 });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !active) return undefined;
    const measure = () => {
      const top = node.scrollTop;
      const height = node.clientHeight;
      setMetrics((current) =>
        current.top === top && current.height === height ? current : { top, height });
    };
    measure();
    node.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // A dragged dock edge and a growing commit box resize the viewport
    // without a scroll or a window resize; jsdom has no ResizeObserver, and
    // without one the fallback above still renders every row.
    const Observer = typeof window.ResizeObserver === "function" ? window.ResizeObserver : null;
    const observer = Observer ? new Observer(measure) : null;
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [active, count, rowHeight, viewport]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !active) return;
    node.scrollTop = 0;
    setMetrics((current) => (current.top === 0 ? current : { ...current, top: 0 }));
  }, [active, resetKey, viewport]);
  return useMemo(() => {
    const { top, height } = metrics;
    // Nothing may be hidden that the viewport could have shown: without a
    // measurement, and for a list that fits, the whole list renders.
    if (height <= 0 || count * rowHeight <= height) {
      return { start: 0, end: count, leading: 0, trailing: 0, measured: height > 0 };
    }
    const start = Math.max(0, Math.floor(top / rowHeight) - SCM_ROW_OVERSCAN);
    const end = Math.min(count, Math.max(start,
      Math.ceil((top + height) / rowHeight) + SCM_ROW_OVERSCAN));
    return {
      start,
      end,
      leading: start * rowHeight,
      trailing: (count - end) * rowHeight,
      measured: true,
    };
  }, [count, metrics, rowHeight]);
}

/** The spacers that stand in for the rows a window does not mount. */
function RowSpacer({ height, edge }: { height: number; edge: "leading" | "trailing" }) {
  return <div className="dock-scm-row-spacer" data-scm-spacer={edge}
    aria-hidden="true" style={{ height }} />;
}

export function SourceControlDock({
  projectPath,
  status,
  statusReady,
  loading: _loading,
  statusError,
  onRefreshStatus,
  headerSlot,
  active,
  readinessKey,
  onReadyChange,
  onOpenFile,
  onOpenDiff,
  onOpenPullRequest,
  projectSelect,
  surface = "changes",
}: {
  projectPath: string;
  status: DesktopGitStatus | null;
  statusReady: boolean;
  loading: boolean;
  statusError: string;
  onRefreshStatus(showLoading?: boolean): Promise<void> | void;
  headerSlot?: HTMLElement | null;
  active: boolean;
  readinessKey: string;
  onReadyChange(key: string, ready: boolean): void;
  onOpenFile?(project: string, rel: string): void;
  onOpenDiff?(project: string, rel: string, request: SourceControlDiffRequest): void;
  onOpenPullRequest?: PullRequestOpenHandler;
  /** The dock's own project picker, hosted as the toolbar's repository
   *  section (GitHub Desktop's toolbar: repository | branch | push-pull). */
  projectSelect?: React.ReactNode;
  /** 'changes' = the Git panel (Changes | History selector, Orca grammar);
   *  'prs' = the split-out Pull Requests tab (user: PR은 완전히 분리). */
  surface?: "changes" | "prs";
}) {
  const api = window.mixdogDesktop;
  const prOnly = surface === "prs";
  const [history, setHistory] = useState<DesktopGitLogEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // GitHub Desktop's commit form is a summary + a description, never one
  // blob (commit-message.tsx:1771-1852).
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  /** Settings → Git commit format: a ghost-text placeholder only (user
   *  decision: 프리셋 + 미리보기) — nothing is ever inserted into the draft —
   *  plus the auto-commit-message switch. */
  const [commitFormat, setCommitFormat] = useState<{ preset: string; template: string; auto: boolean }>(
    // Auto defaults ON (user decision); the preferences read reconciles.
    { preset: "none", template: "", auto: true },
  );
  /** ONE right-click / Menu-key menu shared by every row grammar in the dock
   *  (changed file, history commit, branch) and by the file list's View & Sort
   *  button. The per-row "…" trigger buttons are gone. */
  const [contextMenu, setContextMenu] = useState<ScmContextMenuState | null>(null);
  const viewSortMenuPoint = useRef<{ x: number; y: number } | null>(null);
  const viewSortClickGuard = useImmediateOverlayClickGuard();
  const [view, setView] = useState<"changes" | "history">("changes");
  const [selectedCommit, setSelectedCommit] = useState("");
  const [commitDetail, setCommitDetail] = useState<DesktopGitCommitDetails | null>(null);
  /** Outcome of the last SHA copy — the copy affordance's confirmation
   *  (expandable-commit-summary.tsx:443-448). `ok: false` means the clipboard
   *  was unavailable or refused, which must NOT read as "Copied". */
  const [shaCopy, setShaCopy] = useState<{ hash: string; ok: boolean } | null>(null);
  const [openCommitFile, setOpenCommitFile] = useState("");
  const [commitDiffs, setCommitDiffs] = useState<Record<string, string | null>>({});
  const historyRef = useRef<DesktopGitLogEntry[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  /** The commit count the scroll pager last requested a page FOR. A page that
   *  turns out to be all duplicates leaves the length unchanged, and without
   *  this the same skip would be re-requested forever. */
  const autoPagedSkip = useRef(-1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Checkbox state in GitHub Desktop's grammar: every changed file is
   *  INCLUDED in the next commit until it is unchecked
   *  (changed-file.tsx:30-43), so only the exceptions are tracked and files
   *  that show up later stay checked. */
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [fileFilter, setFileFilter] = useState("");
  const [sortKey, setSortKey] = useState<ScmSortKey>(() => {
    try {
      const saved = window.localStorage.getItem(SCM_SORT_KEY);
      return saved === "name" || saved === "status" ? saved : "path";
    } catch { return "path"; }
  });
  const [branches, setBranches] = useState<DesktopGitBranch[]>([]);
  /** Real default branch, resolved from the remote HEAD (see loadBranches). */
  const [defaultBranchName, setDefaultBranchName] = useState("");
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const branchPickerClickGuard = useImmediateOverlayClickGuard();
  const [branchQuery, setBranchQuery] = useState("");
  const [branchLoading, setBranchLoading] = useState(false);
  const [mergeMode, setMergeMode] = useState(false);
  const branchPickerRef = useRef<HTMLDivElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchPanelRef = useRef<HTMLDivElement>(null);
  const dockRootRef = useRef<HTMLDivElement>(null);
  /** The two windowed scroll containers (see `useRowWindow`). */
  const filesScrollRef = useRef<HTMLDivElement>(null);
  const historyScrollRef = useRef<HTMLDivElement>(null);
  // Both the row context menu and the branch picker are document.body PORTALS,
  // and the Dock keeps this pane MOUNTED (inert + aria-hidden) while another
  // tab is presented — inert cannot reach a portal that left the pane. The
  // owning surface's active signal therefore drives their VISIBLE open state,
  // so deactivation unmounts both in the same commit, before a stale Escape /
  // pointerdown handler, focus move or guarded menu action can run against a
  // surface the user has left. Outside a provider (standalone SourceControlDock
  // mounts, tests) the default is active, so nothing changes.
  const surfaceActive = useSurfaceActive();
  const visibleContextMenu = surfaceActive ? contextMenu : null;
  const branchPickerVisible = branchPickerOpen && surfaceActive;
  useEffect(() => {
    if (surfaceActive) return;
    setContextMenu(null);
    setBranchPickerOpen(false);
  }, [surfaceActive]);
  // Branch panel: reference width 365px (app/styles/ui/_branches.scss:3-16),
  // capped to the room the window actually has.
  const branchPanelStyle = useAnchoredPanel(branchPickerVisible, branchTriggerRef, branchPanelRef, {
    preferredWidth: 300,
    minWidth: 220,
    align: "start",
    placement: "below",
  });
  const chooseSortKey = (next: ScmSortKey) => {
    setSortKey(next);
    try { window.localStorage.setItem(SCM_SORT_KEY, next); } catch { /* convenience */ }
  };
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  /** The guards are also read at EXECUTION time. An open context menu holds
   *  the `busy` / `status.operation` SNAPSHOT of the render that built it, so
   *  an action started while it is open would otherwise slip past the
   *  disabled-at-render check inside those item closures. */
  const busyRef = useRef("");
  const statusRef = useRef<DesktopGitStatus | null>(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  const guardReason = useCallback((): string => {
    if (busyRef.current) return "Another Git action is running";
    const operation = statusRef.current?.operation;
    return operation ? `Finish the in-progress ${operation.replace("-", " ")} first` : "";
  }, []);
  /** Runs a menu action only if the guards STILL allow it; a stale entry
   *  reports the reason instead of acting on a repository that moved. */
  const guarded = useCallback((action: () => void) => {
    const reason = guardReason();
    if (reason) {
      setError(reason);
      return;
    }
    action();
  }, [guardReason]);
  /** …and an open menu STOPS OFFERING what it can no longer do: the guard
   *  state changing (an action starts, an operation appears) closes it. */
  const guardState = `${busy}\u0000${status?.operation ?? ""}`;
  const guardStateRef = useRef(guardState);
  useEffect(() => {
    if (guardStateRef.current === guardState) return;
    guardStateRef.current = guardState;
    setContextMenu(null);
  }, [guardState]);
  /** Right-click AND the keyboard's context key open the SAME menu; the
   *  keyboard has no pointer, so it anchors under the row instead. */
  const rowContextMenu = (label: string, items: () => ScmContextMenuItem[]) => ({
    onContextMenu: (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      commitImmediateOverlay(() =>
        setContextMenu({ label, items: items(), ...pointerMenuPoint(event) }));
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      commitImmediateOverlay(() =>
        setContextMenu({ label, items: items(), ...elementMenuPoint(event.currentTarget) }));
    },
  });
  const refresh = useCallback(async (showLoading = false) => {
    if (!projectPath) return;
    await onRefreshStatus(showLoading);
  }, [onRefreshStatus, projectPath]);

  const loadBranches = useCallback(async () => {
    if (!projectPath) return;
    if (!api?.gitBranches) {
      setBranches(status?.branch ? [{
        name: status.branch,
        current: true,
        remote: false,
        upstream: status.upstreamName,
      }] : []);
      return;
    }
    setBranchLoading(true);
    try {
      setBranches(await api.gitBranches(projectPath));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBranchLoading(false);
    }
  }, [api, projectPath, status?.branch, status?.upstreamName]);

  /** GitHub Desktop groups branches under the repository's DEFAULT branch
   *  (branch-list.tsx:378-398). `gitBranches` drops symbolic refs, so the only
   *  contract member that still carries the remote HEAD is the review base
   *  (main/git-cli.ts:806-819 resolves `refs/remotes/<remote>/HEAD`). Resolved
   *  once per project and cached; the conventional names stay as a fallback. */
  const loadDefaultBranch = useCallback(async () => {
    if (!projectPath || !api?.gitReview) return;
    try {
      const review = await api.gitReview(projectPath);
      const base = review?.base || "";
      if (!base || base === "HEAD") return;
      setDefaultBranchName(base.includes("/") ? base.slice(base.indexOf("/") + 1) : base);
    } catch { /* no remote HEAD — the conventional guess stands in */ }
  }, [api, projectPath]);

  useEffect(() => {
    if (!branchPickerVisible) return undefined;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      // The right button OPENS a row context menu; it never dismisses the
      // panel that row lives in.
      if (event.button === 2) return;
      // The panel is portaled out of the dock, so both boxes count as "inside".
      if (branchPickerRef.current?.contains(target)
        || branchPanelRef.current?.contains(target)
        || visibleContextMenu) return;
      setBranchPickerOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      // An open context menu owns Escape until it closes.
      if (visibleContextMenu) return;
      if (event.key === "Escape") setBranchPickerOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keydown, true);
    };
  }, [branchPickerVisible, visibleContextMenu]);

  const loadHistory = useCallback(async (reset = true) => {
    if (!active || !projectPath || !api?.gitLog) return;
    const skip = reset ? 0 : historyRef.current.length;
    if (reset) autoPagedSkip.current = -1;
    setHistoryLoading(true);
    try {
      const page = await api.gitLog(projectPath, historyQuery, skip, HISTORY_PAGE_SIZE);
      const next = reset
        ? page
        : [...historyRef.current, ...page.filter((entry) =>
          !historyRef.current.some((existing) => existing.hash === entry.hash))];
      historyRef.current = next;
      setHistory(next);
      setHistoryHasMore(page.length === HISTORY_PAGE_SIZE);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHistoryLoading(false);
    }
  }, [active, api, historyQuery, projectPath]);

  useEffect(() => {
    setHistory([]);
    historyRef.current = [];
    setSelectedCommit("");
    setCommitDetail(null);
    setOpenCommitFile("");
    setCommitDiffs({});
    setHistoryQuery("");
    setHistoryHasMore(false);
    setSelected(new Set());
    setExcluded(new Set());
    setFileFilter("");
    setBranches([]);
    setDefaultBranchName("");
    setBranchPickerOpen(false);
    setBranchQuery("");
    setMergeMode(false);
    setView("changes");
  }, [projectPath]);
  useEffect(() => {
    onReadyChange(readinessKey, !projectPath || statusReady);
  }, [onReadyChange, projectPath, readinessKey, statusReady]);
  // (Exclusion reconciliation lives below, next to the file list it depends on.)
  useEffect(() => {
    if (!active || view !== "history") return undefined;
    const timer = window.setTimeout(
      () => void loadHistory(true),
      historyRef.current.length ? 180 : 0,
    );
    return () => window.clearTimeout(timer);
  }, [active, historyQuery, loadHistory, view]);

  /** Everything a landed action has to re-read: the status, the branch list
   *  for branch actions, and the history for the surfaces that rewrite it. */
  const reload = useCallback(async (key: string) => {
    await refresh();
    if (key.startsWith("branch-")) await loadBranches();
    if (view === "history" || key === "commit" || key === "push"
      || key === "pull" || key === "sync" || key === "amend"
      || key === "undo-commit") {
      await loadHistory(true);
    }
  }, [loadBranches, loadHistory, refresh, view]);

  const run = useCallback(async (
    key: string,
    action: () => Promise<unknown> | undefined,
    after?: () => void,
  ) => {
    // Read from the REF, not from this closure's `busy`: a context-menu item
    // built before the running action started still carries the old snapshot.
    if (busyRef.current) return;
    busyRef.current = key;
    setBusy(key);
    setError("");
    try {
      await action();
      after?.();
      await reload(key);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      // A rejected action can have changed the repository FIRST (a conflicted
      // revert/cherry-pick, an interrupted merge), so the surface is re-read
      // instead of waiting for the poll.
      if (leavesStateBehind(key)) {
        try {
          await reload(key);
        } catch { /* the refusal above is the message that matters */ }
        // loadHistory clears the banner on a successful page, so the refusal
        // is restored after the refresh it triggered.
        setError(message);
      }
    } finally {
      busyRef.current = "";
      setBusy("");
    }
  }, [reload]);

  // ONE flat working-directory list (filter-changes-list.tsx): no staged /
  // unstaged / merge groups, just changed files with checkboxes.
  const files = useMemo(() => status?.files ?? [], [status]);
  const conflicts = useMemo(() => files.filter((file) => file.conflicted), [files]);
  const isIncluded = useCallback(
    (file: DesktopGitFile) => !file.conflicted && !excluded.has(file.path),
    [excluded],
  );
  const includedFiles = useMemo(() => files.filter(isIncluded), [files, isIncluded]);
  // Exclusions belong to files that EXIST. A path that is unchecked, then
  // disappears (discarded, committed elsewhere, stashed) must come back
  // CHECKED — the default state — when it shows up again, so the set is
  // reconciled against every refreshed status (and cleared on project switch).
  useEffect(() => {
    setExcluded((current) => {
      if (!current.size) return current;
      const present = new Set(files.map((file) => file.path));
      const next = new Set([...current].filter((path) => present.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [files]);
  const sortedFiles = useMemo(() => [...files].sort((left, right) => {
    if (sortKey === "name") {
      const leftName = left.path.split("/").at(-1) || left.path;
      const rightName = right.path.split("/").at(-1) || right.path;
      return leftName.localeCompare(rightName) || left.path.localeCompare(right.path);
    }
    if (sortKey === "status") {
      return statusKind(left).localeCompare(statusKind(right))
        || left.path.localeCompare(right.path);
    }
    return left.path.localeCompare(right.path);
  }), [files, sortKey]);
  const filterText = fileFilter.trim().toLocaleLowerCase();
  const filteredFiles = useMemo(
    () => filterText
      ? sortedFiles.filter((file) => file.path.toLocaleLowerCase().includes(filterText))
      : sortedFiles,
    [filterText, sortedFiles],
  );
  // The list is SCROLLED, never paged: every changed file is reachable and
  // only the band the viewport shows is mounted (the `Show N more` button is
  // gone). Same for the commit history below it.
  const fileWindow = useRowWindow(
    filesScrollRef,
    SCM_FILE_ROW_HEIGHT,
    filteredFiles.length,
    !prOnly && view === "changes",
    `${projectPath}\u0000${sortKey}\u0000${filterText}`,
  );
  const visibleFiles = filteredFiles.slice(fileWindow.start, fileWindow.end);
  const historyWindow = useRowWindow(
    historyScrollRef,
    SCM_COMMIT_ROW_HEIGHT,
    history.length,
    !prOnly && view === "history" && !selectedCommit,
    `${projectPath}\u0000${historyQuery}`,
  );
  const visibleHistory = history.slice(historyWindow.start, historyWindow.end);
  /** Scrolling IS the history pager now: the next `gitLog` page is fetched as
   *  the window approaches the end of the loaded commits, so the incremental
   *  fetch survives without a `Load more` button. */
  useEffect(() => {
    if (!historyWindow.measured || !historyHasMore || historyLoading) return;
    if (historyWindow.end < history.length - HISTORY_PREFETCH_ROWS) return;
    if (autoPagedSkip.current === history.length) return;
    autoPagedSkip.current = history.length;
    void loadHistory(false);
  }, [history.length, historyHasMore, historyLoading, historyWindow, loadHistory]);
  const includedVisible = filteredFiles.filter(isIncluded).length;
  const includableVisible = filteredFiles.filter((file) => !file.conflicted).length;
  const checkAllLabel = changedFilesLabel(files.length, filteredFiles.length);
  const selectedCount = selected.size;
  // Commit message = summary, blank line, description (GitHub Desktop's
  // ICommitMessage shape).
  const commitMessage = description.trim()
    ? `${summary.trim()}\n\n${description.trim()}`
    : summary.trim();
  // PR eligibility, shared by the review tab's Pull Request pane. The button
  // itself lives ONLY there now (user: PR은 완전히 분리).
  const prAhead = status?.ahead ?? 0;
  const prUrl = status && status.upstream && prAhead === 0 && !status.operation && !status.detached
    ? pullRequestUrl(status.remoteUrl || "", status.branch)
    : "";
  const visibleBranches = branches.filter((branch) =>
    !branchQuery.trim() || branch.name.toLocaleLowerCase()
      .includes(branchQuery.trim().toLocaleLowerCase()));
  // GitHub Desktop's branch grouping (branch-list.tsx:378-398): the real
  // default branch first, and only a conventional-name guess when the
  // repository exposes no remote HEAD to resolve.
  const defaultBranch = (defaultBranchName
    ? visibleBranches.find((branch) => !branch.remote && branch.name === defaultBranchName)
      ?? visibleBranches.find((branch) => branch.name.endsWith(`/${defaultBranchName}`))
    : undefined)
    ?? (defaultBranchName
      ? undefined
      : visibleBranches.find((branch) =>
        !branch.remote && DEFAULT_BRANCH_NAMES.includes(branch.name)));
  const otherBranches = visibleBranches.filter((branch) => branch !== defaultBranch);
  const setIncluded = (file: DesktopGitFile, include: boolean) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (include) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
  };
  const setAllIncluded = (include: boolean, rows: DesktopGitFile[] = filteredFiles) => {
    setExcluded((current) => {
      const next = new Set(current);
      for (const file of rows) {
        if (include) next.delete(file.path);
        else next.add(file.path);
      }
      return next;
    });
  };
  useEffect(() => {
    if (!active) return;
    let live = true;
    void api?.readGitPreferences?.().then((preferences) => {
      if (live) setCommitFormat({
        preset: String(preferences?.commitPreset || "none"),
        template: String(preferences?.commitTemplate || ""),
        auto: preferences?.autoCommitMessage === true,
      });
    }).catch(() => { /* the default placeholders remain */ });
    return () => { live = false; };
  }, [api, active]);
  // Settings → Git saves broadcast in-window so an already-open dock adopts
  // the change immediately (user: 토글 켜고 나오면 커밋 버튼이 바로 살아야 함).
  useEffect(() => {
    const onPreferences = (event: Event) => {
      const detail = (event as CustomEvent<{
        commitPreset?: string; commitTemplate?: string; autoCommitMessage?: boolean;
      }>).detail;
      if (!detail) return;
      setCommitFormat({
        preset: String(detail.commitPreset || "none"),
        template: String(detail.commitTemplate || ""),
        auto: detail.autoCommitMessage === true,
      });
    };
    window.addEventListener("mixdog:git-preferences-changed", onPreferences);
    return () => window.removeEventListener("mixdog:git-preferences-changed", onPreferences);
  }, []);
  // The conventional string mirrors Settings → Git's preset preview.
  const commitFormatLines = (commitFormat.preset === "conventional"
    ? "feat(scope): summary"
    : commitFormat.preset === "custom" ? commitFormat.template : "").split("\n");
  const summaryPlaceholder = (commitFormatLines[0] || "").trim() || "Summary (required)";
  const descriptionPlaceholder = commitFormatLines.slice(1).join("\n").trim() || "Description";
  /** Auto-message needs both the setting AND a build that carries the API. */
  const autoCommitMessage = commitFormat.auto && Boolean(api?.gitGenerateCommitMessage);
  const clearCommitDraft = () => {
    setSummary("");
    setDescription("");
  };
  /** Resolves the checkbox selection into the exact path list to commit.
   *
   *  The status prop is a POLLED snapshot, so it may already be stale: the
   *  index is therefore re-read here and every decision is taken against that
   *  fresh read. Rules:
   *   - the commit is constrained to paths the user could see AND checked,
   *   - a staged path that was never on screen aborts the commit instead of
   *     being swept into it (or silently reset),
   *   - conflicted paths are never reset (that would drop conflict stages),
   *   - replacing partially staged content is confirmed, not assumed.
   *
   *  `gitCommitPaths` (pathspec commit) makes the index churn unnecessary: git
   *  itself constrains the commit to these paths and leaves every other index
   *  entry untouched, so nothing is staged or reset around the commit. Only
   *  when the contract does not carry it does the legacy stage/unstage dance
   *  run as the fallback.
   *  Returns null when the user declines; throws when the commit must not run. */
  const prepareCommitPaths = async (): Promise<string[] | null> => {
    if (!api?.gitStatus) throw new Error("Cannot verify the working tree before committing.");
    const fresh = await api.gitStatus(projectPath);
    if (fresh.operation) {
      throw new Error(`Finish the in-progress ${fresh.operation.replace("-", " ")} before committing.`);
    }
    const freshConflicts = fresh.files.filter((file) => file.conflicted);
    if (freshConflicts.length) {
      throw new Error(`Resolve ${freshConflicts.length} conflicted file${
        freshConflicts.length === 1 ? "" : "s"} before committing.`);
    }
    // Both halves of an on-screen rename count as seen: the row shows
    // `old → new` and its checkbox commits the pair.
    const seen = new Set(files.flatMap(pathsFor));
    const selected = fresh.files.filter((file) =>
      !file.conflicted && seen.has(file.path) && !excluded.has(file.path));
    if (!selected.length) throw new Error("Select one or more files to commit.");
    const selectedPaths = new Set(selected.flatMap(pathsFor));
    const stagedNow = fresh.files.filter((file) =>
      stagedInIndex(file) && !selectedPaths.has(file.path));
    // Nothing the user never saw may be committed OR reset. That covers a
    // staged path outside the list AND every path the commit itself would
    // carry — including the OLD half of a rename the fresh read just
    // discovered, which can be a file that was recreated off-screen.
    // Both halves count on the reset side too: the fallback below resets
    // `pathsFor(file)`, so an unchecked staged RENAME whose old path was
    // never on screen must abort instead of losing that index entry.
    const unseen = [...new Set([
      ...[...selectedPaths].filter((path) => !seen.has(path)),
      ...stagedNow.flatMap(pathsFor).filter((path) => !seen.has(path)),
    ])];
    if (unseen.length) {
      const names = unseen.slice(0, 3).join(", ");
      throw new Error(
        `The index changed outside this list (${names}${unseen.length > 3 ? ", …" : ""}). `
        + "Refresh the changes list and commit again.",
      );
    }
    const byPathspec = Boolean(api?.gitCommitPaths);
    // A pathspec commit replaces the staged content of the paths it COMMITS
    // with their worktree version; the unselected staged entries it never
    // touches need no consent, so the prompt names only what is at risk.
    const partials = (byPathspec ? selected : [...selected, ...stagedNow])
      .filter(partiallyStaged);
    if (partials.length && !window.confirm(
      `${partials.length} file${partials.length === 1 ? " has" : "s have"} staged changes that `
      + "differ from the working tree:\n\n"
      + `${partials.slice(0, 5).map((file) => file.path).join("\n")}`
      + `${partials.length > 5 ? "\n…" : ""}\n\n`
      + "Committing replaces that staged content with the full working-tree version. Continue?",
    )) return null;
    const commitPaths = [...selectedPaths];
    if (byPathspec) return commitPaths;
    // The fallback only works as a WHOLE: without gitUnstage an unchecked
    // staged path would ride along, without gitStage a checked path would be
    // dropped, and without gitCommit nothing lands at all. A partial API
    // refuses instead of committing something the checkboxes never described.
    if (!api?.gitStage || !api?.gitUnstage || !api?.gitCommit) {
      throw new Error(
        "This build cannot commit the selected files: the Git commit API is incomplete "
        + "(gitCommitPaths, gitStage, gitUnstage or gitCommit is missing).",
      );
    }
    const unstagePaths = [...new Set(stagedNow.flatMap(pathsFor))]
      .filter((path) => !selectedPaths.has(path));
    if (commitPaths.length) await api.gitStage(projectPath, commitPaths);
    if (unstagePaths.length) await api.gitUnstage(projectPath, unstagePaths);
    return commitPaths;
  };
  /** ONE commit entry point for the button, the split menu and the title menu:
   *  the draft is cleared only after the commit lands, and a failing follow-up
   *  (push/sync) is reported without aborting run()'s refresh. */
  const runCommitFlow = (key: string, followUp?: () => Promise<unknown> | undefined) => {
    void run(key, async () => {
      const prepared = await prepareCommitPaths();
      if (!prepared) return;
      let message = commitMessage;
      // Auto commit message (Settings → Git): an empty summary asks the
      // maintenance model and commits with the result in ONE press. The
      // generated text NEVER lands in the form (user: 박스에 아무 메시지도
      // 안 보이고 즉시 커밋) — the accidental-trigger guard lives solely in
      // the Ctrl+Enter accelerator, which requires a typed summary.
      if (!message.trim() && autoCommitMessage && api?.gitGenerateCommitMessage) {
        const generated = await api.gitGenerateCommitMessage(projectPath, includedFiles.map(
          (file) => ({ path: file.path, ...(file.untracked ? { untracked: true } : {}) })));
        message = String(generated?.message || "").trim();
        if (!message) throw new Error("Commit message generation returned nothing.");
      }
      if (!message.trim()) throw new Error("A commit summary is required to commit.");
      // A rejected commit must never clear the draft: it throws out of run(),
      // which reports it and leaves the composer untouched.
      if (api?.gitCommitPaths) await api.gitCommitPaths(projectPath, message, prepared);
      else if (api?.gitCommit) await api.gitCommit(projectPath, message);
      else throw new Error("This build cannot commit: no Git commit API is available.");
      clearCommitDraft();
      if (!followUp) return;
      try {
        await followUp();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  };
  /** Commit is refused while git is mid-operation or conflicts are unresolved,
   *  at EVERY entry point (the operation banner's Continue owns that path). */
  const commitBlocked = Boolean(busy) || (!summary.trim() && !autoCommitMessage)
    || includedFiles.length === 0 || Boolean(status?.operation) || conflicts.length > 0;
  const toggleSelected = (file: DesktopGitFile, additive = false) => {
    const key = file.path;
    setSelected((current) => {
      if (!additive) return new Set([key]);
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const selectedActionFiles = (file: DesktopGitFile): DesktopGitFile[] => {
    if (!selected.has(file.path)) return [file];
    const rows = filteredFiles.filter((candidate) => selected.has(candidate.path));
    return rows.length ? rows : [file];
  };
  const discardFiles = async (files: DesktopGitFile[]) => {
    for (const file of files) {
      await api?.gitRevert?.(projectPath, file.path, file.untracked, "worktree");
    }
  };
  /** Clipboard for the row context menus. A clipboard that is absent (insecure
   *  context) or refuses is REPORTED — never a silent no-op. */
  const copyText = async (text: string, what: string) => {
    const clipboard = window.navigator?.clipboard;
    if (!clipboard?.writeText) {
      setError(`Could not copy the ${what}: this environment has no clipboard access.`);
      return;
    }
    try {
      await clipboard.writeText(text);
      setError("");
    } catch (reason) {
      setError(`Could not copy the ${what}: ${
        reason instanceof Error ? reason.message : String(reason)}`);
    }
  };
  /** `Copy file path` copies the ABSOLUTE path (the reference's file context
   *  menu); `Copy relative file path` copies the repository-relative one. */
  const absoluteFilePath = (rel: string): string => {
    const base = projectPath.replace(/[\\/]+$/, "");
    const windows = base.includes("\\") || /^[A-Za-z]:/.test(base);
    return windows ? `${base}\\${rel.replace(/\//g, "\\")}` : `${base}/${rel}`;
  };
  /** `View on GitHub` for one commit, derived from the remote's web URL. */
  const commitWebUrl = (hash: string): string => {
    const base = gitRemoteWebUrl(status?.remoteUrl || "");
    if (!base || !hash) return "";
    return /gitlab/i.test(base) ? `${base}/-/commit/${hash}` : `${base}/commit/${hash}`;
  };
  /** Channels this build does not carry yet: the item stays VISIBLE (nothing
   *  becomes unreachable) but says why it cannot run. */
  const missingChannel = (what: string) =>
    `${what} is not available yet: this build has no Git channel for it.`;
  /** Every history action is refused while another Git action runs or while
   *  the repository is mid-operation — the same rule the branch actions keep,
   *  and the reason the disabled item carries. */
  const historyBusyReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : "";
  /** The tag entries read `DesktopGitLogEntry.tags`, which gitLog now fills per
   *  entry (contract.ts:975-981). Only an OLDER host answers without the field
   *  at all — `refs` alone cannot tell a tag from a branch — and only then do
   *  the two tag-reading entries stay disabled, saying exactly that. */
  const TAGS_UNKNOWN = "Tag names are not available yet: this host's gitLog answers"
    + " without the per-entry `tags` field, and the mixed `refs` decorations cannot"
    + " tell a tag from a branch. Update the app so gitLog carries `tags`.";
  const commitTitle = (entry: DesktopGitLogEntry) =>
    (entry.subject ?? "").trim() || EMPTY_SUMMARY;
  /** Every destructive history action confirms first, and the prompt NAMES the
   *  commit it is about to touch (short SHA + subject). */
  const confirmCommit = (entry: DesktopGitLogEntry, question: string) =>
    window.confirm(`${question}\n\n${entry.shortHash}  ${commitTitle(entry)}`);
  /** `git reset` with the reference's mode choice (GitHub Desktop asks which
   *  reset it is before it runs one), then the confirmation. `hard` says what
   *  it destroys. */
  const resetToCommit = (entry: DesktopGitLogEntry) => {
    const answer = window.prompt(
      `Reset to ${entry.shortHash} — type the reset mode:\n\n`
      + "soft   move HEAD, keep the index and the working tree\n"
      + "mixed  move HEAD, reset the index, keep the working tree\n"
      + "hard   move HEAD and DISCARD every change made after this commit",
      "mixed",
    );
    if (answer === null) return;
    const modes = ["soft", "mixed", "hard"] as const;
    const mode = modes.find((candidate) => candidate === answer.trim().toLowerCase());
    if (!mode) {
      setError(`"${answer.trim()}" is not a reset mode — choose soft, mixed or hard.`);
      return;
    }
    if (!confirmCommit(entry, mode === "hard"
      ? "Reset the branch to this commit with --hard? Every change after it, staged"
        + " or not, is destroyed and cannot be recovered."
      : `Reset the branch to this commit with --${mode}?`)) return;
    void run(`reset:${entry.hash}`, async () => {
      const reset = (confirmedDirty: boolean) =>
        api?.gitResetToCommit?.(projectPath, entry.hash, mode, confirmedDirty);
      try {
        return await reset(false);
      } catch (reason) {
        // A `--mixed` reset REWRITES THE INDEX, so the main side refuses a
        // dirty worktree with a message that NAMES the files it would unstage
        // (git-cli.ts GIT_RESET_DIRTY_CODE) instead of doing it silently. That
        // refusal IS the reference's WarningBeforeReset (app-store.ts:
        // 5839-5846): it is shown as the warning, and a confirmed reset comes
        // back WITH the flag the main side waits for. Anything else is a real
        // Git failure and keeps travelling to the error banner.
        if (!isDirtyResetRefusal(reason)) throw reason;
        const warning = reason instanceof Error ? reason.message : String(reason);
        if (!window.confirm(
          `${warning}\n\n${entry.shortHash}  ${commitTitle(entry)}`)) return undefined;
        return await reset(true);
      }
    });
  };
  const revertCommit = (entry: DesktopGitLogEntry) => {
    if (!confirmCommit(entry, "Revert the changes in this commit? A new commit that"
      + " undoes them is created on the current branch.")) return;
    void run(`revert-commit:${entry.hash}`,
      () => api?.gitRevertCommit?.(projectPath, entry.hash));
  };
  const cherryPickCommit = (entry: DesktopGitLogEntry) => {
    if (!confirmCommit(entry, "Cherry-pick this commit onto the current branch?")) return;
    void run(`cherry-pick:${entry.hash}`,
      () => api?.gitCherryPickCommit?.(projectPath, entry.hash));
  };
  const checkoutCommit = (entry: DesktopGitLogEntry) => {
    if (!confirmCommit(entry, "Check this commit out? HEAD becomes DETACHED: new commits"
      + " belong to no branch until one is created from them.")) return;
    void run(`checkout-commit:${entry.hash}`,
      () => api?.gitCheckoutCommit?.(projectPath, entry.hash));
  };
  const createTagAt = (entry: DesktopGitLogEntry) => {
    const name = window.prompt(`Create a tag at ${entry.shortHash} (${commitTitle(entry)})`, "");
    if (name === null) return;
    if (!name.trim()) {
      setError("A tag name is required to create a tag.");
      return;
    }
    void run(`tag:${entry.hash}`,
      () => api?.gitCreateTag?.(projectPath, name.trim(), entry.hash));
  };
  /** `Delete tag <name>` — the reference names the tag in the item itself
   *  (commit-list.tsx:889-924) and one item per tag replaces its submenu. */
  const deleteTagAt = (entry: DesktopGitLogEntry, tag: string) => {
    if (!confirmCommit(entry, `Delete tag "${tag}"? The tag is removed locally.`)) return;
    void run(`tag-delete:${tag}`, () => api?.gitDeleteTag?.(projectPath, tag));
  };
  /** `Amend commit…` / `Undo commit…` (commit-list.tsx:754-771): both belong to
   *  the MOST RECENT commit only, and undo additionally to a local one. They
   *  moved here from the deleted commit split menu, which is where the
   *  reference has kept them all along. */
  const amendCommitAt = (entry: DesktopGitLogEntry) => {
    if (!confirmCommit(entry, commitMessage.trim()
      ? "Amend this commit with the message in the commit form?"
      : "Amend this commit with the currently included changes?")) return;
    void run("amend", () => api?.gitAmend?.(projectPath, commitMessage.trim() || undefined),
      clearCommitDraft);
  };
  const undoCommitAt = (entry: DesktopGitLogEntry) => {
    if (!confirmCommit(entry,
      "Undo this commit and keep all of its changes staged?")) return;
    void run("undo-commit", () => api?.gitUndoLastCommit?.(projectPath));
  };
  /** `branch-` prefix so run() reloads the branch list too. */
  const createBranchAtCommit = (entry: DesktopGitLogEntry) => {
    const name = window.prompt(
      `Create a branch at ${entry.shortHash} (${commitTitle(entry)})`, "");
    if (name === null) return;
    if (!name.trim()) {
      setError("A branch name is required to create a branch.");
      return;
    }
    void run(`branch-create-at:${entry.hash}`,
      () => api?.gitCreateBranchAtCommit?.(projectPath, name.trim(), entry.hash));
  };

  const openCommit = async (entry: DesktopGitLogEntry) => {
    if (!api?.gitShow || busy) return;
    setBusy(`show:${entry.hash}`);
    setSelectedCommit(entry.hash);
    setCommitDetail(null);
    setOpenCommitFile("");
    setCommitDiffs({});
    setShaCopy(null);
    try {
      setCommitDetail(await api.gitShow(projectPath, entry.hash));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSelectedCommit("");
    } finally {
      setBusy("");
    }
  };

  const closeCommit = () => {
    setSelectedCommit("");
    setCommitDetail(null);
    setOpenCommitFile("");
    setCommitDiffs({});
    setShaCopy(null);
  };
  /** Short SHA + copy affordance (expandable-commit-summary.tsx:434-449).
   *  The Clipboard API can be absent (insecure context) or refuse; either way
   *  the outcome is reported — announced through the header's live region and
   *  surfaced in the error banner — instead of claiming a copy that never
   *  happened. */
  const copyCommitSha = async (hash: string) => {
    const clipboard = window.navigator?.clipboard;
    if (!clipboard?.writeText) {
      setShaCopy({ hash, ok: false });
      setError("Could not copy the SHA: this environment has no clipboard access.");
      return;
    }
    try {
      await clipboard.writeText(hash);
      setShaCopy({ hash, ok: true });
    } catch (reason) {
      setShaCopy({ hash, ok: false });
      setError(`Could not copy the SHA: ${
        reason instanceof Error ? reason.message : String(reason)}`);
    }
  };
  const toggleCommitFile = async (file: DesktopGitCommitFile) => {
    if (openCommitFile === file.path) {
      setOpenCommitFile("");
      return;
    }
    setOpenCommitFile(file.path);
    if (commitDiffs[file.path] !== undefined || !api?.gitShowDiff || !selectedCommit) return;
    setCommitDiffs((current) => ({ ...current, [file.path]: null }));
    try {
      const patch = await api.gitShowDiff(projectPath, selectedCommit, file.path);
      setCommitDiffs((current) => ({ ...current, [file.path]: patch || "" }));
    } catch (reason) {
      setCommitDiffs((current) => ({
        ...current,
        [file.path]: `Error: ${reason instanceof Error ? reason.message : String(reason)}`,
      }));
    }
  };

  /** One flat checkbox row per changed file — GitHub Desktop's
   *  changed-file.tsx:30-43: checkbox (included in the next commit), dim
   *  directory, file name, then the status glyph on the trailing edge. */
  const fileRow = (file: DesktopGitFile) => {
    const included = isIncluded(file);
    const rowSelected = selected.has(file.path);
    const slash = file.path.lastIndexOf("/");
    const fileName = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    const oldSlash = file.oldPath?.lastIndexOf("/") ?? -1;
    const oldFileName = file.oldPath
      ? oldSlash >= 0 ? file.oldPath.slice(oldSlash + 1) : file.oldPath
      : "";
    const displayName = file.oldPath ? `${oldFileName} → ${fileName}` : fileName;
    const kind = statusKind(file);
    const actionFiles = selectedActionFiles(file);
    const openChange = () => onOpenDiff
      ? onOpenDiff(projectPath, file.path, {
        source: indexOnly(file) ? "staged" : "unstaged",
        ...(file.untracked ? { untracked: true } : {}),
      })
      : onOpenFile?.(projectPath, file.path);
    const discardActionFiles = () => {
      const message = actionFiles.length === 1
        ? file.untracked
          ? `Delete untracked file "${file.path}"? This cannot be undone.`
          : `Discard changes to "${file.path}"? This cannot be undone.`
        : `Discard ${actionFiles.length} selected working tree changes? This cannot be undone.`;
      if (!window.confirm(message)) return;
      void run(`revert:${file.path}`, () => discardFiles(actionFiles),
        () => setSelected(new Set()));
    };
    // The reference's file-list context menu (changed-file.tsx): discard, the
    // three .gitignore entries, the two copy-path entries, then the OS ones.
    const folder = slash >= 0 ? file.path.slice(0, slash) : "";
    const dot = fileName.lastIndexOf(".");
    const extension = dot > 0 ? fileName.slice(dot) : "";
    const fileMenuItems = (): ScmContextMenuItem[] => [
      {
        id: "discard",
        label: "Discard changes…",
        danger: true,
        disabled: Boolean(busy) || file.conflicted || !api?.gitRevert,
        title: file.conflicted
          ? "Resolve the conflict before discarding this file"
          : !api?.gitRevert ? missingChannel("Discarding changes") : undefined,
        // Guarded at EXECUTION time: this menu may have been built before the
        // running action (or the in-progress operation) existed.
        onSelect: () => guarded(discardActionFiles),
      },
      {
        id: "ignore-file",
        label: "Ignore file (add to .gitignore)",
        separatorBefore: true,
        disabled: Boolean(busy) || !api?.gitIgnore,
        title: api?.gitIgnore ? undefined : missingChannel("Ignoring a file"),
        onSelect: () => guarded(() => void run(`ignore:${file.path}`,
          () => api?.gitIgnore?.(projectPath, file.path))),
      },
      {
        id: "ignore-folder",
        label: "Ignore folder (add to .gitignore)",
        disabled: Boolean(busy) || !api?.gitIgnore || !folder,
        title: folder
          ? api?.gitIgnore ? undefined : missingChannel("Ignoring a folder")
          : "This file sits at the repository root, so it has no folder to ignore",
        onSelect: () => guarded(() => void run(`ignore:${folder}`,
          () => api?.gitIgnore?.(projectPath, folder))),
      },
      {
        id: "ignore-extension",
        label: `Ignore all ${extension || "extensionless"} files (add to .gitignore)`,
        // `scope: 'extension'` writes the UNANCHORED `*<ext>` rule from the
        // path's own extension (contract.ts:984-988); the renderer never
        // smuggles a pattern past the channel's escaping itself.
        disabled: Boolean(busy) || !api?.gitIgnore || !extension,
        title: extension
          ? api?.gitIgnore ? undefined : missingChannel("Ignoring a file type")
          : "This file has no extension, so there is no file type to ignore",
        onSelect: () => guarded(() => void run(`ignore-extension:${extension}`,
          () => api?.gitIgnore?.(projectPath, file.path, "extension"))),
      },
      {
        id: "copy-file-path",
        label: "Copy file path",
        separatorBefore: true,
        onSelect: () => void copyText(absoluteFilePath(file.path), "file path"),
      },
      {
        id: "copy-relative-path",
        label: "Copy relative file path",
        onSelect: () => void copyText(file.path, "relative file path"),
      },
      {
        id: "reveal",
        label: "Show in Explorer",
        separatorBefore: true,
        disabled: !api?.revealFile,
        title: api?.revealFile ? undefined : missingChannel("Showing a file in Explorer"),
        onSelect: () => void api?.revealFile?.(projectPath, file.path),
      },
      {
        id: "open-default",
        label: "Open with default program",
        disabled: !api?.openFilePath,
        title: api?.openFilePath ? undefined : missingChannel("Opening a file"),
        onSelect: () => void api?.openFilePath?.(projectPath, file.path),
      },
    ];
    return <div className="dock-scm-file" data-selected={rowSelected || undefined}
      data-conflicted={file.conflicted || undefined}
      role="treeitem" aria-selected={rowSelected} key={file.path}
      {...rowContextMenu(`Actions for ${file.path}`, fileMenuItems)}>
      <input type="checkbox" className="dock-scm-file-check" checked={included}
        disabled={file.conflicted || Boolean(busy)}
        aria-label={`Include ${file.path} in the commit`}
        onChange={(event) => setIncluded(file, event.currentTarget.checked)} />
      <button type="button" className="dock-scm-file-main" title={file.path}
        data-status={kind}
        aria-label={`Open changes ${file.path}`}
        onClick={(event) => {
          const additive = event.ctrlKey || event.metaKey;
          toggleSelected(file, additive);
          if (!additive && !event.shiftKey) openChange();
        }}>
        {/* ONE continuous path sentence, dim directory + bright name
            (path-text.tsx:318,345) — no second column, no second line. */}
        <ScmPathText path={file.path} name={displayName} />
      </button>
      {/* Trailing status ICON at the row's right end (changed-file.tsx:30-43 →
          iconForStatus, status.ts:16-37); its accessible name replaces the
          letter the screen reader used to hear. */}
      <ScmStatusIcon kind={kind} className="dock-scm-file-state" />
      <div className="dock-scm-file-actions">
        <button type="button" aria-label={`Open file ${file.path}`}
          onClick={() => onOpenFile?.(projectPath, file.path)}>
          <FileText size={14} aria-hidden="true" />
        </button>
        {/* Conflicted rows keep their resolve affordance; that is the only
            place the index is still touched by hand. */}
        {file.conflicted
          ? <button type="button" aria-label={`Mark resolved ${file.path}`}
              disabled={Boolean(busy)}
              onClick={() => void run(`resolve:${file.path}`,
                () => api?.gitStage?.(projectPath, pathsFor(file)))}>
              <Check size={14} aria-hidden="true" />
            </button>
          : <button type="button" aria-label={`Discard changes ${file.path}`}
              disabled={Boolean(busy)} onClick={discardActionFiles}>
              <Undo2 size={14} aria-hidden="true" />
            </button>}
      </div>
    </div>;
  };

  const discardAllChanges = () => {
    const targets = files.filter((file) => !file.conflicted);
    if (!targets.length
      || !window.confirm(`Discard all ${targets.length} working tree changes? This cannot be undone.`)) return;
    void run("discard-all", () => discardFiles(targets), () => setSelected(new Set()));
  };
  // ONE implementation per branch action, shared by the branch row's inline
  // buttons and by its right-click menu.
  const checkoutBranch = (branch: DesktopGitBranch) => void run(
    `branch-checkout:${branch.name}`,
    () => api?.gitCheckoutBranch?.(projectPath, branch.name, branch.remote),
    () => setBranchPickerOpen(false),
  );
  const renameBranch = (branch: DesktopGitBranch) => {
    const nextName = window.prompt("Rename branch", branch.name);
    if (!nextName?.trim() || nextName.trim() === branch.name) return;
    void run(`branch-rename:${branch.name}`, () =>
      api?.gitRenameBranch?.(projectPath, branch.name, nextName.trim()));
  };
  const deleteBranch = (branch: DesktopGitBranch) => {
    if (!window.confirm(`Delete local branch "${branch.name}"?`)) return;
    void run(`branch-delete:${branch.name}`, () =>
      api?.gitDeleteBranch?.(projectPath, branch.name));
  };
  const openBranchPicker = () => {
    setBranchPickerOpen(true);
    setBranchQuery("");
    setMergeMode(false);
    void loadBranches();
    if (!defaultBranchName) void loadDefaultBranch();
  };
  const createBranchFromFilter = () => {
    // GitHub Desktop seeds the create-branch flow with the filter text.
    const name = branchQuery.trim() || window.prompt("New branch name") || "";
    if (!name.trim()) return;
    void run("branch-create", () => api?.gitCreateBranch?.(projectPath, name.trim()),
      () => setBranchPickerOpen(false));
  };
  const mergeIntoCurrent = (branch: DesktopGitBranch) => void run(
    `branch-merge:${branch.name}`,
    () => api?.gitMergeBranch?.(projectPath, branch.name),
    () => {
      setBranchPickerOpen(false);
      setMergeMode(false);
    },
  );
  /** GitHub Desktop's push/pull state ladder, in order
   *  (toolbar/push-pull-button.tsx:435-510): publish repository → fetch on an
   *  unborn tip → publish branch → fetch when level → pull when behind →
   *  push. ONE button, one action, with the ahead/behind badge (:132-158). */
  const remoteName = (status?.upstreamName || "").split("/")[0] || "origin";
  const aheadCount = status?.ahead ?? 0;
  const behindCount = status?.behind ?? 0;
  // Both directions non-zero is the ONLY case that needs the ↑/↓ arrows: with
  // one direction the button's own verb already carries it (`Push 3`).
  const bothDirections = aheadCount > 0 && behindCount > 0;
  // Label is split verb/target so the narrow dock can drop the remote NAME
  // before it ever has to truncate the verb into a stub.
  const fetchEntry = {
    key: "fetch",
    runKey: "fetch",
    verb: "Fetch",
    target: remoteName,
    label: `Fetch ${remoteName}`,
    reason: "",
    blocked: false,
    icon: <RefreshCw size={14} aria-hidden="true" />,
    perform: () => void run("fetch", () => api?.gitFetch?.(projectPath)),
  };
  const publishEntry = (key: string, label: string) => ({
    key,
    runKey: "push",
    verb: label,
    target: "",
    label,
    reason: "",
    blocked: false,
    icon: <CloudUpload size={14} aria-hidden="true" />,
    perform: () => void run("push", () => api?.gitPush?.(projectPath)),
  });
  /** A rung that is on the ladder but cannot act (reference: the disabled
   *  detached-HEAD button, push-pull-button.tsx:541-555). */
  const blockedEntry = (key: string, label: string, reason: string) => ({
    ...publishEntry(key, label),
    reason,
    blocked: true,
    perform: () => {},
  });
  /** The push rung. When the ladder hands the button to Pull (behind > 0 wins
   *  over ahead — push-pull-button.tsx:491-509) the push action stays reachable
   *  through the commit form's split menu (Push / Sync) and through the History
   *  rows' unpushed push button; the toolbar dropdown that used to carry it is
   *  gone (the header owns Fetch now). */
  const pushEntry = {
    key: "push",
    runKey: "push",
    verb: "Push",
    target: remoteName,
    label: `Push ${remoteName}`,
    reason: "",
    blocked: false,
    icon: <ArrowUp size={14} aria-hidden="true" />,
    perform: () => void run("push", () => api?.gitPush?.(projectPath)),
  };
  const remoteEntry = !status ? null
    : !status.remote
      // Nothing to publish TO: the rung stays visible (ladder parity) but says
      // why it cannot run instead of firing a push that must fail.
      ? blockedEntry("publish-repository", "Publish repository",
        "Add a remote before publishing this repository")
      : status.unborn
        ? fetchEntry
        : status.detached
          // push-pull-button.tsx:541-555.
          ? blockedEntry("detached-head", "Publish branch",
            status.operation === "rebase" ? "Rebase in progress" : "Cannot publish detached HEAD")
        : !status.upstream
          ? publishEntry("publish-branch", "Publish branch")
          : aheadCount === 0 && behindCount === 0
            ? fetchEntry
            : behindCount > 0
              ? {
                key: "pull",
                runKey: "pull",
                verb: "Pull",
                target: remoteName,
                label: `Pull ${remoteName}`,
                reason: "",
                blocked: false,
                icon: <ArrowDown size={14} aria-hidden="true" />,
                perform: () => void run("pull", () => api?.gitPull?.(projectPath)),
              }
              : pushEntry;
  /** The history row's push button IS the toolbar's push action, so it obeys
   *  the toolbar's own rules (push-pull-button.tsx:435-555): never while
   *  another git action or an in-progress operation runs, never without a
   *  remote, never on a detached HEAD, and never without an upstream —
   *  publishing a branch stays the toolbar's job. */
  const rowPushReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !status?.remote
        ? "Add a remote before pushing"
        : status.detached
          ? "Cannot push a detached HEAD"
          : !status.upstream
            ? "Publish the branch from the toolbar before pushing"
            : "";
  const rowPushBlocked = Boolean(rowPushReason);
  /** The panel header's ONE action: Fetch, pinned at the right end of the
   *  `Source Control` title row. The toolbar's third section only OFFERS Fetch
   *  while the branch is level (push-pull-button.tsx:435-510 hands it to Pull
   *  or Push the moment there is anything to move), so a fetch that does not
   *  depend on the ahead/behind state lives here and fires the SAME action the
   *  rung does (`fetchEntry.perform`). The deleted "…" overflow menu does not
   *  come back with it: View & Sort, Stage All / Unstage All / Discard All and
   *  the stash pair are the `N changed files` header actions; Amend and Undo
   *  commit live on the history rows; Commit, Pull/Push and Branch are owned by
   *  the commit form, the toolbar's morphing button and the branch dropdown. */
  const headerFetchReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !api?.gitFetch
        ? missingChannel("Fetching")
        : !status?.remote
          ? "Add a remote before fetching"
          : "";
  const headerFetch = headerSlot && !prOnly
    ? createPortal(<button type="button" className="dock-scm-header-fetch"
      aria-label={`Fetch from ${remoteName}`}
      title={headerFetchReason || `Fetch from ${remoteName}`}
      disabled={Boolean(headerFetchReason)}
      onClick={fetchEntry.perform}>
      {busy === "fetch"
        ? <ProgressSpinner size={14} aria-hidden="true" />
        : <RefreshCw size={14} aria-hidden="true" />}
    </button>, headerSlot)
    : null;
  /** Stash grammar (filter-changes-list.tsx:549-556 `Stash all changes`): the
   *  changed-files header owns it, refused with a reason while another action
   *  or an in-progress operation holds the repository. */
  const stashReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !api?.gitStash
        ? missingChannel("Stashing changes")
        : files.length === 0
          ? "There are no changes to stash"
          : "";
  const popStashReason = busy
    ? "Another Git action is running"
    : status?.operation
      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
      : !api?.gitStashPop
        ? missingChannel("Popping a stash")
        : "";
  const stashChanges = () => {
    const message = window.prompt("Stash message (optional)", "");
    if (message === null) return;
    void run("stash", () => api?.gitStash?.(projectPath, message));
  };
  const popStash = () => void run("stash-pop", () => api?.gitStashPop?.(projectPath));

  if (!projectPath) {
    return <p className="utility-dock-empty">Open a project to use Source Control.</p>;
  }
  if (!statusReady) {
    return <div className="dock-scm-loading">
      <ProgressSpinner size={16} aria-hidden="true" /> Loading…
    </div>;
  }
  if (status && !status.repository) {
    return <p className="utility-dock-empty">
      The selected project is not a Git repository.
    </p>;
  }

  return <div className="dock-source-control" ref={dockRootRef}>
    {/* Always-available Fetch, portaled into the panel header's action slot. */}
    {headerFetch}
    {/* ONE portaled context menu for every row grammar in the dock. */}
    <ScmContextMenu state={visibleContextMenu} onClose={closeContextMenu} />
    {/* GitHub Desktop's top toolbar, three sections above the tab row:
        repository selector, current branch dropdown, and ONE push/pull
        button (toolbar/push-pull-button.tsx:435-510). */}
    {status && !prOnly && <div className="dock-scm-toolbar">
      {projectSelect
        ? <div className="dock-scm-toolbar-section dock-scm-toolbar-project">{projectSelect}</div>
        : null}
      <div className="dock-scm-toolbar-section dock-scm-toolbar-branch" ref={branchPickerRef}>
        <button type="button" className="dock-scm-branch-button" aria-haspopup="dialog"
          ref={branchTriggerRef}
          aria-expanded={branchPickerVisible} disabled={!api?.gitBranches}
          title={status.upstreamName || status.branch}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            branchPickerClickGuard.markPointerActivation();
            commitImmediateOverlay(() => branchPickerVisible
              ? setBranchPickerOpen(false)
              : openBranchPicker());
          }}
          onClick={(event) => {
            if (branchPickerClickGuard.consumePointerClick()) return;
            if (event.detail !== 0) return;
            commitImmediateOverlay(() => branchPickerVisible
              ? setBranchPickerOpen(false)
              : openBranchPicker());
          }}
          onPointerCancel={branchPickerClickGuard.clearPointerActivation}>
          <GitBranch size={14} aria-hidden="true" />
          <span>{status.detached ? "Detached HEAD" : status.branch || "No branch"}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {branchPickerVisible && createPortal(<div className="dock-scm-branch-picker" role="dialog"
          aria-label="Git branches" ref={branchPanelRef} style={branchPanelStyle}>
          {/* branches-container.tsx:124-193: filter + list + a merge row that
              always names the branch being merged INTO. */}
          <header>
            <input type="search" value={branchQuery} autoFocus
              aria-label="Filter branches"
              placeholder="Filter"
              onInput={(event) => setBranchQuery(event.currentTarget.value)} />
            <button type="button" className="dock-scm-branch-new"
              disabled={Boolean(busy) || !api?.gitCreateBranch || Boolean(status.operation)}
              title={status.operation
                ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
                : undefined}
              onClick={createBranchFromFilter}>
              <Plus size={12} aria-hidden="true" />
              <span>New branch</span>
            </button>
          </header>
          <div className="dock-scm-branch-list">
            {branchLoading && <p>Loading branches…</p>}
            {!branchLoading && visibleBranches.length === 0 && <p>No matching branches.</p>}
            {([
              ["Default branch", defaultBranch ? [defaultBranch] : []],
              ["Other branches", otherBranches],
            ] as Array<[string, DesktopGitBranch[]]>)
              .map(([label, rows]) => rows.length > 0 && <section key={label}>
              <h3>{label}</h3>
              {rows.map((branch) => <div className="dock-scm-branch-row"
                data-current={branch.current || undefined} key={`${branch.remote}:${branch.name}`}
                {...rowContextMenu(`Actions for branch ${branch.name}`, () => [
                  {
                    id: "checkout",
                    label: "Checkout",
                    disabled: Boolean(busy) || branch.current || Boolean(status.operation)
                      || !api?.gitCheckoutBranch,
                    title: branch.current
                      ? "This branch is already checked out"
                      : status.operation
                        ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
                        : api?.gitCheckoutBranch ? undefined : missingChannel("Checkout"),
                    onSelect: () => guarded(() => checkoutBranch(branch)),
                  },
                  {
                    id: "rename",
                    label: "Rename…",
                    disabled: Boolean(busy) || branch.remote || !api?.gitRenameBranch,
                    title: branch.remote
                      ? "A remote branch cannot be renamed from here"
                      : api?.gitRenameBranch ? undefined : missingChannel("Renaming a branch"),
                    onSelect: () => guarded(() => renameBranch(branch)),
                  },
                  {
                    id: "delete",
                    label: "Delete…",
                    danger: true,
                    disabled: Boolean(busy) || branch.remote || branch.current
                      || !api?.gitDeleteBranch,
                    title: branch.current
                      ? "The checked-out branch cannot be deleted"
                      : branch.remote
                        ? "A remote branch cannot be deleted from here"
                        : api?.gitDeleteBranch ? undefined : missingChannel("Deleting a branch"),
                    onSelect: () => guarded(() => deleteBranch(branch)),
                  },
                  {
                    id: "merge",
                    label: `Merge into ${status.branch}`,
                    separatorBefore: true,
                    disabled: Boolean(busy) || branch.current || Boolean(status.operation)
                      || !api?.gitMergeBranch || !status.branch || status.detached,
                    title: status.operation
                      ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
                      : api?.gitMergeBranch ? undefined : missingChannel("Merging a branch"),
                    onSelect: () => guarded(() => mergeIntoCurrent(branch)),
                  },
                ])}>
                <button type="button" className="dock-scm-branch-main"
                  // The main process refuses checkout/merge mid-operation; the
                  // UI must not offer it either.
                  disabled={Boolean(busy) || branch.current || Boolean(status.operation)}
                  title={status.operation
                    ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
                    : branch.name}
                  onClick={() => mergeMode
                    ? mergeIntoCurrent(branch)
                    : checkoutBranch(branch)}>
                  {branch.current
                    ? <Check size={14} aria-hidden="true" />
                    : <GitBranch size={14} aria-hidden="true" />}
                  <span>{branch.name}</span>
                  {/* Per-branch last-commit age, the reference's branch row
                      metadata; falls back to the upstream when the main
                      process has not shipped the age yet. */}
                  {(branch.lastCommitRelative || (!branch.remote && branch.upstream)) &&
                    <small>{branch.lastCommitRelative || branch.upstream}</small>}
                </button>
                {!branch.remote && <>
                  <button type="button" className="dock-scm-branch-action"
                    aria-label={`Rename branch ${branch.name}`} disabled={Boolean(busy)}
                    onClick={() => renameBranch(branch)}>Rename</button>
                  {!branch.current && <button type="button" className="dock-scm-branch-action danger"
                    aria-label={`Delete branch ${branch.name}`} disabled={Boolean(busy)}
                    onClick={() => deleteBranch(branch)}>Delete</button>}
                </>}
              </div>)}
            </section>)}
          </div>
          {status.branch && !status.detached && <button type="button" className="dock-scm-merge-row"
            aria-pressed={mergeMode}
            disabled={Boolean(busy) || !api?.gitMergeBranch || Boolean(status.operation)}
            title={status.operation
              ? `Finish the in-progress ${status.operation.replace("-", " ")} first`
              : `Choose a branch to merge into ${status.branch}`}
            onClick={() => setMergeMode((current) => !current)}>
            <GitMerge size={14} aria-hidden="true" />
            <span>Choose a branch to merge into <strong>{status.branch}</strong></span>
          </button>}
        </div>, document.body)}
      </div>
      {/* ONE morphing action, no dropdown beside it — and the toolbar's THIRD
          EQUAL SECTION (desktop.css: all three are `flex: 1 1 0`), so it shows
          its verb instead of degrading to an icon stub. It IS Fetch only while
          the branch is level, which is why the panel header pins a Fetch of its
          own; the push rung the ladder loses to Pull stays reachable on the
          unpushed history rows and comes back here the moment the pull lands. */}
      {remoteEntry && <div className="dock-scm-toolbar-section dock-scm-toolbar-remote">
        <button type="button" className="dock-scm-remote-button"
          data-remote-action={remoteEntry.key}
          title={remoteEntry.reason || remoteEntry.label}
          aria-label={remoteEntry.label}
          disabled={Boolean(busy) || Boolean(status.operation) || remoteEntry.blocked}
          onClick={remoteEntry.perform}>
          {busy === remoteEntry.runKey
            ? <ProgressSpinner size={14} aria-hidden="true" />
            : remoteEntry.icon}
          {/* Degradation order: the icon and the ahead/behind badge always
              survive, the remote NAME drops first, then the verb — the label
              is never truncated into a one or two character stub. */}
          <span className="dock-scm-remote-label">
            <span className="dock-scm-remote-verb">{remoteEntry.verb}</span>
            {remoteEntry.target
              ? <span className="dock-scm-remote-target">{` ${remoteEntry.target}`}</span>
              : null}
          </span>
          {/* Badge hides at 0/0 exactly like renderAheadBehind. The direction
              arrows ride along ONLY when the branch is ahead and behind at the
              same time: with a single direction the verb beside the badge
              already says which way it goes, so it reads `Push 3`, never
              `Push 3↑`. */}
          {status.upstream && (aheadCount > 0 || behindCount > 0) &&
            <span className="dock-scm-ahead-behind"
              data-directions={bothDirections ? "both" : "one"}>
              {aheadCount > 0 && <span>{aheadCount}
                {bothDirections && <ArrowUp size={12} aria-hidden="true" />}</span>}
              {behindCount > 0 && <span>{behindCount}
                {bothDirections && <ArrowDown size={12} aria-hidden="true" />}</span>}
            </span>}
        </button>
      </div>}
    </div>}
    <div className="dock-scm-view-stage">
    {/* Search first, then the Changes | History selector, matching the Search
        panel's query-field + mode-selector order. The selector remains a RADIO
        GROUP (two mutually exclusive views), driven by click or arrow keys. */}
    {!prOnly && <div className="dock-scm-view-controls">
      <label className="dock-scm-search workbench-search-input">
        <Search size={14} aria-hidden="true" />
        {view === "changes" ? <>
          <input type="search" value={fileFilter}
            aria-label="Filter changed files" placeholder="Filter"
            onInput={(event) => setFileFilter(event.currentTarget.value)} />
          {fileFilter && <button type="button" aria-label="Clear the file filter"
            onClick={() => setFileFilter("")}><X size={14} aria-hidden="true" /></button>}
        </> : <>
          <input type="search" value={historyQuery} placeholder="Search commits"
            aria-label="Search commits"
            onInput={(event) => setHistoryQuery(event.currentTarget.value)} />
          {historyQuery && <button type="button" aria-label="Clear the commit search"
            onClick={() => setHistoryQuery("")}><X size={14} aria-hidden="true" /></button>}
        </>}
      </label>
      {(() => {
      const options = [
        { id: "changes" as const, label: "Changes" },
        { id: "history" as const, label: "History" },
      ];
      // One entry point for both pointer and keyboard so the surface switch
      // keeps its side effects (history load + selection clear).
      const selectView = (next: "changes" | "history") => {
        if (next === view) return;
        if (next === "history") setHistoryLoading(true);
        setView(next);
        setSelected(new Set());
      };
      // Layout is GitHub Desktop's tab bar (repository.tsx:217-235 renders the
      // two tabs through <TabBar>): two EQUAL halves spanning the panel width
      // (_tab-bar.scss:33-52, `flex: 1` per item), the selection marked by the
      // inset bottom bar (:59) and the Changes half carrying the counter
      // bubble (:77-86). The SEMANTICS stay a radio group with roving tabindex.
      return <div className="dock-scm-tab-bar" role="radiogroup"
        aria-label="Changes or history">
        {options.map((option, index) => <button type="button" role="radio" key={option.id}
          className="dock-scm-tab"
          data-review-option={option.id}
          aria-checked={view === option.id}
          // Roving tabindex: the group is a SINGLE tab stop; the checked
          // option owns it and the arrows move within the group.
          tabIndex={view === option.id ? 0 : -1}
          onClick={() => selectView(option.id)}
          onKeyDown={(event) => {
            const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
            const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
            if (!forward && !backward) return;
            event.preventDefault();
            const step = forward ? 1 : options.length - 1;
            const next = options[(index + step) % options.length];
            // WAI-ARIA radio group: selection follows focus.
            selectView(next.id);
            event.currentTarget.parentElement
              ?.querySelector<HTMLButtonElement>(`[data-review-option="${next.id}"]`)
              ?.focus();
          }}>
          {/* repository.tsx:225-232 — one `with-indicator` span per tab, the
              label then the changed-file counter (files-changed-badge.tsx). */}
          <span className="dock-scm-tab-content">
            <span className="dock-scm-tab-label">{option.label}</span>
            {option.id === "changes" && files.length > 0 &&
              <span className="dock-review-count">{files.length}</span>}
          </span>
        </button>)}
      </div>;
      })()}
    </div>}
    {(error || statusError) && <p className="dock-scm-error" role="alert">{error || statusError}</p>}
    {!prOnly && status?.operation && <div className="dock-scm-operation" role="status">
      <div>
        <b>{status.operation.replace("-", " ")} in progress</b>
        <small>{conflicts.length
          ? `${conflicts.length} unresolved conflict${conflicts.length === 1 ? "" : "s"}`
          : "All conflicts resolved"}</small>
      </div>
      <button type="button" disabled={Boolean(busy) || conflicts.length > 0}
        onClick={() => void run("continue", () => api?.gitContinue?.(projectPath))}>Continue</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => {
        if (!window.confirm(`Abort the ${status.operation.replace("-", " ")} operation?`)) return;
        void run("abort-operation", () => api?.gitAbortOperation?.(projectPath));
      }}>Abort</button>
    </div>}
    <>
    {prOnly ? <PullRequestsPane projectPath={projectPath} prUrl={prUrl}
      repositoryUrl={gitRemoteWebUrl(status?.remoteUrl || "")}
      headerSlot={headerSlot}
      onOpenPullRequest={onOpenPullRequest}
      currentBranch={status?.branch ?? ""}
      createHint={!status?.upstream
        ? "Publish the branch to a remote before opening a pull request."
        : prAhead > 0
          ? `Push ${prAhead} local commit${prAhead === 1 ? "" : "s"} before opening a pull request.`
          : status?.operation
            ? "Finish the in-progress Git operation first."
            : "Pull requests need a pushed upstream branch."} />
    : view === "changes" ? <>
      {/* GitHub Desktop's tri-state select-all row
          (filter-changes-list.tsx:1235-1281), 29px tall
          (styles/ui/changes/_changes-list.scss:14-20). The shared filter box
          now lives in the view controls above Changes | History. */}
      <div className="dock-scm-list-header">
        {/* The select-all row is also the list's ACTION header now: Stage All,
            Unstage All and Discard All moved here from the deleted "…" menu,
            with View & Sort beside them. It is a plain row (not a <label>) so
            those buttons cannot toggle the checkbox by label activation; the
            checkbox keeps the same accessible name it always had. */}
        <div className="dock-scm-check-all">
          <input type="checkbox"
            checked={includableVisible > 0 && includedVisible === includableVisible}
            disabled={files.length === 0 || Boolean(busy)}
            // Tri-state: partially included lists render mixed, exactly like
            // the reference's CheckboxValue.Mixed.
            ref={(node) => {
              if (node) node.indeterminate = includedVisible > 0
                && includedVisible < includableVisible;
            }}
            aria-label={checkAllLabel}
            onChange={(event) => setAllIncluded(event.currentTarget.checked)} />
          <span>{checkAllLabel}</span>
          <span className="dock-scm-list-actions">
            <button type="button" aria-label="Stage All" title="Stage All"
              data-tooltip="Stage All"
              disabled={Boolean(busy) || files.length === 0}
              onClick={() => setAllIncluded(true, files)}>
              <Check size={14} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Unstage All" title="Unstage All"
              data-tooltip="Unstage All"
              disabled={Boolean(busy) || files.length === 0}
              onClick={() => setAllIncluded(false, files)}>
              <Minus size={14} aria-hidden="true" />
            </button>
            <button type="button" className="danger" aria-label="Discard All"
              title="Discard All" data-tooltip="Discard All"
              disabled={Boolean(busy) || files.length === 0}
              onClick={discardAllChanges}>
              <Undo2 size={14} aria-hidden="true" />
            </button>
            {/* Stash all changes / Pop stash: the reference hangs them off the
                changed-files list (filter-changes-list.tsx:549-556), which is
                where they landed when the commit split menu was deleted. */}
            <button type="button" aria-label="Stash Changes"
              title={stashReason || "Stash Changes"}
              data-tooltip={stashReason || "Stash Changes"}
              disabled={Boolean(stashReason)}
              onClick={stashChanges}>
              <Archive size={14} aria-hidden="true" />
            </button>
            <button type="button" aria-label="Pop Stash"
              title={popStashReason || "Pop Stash"}
              data-tooltip={popStashReason || "Pop Stash"}
              disabled={Boolean(popStashReason)}
              onClick={popStash}>
              <ArchiveRestore size={14} aria-hidden="true" />
            </button>
            {/* ONE flat changed-files list leaves ordering as the only view
                choice (the deleted menu's View & Sort group). */}
            <button type="button" className="dock-scm-sort"
              aria-label="View & Sort" title="View & Sort"
              data-tooltip="View & Sort" aria-haspopup="menu"
              aria-expanded={visibleContextMenu?.label === "View & Sort"}
              onPointerEnter={(event) => {
                viewSortMenuPoint.current = elementMenuPoint(event.currentTarget);
              }}
              onFocus={(event) => {
                viewSortMenuPoint.current = elementMenuPoint(event.currentTarget);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                viewSortClickGuard.markPointerActivation();
                const point = viewSortMenuPoint.current ?? elementMenuPoint(event.currentTarget);
                commitImmediateOverlay(() => setContextMenu(
                  visibleContextMenu?.label === "View & Sort" ? null : {
                    label: "View & Sort",
                    items: [
                      { id: "sort-path", label: "Sort by Path", checked: sortKey === "path",
                        onSelect: () => chooseSortKey("path") },
                      { id: "sort-name", label: "Sort by Name", checked: sortKey === "name",
                        onSelect: () => chooseSortKey("name") },
                      { id: "sort-status", label: "Sort by Status", checked: sortKey === "status",
                        onSelect: () => chooseSortKey("status") },
                    ],
                    ...point,
                  },
                ));
              }}
              onClick={(event) => {
                if (viewSortClickGuard.consumePointerClick()) return;
                if (event.detail !== 0) return;
                const point = viewSortMenuPoint.current ?? elementMenuPoint(event.currentTarget);
                commitImmediateOverlay(() => setContextMenu(
                  visibleContextMenu?.label === "View & Sort" ? null : {
                    label: "View & Sort",
                    items: [
                      { id: "sort-path", label: "Sort by Path", checked: sortKey === "path",
                        onSelect: () => chooseSortKey("path") },
                      { id: "sort-name", label: "Sort by Name", checked: sortKey === "name",
                        onSelect: () => chooseSortKey("name") },
                      { id: "sort-status", label: "Sort by Status", checked: sortKey === "status",
                        onSelect: () => chooseSortKey("status") },
                    ],
                    ...point,
                  },
                ));
              }}
              onPointerCancel={viewSortClickGuard.clearPointerActivation}>
              <ArrowUpDown size={14} aria-hidden="true" />
            </button>
          </span>
        </div>
      </div>
      <div className="dock-scm-scroll" ref={filesScrollRef}
      onKeyDown={(event) => {
        // Esc anywhere in the list clears the checkbox selection (user: 셀렉트
        // 하면 어떻게 언셀렉함) — the toolbar Clear button is the mouse path.
        if (event.key !== "Escape" || selectedCount === 0) return;
        event.stopPropagation();
        setSelected(new Set());
      }}>
      {/* Windowed rows: the spacers carry the height of every row that is not
          mounted, so the scrollbar measures the WHOLE changed-file set and
          scrolling — not a button — is what reaches the end of it. */}
      <RowSpacer edge="leading" height={fileWindow.leading} />
      {visibleFiles.map((file) => fileRow(file))}
      <RowSpacer edge="trailing" height={fileWindow.trailing} />
      {files.length === 0 && <p className="dock-scm-clean">No changes in this project.</p>}
      {files.length > 0 && filteredFiles.length === 0 &&
        <p className="dock-scm-clean">No changed files match the filter.</p>}
      </div>
      {/* Commit box lives in NORMAL FLOW as the bottom region of the view
          stage (never an overlay over the file list) and follows the chat
          composer grammar: textarea row, then an action row. */}
      {(() => {
        // GitHub Desktop's commit form (commit-message.tsx:1771-1852): the
        // primary button carries the whole action — verb, file count and the
        // target branch — and it is the form's ONLY control: the split-menu
        // chevron is gone. Commit & Push / Commit & Sync are the toolbar's
        // morphing button the moment the commit lands (it becomes Push /
        // Sync), Amend and Undo commit live on the history rows and the stash
        // pair on the changed-files header.
        const committing = busy === "commit" || busy === "amend";
        // With auto messages on, an empty summary still commits in one press
        // (silent generation); the tooltip below is the only tell.
        const autoDraft = !summary.trim() && autoCommitMessage;
        const branchName = status?.detached ? "" : status?.branch || "";
        const selectedCommitCount = includedFiles.length;
        // Reference button text (commit-message.tsx:1519-1541): verb, then
        // "N file(s) ", then "to " and the BOLD branch.
        const verb = committing ? "Committing…" : "Commit";
        const countText = selectedCommitCount > 0
          ? `${selectedCommitCount} ${selectedCommitCount > 1 ? "files" : "file"} `
          : "";
        // Disabled set (shared with the title menu through `commitBlocked`):
        // blank summary, nothing selected, a commit in flight, an in-progress
        // Git operation, or unresolved conflicts.
        const primaryDisabled = commitBlocked;
        // Reference tooltip strings, commit-message.tsx:1579-1598.
        const primaryTitle = autoDraft
          ? "Commit with an auto-generated message"
          : !summary.trim()
            ? "A commit summary is required to commit"
            : selectedCommitCount === 0 && files.length > 0
              ? "Select one or more files to commit"
              : committing
                ? "Committing changes…"
                : status?.operation
                  ? "Finish the in-progress Git operation first"
                  : conflicts.length > 0
                    ? "Resolve conflicts before committing"
                    : branchName ? `Commit to ${branchName}` : "Commit";
        const submitOnAccelerator = (
          event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
        ) => {
          // GitHub Desktop commits on Ctrl/Cmd+Enter from either field — but
          // only on a summary the user typed: an empty draft never starts
          // auto generation or a commit from a stray accelerator.
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (!summary.trim()) return;
          event.currentTarget.form?.requestSubmit();
        };
        // noValidate: commit gating is OURS (commitBlocked disables the
        // button and the submit handler re-checks). The browser's native
        // "fill out this field" balloon is off-theme and, with auto commit
        // messages, plain wrong — an empty summary is a valid submit.
        return <form className="dock-scm-commit" noValidate onSubmit={(event) => {
          event.preventDefault();
          if (primaryDisabled) return;
          runCommitFlow("commit");
        }}>
          {/* Two DISTINCT fields, never two identical empty boxes
              (_commit-message.scss:83-100 vs :209-250): a real single-line
              bordered text input, then the description's own focus container
              underneath it. */}
          <input type="text" className="dock-scm-commit-summary" aria-label="Summary"
            placeholder={summaryPlaceholder} value={summary}
            readOnly={committing}
            onInput={(event) => setSummary(event.currentTarget.value)}
            onKeyDown={submitOnAccelerator} />
          <div className="dock-scm-commit-description-box">
            <textarea className="dock-scm-commit-description" aria-label="Description"
              placeholder={descriptionPlaceholder} value={description} rows={1}
              readOnly={committing}
              onInput={(event) => setDescription(event.currentTarget.value)}
              onKeyDown={submitOnAccelerator} />
          </div>
          <div className="dock-scm-commit-split">
            <button type="submit" className="dock-scm-commit-button"
              disabled={primaryDisabled} title={primaryTitle}>
              {committing && <ProgressSpinner size={14} aria-hidden="true" />}
              {/* Wrapped like .model-trigger > span so a narrow dock
                  ellipsizes the label instead of clipping the button. */}
              <span>
                {`${verb} ${countText}${branchName ? "to " : ""}`}
                {branchName ? <strong>{branchName}</strong> : null}
              </span>
            </button>
          </div>
          {/* Create Pull Request moved to the Graph/PR tab (user: PR 분리). */}
        </form>;
      })()}
    </> : selectedCommit ? (() => {
      // Commit header grammar: expandable-commit-summary.tsx:495-522 — title,
      // then ONE meta row of author NAME (no monogram — the header follows the
      // history rows, where the disc only ate width), commit ref (short SHA +
      // copy button, :434-449) and the added/deleted line totals (:552-566);
      // the changed-file list is introduced by selected-commits.tsx:278-283's
      // `N changed files` header. The files themselves keep routing to the
      // existing diff surface — no third pane inside a ~300px dock.
      const detailFiles = commitDetail?.files ?? [];
      const additions = detailFiles.reduce((sum, file) => sum + file.additions, 0);
      const deletions = detailFiles.reduce((sum, file) => sum + file.deletions, 0);
      // A LOADED commit with no subject is an empty commit message, not a
      // pending load — the two must never render the same string.
      const detailSummary = (commitDetail?.subject ?? "").trim();
      const headline = commitDetail
        ? detailSummary || EMPTY_SUMMARY
        : "Loading commit…";
      const detailAuthor = (commitDetail?.author ?? "").trim();
      const copyState = commitDetail && shaCopy?.hash === commitDetail.hash ? shaCopy : null;
      return <div className="dock-scm-history dock-scm-commit-detail">
      <header className="dock-scm-commit-header">
        <div className="dock-scm-commit-headline">
          <button type="button" className="dock-scm-commit-back"
            aria-label="Back to commit history" onClick={closeCommit}>
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
          <b title={headline}
            data-empty={commitDetail && !detailSummary ? true : undefined}>{headline}</b>
        </div>
        {commitDetail && <div className="dock-scm-commit-meta">
          <span className="dock-scm-commit-author" title={commitDetail.email}>
            <span>{detailAuthor || UNKNOWN_AUTHOR}</span>
          </span>
          <span className="dock-scm-commit-ref">
            <GitCommit size={12} aria-hidden="true" />
            <code>{commitDetail.shortHash}</code>
            <button type="button" className="dock-scm-commit-copy"
              aria-label="Copy the full SHA"
              title={copyState ? copyState.ok ? "Copied" : "Copy failed" : "Copy the full SHA"}
              onClick={() => void copyCommitSha(commitDetail.hash)}>
              {copyState?.ok
                ? <Check size={12} aria-hidden="true" />
                : <Copy size={12} aria-hidden="true" />}
            </button>
            {/* The copy outcome is announced, never left to the icon alone. */}
            <span className="dock-scm-copy-status" role="status" aria-live="polite">
              {copyState
                ? copyState.ok
                  ? "Full SHA copied to the clipboard"
                  : "Could not copy the SHA to the clipboard"
                : ""}
            </span>
          </span>
          <span className="dock-scm-commit-lines">
            <i>+{additions}</i><em>−{deletions}</em>
          </span>
          <time dateTime={commitDetail.authoredAt}>
            {new Date(commitDetail.authoredAt).toLocaleString()}
          </time>
        </div>}
      </header>
      {commitDetail && <div className="dock-scm-commit-files-header">
        {changedFilesLabel(detailFiles.length, detailFiles.length)}
      </div>}
      {detailFiles.map((file) => {
        const open = openCommitFile === file.path;
        const patch = commitDiffs[file.path];
        return <section className="dock-scm-commit-file" data-open={open || undefined} key={file.path}>
          <button type="button" className="dock-scm-commit-file-row"
            aria-expanded={onOpenDiff ? undefined : open} onClick={() => {
              if (onOpenDiff) {
                onOpenDiff(projectPath, file.path, {
                  source: "commit",
                  hash: selectedCommit,
                });
              } else {
                void toggleCommitFile(file);
              }
            }}>
            {/* Same one-sentence path grammar as the working-directory rows —
                the file name is kept whole and only the dim directory prefix
                loses characters (path-text.tsx:107-139). */}
            <ScmPathText title={file.path}
              path={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} />
            {/* The counts are a FIXED right-aligned column, so the path keeps
                every pixel they do not need. */}
            <small className="dock-scm-commit-file-lines">
              {file.additions > 0 && <i>+{file.additions}</i>}
              {file.deletions > 0 && <em>-{file.deletions}</em>}
            </small>
            {/* ONE trailing control per row: the status icon, same grammar as
                the working-directory rows (changed-file.tsx:30-43). */}
            <ScmStatusIcon kind={scmStatusKind(file.status)} size={12} />
          </button>
          {open && <div className="dock-scm-commit-diff">
            {patch === undefined || patch === null
              ? <p>Loading diff…</p>
              : patch.startsWith("Error:")
                ? <p>{patch}</p>
                : patch
                  ? <GitFileDiff patch={patch} mode="unified" />
                  : <p>No textual diff.</p>}
          </div>}
        </section>;
      })}
      {commitDetail && detailFiles.length === 0 &&
        <p className="utility-dock-empty">No file changes in this commit.</p>}
    </div>;
    })() : <div className="dock-scm-history" ref={historyScrollRef}>
      {/* commit-list-item.tsx:136-194 without the avatar stack (the dock has
          no avatar service, and a monogram only ate width): a one-line
          summary, the byline (`author • relative age`), then the tag and the
          unpushed push button as compact TRAILING affordances so neither can
          grow the row. */}
      {/* Windowed exactly like the changed-file list, and the next page is
          fetched from the scroll position instead of a `Load more` button. */}
      <RowSpacer edge="leading" height={historyWindow.leading} />
      {visibleHistory.map((entry, windowIndex) => {
        const entryIndex = historyWindow.start + windowIndex;
        const refs = entry.refs ?? [];
        // gitLog now splits the decorations per KIND (contract.ts:975-981).
        // An OLDER host answers without `tags` at all — that, and only that,
        // is what keeps the two tag-reading entries disabled.
        const tagsKnown = Array.isArray(entry.tags);
        const tags = entry.tags ?? [];
        // `Amend commit…` / `Undo commit…` belong to the most recent commit
        // (commit-list.tsx:730-732), undo additionally to a LOCAL one.
        const isTipCommit = entryIndex === 0;
        const summary = (entry.subject ?? "").trim();
        const author = (entry.author ?? "").trim();
        // The row is the focusable element, so the truncated title, the hidden
        // refs and the unpushed glyph all live in ITS accessible name.
        const rowLabel = [
          summary || EMPTY_SUMMARY,
          `${author || UNKNOWN_AUTHOR}, ${entry.when}`,
          refs.length ? `refs: ${refs.join(", ")}` : "",
          entry.pushed ? "" : "unpushed",
        ].filter(Boolean).join(" · ");
        // The reference's history context menu (commit-list.tsx:724-865) in its
        // own order: Amend, Undo, Reset, Checkout, Reorder, Revert, then the
        // branch/tag group and the copy group. Every destructive entry confirms
        // while NAMING the commit, every entry is refused (with the reason in
        // its tooltip) while a Git action or an in-progress operation owns the
        // repository, and an entry whose channel this build has no IPC for
        // stays VISIBLE and DISABLED.
        const commitMenuItems = (): ScmContextMenuItem[] => [
          {
            id: "amend",
            label: "Amend commit…",
            disabled: Boolean(historyBusyReason) || !isTipCommit
              || Boolean(status?.unborn) || conflicts.length > 0 || !api?.gitAmend,
            title: historyBusyReason
              || (!isTipCommit
                ? "Only the most recent commit can be amended"
                : conflicts.length > 0
                  ? "Resolve conflicts before amending"
                  : api?.gitAmend ? undefined : missingChannel("Amending a commit")),
            onSelect: () => guarded(() => amendCommitAt(entry)),
          },
          {
            id: "undo",
            label: "Undo commit…",
            danger: true,
            disabled: Boolean(historyBusyReason) || !isTipCommit || entry.pushed
              || !api?.gitUndoLastCommit,
            title: historyBusyReason
              || (!isTipCommit
                ? "Only the most recent commit can be undone"
                : entry.pushed
                  ? "This commit is already pushed, so it cannot be undone here"
                  : api?.gitUndoLastCommit
                    ? undefined
                    : missingChannel("Undoing a commit")),
            onSelect: () => guarded(() => undoCommitAt(entry)),
          },
          {
            id: "reset",
            label: "Reset to commit…",
            danger: true,
            separatorBefore: true,
            disabled: Boolean(historyBusyReason) || !api?.gitResetToCommit,
            title: historyBusyReason
              || (api?.gitResetToCommit ? undefined : missingChannel("Resetting to a commit")),
            onSelect: () => guarded(() => resetToCommit(entry)),
          },
          {
            id: "checkout",
            label: "Checkout commit",
            disabled: Boolean(historyBusyReason) || !api?.gitCheckoutCommit,
            title: historyBusyReason
              || (api?.gitCheckoutCommit ? undefined : missingChannel("Checking out a commit")),
            onSelect: () => guarded(() => checkoutCommit(entry)),
          },
          { id: "reorder", label: "Reorder commit", disabled: true, title: missingChannel("Reordering a commit") },
          {
            id: "revert",
            label: "Revert changes in commit",
            danger: true,
            disabled: Boolean(historyBusyReason) || !api?.gitRevertCommit,
            title: historyBusyReason
              || (api?.gitRevertCommit ? undefined : missingChannel("Reverting a commit")),
            onSelect: () => guarded(() => revertCommit(entry)),
          },
          {
            id: "create-branch",
            label: "Create branch from commit",
            separatorBefore: true,
            disabled: Boolean(historyBusyReason) || !api?.gitCreateBranchAtCommit,
            title: historyBusyReason
              || (api?.gitCreateBranchAtCommit
                ? undefined
                : missingChannel("Creating a branch from a commit")),
            onSelect: () => guarded(() => createBranchAtCommit(entry)),
          },
          {
            id: "create-tag",
            label: "Create Tag…",
            disabled: Boolean(historyBusyReason) || !api?.gitCreateTag,
            title: historyBusyReason
              || (api?.gitCreateTag ? undefined : missingChannel("Creating a tag")),
            onSelect: () => guarded(() => createTagAt(entry)),
          },
          // One `Delete tag <name>` per tag — the reference names the tag in
          // the item (commit-list.tsx:901-923). Without tag data (older host)
          // or without a tag on this commit, ONE disabled entry says why.
          ...(tags.length
            ? tags.map((tag, tagIndex) => ({
              id: `delete-tag:${tag}`,
              label: `Delete tag ${tag}`,
              danger: true,
              separatorBefore: tagIndex === 0,
              disabled: Boolean(historyBusyReason) || !api?.gitDeleteTag,
              title: historyBusyReason
                || (api?.gitDeleteTag ? undefined : missingChannel("Deleting a tag")),
              onSelect: () => guarded(() => deleteTagAt(entry, tag)),
            }))
            : [{
              id: "delete-tag",
              label: "Delete tag",
              separatorBefore: true,
              disabled: true,
              title: tagsKnown ? "This commit carries no tag to delete" : TAGS_UNKNOWN,
            }]),
          {
            id: "cherry-pick",
            label: "Cherry-pick commit…",
            disabled: Boolean(historyBusyReason) || !api?.gitCherryPickCommit,
            title: historyBusyReason
              || (api?.gitCherryPickCommit
                ? undefined
                : missingChannel("Cherry-picking a commit")),
            onSelect: () => guarded(() => cherryPickCommit(entry)),
          },
          {
            id: "copy-sha",
            label: "Copy SHA",
            separatorBefore: true,
            onSelect: () => void copyText(entry.hash, "SHA"),
          },
          {
            id: "copy-tags",
            label: tags.length > 1 ? "Copy tags" : "Copy tag",
            disabled: tags.length === 0,
            title: tagsKnown
              ? tags.length ? undefined : "This commit carries no tag to copy"
              : TAGS_UNKNOWN,
            onSelect: () => void copyText(tags.join(" "),
              tags.length > 1 ? "tags" : "tag"),
          },
          {
            id: "open-github",
            label: "View on GitHub",
            disabled: !commitWebUrl(entry.hash) || !api?.openExternal,
            title: commitWebUrl(entry.hash)
              ? undefined
              : "This repository has no hosted remote to open the commit on",
            onSelect: () => void api?.openExternal?.(commitWebUrl(entry.hash)),
          },
        ];
        // The row hosts its own push BUTTON now, so it cannot be a <button>
        // itself (nested interactive content); it keeps the button role, the
        // single tab stop and Enter/Space activation instead.
        return <div role="button" tabIndex={0} className="dock-scm-commit-row" key={entry.hash}
          title={summary || EMPTY_SUMMARY}
          aria-label={rowLabel}
          onClick={() => void openCommit(entry)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu({
              label: `Actions for commit ${entry.shortHash}`,
              items: commitMenuItems(),
              ...pointerMenuPoint(event),
            });
          }}
          onKeyDown={(event) => {
            if (isContextMenuKey(event)) {
              event.preventDefault();
              setContextMenu({
                label: `Actions for commit ${entry.shortHash}`,
                items: commitMenuItems(),
                ...elementMenuPoint(event.currentTarget),
              });
              return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            if (event.target !== event.currentTarget) return;
            event.preventDefault();
            void openCommit(entry);
          }}>
          <span className="dock-scm-commit-info">
            <b data-empty={summary ? undefined : true}>{summary || EMPTY_SUMMARY}</b>
            <small>{author || UNKNOWN_AUTHOR} · {entry.when}</small>
          </span>
          <span className="dock-scm-commit-indicators">
            {/* renderCommitListItemTags (:251-266): the FIRST ref only. The
                rest stay reachable — counted VISIBLY as `+N` for pointer and
                touch, spelled out in the row's accessible name for AT, and
                listed in the tooltip for the mouse. */}
            {refs.length > 0 && <i className="dock-scm-refs" title={refs.join(", ")}>
              <em>{refs[0]}</em>
              {refs.length > 1 && <span className="dock-scm-refs-more"
                aria-hidden="true">+{refs.length - 1}</span>}
            </i>}
            {/* renderUnpushedIndicator (:196-211) promoted to an ACTION: a
                round push button that runs the toolbar's push, under the
                toolbar's own rules. */}
            {/* A download-style accent action, smaller than the composer's
                28px send button but immediately visible at the row edge. */}
            {!entry.pushed && <button type="button" className="dock-scm-unpushed"
              aria-label={`Push unpushed commits to ${remoteName}`}
              disabled={rowPushBlocked}
              title={rowPushReason
                || `This commit has not been pushed — push to ${remoteName}`}
              onClick={(event) => {
                event.stopPropagation();
                if (rowPushBlocked) return;
                void run("push", () => api?.gitPush?.(projectPath));
              }}>
              <ArrowUp size={12} aria-hidden="true" />
            </button>}
          </span>
        </div>;
      })}
      <RowSpacer edge="trailing" height={historyWindow.trailing} />
      {historyLoading && <p className="utility-dock-empty">Loading history…</p>}
      {!historyLoading && history.length === 0 && <p className="utility-dock-empty">No commits found.</p>}
    </div>}
    </>
    </div>
  </div>;
}
