// Pull Requests dock surface — GitHub Desktop's compact filtered-list grammar
// for the dock, with the Orca-derived metadata and tab hierarchy in the editor.
// Data and actions are backed by the gh CLI IPC chain.
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  FileDiff,
  FileText,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestDraft,
  Github,
  ListChecks,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DesktopPullRequestCategory,
  DesktopPullRequestDetail,
  DesktopPullRequestEntry,
} from "../shared/contract";
import { ProgressSpinner } from "./ProgressSpinner";
import { GitFileDiff } from "./ReviewPane";
import { OpenSelect } from "./OpenSelect";
import { useSurfaceActive } from "./surface-activity";
import { RowOverflowMenu } from "./RowOverflowMenu";
import { ScmPathText } from "./ScmPathText";
import { ScmStatusIcon, type ScmStatusKind } from "./ScmStatusIcon";

export type PullRequestViewMode = "overview" | "changes";
export type PullRequestListView = "open" | "mine" | "review";
export type PullRequestOpenHandler = (
  projectPath: string,
  pullRequest: DesktopPullRequestEntry,
  mode: PullRequestViewMode,
  toSide?: boolean,
) => void;

const PULL_REQUEST_LIST_VIEWS: readonly PullRequestListView[] = ["open", "mine", "review"];
const PULL_REQUEST_DETAIL_TABS = ["conversation", "checks", "files"] as const;
type PullRequestDetailTab = typeof PULL_REQUEST_DETAIL_TABS[number];

/** Split one `gh pr diff` payload into per-file unified patches. */
export function splitPrDiff(diff: string): Map<string, string> {
  const patches = new Map<string, string>();
  const lines = String(diff ?? "").split("\n");
  let path = "";
  let buffer: string[] = [];
  const flush = () => {
    if (path && buffer.length) patches.set(path, buffer.join("\n"));
  };
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      path = header[2];
      buffer = [line];
      continue;
    }
    if (path) buffer.push(line);
  }
  flush();
  return patches;
}

function relativeAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 2_592_000) return `${Math.round(seconds / 86_400)}d`;
  return `${Math.round(seconds / 2_592_000)}mo`;
}

/** The PR payload carries no per-file status (contract: DesktopPullRequestFile
 *  is path + counts), so the changed-file rows read their status kind off the
 *  unified patch header the list already holds — `new file mode` /
 *  `deleted file mode` / `rename from` / `copy from`. Without that header the
 *  file is a MODIFICATION; the +/- totals are never guessed from. */
export function prFileStatusKind(patch: string | undefined): ScmStatusKind {
  const header = (patch ?? "").split("@@")[0];
  if (/^new file mode /m.test(header)) return "new";
  if (/^deleted file mode /m.test(header)) return "deleted";
  if (/^rename from /m.test(header)) return "renamed";
  if (/^copy from /m.test(header)) return "copied";
  return "modified";
}

function StateIcon({ pr }: { pr: DesktopPullRequestEntry }) {
  if (pr.isDraft) return <GitPullRequestDraft size={14} className="dock-pr-state-draft" aria-hidden="true" />;
  if (pr.state === "MERGED") return <GitMerge size={14} className="dock-pr-state-merged" aria-hidden="true" />;
  return <GitPullRequestArrow size={14}
    className={pr.state === "CLOSED" ? "dock-pr-state-closed" : "dock-pr-state-open"} aria-hidden="true" />;
}

function AuthorIcon({ login }: { login: string }) {
  return <span className="dock-pr-avatar" aria-hidden="true">
    <Github size={14} />
    {login && <img src={`https://github.com/${encodeURIComponent(login)}.png?size=32`} alt=""
      onError={(event) => event.currentTarget.remove()} />}
  </span>;
}

export function buildPullRequestCategories(
  categories: readonly DesktopPullRequestCategory[],
  localBranchNames: ReadonlySet<string>,
): DesktopPullRequestCategory[] {
  const source = categories.filter((category) => category.key !== "local");
  const all = source.find((category) => category.key === "all")?.prs ?? [];
  const local = {
    key: "local",
    label: "Local Pull Request Branches",
    prs: all.filter((pr) => localBranchNames.has(pr.headRefName)),
  };
  const copilotIndex = source.findIndex((category) => category.key === "copilot");
  // Renderer HMR can temporarily talk to an older desktop main process, and
  // older Enterprise hosts may omit the optional Copilot query altogether.
  // Keep the current extension's visible category grammar stable in both.
  if (copilotIndex < 0) {
    return [
      { key: "copilot", label: "Copilot on My Behalf", prs: [] },
      local,
      ...source,
    ];
  }
  return [
    ...source.slice(0, copilotIndex + 1),
    local,
    ...source.slice(copilotIndex + 1),
  ];
}

