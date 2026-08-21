import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  Copy,
  GitCommit,
  Minus,
  Search,
  Undo2,
  X
} from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ProgressSpinner } from "./ProgressSpinner";
import { commitImmediateOverlay, useImmediateOverlayClickGuard } from "./immediate-overlay";
import type {
  DesktopGitBranch,
  DesktopGitCommitDetails,
  DesktopGitCommitFile,
  DesktopGitFile,
  DesktopGitLogEntry,
  DesktopGitStatus,
} from "../shared/contract";
import { isConventionalCommitMessage } from "../shared/commit-message-format";
import { t } from "./i18n";
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
import { ScmStatusIcon, scmStatusKind } from "./ScmStatusIcon";
import {
  changedFileMenuItems,
  SourceControlFileRow,
} from "./source-control-file-row";
import { sourceControlRemoteActions } from "./source-control-remote-actions";
import { SourceControlBranchPicker } from "./source-control-branch-picker";
import { useSurfaceActive } from "./surface-activity";
import {
  changedFilesLabel,
  DEFAULT_BRANCH_NAMES,
  EMPTY_SUMMARY,
  gitRemoteWebUrl,
  HISTORY_PAGE_SIZE,
  HISTORY_PREFETCH_ROWS,
  indexOnly,
  isDirtyResetRefusal,
  leavesStateBehind,
  partiallyStaged,
  pathsFor,
  pullRequestUrl,
  RowSpacer,
  SCM_COMMIT_ROW_HEIGHT,
  SCM_FILE_ROW_HEIGHT,
  SCM_SORT_KEY,
  stagedInIndex,
  statusKind,
  UNKNOWN_AUTHOR,
  useAnchoredPanel,
  useRowWindow,
  type ScmSortKey,
  type SourceControlDiffRequest,
} from "./source-control-support";
export {
  changedFilesLabel,
  gitRemoteWebUrl,
  isDirtyResetRefusal,
  pullRequestUrl,
  type ScmRowWindow,
  type SourceControlDiffRequest,
} from "./source-control-support";

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
  /** Project picker hosted in its own row above the fixed Git toolbar. */
  projectSelect?: React.ReactNode;
  /** `changes` is the Git panel; `prs` is the separate pull-request panel. */
  surface?: "changes" | "prs";
}) {
  const api = window.mixdogDesktop;
  const prOnly = surface === "prs";
  const [history, setHistory] = useState<DesktopGitLogEntry[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // Commit messages keep summary and description as separate fields.
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  /** Settings → Git commit format: a ghost-text placeholder only (user
   *  decision: 프리셋 + 미리보기) — nothing is ever inserted into the draft —
   *  plus the auto-commit-message switch. */
  const [commitFormat, setCommitFormat] = useState<{ preset: string; example: string; auto: boolean }>(
    // Auto defaults ON (user decision); the preferences read reconciles.
    { preset: "none", example: "", auto: true },
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
   *  `ok: false` means the clipboard
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
  /** Every changed file is included until unchecked, so only exclusions are
   *  tracked and newly discovered files stay included. */
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

  /** Branches are grouped under the repository's default branch.
   *  `gitBranches` drops symbolic refs, so the only
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

  // ONE flat working-directory list: no staged /
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
  // Commit message = summary, blank line, description.
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
  // Put the resolved default branch first; only guess from conventional names
  // when the repository exposes no remote HEAD.
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
        example: String(preferences?.commitExample
          || String(preferences?.commitTemplate || "").split(/\r?\n/)[0]
          || ""),
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
        commitPreset?: string; commitTemplate?: string; commitExample?: string;
        autoCommitMessage?: boolean;
      }>).detail;
      if (!detail) return;
      setCommitFormat({
        preset: String(detail.commitPreset || "none"),
        example: String(detail.commitExample
          || String(detail.commitTemplate || "").split(/\r?\n/)[0]
          || ""),
        auto: detail.autoCommitMessage === true,
      });
    };
    window.addEventListener("mixdog:git-preferences-changed", onPreferences);
    return () => window.removeEventListener("mixdog:git-preferences-changed", onPreferences);
  }, []);
  // The conventional string mirrors Settings → Git's preset preview.
  const commitFormatLines = (commitFormat.preset === "conventional"
    ? "feat(scope): summary"
    : commitFormat.preset === "custom" ? commitFormat.example : "").split("\n");
  const summaryPlaceholder = (commitFormatLines[0] || "").trim() || "Summary (required)";
  const descriptionPlaceholder = commitFormatLines.slice(1).join("\n").trim() || "Description";
  /** Auto-message needs both the setting AND a build that carries the API. */
  const autoCommitMessage = commitFormat.auto && Boolean(api?.gitGenerateCommitMessage);
  const conventionalWarning = commitFormat.preset === "conventional"
    && Boolean(summary.trim())
    && !isConventionalCommitMessage(summary);
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
  /** Ask for the reset mode before confirmation; `hard` states what it
   *  destroys. */
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
        // refusal IS the warning: it is surfaced as such, and a confirmed reset comes
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
   *  and one item per tag replaces its submenu. */
  const deleteTagAt = (entry: DesktopGitLogEntry, tag: string) => {
    if (!confirmCommit(entry, `Delete tag "${tag}"? The tag is removed locally.`)) return;
    void run(`tag-delete:${tag}`, () => api?.gitDeleteTag?.(projectPath, tag));
  };
  /** `Amend commit…` / `Undo commit…`: both belong to
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
  /** Short SHA + copy affordance.
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

  const fileRow = (file: DesktopGitFile) => {
    const included = isIncluded(file);
    const rowSelected = selected.has(file.path);
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
    const fileMenuItems = () => changedFileMenuItems({
      file,
      busy: Boolean(busy),
      canRevert: Boolean(api?.gitRevert),
      canIgnore: Boolean(api?.gitIgnore),
      canReveal: Boolean(api?.revealFile),
      canOpenDefault: Boolean(api?.openFilePath),
      missingChannel,
      guarded,
      onDiscard: discardActionFiles,
      onIgnore: (path, scope) => {
        const extension = scope ? path.slice(path.lastIndexOf(".")) : "";
        void run(
          scope ? `ignore-extension:${extension}` : `ignore:${path}`,
          () => api?.gitIgnore?.(projectPath, path, scope),
        );
      },
      onCopyFilePath: () => { void copyText(absoluteFilePath(file.path), "file path"); },
      onCopyRelativePath: () => { void copyText(file.path, "relative file path"); },
      onReveal: () => { void api?.revealFile?.(projectPath, file.path); },
      onOpenDefault: () => { void api?.openFilePath?.(projectPath, file.path); },
    });
    return <SourceControlFileRow key={file.path}
      file={file}
      included={included}
      selected={rowSelected}
      busy={Boolean(busy)}
      contextMenuProps={rowContextMenu(`Actions for ${file.path}`, fileMenuItems)}
      onSetIncluded={(next) => setIncluded(file, next)}
      onToggleSelected={(additive) => toggleSelected(file, additive)}
      onOpenChange={openChange}
      onOpenFile={() => onOpenFile?.(projectPath, file.path)}
      onResolve={() => {
        void run(`resolve:${file.path}`,
          () => api?.gitStage?.(projectPath, pathsFor(file)));
      }}
      onDiscard={discardActionFiles} />;
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
    // Seed the create-branch flow with the current filter text.
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
  const {
    remoteName,
    aheadCount,
    behindCount,
    fetchEntry,
    pushEntry,
    rowPushReason,
    rowPushBlocked,
  } = sourceControlRemoteActions({
    status,
    busy,
    canFetch: Boolean(api?.gitFetch),
    canPush: Boolean(api?.gitPush),
    missingChannel,
    onFetch: () => void run("fetch", () => api?.gitFetch?.(projectPath)),
    onPush: () => void run("push", () => api?.gitPush?.(projectPath)),
  });
  /** Stash grammar (`Stash all changes`): the
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
    {/* ONE portaled context menu for every row grammar in the dock. */}
    <ScmContextMenu state={visibleContextMenu} onClose={closeContextMenu} />
    {status && !prOnly && projectSelect &&
      <div className="utility-dock-project-row">{projectSelect}</div>}
    {/* Fixed toolbar: current branch, Push, and Fetch. Git action names and
        their supporting labels intentionally stay in English. */}
    {status && !prOnly && <div className="dock-scm-toolbar" data-i18n-skip>
      <SourceControlBranchPicker
        status={status}
        busy={busy}
        open={branchPickerVisible}
        query={branchQuery}
        loading={branchLoading}
        visibleBranches={visibleBranches}
        defaultBranch={defaultBranch}
        otherBranches={otherBranches}
        mergeMode={mergeMode}
        capabilities={{
          list: Boolean(api?.gitBranches),
          create: Boolean(api?.gitCreateBranch),
          checkout: Boolean(api?.gitCheckoutBranch),
          rename: Boolean(api?.gitRenameBranch),
          delete: Boolean(api?.gitDeleteBranch),
          merge: Boolean(api?.gitMergeBranch),
        }}
        rootRef={branchPickerRef}
        triggerRef={branchTriggerRef}
        panelRef={branchPanelRef}
        panelStyle={branchPanelStyle}
        clickGuard={branchPickerClickGuard}
        rowContextMenu={rowContextMenu}
        missingChannel={missingChannel}
        guarded={guarded}
        onOpen={openBranchPicker}
        onClose={() => setBranchPickerOpen(false)}
        onQueryChange={setBranchQuery}
        onCreate={createBranchFromFilter}
        onCheckout={checkoutBranch}
        onRename={renameBranch}
        onDelete={deleteBranch}
        onMerge={mergeIntoCurrent}
        onToggleMergeMode={() => setMergeMode((current) => !current)}
      />
      {[pushEntry, fetchEntry].map((entry) =>
        <div key={entry.key}
          className={`dock-scm-toolbar-section dock-scm-toolbar-${entry.key}`}>
          <button type="button" className="dock-scm-remote-button"
            data-remote-action={entry.key}
            title={entry.reason || entry.label}
            aria-label={entry.label}
            disabled={Boolean(busy) || Boolean(status.operation) || entry.blocked}
            onClick={entry.perform}>
            {busy === entry.runKey
              ? <ProgressSpinner size={14} aria-hidden="true" />
              : entry.icon}
            <span className="dock-scm-remote-label">
              <span className="dock-scm-remote-verb">{entry.verb}</span>
              {entry.target
                ? <span className="dock-scm-remote-target">{` ${entry.target}`}</span>
                : null}
            </span>
            {entry.key === "push" && status.upstream && (aheadCount > 0 || behindCount > 0) &&
              <span className="dock-scm-ahead-behind">
                {aheadCount > 0 && <span>{aheadCount}
                  <ArrowUp size={12} aria-hidden="true" /></span>}
                {behindCount > 0 && <span>{behindCount}
                  <ArrowDown size={12} aria-hidden="true" /></span>}
              </span>}
          </button>
        </div>)}
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
      // Two equal tabs span the panel; the selected tab owns the inset marker
      // and the Changes tab carries the counter. Semantics remain a radio group
      // with roving tabindex.
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
          {/* One `with-indicator` span per tab, the
              label then the changed-file counter. */}
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
      {/* Tri-state select-all row; the shared filter box lives in the view
          controls above Changes | History. */}
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
            {/* Stash all changes / Pop stash hang off the
                changed-files list, which is
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
        // The primary button carries the whole action — verb, file count and
        // target branch — and it is the form's ONLY control. Push and Fetch
        // remain fixed in the toolbar; Amend and Undo commit live on history
        // rows, and the stash pair lives on the changed-files header.
        const committing = busy === "commit" || busy === "amend";
        // With auto messages on, an empty summary still commits in one press
        // (silent generation); the tooltip below is the only tell.
        const autoDraft = !summary.trim() && autoCommitMessage;
        const branchName = status?.detached ? "" : status?.branch || "";
        const selectedCommitCount = includedFiles.length;
        // Button text: verb, then
        // "N file(s) ", then "to " and the BOLD branch.
        const verb = committing ? "Committing…" : "Commit";
        const countText = selectedCommitCount > 0
          ? `${selectedCommitCount} ${selectedCommitCount > 1 ? "files" : "file"} `
          : "";
        // Disabled set (shared with the title menu through `commitBlocked`):
        // blank summary, nothing selected, a commit in flight, an in-progress
        // Git operation, or unresolved conflicts.
        const primaryDisabled = commitBlocked;
        // Tooltip strings.
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
          // Ctrl/Cmd+Enter submits from either field only when the user typed a
          // summary; an empty draft never starts
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
              — a real single-line
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
          {conventionalWarning && <p className="dock-scm-commit-format-warning" role="status">
            {t("Expected {{format}}. You can still commit this message.", { format: "type(scope)!: description" })}
          </p>}
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
      // Commit header grammar: title, then ONE meta row of author NAME (no
      // monogram — the header follows the history rows, where the disc only
      // ate width), commit ref (short SHA + copy button) and the added/deleted
      // line totals; the changed-file list is introduced by an
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
                loses characters. */}
            <ScmPathText title={file.path}
              path={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} />
            {/* The counts are a FIXED right-aligned column, so the path keeps
                every pixel they do not need. */}
            <small className="dock-scm-commit-file-lines">
              {file.additions > 0 && <i>+{file.additions}</i>}
              {file.deletions > 0 && <em>-{file.deletions}</em>}
            </small>
            {/* ONE trailing control per row: the status icon, same grammar as
                the working-directory rows. */}
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
      {/* History row without the avatar stack (the dock has
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
        // undo additionally applies to a LOCAL one.
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
        // The history context menu in its
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
          // the item. Without tag data (older host)
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
