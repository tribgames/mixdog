import { FileText, Minus, Plus, X } from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { splitGitPatchHunks, type GitPatchHunk } from "../shared/git-patch";
import { t } from "./i18n";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import type { WorkspaceSelection } from "./nav-types";
import {
  type DiffStyle,
  readDiffStyle,
  SCM_DIFF_STYLE_KEY,
  SESSION_DIFF_STYLE_KEY,
  writeDiffStyle,
} from "./desktop-types";
import { ProgressSpinner } from "./ProgressSpinner";
import { GitFileDiff } from "./ReviewPane";
import { createSingleFlightRefresh } from "./git-diff-refresh";
import { createGitRefreshScheduler } from "./git-refresh-scheduler";
import { prefetchDiffView } from "./lazy-widgets";
import { subscribeProjectFileChanges } from "./project-file-changes";
import { navigationKey } from "./text-format";
import { fetchSessionDiffFilePatch } from "./session-diff-cache";

type GitDiffSelection = Extract<WorkspaceSelection, { kind: "diff" }>;

/** The session review diff is ONE patch for every file the session touched;
 *  the pane shows the slice for `rel` (the Session Diff rows open here),
 *  served from the shared session-diff cache so opening a file never
 *  recomputes the whole session diff. */
async function loadSessionFilePatch(sessionId: string, rel: string): Promise<string> {
  return fetchSessionDiffFilePatch(sessionId, rel);
}