function dedupePullRequests(entries: readonly DesktopPullRequestEntry[]): DesktopPullRequestEntry[] {
  const seen = new Set<number>();
  return entries.filter((entry) => {
    if (seen.has(entry.number)) return false;
    seen.add(entry.number);
    return true;
  });
}

export function buildPullRequestViews(
  categories: readonly DesktopPullRequestCategory[],
  localBranchNames: ReadonlySet<string>,
): Record<PullRequestListView, DesktopPullRequestEntry[]> {
  const display = buildPullRequestCategories(categories, localBranchNames);
  const byKey = new Map(display.map((category) => [category.key, category.prs] as const));
  const fallbackOpen = dedupePullRequests(display.flatMap((category) => category.prs));
  return {
    open: dedupePullRequests(byKey.get("all") ?? fallbackOpen),
    mine: dedupePullRequests([
      ...(byKey.get("created") ?? []),
      ...(byKey.get("local") ?? []),
      ...(byKey.get("copilot") ?? []),
    ]),
    review: dedupePullRequests(byKey.get("review-requested") ?? []),
  };
}

function pullRequestMatchesFilter(entry: DesktopPullRequestEntry, rawFilter: string): boolean {
  const filter = rawFilter.trim().toLocaleLowerCase();
  if (!filter) return true;
  return [
    `#${entry.number}`,
    String(entry.number),
    entry.title,
    entry.author,
    entry.headRefName,
    entry.baseRefName,
  ].some((value) => value.toLocaleLowerCase().includes(filter));
}

export function pullRequestsWebUrl(repositoryUrl: string): string {
  const base = repositoryUrl.replace(/\/+$/, "");
  if (!base) return "";
  return /gitlab/i.test(base) ? `${base}/-/merge_requests` : `${base}/pulls`;
}

