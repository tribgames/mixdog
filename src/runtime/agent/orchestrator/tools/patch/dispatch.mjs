// Native-engine dispatch + failure-context formatting for apply_patch. Moved
// verbatim from patch.mjs; native protocol, cache/snapshot side effects, and
// output formatting are unchanged.

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  normalizeOutputPath,
  invalidateBuiltinResultCache,
  recordReadSnapshotForPath,
  clearReadSnapshotForPath,
} from '../builtin.mjs';
import { markCodeGraphDirtyPaths } from '../code-graph-state.mjs';
import { classifyEntry, stripDiffPrefix, resolveEntryPath } from './paths.mjs';
import {
  getNativePatchServer,
  scheduleNativePatchIdleClose,
  nativePatchTraceEnabled,
  patchTraceEnabled,
  ioTrace,
} from './native-server.mjs';
import {
  extractNativeFailurePath,
  nativeFailureMatchesEntry,
  findFirstFailingUnifiedHunk,
  firstFailingUnifiedHunkLineDetail,
  firstMeaningfulUnifiedHunkLine,
  firstMeaningfulUnifiedEntryLine,
  compactPatchPreviewLine,
  nearestPatchLineHint,
  normalizeTypographic,
  splitBufferLinesForPatch,
  splitTextLinesForPatch,
} from './matcher.mjs';

export function formatNativeFailureContext(parsed, basePath, failedPath = '', options = {}) {
  const entries = Array.isArray(parsed) ? parsed : [];
  const entry = entries.find((candidate) => classifyEntry(candidate) !== 'create' && nativeFailureMatchesEntry(candidate, failedPath))
    || entries.find((candidate) => classifyEntry(candidate) !== 'create');
  const headerName = entry?.oldFileName;
  const displayPath = headerName ? normalizeOutputPath(stripDiffPrefix(headerName)) : '';
  const fuzz = Number.isFinite(options?.fuzz) && options.fuzz > 0 ? Math.floor(options.fuzz) : 0;
  let sourceLines = null;
  let sourceByteLines = null;
  try {
    const fullPath = resolveEntryPath(basePath, entry.oldFileName);
    const raw = readFileSync(fullPath); // Buffer — no 'utf8' decode
    sourceByteLines = splitBufferLinesForPatch(raw);
    sourceLines = splitTextLinesForPatch(raw.toString('utf8'));
  } catch {}
  const failingHunk = sourceByteLines ? findFirstFailingUnifiedHunk(entry, sourceByteLines, fuzz) : null;
  const failingDetail = (failingHunk && sourceByteLines)
    ? firstFailingUnifiedHunkLineDetail(sourceByteLines, failingHunk)
    : null;
  const expected = failingDetail || firstMeaningfulUnifiedHunkLine(failingHunk) || firstMeaningfulUnifiedEntryLine(entry);
  if (!entry || !expected?.line) return '';
  const expectedText = JSON.stringify(compactPatchPreviewLine(expected.line));
  let nearest = '';
  let normalizeHint = '';
  if (sourceLines) {
    nearest = nearestPatchLineHint(sourceLines, expected.line, expected.preferredLine);
    const wantNorm = normalizeTypographic(expected.line);
    if (wantNorm) {
      for (let i = 0; i < sourceLines.length; i++) {
        if (sourceLines[i] === expected.line) break; // exact match exists; not a normalization issue
        if (
          sourceLines[i].trim() !== expected.line.trim()
          && normalizeTypographic(sourceLines[i]) === wantNorm
        ) {
          normalizeHint = `context matches after Unicode normalization at line ${i + 1} — source may contain typographic dashes/quotes/NBSP`;
          break;
        }
      }
    }
  }
  return ` expected first old/context line${displayPath ? ` in ${displayPath}` : ''}: ${expectedText}${nearest ? `; ${nearest}` : ''}${normalizeHint ? `; ${normalizeHint}` : ''}; use exact current lines, no stubs.`;
}

