/**
 * read-tool/batch-dispatch.mjs — parallel dispatch of the individual reads of
 * a batch via the child `read` tool (same size cap and line-number
 * formatting), one shared byte ceiling split across distinct disk windows,
 * and the fan-out of a primary read's body to its duplicate slots.
 */
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { imageMimeForPath } from '../read-image.mjs';
import { readEntryCoalescedDiskWindow } from '../read-batch.mjs';

// A path[] Read shares one byte ceiling. Reserve room for headers; the
// remaining body budget is split across distinct disk windows by allocateBudgets.
function batchBodyBudget(entries, options, { normalizeOutputPath, READ_MAX_OUTPUT_BYTES }) {
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
  return Math.max(256, readCallBudget - headerReserve);
}

const AVG_LINE_BYTES = 40;
const MIN_LINE_BYTES = 20; // conservative: shorter lines mean more prefixes
const LINE_PREFIX_BYTES = 8;
const READ_RENDER_SLACK_BYTES = 1024; // trailer/marker reserve inside a child read

// Estimated rendered bytes of a task: file bytes plus line-number prefixes,
// scaled to the requested window when one is given. Unknown size → Infinity.
async function estimateTaskBytes(entry, workDir) {
  const st = await stat(resolvePath(workDir || '.', String(entry?.path || ''))).catch(() => null);
  if (!st?.isFile()) return Infinity;
  const lines = Math.max(1, st.size / AVG_LINE_BYTES);
  let need = st.size + (st.size / MIN_LINE_BYTES) * LINE_PREFIX_BYTES;
  // A coalesced entry reads its whole union window, not only its own slot.
  const limit = Number(readEntryCoalescedDiskWindow(entry)?.limit ?? entry?.limit);
  if (Number.isFinite(limit) && limit > 0) need *= Math.min(1, limit / lines);
  return Math.ceil(need) + READ_RENDER_SLACK_BYTES;
}

// Water-filling: tasks needing less than the equal share get what they need;
// the remainder is redistributed to the larger ones. Sum <= total.
function allocateBudgets(needs, total) {
  const budgets = new Array(needs.length).fill(0);
  let open = needs.map((_, i) => i);
  let remaining = total;
  while (open.length) {
    const share = Math.floor(remaining / open.length);
    const small = open.filter((i) => needs[i] <= share);
    if (small.length === 0) {
      for (const i of open) budgets[i] = share;
      break;
    }
    for (const i of small) {
      budgets[i] = needs[i];
      remaining -= needs[i];
    }
    open = open.filter((i) => needs[i] > share);
  }
  return budgets;
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
  const totalBudget = batchBodyBudget(entries, options, helpers);
  const needs = await Promise.all(tasks.map((t) => (t.entry?.path ? estimateTaskBytes(t.entry, workDir) : 0)));
  const allocated = allocateBudgets(needs, totalBudget);
  const budgetByIndex = new Map(tasks.map((t, i) => [t.index, Math.max(256, allocated[i])]));
  const results = new Array(entries.length);
  const readChains = new Map();
  await Promise.all(
    tasks.map(({ entry, index }) => {
      if (!entry?.path) {
        results[index] = { path: '(missing-path)', mode: 'full', body: 'Error: path is required.' };
        return Promise.resolve();
      }
      const run = async () => {
        const outputBudget = budgetByIndex.get(index);
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
        // Retain producer identity when caller slots are restored from a union.
        results[index] = { path: entry.path, mode: entry.mode || 'full', n: entry.n, body, readEntry };
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