function titleFromBranch(branch: string): string {
  const leaf = branch.split("/").filter(Boolean).at(-1) ?? branch;
  const text = leaf.replace(/[-_.]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? `${text[0].toLocaleUpperCase()}${text.slice(1)}` : "";
}

export function PullRequestsPane({
  projectPath,
  prUrl,
  repositoryUrl,
  currentBranch,
  createHint,
  headerSlot,
  onOpenPullRequest,
}: {
  projectPath: string;
  /** Hosted compare URL when the branch is pushed and PR-ready (else ""). */
  prUrl: string;
  /** Hosted repository page used by the view-title overflow actions. */
  repositoryUrl: string;
  currentBranch: string;
  /** Guidance when a PR cannot be created yet (publish/push first). */
  createHint: string;
  /** VS Code-style view/title action host owned by the utility dock header. */
  headerSlot?: HTMLElement | null;
  /** Opens the extension-style overview or changes surface in an editor group. */
  onOpenPullRequest?: PullRequestOpenHandler;
}) {
  const api = window.mixdogDesktop;
  const [categories, setCategories] = useState<DesktopPullRequestCategory[] | null>(null);
  const [listError, setListError] = useState("");
  const [loading, setLoading] = useState(false);
  const [listView, setListView] = useState<PullRequestListView>("open");
  const [filter, setFilter] = useState("");
  const [localBranchNames, setLocalBranchNames] = useState<Set<string>>(new Set());
  const [baseBranchNames, setBaseBranchNames] = useState<string[]>(["main"]);
  const [defaultBranchName, setDefaultBranchName] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createBody, setCreateBody] = useState("");
  const [createBase, setCreateBase] = useState("main");
  const [createDraft, setCreateDraft] = useState(false);
  const [createError, setCreateError] = useState("");
  const [busy, setBusy] = useState("");
  // The Dock retains this pane while another tab is presented. Retained is not
  // running: no ghPrList/gitBranches may be issued while inactive, and any
  // in-flight list is invalidated on deactivate or project change so a late
  // answer cannot repaint a surface the user has left. The rows already loaded
  // stay on screen, so re-entry is instant.
  const surfaceActive = useSurfaceActive();
  const listEpoch = useRef(0);
  const loadedProject = useRef<string | null>(null);

  const loadList = useCallback(async () => {
    if (!projectPath || !surfaceActive) return;
    const epoch = ++listEpoch.current;
    setLoading(true);
    try {
      const [rows, branches, remoteDefaultBranch] = await Promise.all([
        api?.ghPrList?.(projectPath),
        api?.gitBranches?.(projectPath).catch(() => []),
        api?.ghPrDefaultBranch?.(projectPath).catch(() => "") ?? Promise.resolve(""),
      ]);
      if (epoch !== listEpoch.current) return;
      setCategories(rows ?? []);
      setLocalBranchNames(new Set((branches ?? [])
        .filter((branch) => !branch.remote)
        .map((branch) => branch.name)));
      const baseNames = [...new Set((branches ?? []).flatMap((branch) => {
        const name = branch.remote ? branch.name.replace(/^[^/]+\//, "") : branch.name;
        return !name || name === "HEAD" ? [] : [name];
      }))];
      setBaseBranchNames(baseNames.length ? baseNames : ["main"]);
      setDefaultBranchName(remoteDefaultBranch
        || (baseNames.includes("main") ? "main" : baseNames.includes("master") ? "master" : baseNames[0] ?? "main"));
      setListError("");
    } catch (cause) {
      if (epoch !== listEpoch.current) return;
      setListError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch === listEpoch.current) setLoading(false);
    }
  }, [api, currentBranch, projectPath, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) {
      // Deactivation cancels: the epoch bump orphans every in-flight answer.
      listEpoch.current += 1;
      setLoading(false);
      return;
    }
    if (loadedProject.current !== projectPath) {
      loadedProject.current = projectPath;
      setCategories(null);
      setListError("");
      setListView("open");
      setFilter("");
      setCreateOpen(false);
      setCreateError("");
      setDefaultBranchName("");
    }
    void loadList();
  }, [loadList, projectPath, surfaceActive]);

  const run = useCallback(async (key: string, action: () => Promise<unknown> | undefined) => {
    setBusy(key);
    try {
      await action();
      setListError("");
      await loadList();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setListError(message);
    } finally {
      setBusy("");
    }
  }, [loadList]);

  const refreshAll = useCallback(() => {
    void loadList();
  }, [loadList]);

  const pullRequestViews = useMemo(() => {
    if (categories === null) return null;
    return buildPullRequestViews(categories, localBranchNames);
  }, [categories, localBranchNames]);
  const visiblePullRequests = useMemo(
    () => (pullRequestViews?.[listView] ?? []).filter((entry) =>
      pullRequestMatchesFilter(entry, filter)),
    [filter, listView, pullRequestViews],
  );

  const repositoryPullsUrl = useMemo(() => pullRequestsWebUrl(repositoryUrl), [repositoryUrl]);
  const defaultBaseBranch = defaultBranchName || (baseBranchNames.includes("main") ? "main"
    : baseBranchNames.includes("master") ? "master"
      : baseBranchNames[0] ?? "main");
  const onDefaultBranch = Boolean(currentBranch && defaultBaseBranch
    && currentBranch.toLocaleLowerCase() === defaultBaseBranch.toLocaleLowerCase());
  const beginCreatePullRequest = () => {
    setCreateTitle(titleFromBranch(currentBranch));
    setCreateBody("");
    setCreateBase(defaultBaseBranch);
    setCreateDraft(false);
    setCreateError("");
    setCreateOpen(true);
  };
  const cancelCreatePullRequest = () => {
    if (busy === "create") return;
    setCreateOpen(false);
    setCreateError("");
  };
  const submitCreatePullRequest = async () => {
    const title = createTitle.trim();
    const base = createBase.trim();
    if (!title || !base || !currentBranch || base.toLocaleLowerCase() === currentBranch.toLocaleLowerCase()) return;
    if (!api?.ghPrCreate) {
      setCreateError("Pull request creation is unavailable in this host.");
      return;
    }
    setBusy("create");
    setCreateError("");
    try {
      if (!prUrl) {
        if (!api.gitPush) throw new Error(createHint || "Publish or push this branch before creating a pull request.");
        await api.gitPush(projectPath);
      }
      const created = await api.ghPrCreate(projectPath, {
        base,
        head: currentBranch,
        title,
        body: createBody,
        draft: createDraft,
      });
      setCreateOpen(false);
      await loadList();
      onOpenPullRequest?.(projectPath, created, "overview", false);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  };
  const openPullRequest = (
    pullRequest: DesktopPullRequestEntry,
    mode: PullRequestViewMode = "overview",
    toSide = false,
  ) => {
    if (onOpenPullRequest) {
      onOpenPullRequest(projectPath, pullRequest, mode, toSide);
      return;
    }
    if (pullRequest.url) void api?.openExternal?.(pullRequest.url);
  };
  const checkoutByNumber = () => {
    const raw = window.prompt("Pull request number", "");
    if (raw === null) return;
    const match = /^#?(\d+)$/.exec(raw.trim());
    if (!match) {
      setListError("Enter a valid pull request number.");
      return;
    }
    const number = Number(match[1]);
    void run(`checkout:${number}`, () => api?.ghPrCheckout?.(projectPath, number));
  };
  const renderHeaderActions = () => <>
    <button type="button" aria-label="Create pull request"
      disabled={createOpen || onDefaultBranch || !currentBranch || !api?.ghPrCreate
        || (!prUrl && !api?.gitPush) || Boolean(busy)}
      title={onDefaultBranch ? "Create or check out a feature branch first." : createHint || "Create Pull Request"}
      data-tooltip={onDefaultBranch ? "Create or check out a feature branch first." : createHint || "Create Pull Request"}
      onClick={beginCreatePullRequest}>
      <Plus size={14} aria-hidden="true" />
    </button>
    <button type="button" aria-label="Refresh pull requests" disabled={loading || Boolean(busy)}
      data-tooltip="Refresh Pull Requests" onClick={refreshAll}>
      <RefreshCw size={14} className={loading ? "spin" : undefined} aria-hidden="true" />
    </button>
    <RowOverflowMenu label="More pull request actions" items={[
      {
        id: "open-github",
        label: "Open Pull Requests on GitHub",
        disabled: !repositoryPullsUrl,
        onSelect: () => { if (repositoryPullsUrl) void api?.openExternal?.(repositoryPullsUrl); },
      },
      {
        id: "checkout",
        label: "Checkout Pull Request…",
        disabled: Boolean(busy) || !api?.ghPrCheckout,
        onSelect: checkoutByNumber,
      },
    ]} />
  </>;
  const headerPortal = headerSlot ? createPortal(renderHeaderActions(), headerSlot) : null;
  const inlineHeader = !headerSlot && <div className="dock-pr-toolbar">{renderHeaderActions()}</div>;
  const viewLabels: Record<PullRequestListView, string> = {
    open: "Open",
    mine: "Mine",
    review: "Review",
  };
  const activeViewCount = pullRequestViews?.[listView].length ?? 0;
  const emptyTitle = filter
    ? "No matching pull requests"
    : listView === "open"
      ? "No open pull requests"
      : listView === "mine"
        ? "No pull requests from you"
        : "No pull requests awaiting your review";
  const emptyMessage = filter
    ? "Try a different search."
    : listView === "open"
      ? onDefaultBranch
        ? "Create or check out a feature branch to open a pull request."
        : prUrl
        ? "Create a pull request from the current branch."
        : createHint || "This repository has no open pull requests."
      : listView === "mine"
        ? "Pull requests you create or check out will appear here."
        : "Review requests assigned to you will appear here.";
  const scopeOptions = PULL_REQUEST_LIST_VIEWS.map((view) => ({
    value: view,
    label: `${viewLabels[view]} (${pullRequestViews?.[view].length ?? 0})`,
  }));
  const createDisabled = !createTitle.trim() || !createBase.trim() || !currentBranch
    || createBase.trim().toLocaleLowerCase() === currentBranch.toLocaleLowerCase()
    || busy === "create";

  return <>{headerPortal}<div className="dock-pr-surface">
    {inlineHeader}
    {!createOpen && <>
      <div className="dock-pr-view-controls workbench-explorer-search">
        <label className="dock-pr-search workbench-search-input">
          <Search size={14} aria-hidden="true" />
          <input type="search" value={filter}
            aria-label="Filter pull requests" placeholder="Filter pull requests"
            onInput={(event) => setFilter(event.currentTarget.value)} />
          {filter && <button type="button" aria-label="Clear pull request filter"
            onClick={() => setFilter("")}>
            <X size={13} aria-hidden="true" />
          </button>}
        </label>
      </div>
      <div className="dock-pr-list-header">
        <OpenSelect className="dock-pr-scope-select" ariaLabel="Pull request list"
          value={listView} options={scopeOptions}
          displayValue={`${viewLabels[listView]} pull requests · ${activeViewCount}`}
          onChange={(value) => setListView(value as PullRequestListView)} />
      </div>
    </>}
    <div className="dock-scm-scroll dock-pr-list">
      {createOpen && <form className="dock-pr-create" onSubmit={(event) => {
        event.preventDefault();
        void submitCreatePullRequest();
      }}>
        <header>
          <GitPullRequestArrow size={16} aria-hidden="true" />
          <span><b>New pull request</b><small>{currentBranch} → {createBase || "base"}</small></span>
        </header>
        <label>
          <span>Title</span>
          <input type="text" aria-label="Pull request title" value={createTitle} maxLength={1024}
            autoFocus onInput={(event) => setCreateTitle(event.currentTarget.value)} />
        </label>
        <label>
          <span>Description</span>
          <textarea aria-label="Pull request description" rows={6} value={createBody}
            placeholder="Description (optional)"
            onInput={(event) => setCreateBody(event.currentTarget.value)} />
        </label>
        <div className="dock-pr-create-base">
          <span>Base</span>
          <OpenSelect className="dock-pr-base-select" ariaLabel="Pull request base branch"
            value={createBase}
            options={baseBranchNames.map((branch) => ({ value: branch, label: branch }))}
            onChange={setCreateBase} />
        </div>
        <label className="dock-pr-create-draft">
          <input type="checkbox" checked={createDraft}
            onChange={(event) => setCreateDraft(event.currentTarget.checked)} />
          <span>Create as draft</span>
        </label>
        {!prUrl && <p className="dock-pr-create-note">{createHint || "The branch will be pushed before creation."}</p>}
        {createError && <p className="dock-pr-create-error" role="alert">{createError}</p>}
        <footer>
          <button type="button" onClick={cancelCreatePullRequest} disabled={busy === "create"}>Cancel</button>
          <button type="submit" disabled={createDisabled}>
            {busy === "create" && <ProgressSpinner size={13} aria-hidden="true" />}
            {busy === "create" ? "Creating…" : !prUrl ? "Push & Create PR"
              : createDraft ? "Create draft PR" : "Create PR"}
          </button>
        </footer>
      </form>}
      {!createOpen && <>
      {listError && <div className="dock-pr-error-state" role="alert">
        <Github size={18} aria-hidden="true" />
        <div>
          <b>Could not load pull requests</b>
          <span>{listError}</span>
        </div>
        <button type="button" onClick={() =>
          void api?.openExternal?.("https://cli.github.com/manual/gh_auth_login")}>
          GitHub CLI help
        </button>
      </div>}
      {categories === null && !listError && <p className="utility-dock-empty">
        <ProgressSpinner size={14} aria-hidden="true" /> Loading pull requests…
      </p>}
      {pullRequestViews && !listError && visiblePullRequests.length === 0 &&
        <div className="dock-pr-empty" role="status">
          <GitPullRequestArrow size={23} aria-hidden="true" />
          <b>{emptyTitle}</b>
          <span>{emptyMessage}</span>
          {!filter && listView === "open" && !onDefaultBranch && currentBranch && api?.ghPrCreate &&
            <button type="button" onClick={beginCreatePullRequest}>
              Create pull request
            </button>}
        </div>}
      {pullRequestViews && !listError && visiblePullRequests.length > 0 &&
        <div className="dock-pr-results" role="list"
          aria-label={`${viewLabels[listView]} pull requests`}>
          {visiblePullRequests.map((pr) => {
            const checkedOut = Boolean(currentBranch && pr.headRefName === currentBranch);
            const checkoutKey = `checkout:${pr.number}`;
            return <div className="dock-pr-row" data-draft={pr.isDraft || undefined}
              role="listitem" key={pr.number}>
              <button type="button" className="dock-pr-row-main"
                onClick={() => openPullRequest(pr)}>
                <span className="dock-pr-row-icon" aria-hidden="true">
                  <StateIcon pr={pr} />
                </span>
                <span className="dock-pr-row-label">
                  <b>{pr.title}</b>
                  <small>#{pr.number}
                    {relativeAge(pr.updatedAt) ? ` · ${relativeAge(pr.updatedAt)}` : ""}
                    {pr.author ? ` · @${pr.author}` : ""}
                  </small>
                </span>
                <span className="dock-pr-row-signals" aria-hidden="true">
                  {checkedOut && <Check size={12} className="dock-pr-row-active" />}
                  {pr.checks.total > 0 && <i className="dock-pr-row-checks" data-checks={
                    pr.checks.failing > 0 ? "failing" : pr.checks.pending > 0 ? "pending" : "passing"
                  } />}
                </span>
              </button>
              <span className="dock-pr-row-actions">
                <button type="button" aria-label={`Open changes for pull request ${pr.number}`}
                  data-tooltip="Open Changes" onClick={() => openPullRequest(pr, "changes")}>
                  <FileDiff size={13} aria-hidden="true" />
                </button>
                {!checkedOut && <button type="button" aria-label={`Checkout pull request ${pr.number}`}
                  data-tooltip="Checkout Pull Request" disabled={Boolean(busy) || !api?.ghPrCheckout}
                  onClick={() => void run(checkoutKey, () => api?.ghPrCheckout?.(projectPath, pr.number))}>
                  {busy === checkoutKey
                    ? <ProgressSpinner size={13} aria-hidden="true" />
                    : <ArrowRight size={13} aria-hidden="true" />}
                </button>}
                <RowOverflowMenu label={`Actions for pull request ${pr.number}`} items={[
                  {
                    id: "overview",
                    label: "View Pull Request Description",
                    onSelect: () => openPullRequest(pr),
                  },
                  {
                    id: "overview-side",
                    label: "Open Pull Request Description to the Side",
                    onSelect: () => openPullRequest(pr, "overview", true),
                  },
                  {
                    id: "changes",
                    label: "Open Changes",
                    onSelect: () => openPullRequest(pr, "changes"),
                  },
                  {
                    id: "checkout",
                    label: checkedOut ? "Pull Request Checked Out" : "Checkout Pull Request",
                    disabled: checkedOut || Boolean(busy) || !api?.ghPrCheckout,
                    onSelect: () => void run(checkoutKey, () =>
                      api?.ghPrCheckout?.(projectPath, pr.number)),
                  },
                  {
                    id: "open-github",
                    label: "Open on GitHub",
                    disabled: !pr.url,
                    onSelect: () => { if (pr.url) void api?.openExternal?.(pr.url); },
                  },
                  {
                    id: "refresh",
                    label: "Refresh Pull Request",
                    separatorBefore: true,
                    onSelect: refreshAll,
                  },
                ]} />
              </span>
            </div>;
          })}
        </div>}
      </>}
    </div>
  </div></>;
}

