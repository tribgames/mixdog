// manager/prefetch-bridge.mjs
// Explicit-prefetch bridge. Runs Lead-supplied files[]/callers[]/references[]
// prefetch outside the agent loop.
import { isAgentOwner } from '../../agent-owner.mjs';
import { throwIfAborted } from '../../../../shared/abort-race.mjs';
import { collectPrefetchFiles } from './prefetch-bridge/file-entries.mjs';
import { prefetchFiles } from './prefetch-bridge/file-prefetch.mjs';
import { prefetchSymbols, symbolEntries } from './prefetch-bridge/symbol-prefetch.mjs';

const prefetchWarn = (failed, total) =>
  `<prefetch-warn>${failed.length} of ${total} prefetch entries failed: ${[...new Set(failed)].join(', ')}</prefetch-warn>`;

export async function _tryBridgeExplicitPrefetch(session, explicitPrefetch, signal = null) {
  throwIfAborted(signal);
  if (!explicitPrefetch || typeof explicitPrefetch !== 'object') return null;
  if (!isAgentOwner(session)) return null;
  const parts = [];
  const failed = [];
  let totalEntries = 0;

  const fileEntries = collectPrefetchFiles(explicitPrefetch.files);
  if (fileEntries.files.length > 0) {
    totalEntries += fileEntries.files.length;
    const { readParts, failed: failedFiles, stats } = await prefetchFiles(session, fileEntries, signal);
    failed.push(...failedFiles);
    if (readParts.length > 0) parts.push(`### prefetch files\nread ${readParts.length}\n\n${readParts.join('\n\n')}`);
    // Hit/miss counters so dispatch telemetry shows prefetch effectiveness.
    if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
      process.stderr.write(
        `[prefetch] files=${stats.files} cached=${stats.cached} miss=${stats.miss} failed=${stats.failed}\n`
      );
    }
    // Session-attached stats let post-hoc analyzers (inspect-session.mjs) see
    // prefetch effectiveness without parsing stderr logs.
    if (session && typeof session === 'object') {
      if (!session.prefetchStats) session.prefetchStats = { files: 0, cached: 0, miss: 0, failed: 0 };
      session.prefetchStats.files += stats.files;
      session.prefetchStats.cached += stats.cached;
      session.prefetchStats.miss += stats.miss;
      session.prefetchStats.failed += stats.failed;
    }
  }

  const callers = symbolEntries(explicitPrefetch.callers);
  const references = symbolEntries(explicitPrefetch.references);
  for (const [mode, entries] of [
    ['callers', callers],
    ['references', references],
  ]) {
    totalEntries += entries.length;
    const found = await prefetchSymbols(session, mode, entries, signal);
    parts.push(...found.parts);
    failed.push(...found.failed);
  }
  throwIfAborted(signal);
  if (session && typeof session === 'object' && (callers.length > 0 || references.length > 0)) {
    if (!session.prefetchStats)
      session.prefetchStats = { files: 0, cached: 0, miss: 0, failed: 0, callers: 0, references: 0 };
    session.prefetchStats.callers = (session.prefetchStats.callers || 0) + callers.length;
    session.prefetchStats.references = (session.prefetchStats.references || 0) + references.length;
  }
  if (parts.length === 0) {
    // All entries failed but Lead presence must still be signalled — emit
    // warn-only so the gate logic can distinguish "prefetch was requested"
    // from "no prefetch at all".
    return totalEntries > 0 && failed.length > 0 ? prefetchWarn(failed, totalEntries) : null;
  }
  const warnLine = failed.length > 0 ? `${prefetchWarn(failed, totalEntries)}\n` : '';
  return `${warnLine}<prefetch>\n${parts.join('\n\n')}\n</prefetch>`;
}
