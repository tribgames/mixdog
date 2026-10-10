import { FileDiff } from 'lucide-react';
import { Component, Suspense, useMemo, useState, type ReactNode } from 'react';
import type { TranscriptItem } from './desktop-types';
import { t } from './i18n';
import { DiffView } from './lazy-widgets';
import { ProgressSpinner } from './ProgressSpinner';
import { normalizeApplyPatch, parseUnifiedDiff } from './renderer-logic.mjs';
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

function fileOperationLabel(status: string): string {
  if (status === 'A') return t('Added');
  if (status === 'D') return t('Deleted');
  return status === 'M' ? t('Changed') : '';
}

export function CodeDiff({ patch }: { patch: string }) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = patch.split('\n').length;
  const files = useMemo(() => parseUnifiedDiff(patch), [patch]);
  // Collapsing changes only the clipping wrapper. Recreating `data` here
  // made the diff library discard and rebuild every parsed line on each
  // toggle, even though the patch (and its copy/selection contents) was unchanged.
  const diffViews = useMemo(
    () =>
      files.map((file, index) => (
        <DiffView
          // biome-ignore lint/suspicious/noArrayIndexKey: parsed files are positional and never reorder for a given patch
          key={index}
          data={{ oldFile: file.oldFile, newFile: file.newFile, hunks: [file.renderPatch || file.patch] }}
        />
      )),
    [files]
  );
  const fallback = <pre className="diff-fallback">{patch}</pre>;
  return (
    <section className="code-diff">
      <div className={expanded ? '' : 'diff-collapsed'}>
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
            const operation = fileOperationLabel(file.status);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: parsed files are positional and never reorder for a given patch
              <div className="diff-file" key={`${file.newFile.fileName}-${index}`}>
                <header>
                  <FileDiff size={16} />
                  <b>{file.newFile.fileName}</b>
                  {operation && (
                    <span className="diff-operation" data-status={file.status}>
                      {operation}
                    </span>
                  )}
                  {(additions > 0 || deletions > 0) && (
                    <span className="diff-stats">
                      {additions > 0 && <i>+{additions}</i>}
                      {deletions > 0 && <em>-{deletions}</em>}
                    </span>
                  )}
                  <CopyControl
                    value={file.patch}
                    label="Copy diff for {{value0}}"
                    labelOptions={{ value0: file.newFile.fileName }}
                    className="tool-detail-copy diff-copy"
                  />
                </header>
                {file.renderable ? (
                  <Suspense
                    fallback={
                      <div
                        className="diff-loading"
                        data-transcript-pending
                        role="status"
                        aria-label={t('Rendering diff…')}
                      >
                        <ProgressSpinner size={24} className="desktop-loading-spinner" aria-hidden="true" />
                      </div>
                    }
                  >
                    {diffViews[index]}
                  </Suspense>
                ) : (
                  <pre className="diff-fallback">{file.patch}</pre>
                )}
              </div>
            );
          })}
        </DiffBoundary>
      </div>
      {lineCount > 14 && (
        <button
          type="button"
          className="diff-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? t('Collapse diff') : t('Show full diff')}
        </button>
      )}
    </section>
  );
}
