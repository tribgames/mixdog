import React, { Component, Suspense, lazy, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Code2, Command, FileDiff, Folder, GitCompare, Layers3, LoaderCircle, Mic, PanelLeft, PanelRight, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X } from "lucide-react";
import { MxIcon } from "./MxIcon";
import { type RecordValue, type Project, type TranscriptItem, type Approval, type Toast, type Snapshot, EMPTY_SNAPSHOT, EMPTY_TRANSCRIPT_ITEMS, hasActiveSnapshotWork, workingSessionIdsForSnapshot } from "./desktop-types";
import { asRecord, displayProject, navigationKey, newDraftSelection, textOf, publicThinkingSummary, oneLine, queueText, formatElapsed, formatIdleDuration, TURN_LOCKED_SLASH_COMMANDS, copyTextToClipboard } from "./text-format";
import { approvalInstanceKey, draftAfterSubmission, followAfterScroll, isApprovalDismissKey, isScrollIntentKey, mergeTranscript, normalizeApplyPatch, parseUnifiedDiff, reconcileTurnFailures, shouldNavigatePromptHistory, toolInputRows, transcriptTurnKeys } from "./renderer-logic.mjs";
import { DiffView, TerminalPane } from "./lazy-widgets";
import { findPatch, PATCH_CACHE_LIMIT } from "./TranscriptView";
import { GitDiffBody } from "./ReviewPane";
import { REVIEW_DIFF_STYLE_KEY } from "./desktop-types";


// "Review Changes": an accordion above the composer summarizing the
// files the current turn edited (count + line delta). Scope rule: every tool
// item AFTER the last user message whose args/result carry a unified diff
// (apply_patch/edit payloads) is parsed and aggregated per file. Rows expand
// to the actual diff and carry a guarded working-tree revert.
type TurnReviewPatchPart = ReturnType<typeof parseUnifiedDiff>[number];
const turnReviewPatchCache = new Map<string, Array<{
  name: string;
  additions: number;
  deletions: number;
  part: TurnReviewPatchPart;
}>>();

