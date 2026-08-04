import { FileText, Minus, Plus, RefreshCw } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { splitGitPatchHunks, type GitPatchHunk } from "../shared/git-patch";
import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import type { WorkspaceSelection } from "./nav-types";
import { ProgressSpinner } from "./ProgressSpinner";
import { GitFileDiff } from "./ReviewPane";
import { prefetchDiffView } from "./lazy-widgets";
import { navigationKey } from "./text-format";

type GitDiffSelection = Extract<WorkspaceSelection, { kind: "diff" }>;

// Monaco DiffEditor renderer (VS Code diff parity) loads on first use only.
const MonacoGitDiff = lazy(() => import("./MonacoGitDiff.lazy"));

export function GitDiffPane({
  selection,
  active,
  onOpenFile,
  onReady,
}: {
  selection: GitDiffSelection;
  active: boolean;
  onOpenFile?(project: string, rel: string): void;
  onReady?(): void;
}) {
  const api = window.mixdogDesktop;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const metricKey = navigationKey(selection);
  beginBootSurface("diff", metricKey);
  reportBootSurfaceStage("diff", metricKey, "module");
  const epoch = useRef(0);
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"unified" | "split">("unified");
  // "text" = @git-diff-view rows with Stage/Unstage Hunk; "editor" = Monaco
  // DiffEditor (char-level highlights, revert arrows, editable worktree side).
  const [renderer, setRenderer] = useState<"text" | "editor">("text");
  const [busyHunk, setBusyHunk] = useState(-1);
  const load = useCallback(async () => {
    if (!active) return;
    const request = ++epoch.current;
    setError("");
    try {
      const next = selection.source === "commit"
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
        setPatch(nextPatch);
        if (nextPatch) await prefetchDiffView().catch(() => undefined);
        if (request !== epoch.current) return;
        reportBootSurfaceStage("diff", metricKey, "data");
        reportBootSurfaceReady("diff", metricKey);
        onReadyRef.current?.();
      }
    } catch (reason) {
      if (request === epoch.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPatch("");
        reportBootSurfaceStage("diff", metricKey, "data", "error");
        reportBootSurfaceReady("diff", metricKey, "error");
        onReadyRef.current?.();
      }
    }
  }, [active, api, metricKey, selection]);
  useEffect(() => {
    epoch.current += 1;
    setPatch(null);
    if (!active) return undefined;
    void load();
    if (selection.source === "commit") return undefined;
    const timer = window.setInterval(() => void load(), 3_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, load, selection.source]);
  const hunks = useMemo(
    () => patch && selection.source !== "commit" ? splitGitPatchHunks(patch) : [],
    [patch, selection.source],
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

  const sourceLabel = selection.source === "commit"
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
          onClick={() => setMode("unified")}>Unified</button>
        <button type="button" aria-pressed={mode === "split"}
          onClick={() => setMode("split")}>Split</button>
        <button type="button" aria-pressed={renderer === "editor"}
          onClick={() => setRenderer(renderer === "editor" ? "text" : "editor")}>
          Editor
        </button>
        <button type="button" aria-label={`Open file ${selection.rel}`}
          onClick={() => onOpenFile?.(selection.project, selection.rel)}>
          <FileText size={14} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Refresh diff" onClick={() => void load()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
    </header>
    <div className="workspace-git-diff-body">
      {renderer === "editor"
        ? <Suspense fallback={<p className="workspace-git-diff-state">
            <ProgressSpinner size={16} /> Loading editor…
          </p>}>
            <MonacoGitDiff project={selection.project} rel={selection.rel}
              source={selection.source} hash={selection.hash}
              sideBySide={mode === "split"} onSaved={() => void load()} />
          </Suspense>
        : patch === null
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
                          ? <ProgressSpinner size={13} aria-hidden="true" />
                          : staged
                            ? <Minus size={13} aria-hidden="true" />
                            : <Plus size={13} aria-hidden="true" />}
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
            : <p className="workspace-git-diff-state">No textual differences.</p>}
    </div>
  </div>;
}