// Dispatch the (already validated, header-rewritten) patch to the native
// engine. Throws on any native error; on success returns the formatted
// human-readable response string. Never silently falls back to JS — the
// caller MUST surface throws as `Error: ...` strings.
export async function dispatchNativePatch({ entries, basePath, nativePatchStr, fuzz, rejectPartial, dryRun, readStateScope, signal, parsed }) {
  const nativeStart = performance.now();
  let stats;
  try {
    stats = await getNativePatchServer().apply(basePath, nativePatchStr, { fuzz, rejectPartial, dryRun, signal });
  } catch (err) {
    scheduleNativePatchIdleClose();
    const msg = err?.message || String(err);
    const failedPath = extractNativeFailurePath(msg, parsed);
    return `Error: native patch failed — ${msg}${formatNativeFailureContext(parsed, basePath, failedPath, { fuzz })}`;
  }
  const afterInvalidateStart = performance.now();
  const failedDisplaySet = new Set();
  for (const f of stats.failures || []) {
    if (!f?.path) continue;
    failedDisplaySet.add(normalizeOutputPath(f.path));
    failedDisplaySet.add(normalizeOutputPath(stripDiffPrefix(f.path)));
  }
  const writtenEntries = entries.filter((entry) => !failedDisplaySet.has(entry.displayPath));
  const fullPaths = writtenEntries.map((entry) => entry.fullPath);
  if (!dryRun) invalidateBuiltinResultCache(fullPaths);
  const afterInvalidate = performance.now();
  if (!dryRun) markCodeGraphDirtyPaths(fullPaths);
  const afterDirty = performance.now();
  if (!dryRun) {
    for (let i = 0; i < writtenEntries.length; i++) {
      const entry = writtenEntries[i];
      if (entry.kind === 'delete') {
        clearReadSnapshotForPath(entry.fullPath, readStateScope);
      } else {
        const snapshotMeta = {
          source: 'apply_patch_native',
          isPartialView: false,
        };
        const contentHash = stats.contentHashes?.[i] || null;
        if (contentHash) snapshotMeta.contentHash = contentHash;
        recordReadSnapshotForPath(entry.fullPath, readStateScope, snapshotMeta);
      }
    }
  }
  const afterSnapshot = performance.now();
  ioTrace('apply_patch_native', {
    files: writtenEntries.length,
    dryRun,
    partial: stats.partial,
    failed: stats.failures.length,
    roundtripMs: Number(stats.roundtripMs.toFixed(3)),
    rustTotalMs: Number(stats.totalMs.toFixed(3)),
    invalidateMs: Number((afterInvalidate - afterInvalidateStart).toFixed(3)),
    dirtyMs: Number((afterDirty - afterInvalidate).toFixed(3)),
    snapshotMs: Number((afterSnapshot - afterDirty).toFixed(3)),
    contentHashes: (stats.contentHashes || []).filter(Boolean).length,
  });
  if (nativePatchTraceEnabled()) {
    process.stderr.write(
      `[patch-native-trace] files=${writtenEntries.length} partial=${stats.partial ? 1 : 0} failed=${stats.failures.length} roundtrip_ms=${stats.roundtripMs.toFixed(3)} rust_total_ms=${stats.totalMs.toFixed(3)} rust_hash_ms=${stats.hashMs.toFixed(3)} invalidate_ms=${(afterInvalidate - afterInvalidateStart).toFixed(3)} dirty_ms=${(afterDirty - afterInvalidate).toFixed(3)} snapshot_ms=${(afterSnapshot - afterDirty).toFixed(3)} total_js_ms=${(afterSnapshot - nativeStart).toFixed(3)} content_hashes=${(stats.contentHashes || []).filter(Boolean).length}\n`
    );
  }
  if (patchTraceEnabled()) {
    process.stderr.write(`[patch-native] applied files=${writtenEntries.length} partial=${stats.partial ? 1 : 0} ms=${stats.totalMs.toFixed(3)}\n`);
  }
  scheduleNativePatchIdleClose();
  const verb = dryRun ? 'checked' : 'applied';
  const verbLabel = dryRun ? 'Checked' : 'Applied';
  const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
  const kindLabel = (kind) => {
    const text = String(kind || '').trim();
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}` : 'Update';
  };
  const summary = stats.partial
    ? `Error: Patch Partially ${verbLabel} (${countLabel(writtenEntries.length, 'File')} ${verb} · ${countLabel(stats.failures.length, 'File')} Skipped) (Native)`
    : `${verbLabel} ${countLabel(writtenEntries.length, 'File')} (Native)${dryRun ? ' Dry Run' : ''}`;
  const lines = [summary];
  for (const entry of writtenEntries) {
    const added = entry.added || 0;
    const removed = entry.removed || 0;
    const parts = [];
    if (added > 0) parts.push(`+${countLabel(added, 'Line')}`);
    if (removed > 0) parts.push(`-${countLabel(removed, 'Line')}`);
    const detail = parts.join(' · ');
    lines.push(detail
      ? `  OK ${kindLabel(entry.kind)} ${entry.displayPath} — ${detail}`
      : `  OK ${kindLabel(entry.kind)} ${entry.displayPath}`);
  }
  for (const f of stats.failures || []) {
    lines.push(`  SKIP ${f.path || '(unknown)'} — ${f.reason}${formatNativeFailureContext(parsed, basePath, f.path, { fuzz })}`);
  }
  return lines.join('\n');
}
