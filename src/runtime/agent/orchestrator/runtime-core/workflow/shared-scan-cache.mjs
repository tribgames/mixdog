// Process-wide stale-while-revalidate cache for the small disk scans every
// session's 2 s status pulse needs (agent list, active WORKFLOW.md). A scan is
// written once as a generator that yields { op, path } fs requests, so the
// same logic runs synchronously (cold start, explicit fresh reads) or on
// libuv's pool (background revalidation) without blocking the event loop.
import { existsSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { readDirEntriesSafe, readTextSafe } from '../fs-utils.mjs';

// A change on disk that bypassed the app's writers reaches shared readers
// within this interval plus one background scan.
export const SHARED_SCAN_REVALIDATE_MS = 5_000;
const SHARED_SCAN_CACHE_LIMIT = 16;

const syncOps = { readdir: readDirEntriesSafe, exists: existsSync, readText: readTextSafe };
const asyncOps = {
  readdir: (path) => readdir(path, { withFileTypes: true }).catch(() => []),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false
    ),
  readText: (path) =>
    readFile(path, 'utf8').then(
      (text) => text.trim(),
      () => ''
    ),
};

function runScanSync(scan) {
  let step = scan.next();
  while (!step.done) step = scan.next(syncOps[step.value.op](step.value.path));
  return step.value;
}

async function runScanAsync(scan) {
  let step = scan.next();
  while (!step.done) step = scan.next(await asyncOps[step.value.op](step.value.path));
  return step.value;
}

export function createSharedScanCache() {
  const entries = new Map();

  function store(key, value) {
    entries.delete(key);
    if (entries.size >= SHARED_SCAN_CACHE_LIMIT) entries.delete(entries.keys().next().value);
    const entry = { value, checkedAt: Date.now(), refreshing: false };
    entries.set(key, entry);
    return entry;
  }

  return {
    // Synchronous scan for explicit callers (editors, session create). The
    // result is republished, so a write made through the app and then read
    // back here is what shared readers see next.
    fresh(key, makeScan) {
      return store(key, runScanSync(makeScan())).value;
    },
    // Cached value for per-tick readers. Only the first read of a key scans
    // synchronously; a stale entry is served as-is while one background scan
    // replaces it.
    shared(key, makeScan) {
      const entry = entries.get(key);
      if (!entry) return store(key, runScanSync(makeScan())).value;
      if (!entry.refreshing && Date.now() - entry.checkedAt >= SHARED_SCAN_REVALIDATE_MS) {
        entry.refreshing = true;
        runScanAsync(makeScan()).then(
          (value) => {
            // A fresh read may have replaced the entry meanwhile.
            if (entries.get(key) === entry) store(key, value);
          },
          () => {
            // Keep serving the last value; retry after another interval.
            entry.refreshing = false;
            entry.checkedAt = Date.now();
          }
        );
      }
      return entry.value;
    },
  };
}
