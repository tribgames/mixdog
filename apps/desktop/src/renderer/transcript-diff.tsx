import { FileDiff } from 'lucide-react';
import { Component, useMemo, type ReactNode } from 'react';
import type { TranscriptItem } from './desktop-types';
import { InlineDiff } from './inline-diff';
import { normalizeApplyPatch, parseUnifiedDiff } from './renderer-logic.mjs';
import { toolActivityCodeLanguage } from './transcript-tool-format';
import { asRecord } from './text-format';
import { CopyControl } from './transcript-primitives';
import { registerIdleReclaim } from './idle-reclaim';
import { RendererLruCache } from './renderer-lru-cache';

export const PATCH_CACHE_LIMIT = 24;
const PATCH_CACHE_ENTRY_MAX_CHARS = 1024 * 1024;
const normalizedPatchCache = new RendererLruCache<string, string>({
  name: 'normalized-patch',
  maxEntries: PATCH_CACHE_LIMIT,
  maxChars: 8 * 1024 * 1024,
  measure: (normalized, input) => input.length + normalized.length,
});

// Normalized patches rebuild from the transcript item on demand; an idle drop
// costs one re-normalize when that diff is next expanded.
registerIdleReclaim(() => {
  normalizedPatchCache.clear();
});

export function findPatch(item: TranscriptItem) {
  const args = asRecord(item.args);
  const result = asRecord(item.result);
  const candidates = [args?.patch, args?.diff, result?.patch, result?.diff, item.result, item.rawResult];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const cached = normalizedPatchCache.get(value);
    if (cached !== undefined) return cached;
    if (
      !(
        /^@@/m.test(value) ||
        /^diff --git/m.test(value) ||
        /^\*\*\* (?:Begin Patch|Add File:|Delete File:)/m.test(value)
      )
    )
      continue;
    const normalized = normalizeApplyPatch(value);
    if (value.length + normalized.length <= PATCH_CACHE_ENTRY_MAX_CHARS) normalizedPatchCache.set(value, normalized);
    return normalized;
  }
  return undefined;
}

export class DiffBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function baseName(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

/** Hunks with V4A-style rangeless `@@` headers rewritten to ranged ones, so
 *  InlineDiff never draws the header as a context row. */
function renderHunks(file: { hunks: string[]; renderPatch: string }): string[] {
  return parseUnifiedDiff(file.renderPatch)[0]?.hunks ?? file.hunks;
}

/** A call's diff inside the scrolling frame under the row's path line, drawn
 *  by the same renderer as the changes pane so both read identically.
 *  `target` is the file that line already names (with its copy): a diff of
 *  that one file draws no caption of its own. Other files of the same patch
 *  keep a caption with their own copy. */
export function CodeDiff({ patch, target = '' }: { patch: string; target?: string }) {
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const fallback = <pre className="diff-fallback">{patch}</pre>;
  return (
    <section className="code-diff">
      <div>
        <DiffBoundary key={patch} fallback={fallback}>
          {files.map((file, index) => {
            const additions = file.hunks
              .join('\n')
              .split('\n')
              .filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
            const deletions = file.hunks
              .join('\n')
              .split('\n')
              .filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
            // Workspace files are named relative; an absolute path (outside the
            // workspace) would otherwise stretch the caption — the call row above carries the full path.
            const displayName = /^(?:[A-Za-z]:)?\//.test(file.newFile.fileName)
              ? baseName(file.newFile.fileName)
              : file.newFile.fileName;
            const copy = (
              <CopyControl
                value={file.patch}
                label="Copy diff for {{value0}}"
                labelOptions={{ value0: displayName }}
                className="tool-detail-copy diff-copy"
              />
            );
            const captionless =
              files.length === 1 && Boolean(target) && baseName(target) === baseName(file.newFile.fileName);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: parsed files are positional and never reorder for a given patch
              <div className="diff-file" key={`${file.newFile.fileName}-${index}`}>
                {captionless ? null : (
                  <header>
                    <FileDiff size={16} />
                    <b>{displayName}</b>
                    {(additions > 0 || deletions > 0) && (
                      <span className="diff-stats">
                        <i>+{additions}</i>
                        <em>−{deletions}</em>
                      </span>
                    )}
                    {copy}
                  </header>
                )}
                {file.renderable && file.hunks.length > 0 ? (
                  <InlineDiff hunks={renderHunks(file)} language={toolActivityCodeLanguage(file.newFile.fileName)} />
                ) : (
                  <pre className="diff-fallback">{file.patch}</pre>
                )}
              </div>
            );
          })}
        </DiffBoundary>
      </div>
    </section>
  );
}
