// What a native apply reports: the io/patch trace lines and the human-readable
// summary the model receives.
import { ioTrace, nativePatchTraceEnabled, patchTraceEnabled } from '../native-server.mjs';

const ms = (value) => Number(value.toFixed(3));

export function traceNativeApply({ writtenEntries, stats, dryRun, timings }) {
  const contentHashes = (stats.contentHashes || []).filter(Boolean).length;
  ioTrace('apply_patch_native', {
    files: writtenEntries.length,
    dryRun,
    partial: stats.partial,
    failed: stats.failures.length,
    roundtripMs: ms(stats.roundtripMs),
    rustTotalMs: ms(stats.totalMs),
    invalidateMs: ms(timings.invalidateMs),
    dirtyMs: ms(timings.dirtyMs),
    snapshotMs: ms(timings.snapshotMs),
    contentHashes,
  });
  if (nativePatchTraceEnabled()) {
    process.stderr.write(
      `[patch-native-trace] files=${writtenEntries.length} partial=${stats.partial ? 1 : 0} failed=${stats.failures.length} roundtrip_ms=${stats.roundtripMs.toFixed(3)} rust_total_ms=${stats.totalMs.toFixed(3)} rust_hash_ms=${stats.hashMs.toFixed(3)} invalidate_ms=${timings.invalidateMs.toFixed(3)} dirty_ms=${timings.dirtyMs.toFixed(3)} snapshot_ms=${timings.snapshotMs.toFixed(3)} total_js_ms=${timings.totalJsMs.toFixed(3)} content_hashes=${contentHashes}\n`
    );
  }
  if (patchTraceEnabled()) {
    process.stderr.write(
      `[patch-native] applied files=${writtenEntries.length} partial=${stats.partial ? 1 : 0} ms=${stats.totalMs.toFixed(3)}\n`
    );
  }
}

export const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
export const kindLabel = (kind) => {
  const text = String(kind || '').trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1).toLowerCase()}` : 'Update';
};

// `failureContext(path)` renders the JS-side excerpt for a failed hunk.
export function formatNativeSummary({ writtenEntries, stats, dryRun, failureContext }) {
  const verb = dryRun ? 'checked' : 'applied';
  const verbLabel = dryRun ? 'Checked' : 'Applied';
  const dryRunLabel = dryRun ? ' Dry Run' : '';
  const summary = stats.partial
    ? `Error: Patch Partially ${verbLabel} (${countLabel(writtenEntries.length, 'File')} ${verb} · ${countLabel(stats.failures.length, 'File')} Skipped) (Native)`
    : `${verbLabel} ${countLabel(writtenEntries.length, 'File')} (Native)${dryRunLabel}`;
  const lines = [summary];
  for (const entry of writtenEntries) {
    const added = entry.added || 0;
    const removed = entry.removed || 0;
    const parts = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`-${removed}`);
    const detail = parts.join('/');
    lines.push(
      detail
        ? `  OK ${kindLabel(entry.kind)} ${entry.displayPath} — ${detail}`
        : `  OK ${kindLabel(entry.kind)} ${entry.displayPath}`
    );
  }
  for (const f of stats.failures || []) {
    lines.push(`  SKIP ${f.path || '(unknown)'} — ${f.reason}${failureContext(f.path)}`);
  }
  return lines.join('\n');
}