export function GitDiffPane({
  selection,
  active,
  onOpenFile,
  onClose,
  onReady,
}: {
  selection: GitDiffSelection;
  active: boolean;
  onOpenFile?(project: string, rel: string): void;
  /** Pane-dock host: the diff owns its close affordance (user: DIFF 탭 없이
   *  창 자체에 X). */
  onClose?(): void;
  onReady?(): void;
}) {
  const api = window.mixdogDesktop;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const metricKey = navigationKey(selection);
  beginBootSurface("diff", metricKey);
  reportBootSurfaceStage("diff", metricKey, "module");
  const epoch = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mountedRef = useRef(false);
  const loadOnceRef = useRef<() => Promise<void>>(async () => undefined);
  const [refreshQueue] = useState(
    () => createSingleFlightRefresh(() => loadOnceRef.current()),
  );
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Unified/Split persists per surface: the session dock's diff tab and the
  // Source Control diff tab remember their own choice.
  const styleKey = selection.source === "session" ? SESSION_DIFF_STYLE_KEY : SCM_DIFF_STYLE_KEY;
  const [mode, setModeState] = useState<DiffStyle>(() => readDiffStyle(styleKey));
  useEffect(() => { setModeState(readDiffStyle(styleKey)); }, [styleKey]);
  const setMode = useCallback((next: DiffStyle) => {
    setModeState(next);
    writeDiffStyle(styleKey, next);
  }, [styleKey]);
  // One renderer only: @git-diff-view rows with Stage/Unstage Hunk (the
  // Monaco "Editor" mode was dropped — user: 에디터 빼주라).
  const [busyHunk, setBusyHunk] = useState(-1);
  // The shell owns its own visible Loading diff… / error states. Reveal it as
  // soon as it mounts instead of keeping those states hidden behind a
  // full-pane readiness cover until Git and the lazy renderer both finish.
  useLayoutEffect(() => {
    onReadyRef.current?.();
  }, [metricKey]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      epoch.current += 1;
    };
  }, []);
  const loadOnce = useCallback(async () => {
    if (!activeRef.current || !mountedRef.current) return;
    const request = epoch.current;
    setError("");
    try {
      const next = selection.source === "session"
        ? await loadSessionFilePatch(String(selection.hash || ""), selection.rel)
        : selection.source === "commit"
        ? await api?.gitShowDiff?.(
          selection.project,
          String(selection.hash || ""),
          selection.rel,
        )
        : await api?.gitDiff?.(
          selection.project,
          selection.rel,
          selection.source === "staged",
          selection.source === "unstaged",
          selection.untracked === true,
        );
      if (request === epoch.current) {
        const nextPatch = next ?? "";
        // The rows for a large patch render as a transition: React then
        // yields between them, so a composer keystroke arriving while the
        // diff opens or refreshes paints in its own frame instead of behind
        // the whole diff (user: 디프창이 생성될 때 덜컹).
        startTransition(() => setPatch(nextPatch));
        if (nextPatch) void prefetchDiffView().catch(() => undefined);
        reportBootSurfaceStage("diff", metricKey, "data");
        reportBootSurfaceReady("diff", metricKey);
      }
    } catch (reason) {
      if (request === epoch.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPatch("");
        reportBootSurfaceStage("diff", metricKey, "data", "error");
        reportBootSurfaceReady("diff", metricKey, "error");
      }
    }
  }, [api, metricKey, selection]);
  loadOnceRef.current = loadOnce;
  const load = useCallback(() => refreshQueue.request(), [refreshQueue]);
  useEffect(() => {
    epoch.current += 1;
    setPatch(null);
    setError("");
  }, [metricKey]);
  useEffect(() => {
    if (!active) return undefined;
    if (selection.source === "commit") {
      void load();
      return undefined;
    }
    const scheduler = createGitRefreshScheduler(() => load(), {
      safetyIntervalMs: 30_000,
      activityDebounceMs: 125,
      activityMinGapMs: 1_000,
    });
    const signal = () => scheduler.signal();
    const refreshNow = () => scheduler.refreshNow();
    const visibilityChanged = () => {
      if (document.visibilityState === "hidden") scheduler.pause();
      else scheduler.resume();
    };
    const unsubscribeProject = subscribeProjectFileChanges(selection.project, signal);
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
  }, [active, load, metricKey, selection.source]);
  // Hunk staging exists for the index/worktree sources only: a commit or a
  // session slice is read-only, so it renders as ONE continuous diff.
  const stageable = selection.source === "staged" || selection.source === "unstaged";
  const hunks = useMemo(
    () => patch && stageable ? splitGitPatchHunks(patch) : [],
    [patch, stageable],
  );
  const applyHunk = async (hunk: GitPatchHunk, index: number) => {
    if (!api?.gitApplyPatch || busyHunk >= 0) return;
    setBusyHunk(index);
    setError("");
    try {
      await api.gitApplyPatch(
        selection.project,
        selection.rel,
        hunk.patch,
        selection.source === "staged",
      );
      await load();
      window.dispatchEvent(new Event("mixdog:git-changed"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyHunk(-1);
    }
  };

  const sourceLabel = selection.source === "session"
    ? t("Session diff")
    : selection.source === "commit"
    ? `Commit ${String(selection.hash || "").slice(0, 8)}`
    : selection.source === "staged" ? "Staged Changes" : "Working Tree Changes";
  return <div className="workspace-git-diff">
    <header>
      <div>
        <b title={selection.rel}>{selection.rel}</b>
        <small>{sourceLabel}</small>
      </div>
      <div className="workspace-git-diff-actions">
        <button type="button" aria-pressed={mode === "unified"}
          onClick={() => setMode("unified")}>{t("Unified")}</button>
        <button type="button" aria-pressed={mode === "split"}
          onClick={() => setMode("split")}>{t("Split")}</button>
        <button type="button" aria-label={t("Open file {{file}}", { file: selection.rel })}
          onClick={() => onOpenFile?.(selection.project, selection.rel)}>
          <FileText size={14} aria-hidden="true" />
        </button>
        {onClose && <button type="button" aria-label={t("Close diff")}
          data-tooltip={t("Close diff")} onClick={onClose}>
          <X size={14} aria-hidden="true" />
        </button>}
      </div>
    </header>
    <div className="workspace-git-diff-body">
      {patch === null
        ? <p className="workspace-git-diff-state"><ProgressSpinner size={16} /> Loading diff…</p>
        : error
          ? <p className="workspace-git-diff-state" role="alert">{error}</p>
          : patch
            ? hunks.length > 0
              ? <div className="workspace-git-diff-hunks">
                {hunks.map((hunk, index) => {
                  const staged = selection.source === "staged";
                  const label = staged ? "Unstage" : "Stage";
                  return <section className="workspace-git-diff-hunk"
                    key={`${hunk.header}:${index}`}>
                    <header>
                      <code>{hunk.header}</code>
                      <button type="button" disabled={busyHunk >= 0}
                        aria-label={`${label} hunk ${index + 1}`}
                        onClick={() => void applyHunk(hunk, index)}>
                        {busyHunk === index
                          ? <ProgressSpinner size={14} aria-hidden="true" />
                          : staged
                            ? <Minus size={14} aria-hidden="true" />
                            : <Plus size={14} aria-hidden="true" />}
                        {label} Hunk
                      </button>
                    </header>
                    {/* The section header above is the ONE place this hunk's
                        `@@ … @@` line is printed; the body renders rows only. */}
                    <GitFileDiff patch={hunk.patch} mode={mode} hideHunkHeader />
                  </section>;
                })}
              </div>
              : <GitFileDiff patch={patch} mode={mode} />
            : <p className="workspace-git-diff-state">{t("No textual differences.")}</p>}
    </div>
  </div>;
}