function analyzeTurnReviewPatch(patch: string) {
  const cached = turnReviewPatchCache.get(patch);
  if (cached) {
    turnReviewPatchCache.delete(patch);
    turnReviewPatchCache.set(patch, cached);
    return cached;
  }
  const analyzed = parseUnifiedDiff(patch).flatMap((part) => {
    const name = String(part.newFile?.fileName || "");
    if (!name) return [];
    let additions = 0;
    let deletions = 0;
    for (const line of part.hunks.join("\n").split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    return [{ name, additions, deletions, part }];
  });
  turnReviewPatchCache.set(patch, analyzed);
  if (turnReviewPatchCache.size > PATCH_CACHE_LIMIT) {
    turnReviewPatchCache.delete(turnReviewPatchCache.keys().next().value as string);
  }
  return analyzed;
}

// Single-quoted so the capability-inventory source scan counts this surface.
const TURN_REVIEW_CAPABILITY = 'getTurnReviewDiff';

export function TurnReviewBar({ items, cwd }: { items: TranscriptItem[]; cwd?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [openFile, setOpenFile] = useState("");
  const [confirmFile, setConfirmFile] = useState("");
  const [reverted, setReverted] = useState<string[]>([]);
  // Preferred source: the engine's shadow-snapshot diff (getTurnReviewDiff).
  // It covers EVERYTHING the turn changed on disk — subagent and background
  // job edits included — while the transcript parse below only sees patches
  // the Lead itself applied. The transcript summary stays as the fallback for
  // surfaces without the capability (remote/web shim) or when snapshots are
  // disabled/unsupported.
  const [snapshotReview, setSnapshotReview] = useState<{
    files: Array<{ name: string; additions: number; deletions: number }>;
    patch: string;
  } | null>(null);
  const snapshotFailures = useRef(0);
  const snapshotRequestInFlight = useRef(false);
  const lastSnapshotPatch = useRef<string | null>(null);
  // Only probe once the transcript shows turn activity: a fresh/empty session
  // has no base to diff, and passive mounts must not fire capability calls
  // (test call-order recordings and real engine leases both stay quiet).
  const hasTurnActivity = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "user") return false;
      if (items[index]) return true;
    }
    return false;
  }, [items]);
  const refreshSnapshotReview = useCallback(async () => {
    const api = window.mixdogDesktop as {
      invokeCapability?: (request: { capability: string; args: unknown[] }) => Promise<{ value?: unknown }>;
    } | undefined;
    if (!api?.invokeCapability || snapshotFailures.current >= 3) return;
    // Single-flight + visibility gate (measured: during a live attached
    // session the diff refresh fired every ~2s and each response re-parsed a
    // large patch — periodic scroll-time jank bursts).
    if (snapshotRequestInFlight.current || document.visibilityState === "hidden") return;
    snapshotRequestInFlight.current = true;
    try {
      const result = await api.invokeCapability({ capability: TURN_REVIEW_CAPABILITY, args: [] });
      const value = (result?.value ?? null) as {
        supported?: boolean;
        files?: Array<{ name?: unknown; additions?: unknown; deletions?: unknown }>;
        patch?: unknown;
      } | null;
      if (!value || value.supported === false) {
        snapshotFailures.current += 1;
        return;
      }
      snapshotFailures.current = 0;
      const nextPatch = typeof value.patch === "string" ? value.patch : "";
      // Unchanged diff → no state write: skips the re-render + downstream
      // patch re-analysis entirely (the common case for every poll tick).
      if (lastSnapshotPatch.current === nextPatch) return;
      lastSnapshotPatch.current = nextPatch;
      setSnapshotReview({
        files: (Array.isArray(value.files) ? value.files : []).flatMap((file) => {
          const name = String(file?.name || "");
          if (!name) return [];
          return [{
            name,
            additions: Math.max(0, Number(file?.additions) || 0),
            deletions: Math.max(0, Number(file?.deletions) || 0),
          }];
        }),
        patch: nextPatch,
      });
    } catch {
      snapshotFailures.current += 1;
    } finally {
      snapshotRequestInFlight.current = false;
    }
  }, []);
  // Refresh on TURN BOUNDARIES, not on every transcript publication: a live
  // streaming session republishes `items` every ~2s, and each refresh ran a
  // main-process worktree diff + shipped the full patch over IPC (measured:
  // ~34 calls during a 34s scroll window — the reported scroll stutter). The
  // diff only meaningfully changes when a tool settles or a turn completes;
  // the 6s idle poll below still catches background/subagent edits.
  const turnBoundaryKey = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!item) continue;
      if (item.kind === "turndone" || item.kind === "statusdone" || item.kind === "tool") {
        return `${String(item.id ?? index)}:${String(item.completedAt ?? item.completedCount ?? "")}`;
      }
    }
    return "";
  }, [items]);
  useEffect(() => {
    if (hasTurnActivity) void refreshSnapshotReview();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- turnBoundaryKey stands in for items
  }, [refreshSnapshotReview, hasTurnActivity, turnBoundaryKey]);
  useEffect(() => {
    if (!hasTurnActivity && !snapshotReview) return undefined;
    const timer = window.setInterval(() => { void refreshSnapshotReview(); }, 6_000);
    return () => window.clearInterval(timer);
  }, [refreshSnapshotReview, hasTurnActivity, snapshotReview]);
  // Shares the Review pane's persisted diff-style preference (user request:
  // the expanded bar renders real diffs, so it needs the same Unified/Split
  // control).
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">(() => {
    try { return window.localStorage.getItem(REVIEW_DIFF_STYLE_KEY) === "split" ? "split" : "unified"; }
    catch { return "unified"; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(REVIEW_DIFF_STYLE_KEY, diffStyle); } catch { /* persistence only */ }
  }, [diffStyle]);
  const transcriptSummary = useMemo(() => {
    let lastUser = -1;
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "user") { lastUser = index; break; }
    }
    const files = new Map<string, {
      additions: number;
      deletions: number;
      parts: ReturnType<typeof parseUnifiedDiff>;
    }>();
    for (let index = lastUser + 1; index < items.length; index++) {
      const item = items[index];
      if (!item || item.kind !== "tool") continue;
      const patch = findPatch(item);
      if (typeof patch !== "string" || !patch) continue;
      try {
        for (const analyzed of analyzeTurnReviewPatch(patch)) {
          const entry = files.get(analyzed.name) || { additions: 0, deletions: 0, parts: [] };
          entry.additions += analyzed.additions;
          entry.deletions += analyzed.deletions;
          entry.parts.push(analyzed.part);
          files.set(analyzed.name, entry);
        }
      } catch { /* non-diff payload — skip */ }
    }
    let additions = 0;
    let deletions = 0;
    for (const entry of files.values()) { additions += entry.additions; deletions += entry.deletions; }
    return { files, additions, deletions };
  }, [items]);
  const summary = useMemo(() => {
    if (!snapshotReview || snapshotReview.files.length === 0) return transcriptSummary;
    const partsByName = new Map<string, ReturnType<typeof parseUnifiedDiff>>();
    if (snapshotReview.patch) {
      try {
        for (const analyzed of analyzeTurnReviewPatch(snapshotReview.patch)) {
          const bucket = partsByName.get(analyzed.name) || [];
          bucket.push(analyzed.part);
          partsByName.set(analyzed.name, bucket);
        }
      } catch { /* counts still render without expandable hunks */ }
    }
    const files = new Map<string, {
      additions: number;
      deletions: number;
      parts: ReturnType<typeof parseUnifiedDiff>;
    }>();
    let additions = 0;
    let deletions = 0;
    for (const file of snapshotReview.files) {
      files.set(file.name, {
        additions: file.additions,
        deletions: file.deletions,
        parts: partsByName.get(file.name) || [],
      });
      additions += file.additions;
      deletions += file.deletions;
    }
    return { files, additions, deletions };
  }, [snapshotReview, transcriptSummary]);
  if (summary.files.size === 0) return null;
  return (
    <section className="turn-review-bar" aria-label="Files changed this turn"
      data-expanded={expanded ? "true" : "false"}>
      <div className="turn-review-head">
        <button type="button" className="turn-review-summary" aria-expanded={expanded}
          onClick={() => setExpanded((value) => {
            const next = !value;
            // Collapsing also closes any open inline diff/confirm so reopening
            // starts from the tidy list, not a tall stale diff.
            if (!next) { setOpenFile(""); setConfirmFile(""); }
            return next;
          })}>
          <FileDiff size={14} aria-hidden="true" />
          <strong>{summary.files.size} file{summary.files.size === 1 ? "" : "s"} changed</strong>
          <span className="diff-stats"><i>+{summary.additions}</i><em>-{summary.deletions}</em></span>
          <ChevronDown className="turn-review-chevron" size={14} aria-hidden="true" />
        </button>
        {expanded && <div className="review-style-toggle turn-review-style" role="radiogroup"
          aria-label="Diff style">
          <button type="button" aria-pressed={diffStyle === "unified"}
            onClick={() => setDiffStyle("unified")}>Unified</button>
          <button type="button" aria-pressed={diffStyle === "split"}
            onClick={() => setDiffStyle("split")}>Split</button>
        </div>}
      </div>
      <div className="turn-review-collapse" inert={!expanded} aria-hidden={!expanded}>
        <div className="turn-review-collapse-inner">
          <ul className="turn-review-files">
        {[...summary.files.entries()].map(([name, entry]) => {
          // Tool patches sometimes carry ABSOLUTE paths; display and revert
          // use the project-relative form (git confinement expects it).
          const normalizedCwd = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
          const normalizedName = name.replace(/\\/g, "/");
          const rel = normalizedCwd && normalizedName.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)
            ? normalizedName.slice(normalizedCwd.length + 1)
            : normalizedName;
          const isReverted = reverted.includes(name);
          const confirming = confirmFile === name;
          return (
          <li key={name} data-open={openFile === name ? "true" : "false"}
            data-reverted={isReverted ? "true" : "false"}>
            <button type="button" className="turn-review-file" aria-expanded={openFile === name}
              onClick={() => setOpenFile((current) => current === name ? "" : name)}>
              <code>{rel}</code>
              <span className="diff-stats"><i>+{entry.additions}</i><em>-{entry.deletions}</em></span>
            </button>
            {Boolean(cwd) && !isReverted && (confirming ? (
              <span className="turn-review-confirm" role="group"
                aria-label={`Confirm reverting ${rel} (discards ALL working-tree changes in the file)`}>
                <button type="button" className="turn-review-revert"
                  aria-label="Cancel revert" data-tooltip="Cancel"
                  onClick={() => setConfirmFile("")}>
                  <X size={12} />
                </button>
                <button type="button" className="turn-review-revert danger"
                  aria-label={`Confirm revert of ${rel}`} data-tooltip="Revert to HEAD"
                  onClick={() => {
                    setConfirmFile("");
                    void window.mixdogDesktop.gitRevert?.(cwd as string, rel, false)
                      .then(() => setReverted((current) => [...current, name]))
                      .catch(() => {});
                  }}>
                  <Check size={12} />
                </button>
              </span>
            ) : (
              <button type="button" className="turn-review-revert"
                aria-label={`Revert ${rel}`} data-tooltip="Revert file (working tree → HEAD)"
                onClick={() => setConfirmFile(name)}>
                <RotateCcw size={12} />
              </button>
            ))}
            {openFile === name && <div className="turn-review-diff">
              {entry.parts.map((file, index) => (
                <GitDiffBody key={`${name}:${index}`} file={file} mode={diffStyle} />
              ))}
            </div>}
          </li>
          );
        })}
          </ul>
        </div>
      </div>
    </section>
  );
}
