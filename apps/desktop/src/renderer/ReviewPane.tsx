import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Command, FileDiff, Folder, GitCompare, Layers3, LoaderCircle, Mic, PanelLeft, PanelRight, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { MxIcon } from "./MxIcon";
import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { approvalInstanceKey, draftAfterSubmission, followAfterScroll, isApprovalDismissKey, isScrollIntentKey, mergeTranscript, normalizeApplyPatch, parseUnifiedDiff, reconcileTurnFailures, shouldNavigatePromptHistory, toolInputRows, transcriptTurnKeys } from "./renderer-logic.mjs";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { DiffBoundary } from "./TranscriptView";
import { REVIEW_DIFF_STYLE_KEY } from "./desktop-types";

// ── Dock Git panel ───────────────────────
interface GitPanelStatus {
  repository: boolean;
  branch: string;
  ahead: number;
  behind: number;
  upstream: boolean;
  files: Array<{ path: string; index: string; worktree: string; untracked: boolean; additions: number; deletions: number }>;
}
// Review pane: cumulative diff of the working tree
// vs merge-base(origin default branch, HEAD) — committed + uncommitted +
// untracked read as ONE change set.
export interface GitReviewFile {
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
export function GitDiffBody({ file, mode }: { file: ReturnType<typeof parseUnifiedDiff>[number]; mode?: "unified" | "split" }) {
  const fallback = <pre className="diff-fallback">{file.patch}</pre>;
  if (!file.renderable) return fallback;
  return <DiffBoundary fallback={fallback}>
    <Suspense fallback={<div className="diff-loading" aria-hidden="true">Loading diff…</div>}>
      <DiffView data={{ oldFile: file.oldFile, newFile: file.newFile, hunks: [file.renderPatch || file.patch] }} mode={mode} />
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
export function ReviewPane({ cwd }: { cwd: string | null }) {
  const [status, setStatus] = useState<GitPanelStatus | null>(null);
  const [review, setReview] = useState<GitReviewInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Single-open accordion (user decision): opening a file closes the rest
  // and snaps the opened card flush under the sticky header.
  const [openFile, setOpenFile] = useState("");
  // Right-click context menu: open / reveal / copy
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
