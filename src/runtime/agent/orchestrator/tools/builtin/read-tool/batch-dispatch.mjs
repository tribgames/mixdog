/**
 * read-tool/batch-dispatch.mjs — parallel dispatch of the individual reads of
 * a batch via the child `read` tool (same size cap and line-number
 * formatting), one shared byte ceiling split across distinct disk windows,
 * and the fan-out of a primary read's body to its duplicate slots.
 */
import { imageMimeForPath } from '../read-image.mjs';
import { readEntryCoalescedDiskWindow } from '../read-batch.mjs';

// A path[] Read shares one byte ceiling. Reserve room for headers and split
// the remaining body budget across distinct disk windows.
function perTaskOutputBudget(entries, taskCount, options, { normalizeOutputPath, READ_MAX_OUTPUT_BYTES }) {
  const readCallBudget =
    Number(options?.readOutputBudgetBytes) > 0
      ? Math.min(READ_MAX_OUTPUT_BYTES, Math.trunc(Number(options.readOutputBudgetBytes)))
      : READ_MAX_OUTPUT_BYTES;
  const headerReserve = Math.min(
    Math.max(
      2_048,
      entries.reduce(
        (sum, entry) =>
          sum + Buffer.byteLength(String(normalizeOutputPath(entry?.path || '(missing-path)')), 'utf8') + 128,
        0
      )
    ),
    Math.floor(readCallBudget / 2)
  );
  return Math.max(256, Math.floor((readCallBudget - headerReserve) / Math.max(1, taskCount)));
}

// Primary reads only, ordered by path then window so same-file reads chain
// in ascending order.
function primaryTasks(entries, readIndexFor, { _isFullModeReadEntry, _readEntryLineWindow }) {
  return entries
    .map((entry, index) => ({
      entry,
      index,
      offset: _isFullModeReadEntry(entry) ? _readEntryLineWindow(entry).offset : 0,
    }))
    .filter((t) => readIndexFor[t.index] === t.index)
    .sort((a, b) => {
      const ap = a.entry?.path || '';
      const bp = b.entry?.path || '';
      if (ap !== bp) return ap < bp ? -1 : 1;
      if (a.offset !== b.offset) return a.offset - b.offset;
      return a.index - b.index;
    });
}

function childReadEntry(entry) {
  const diskWin = readEntryCoalescedDiskWindow(entry);
  const readEntry = diskWin ? { ...entry, offset: diskWin.offset, limit: diskWin.limit } : entry;
  if (
    (!readEntry.mode || readEntry.mode === 'full') &&
    readEntry.offset == null &&
    readEntry.limit == null &&
    readEntry.full !== true
  ) {
    return { ...readEntry, offset: 0, limit: 2000 };
  }
  return readEntry;
}

// Per-file errors come back as their own string and are pasted into the
// aggregate rather than aborting the whole batch.
export async function dispatchBatchReads({
  entries,
  readIndexFor,
  workDir,
  options,
  helpers,
  executeChildBuiltinTool,
}) {
  const tasks = primaryTasks(entries, readIndexFor, helpers);
  const outputBudget = perTaskOutputBudget(entries, tasks.length, options, helpers);
  const results = new Array(entries.length);
  const readChains = new Map();
  await Promise.all(
    tasks.map(({ entry, index }) => {
      if (!entry?.path) {
        results[index] = { path: '(missing-path)', mode: 'full', body: 'Error: path is required.' };
        return Promise.resolve();
      }
      const run = async () => {
        const readEntry = childReadEntry(entry);
        // Full image children retain their rich blocks; the aggregate
        // assembler flattens them without stringification. Other media
        // (PDF/notebook) remains text-only in a batch so its existing
        // per-entry rendering contract is unchanged.
        const richImage = (!readEntry.mode || readEntry.mode === 'full') && !!imageMimeForPath(readEntry.path);
        const body = await executeChildBuiltinTool('read', readEntry, workDir, {
          suppressReadUnchangedStub: true,
          mediaTextOnly: !richImage,
          _skipReachPreflight: true,
          forceReadRangeStream: true,
          readOutputBudgetBytes: outputBudget,
          toolOutputMaxBytes: outputBudget,
        });
        results[index] = { path: entry.path, mode: entry.mode || 'full', n: entry.n, body };
      };
      const key = entry.path || `#missing-${index}`;
      const prev = readChains.get(key) ?? Promise.resolve();
      const next = prev.then(run);
      readChains.set(
        key,
        next.catch(() => {})
      );
      return next;
    })
  );
  // Fan the primary read's result out to its duplicate indices so every
  // caller slot is populated without a second disk window.
  for (let i = 0; i < entries.length; i++) {
    const src = readIndexFor[i];
    if (src === i) continue;
    const e = entries[i];
    const s = results[src];
    results[i] = {
      path: e.path,
      mode: e.mode || 'full',
      n: e.n,
      body: s ? s.body : 'Error: dedup mapping failed',
    };
  }
  return results;
}
