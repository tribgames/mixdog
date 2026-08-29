import { FileDiff } from "lucide-react";
import { Component, Suspense, useMemo, useState, type ReactNode } from "react";
import { type TranscriptItem } from "./desktop-types";
import { t } from "./i18n";
import { DiffView } from "./lazy-widgets";
import { ProgressSpinner } from "./ProgressSpinner";
import { normalizeApplyPatch, parseUnifiedDiff } from "./renderer-logic.mjs";
import { asRecord } from "./text-format";
import { CopyControl } from "./transcript-primitives";
import { registerIdleReclaim } from "./idle-reclaim";
import { enforceRendererCacheBudget, registerBudgetedCache } from "./renderer-cache-budget";

const normalizedPatchCache = new Map<string, string>();
export const PATCH_CACHE_LIMIT = 24;
const PATCH_CACHE_MAX_CHARS = 8 * 1024 * 1024;
const PATCH_CACHE_ENTRY_MAX_CHARS = 1024 * 1024;

function retainedPatchChars(): number {
  let total = 0;
  for (const [input, normalized] of normalizedPatchCache) {
    total += input.length + normalized.length;
  }
  return total;
}

function trimPatchCacheTo(targetChars: number): void {
  while (retainedPatchChars() > targetChars) {
    const oldest = normalizedPatchCache.keys().next().value;
    if (oldest === undefined) break;
    normalizedPatchCache.delete(oldest);
  }
}

registerBudgetedCache({
  name: "normalized-patch",
  chars: retainedPatchChars,
  trim: trimPatchCacheTo,
});

function pruneNormalizedPatchCache(): void {
  while (
    normalizedPatchCache.size > PATCH_CACHE_LIMIT
    || retainedPatchChars() > PATCH_CACHE_MAX_CHARS
  ) {
    const oldest = normalizedPatchCache.keys().next().value;
    if (oldest === undefined) break;
    normalizedPatchCache.delete(oldest);
  }
  enforceRendererCacheBudget();
}

// Normalized patches rebuild from the transcript item on demand; an idle drop
// costs one re-normalize when that diff is next expanded.
registerIdleReclaim(() => { normalizedPatchCache.clear(); });

export function findPatch(item: TranscriptItem) {
  const args = asRecord(item.args);
  const result = asRecord(item.result);
  const candidates = [args?.patch, args?.diff, result?.patch, result?.diff, item.result, item.rawResult];
  for (const value of candidates) {
    if (typeof value !== "string") continue;
    const cached = normalizedPatchCache.get(value);
    if (cached !== undefined) {
      normalizedPatchCache.delete(value);
      normalizedPatchCache.set(value, cached);
      return cached;
    }
    if (!(/^@@/m.test(value) || /^diff --git/m.test(value)
      || /^\*\*\* (?:Begin Patch|Add File:|Delete File:)/m.test(value))) continue;
    const normalized = normalizeApplyPatch(value);
    if (value.length + normalized.length <= PATCH_CACHE_ENTRY_MAX_CHARS) {
      normalizedPatchCache.set(value, normalized);
      pruneNormalizedPatchCache();
    }
    return normalized;
  }
  return undefined;
}

export class DiffBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export function CodeDiff({ patch }: { patch: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = patch.split("\n").length;
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const fallback = <pre className="diff-fallback">{patch}</pre>;
  return (
    <section className="code-diff">
      <div className={expanded ? "" : "diff-collapsed"}>
        <DiffBoundary key={patch} fallback={fallback}>
          {files.map((file, index) => {
            const additions = file.hunks.join("\n").split("\n")
              .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
            const deletions = file.hunks.join("\n").split("\n")
              .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
            const operation = file.status === "A" ? t("Added")
              : file.status === "D" ? t("Deleted")
                : file.status === "M" ? t("Changed") : "";
            return <div className="diff-file" key={`${file.newFile.fileName}-${index}`}>
              <header><FileDiff size={16} /><b>{file.newFile.fileName}</b>
                {operation && <span className="diff-operation" data-status={file.status}>{operation}</span>}
                {(additions > 0 || deletions > 0) && <span className="diff-stats">
                  {additions > 0 && <i>+{additions}</i>}
                  {deletions > 0 && <em>-{deletions}</em>}
                </span>}
                <CopyControl value={file.patch} label={`Copy diff for ${file.newFile.fileName}`}
                  className="tool-detail-copy diff-copy" />
              </header>
              {file.renderable ? (
                <Suspense fallback={<div className="diff-loading" role="status" aria-label={t("Rendering diff…")}>
                  <ProgressSpinner size={24} className="desktop-loading-spinner" aria-hidden="true" />
                </div>}>
                  <DiffView data={{ oldFile: file.oldFile, newFile: file.newFile, hunks: [file.renderPatch || file.patch] }} />
                </Suspense>
              ) : <pre className="diff-fallback">{file.patch}</pre>}
            </div>;
          })}
        </DiffBoundary>
      </div>
      {lineCount > 14 && (
        <button type="button" className="diff-toggle" onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}>
          {expanded ? t("Collapse diff") : t("Show full diff")}
        </button>
      )}
    </section>
  );
}