export function PullRequestEditor({
  projectPath,
  number,
  mode,
  active = true,
}: {
  projectPath: string;
  number: number;
  mode: PullRequestViewMode;
  active?: boolean;
}) {
  const api = window.mixdogDesktop;
  const [detail, setDetail] = useState<DesktopPullRequestDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [diffs, setDiffs] = useState<Map<string, string> | null>(null);
  const [currentBranch, setCurrentBranch] = useState("");
  const [openFile, setOpenFile] = useState("");
  const [detailTab, setDetailTab] = useState<PullRequestDetailTab>(
    mode === "changes" ? "files" : "conversation");
  const [busy, setBusy] = useState("");
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    setDetailTab(mode === "changes" ? "files" : "conversation");
  }, [mode, number]);

  useEffect(() => {
    if (!active || !projectPath || !number) return undefined;
    let live = true;
    setDetail(null);
    setDetailError("");
    setDiffs(null);
    setOpenFile("");
    void (async () => {
      try {
        const [prDetail, diffText, branches] = await Promise.all([
          api?.ghPrView?.(projectPath, number),
          api?.ghPrDiff?.(projectPath, number).catch(() => ""),
          api?.gitBranches?.(projectPath).catch(() => []),
        ]);
        if (!live) return;
        setDetail(prDetail ?? null);
        setDiffs(splitPrDiff(diffText ?? ""));
        setCurrentBranch((branches ?? []).find((branch) => branch.current)?.name ?? "");
      } catch (cause) {
        if (live) setDetailError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => { live = false; };
  }, [active, api, number, projectPath, refresh]);

  const run = useCallback(async (key: string, action: () => Promise<unknown> | undefined) => {
    setBusy(key);
    try {
      await action();
      setDetailError("");
      setRefresh((value) => value + 1);
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }, []);
  const checkedOut = Boolean(detail && currentBranch && detail.headRefName === currentBranch);
  const checksTone = !detail || detail.checks.pending > 0 ? "pending"
    : detail.checks.failing > 0 ? "failing" : "passing";
  const checksLabel = !detail || detail.checks.total === 0 ? "No checks reported"
    : detail.checks.failing > 0 ? `${detail.checks.failing} checks failing`
      : detail.checks.pending > 0 ? `${detail.checks.pending} checks pending`
        : "All checks passing";

  return <div className="workspace-pr-editor dock-pr-detail" data-mode={mode}>
    <header className="workspace-pr-editor-header">
      <div className="workspace-pr-editor-title-row">
        <h1>{detail?.title || `Pull Request #${number}`}
          {detail && <small>#{detail.number}</small>}
        </h1>
        <span className="workspace-pr-editor-header-actions">
          <button type="button" aria-label="Refresh pull request" disabled={Boolean(busy)}
            data-tooltip="Refresh Pull Request" onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw size={14} className={!detail && !detailError ? "spin" : undefined}
              aria-hidden="true" />
          </button>
          <button type="button" aria-label="Open pull request on GitHub" disabled={!detail?.url}
            data-tooltip="Open on GitHub"
            onClick={() => { if (detail?.url) void api?.openExternal?.(detail.url); }}>
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
      {detail && <>
        <div className="dock-pr-editor-meta">
          <span className="dock-pr-badge" data-state={detail.isDraft ? "DRAFT" : detail.state}>
            <StateIcon pr={detail} />
            {detail.isDraft ? "Draft" : detail.state === "OPEN" ? "Open"
              : detail.state === "MERGED" ? "Merged" : "Closed"}
          </span>
          <span className="dock-pr-author">
            <AuthorIcon login={detail.author} />
            <b>@{detail.author}</b>
          </span>
          <span className="dock-pr-refs">
            <code>{detail.baseRefName}</code> ← <code>{detail.headRefName}</code>
          </span>
          <span className="dock-pr-updated">updated {relativeAge(detail.updatedAt)} ago</span>
        </div>
        <div className="dock-pr-actions dock-pr-header-actions">
          <button type="button" disabled={Boolean(busy) || checkedOut}
            onClick={() => void run("checkout", () => api?.ghPrCheckout?.(projectPath, detail.number))}>
            {busy === "checkout" ? <ProgressSpinner size={13} aria-hidden="true" />
              : <Check size={13} aria-hidden="true" />}
            {checkedOut ? "Checked Out" : "Checkout"}
          </button>
          {detail.state === "OPEN" && !detail.isDraft && <span className="dock-pr-merge">
            <button type="button" disabled={Boolean(busy)}
              onClick={() => {
                const action = mergeMethod === "merge" ? "Merge"
                  : mergeMethod === "squash" ? "Squash and merge" : "Rebase and merge";
                if (!window.confirm(`${action} pull request #${detail.number}?`)) return;
                void run("merge", () => api?.ghPrMerge?.(projectPath, detail.number, mergeMethod));
              }}>
              {busy === "merge" ? <ProgressSpinner size={13} aria-hidden="true" />
                : <GitMerge size={13} aria-hidden="true" />}
              {mergeMethod === "merge" ? "Merge" : mergeMethod === "squash" ? "Squash" : "Rebase"}
            </button>
            <select aria-label="Merge method" value={mergeMethod} disabled={Boolean(busy)}
              onChange={(event) => setMergeMethod(event.currentTarget.value as typeof mergeMethod)}>
              <option value="merge">Create a merge commit</option>
              <option value="squash">Squash and merge</option>
              <option value="rebase">Rebase and merge</option>
            </select>
          </span>}
        </div>
      </>}
    </header>
    <div className="dock-pr-detail-tabs" role="tablist" aria-label="Pull request details"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const currentIndex = PULL_REQUEST_DETAIL_TABS.indexOf(detailTab);
        const nextIndex = event.key === "Home" ? 0
          : event.key === "End" ? PULL_REQUEST_DETAIL_TABS.length - 1
            : (currentIndex + (event.key === "ArrowRight" ? 1 : -1)
              + PULL_REQUEST_DETAIL_TABS.length) % PULL_REQUEST_DETAIL_TABS.length;
        const nextTab = PULL_REQUEST_DETAIL_TABS[nextIndex];
        setDetailTab(nextTab);
        requestAnimationFrame(() => document
          .querySelector<HTMLButtonElement>(`[data-pr-detail-tab="${nextTab}"]`)?.focus());
      }}>
      <button type="button" role="tab" data-pr-detail-tab="conversation"
        aria-selected={detailTab === "conversation"} tabIndex={detailTab === "conversation" ? 0 : -1}
        onClick={() => setDetailTab("conversation")}>
        <MessageSquare size={14} aria-hidden="true" /> Conversation
        {detail && <small>{detail.timeline.length}</small>}
      </button>
      <button type="button" role="tab" data-pr-detail-tab="checks"
        aria-selected={detailTab === "checks"} tabIndex={detailTab === "checks" ? 0 : -1}
        onClick={() => setDetailTab("checks")}>
        <ListChecks size={14} aria-hidden="true" /> Checks
        {detail && <small>{detail.checks.total}</small>}
      </button>
      <button type="button" role="tab" data-pr-detail-tab="files"
        aria-selected={detailTab === "files"} tabIndex={detailTab === "files" ? 0 : -1}
        onClick={() => setDetailTab("files")}>
        <FileText size={14} aria-hidden="true" /> Files changed
        {detail && <small>{detail.changedFiles}</small>}
      </button>
    </div>
    <div className="workspace-pr-editor-scroll">
      {detailError && <div className="dock-pr-error-state" role="alert">
        <Github size={18} aria-hidden="true" />
        <div><b>Could not load pull request</b><span>{detailError}</span></div>
        <button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry</button>
      </div>}
      {!detail && !detailError && <p className="utility-dock-empty">
        <ProgressSpinner size={14} aria-hidden="true" /> Loading pull request…
      </p>}
      {detail && <>
        {detailTab === "conversation" && <div className="dock-pr-panel dock-pr-conversation-panel"
          role="tabpanel" data-pr-detail-panel="conversation">
          <section className="dock-pr-description">
            <header>
              <AuthorIcon login={detail.author} />
              <b>@{detail.author}</b>
              <span>opened this pull request {relativeAge(detail.createdAt)} ago</span>
            </header>
            <div className="dock-pr-body">
              {detail.body.trim() || "No description provided."}
            </div>
          </section>
          {detail.labels.length > 0 && <div className="dock-pr-labels" aria-label="Labels">
            {detail.labels.map((label) => <span key={label}>{label}</span>)}
          </div>}
          <section className="dock-pr-section">
            <header>
              <MessageSquare size={14} aria-hidden="true" />
              <b>Conversation</b>
              <span>{detail.timeline.length}</span>
            </header>
            {detail.timeline.length > 0 ? <div className="dock-pr-timeline">
              {detail.timeline.map((item, index) => (
                <article className="dock-pr-comment" key={`${item.createdAt}:${index}`}>
                  <img src={`https://github.com/${encodeURIComponent(item.author)}.png?size=32`} alt="" />
                  <div>
                    <header>
                      <b>{item.author}</b>
                      {item.state === "APPROVED" && <em data-state="APPROVED">approved</em>}
                      {item.state === "CHANGES_REQUESTED" &&
                        <em data-state="CHANGES_REQUESTED">requested changes</em>}
                      {item.state === "COMMENTED" && <em>commented</em>}
                      <i>{relativeAge(item.createdAt)} ago</i>
                    </header>
                    {item.body && <p>{item.body}</p>}
                  </div>
                </article>
              ))}
            </div> : <div className="dock-pr-empty-row">No conversation yet.</div>}
          </section>
        </div>}
        {detailTab === "checks" && <div className="dock-pr-panel dock-pr-checks-panel"
          role="tabpanel" data-pr-detail-panel="checks">
          <section className="dock-pr-check-card">
            <header>
              <span className="dock-pr-check-state" data-checks={checksTone} aria-hidden="true" />
              <div>
                <b>{checksLabel}</b>
                <small>{detail.checks.total > 0
                  ? `${detail.checks.passing} of ${detail.checks.total} completed successfully`
                  : "This pull request has no reported checks yet."}</small>
              </div>
            </header>
            <div className="dock-pr-check-grid">
              <span><b>{detail.checks.total}</b><small>Total</small></span>
              <span><b>{detail.checks.passing}</b><small>Passing</small></span>
              <span><b>{detail.checks.pending}</b><small>Pending</small></span>
              <span><b>{detail.checks.failing}</b><small>Failing</small></span>
            </div>
          </section>
          <section className="dock-pr-section">
            <header>
              <b>Reviewers</b>
              <span>{detail.reviewers.length}</span>
            </header>
            {detail.reviewers.length > 0 ? <div className="dock-pr-reviewers">
              {detail.reviewers.map((reviewer) => (
                <span className="dock-pr-reviewer" data-state={reviewer.state} key={reviewer.login}
                  title={reviewer.state === "APPROVED" ? "Approved"
                    : reviewer.state === "CHANGES_REQUESTED" ? "Requested changes"
                      : reviewer.state === "COMMENTED" ? "Commented" : "Review pending"}>
                  <img src={`https://github.com/${encodeURIComponent(reviewer.login)}.png?size=32`} alt="" />
                  <span><b>{reviewer.login}</b><small>{reviewer.state.toLocaleLowerCase()
                    .replaceAll("_", " ")}</small></span>
                </span>
              ))}
            </div> : <div className="dock-pr-empty-row">No reviewers requested.</div>}
            {detail.reviewDecision && <p className="dock-pr-review-decision" data-checks={
              detail.reviewDecision === "APPROVED" ? "passing"
                : detail.reviewDecision === "CHANGES_REQUESTED" ? "failing" : "pending"
            }>{detail.reviewDecision === "APPROVED" ? "Approved"
              : detail.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested"
                : "Review required"}</p>}
          </section>
        </div>}
        {detailTab === "files" && <div className="dock-pr-files-panel"
          role="tabpanel" data-pr-detail-panel="files">
          <header className="dock-pr-files-summary">
            <div>
              <b>Files changed</b>
              <small>{detail.changedFiles} {detail.changedFiles === 1 ? "file" : "files"}</small>
            </div>
            <span>
              {detail.additions > 0 && <i>+{detail.additions}</i>}
              {detail.deletions > 0 && <em>-{detail.deletions}</em>}
            </span>
          </header>
          <section className="dock-pr-files" data-group="pr-files">
          {detail.files.map((file) => {
            const patch = diffs?.get(file.path);
            const open = openFile === file.path;
            return <section className="dock-scm-commit-file" data-open={open || undefined} key={file.path}>
              <button type="button" className="dock-scm-commit-file-row" aria-expanded={open}
                onClick={() => setOpenFile(open ? "" : file.path)}>
                {/* Same one-sentence path grammar as the dock's other two
                    file lists (path-text.tsx:318,345). */}
                <ScmPathText path={file.path} title={file.path} />
                {/* Fixed right-aligned count column, same as the dock's
                    commit-detail rows: the path keeps the rest of the width. */}
                <small className="dock-scm-commit-file-lines">
                  {file.additions > 0 && <i>+{file.additions}</i>}
                  {file.deletions > 0 && <em>-{file.deletions}</em>}
                </small>
                {/* ONE trailing control: the status icon, same grammar as the
                    dock's other two file lists. */}
                <ScmStatusIcon kind={prFileStatusKind(patch)} size={12} />
              </button>
              {open && <div className="dock-scm-commit-diff">
                {patch ? <GitFileDiff patch={patch} mode="unified" /> : <p>No textual diff.</p>}
              </div>}
            </section>;
          })}
          {detail.files.length === 0 &&
            <div className="dock-pr-empty-row">0 changed files</div>}
          </section>
        </div>}
      </>}
    </div>
  </div>;
}
