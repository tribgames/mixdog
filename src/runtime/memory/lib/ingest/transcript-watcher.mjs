// ingest/transcript-watcher.mjs
// Keeps transcripts flowing into the store while the runtime is up: debounced
// per-file ingest on change events, a periodic safety sweep over recently
// active transcripts, and the change source each platform can rely on.
//   win32     — fs.watch({recursive}) is reliable; one watcher on the root.
//   darwin    — recursive watch is unreliable; a flat watcher per immediate
//               subdirectory (new subdirs are picked up by the next sweep).
//   linux/WSL — recursive watch unsupported; fs.watchFile polling per file
//               surfaced by the sweep, in addition to the sweep itself.
import fs from 'node:fs';
import path from 'node:path';
import { discoverActiveTranscripts, isWatchable } from './transcript-discovery.mjs';
import { cwdFromTranscriptPath } from './transcript-rows.mjs';

const SAFETY_POLL_MS = 5 * 60_000;
const DEBOUNCE_MS = 500;
const WATCH_FILE_INTERVAL_MS = 2000;

/** Ingest one file unless its mtime was already fully consumed. */
function createFileIngest({ ingestTranscriptFile, getOffset, log }) {
  const consumedMtime = new Map();
  const ingestOne = async function ingestOne(fp) {
    try {
      if (!fs.existsSync(fp)) return;
      const stat = fs.statSync(fp);
      const mtime = stat.mtimeMs;
      const prev = consumedMtime.get(fp);
      if (prev && prev >= mtime) return;
      const n = await ingestTranscriptFile(fp, { cwd: cwdFromTranscriptPath(fp) });
      // Only mark this mtime as 'consumed' once the persisted offset has fully
      // advanced past the observed file size. On a transient insert error (or a
      // malformed trailing line) the ingest leaves the persisted offset before
      // the failed line for retry; caching the new mtime unconditionally would
      // suppress the next sweep until the file mutated again, losing the retry.
      const off = getOffset(fp);
      if (off && off.bytes >= stat.size) consumedMtime.set(fp, mtime);
      if (n > 0) log(`[transcript-watch] ingested ${n} entries from ${path.basename(fp)}\n`);
    } catch (e) {
      log(`[transcript-watch] ingest error: ${e.message}\n`);
    }
  };
  return {
    ingestOne,
    prune(activePaths) {
      const active = new Set(activePaths);
      for (const fp of consumedMtime.keys()) {
        if (!active.has(fp)) consumedMtime.delete(fp);
      }
    },
    clear() {
      consumedMtime.clear();
    },
  };
}

function createDebouncedIngest(ingestOne, pendingByFile) {
  return function scheduleIngest(fp) {
    const existing = pendingByFile.get(fp);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      pendingByFile.delete(fp);
      ingestOne(fp);
    }, DEBOUNCE_MS);
    pendingByFile.set(fp, timer);
  };
}

function attachRecursiveWatch({ root, scheduleIngest, watchers, log }) {
  try {
    const watcher = fs.watch(root, { recursive: true, persistent: true }, (_event, filename) => {
      if (!filename) return;
      if (!isWatchable(filename)) return;
      scheduleIngest(path.join(root, filename));
    });
    watcher.on('error', (err) => {
      log(`[transcript-watch] fs.watch error: ${err.message}\n`);
    });
    watchers.push(watcher);
    log(`[transcript-watch] fs.watch(recursive) active on ${root}\n`);
  } catch (e) {
    log(`[transcript-watch] fs.watch setup failed: ${e.message} — relying on safety sweep only\n`);
  }
}

function listSubdirectories(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return []; // best effort
  }
}

function attachFlatWatch({ root, scheduleIngest, watchers, log }) {
  const registerFlat = (dir) => {
    try {
      const w = fs.watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return;
        const fp = path.join(dir, filename);
        if (!isWatchable(fp)) return;
        scheduleIngest(fp);
      });
      w.on('error', () => {
        /* ignore individual dir errors */
      });
      watchers.push(w);
    } catch {
      /* dir may not exist yet */
    }
  };
  try {
    registerFlat(root);
    for (const dir of listSubdirectories(root)) registerFlat(dir);
    log(`[transcript-watch] flat fs.watch active on ${root} (darwin)\n`);
  } catch (e) {
    log(`[transcript-watch] flat watch setup failed: ${e.message} — relying on safety sweep only\n`);
  }
}

/** The sweep variant for platforms without a usable directory watch: every
 *  active file also gets an fs.watchFile poller the first time it is seen. */
function createPolledSweep({ root, ingestOne, scheduleIngest, polledFiles, pruneConsumed, log }) {
  return async function polledSweep() {
    try {
      const active = await discoverActiveTranscripts(root);
      pruneConsumed(active.map(({ path: fp }) => fp));
      for (const { path: fp } of active) {
        if (!polledFiles.has(fp)) {
          polledFiles.add(fp);
          fs.watchFile(fp, { persistent: false, interval: WATCH_FILE_INTERVAL_MS }, () => {
            if (isWatchable(fp)) scheduleIngest(fp);
          });
        }
        ingestOne(fp);
      }
    } catch (e) {
      log(`[transcript-watch] linux sweep error: ${e.message}\n`);
    }
  };
}

function disposeWatchResources({ pendingByFile, intervals, watchers, polledFiles, clearConsumed }) {
  for (const t of pendingByFile.values()) {
    try {
      clearTimeout(t);
    } catch {}
  }
  pendingByFile.clear();
  for (const i of intervals) {
    try {
      clearInterval(i);
    } catch {}
  }
  intervals.length = 0;
  for (const w of watchers) {
    try {
      w.close();
    } catch {}
  }
  watchers.length = 0;
  for (const fp of polledFiles) {
    try {
      fs.unwatchFile(fp);
    } catch {}
  }
  polledFiles.clear();
  clearConsumed();
}

/** Starts watching `root`; resolves after the first active-transcript sweep
 *  and returns { stop }. */
export async function startTranscriptWatcher({ root, ingestTranscriptFile, getOffset, log }) {
  const resources = { pendingByFile: new Map(), intervals: [], watchers: [], polledFiles: new Set() };
  const fileIngest = createFileIngest({ ingestTranscriptFile, getOffset, log });
  const ingestOne = fileIngest.ingestOne;
  const scheduleIngest = createDebouncedIngest(ingestOne, resources.pendingByFile);
  async function safetySweep() {
    try {
      const active = await discoverActiveTranscripts(root);
      fileIngest.prune(active.map(({ path: fp }) => fp));
      await Promise.all(active.map(({ path: fp }) => ingestOne(fp)));
    } catch (e) {
      log(`[transcript-watch] safety sweep error: ${e.message}\n`);
    }
  }

  const source = { root, scheduleIngest, watchers: resources.watchers, log };
  if (process.platform === 'win32') {
    attachRecursiveWatch(source);
    resources.intervals.push(setInterval(safetySweep, SAFETY_POLL_MS));
  } else if (process.platform === 'darwin') {
    attachFlatWatch(source);
    resources.intervals.push(setInterval(safetySweep, SAFETY_POLL_MS));
  } else {
    log(`[transcript-watch] linux/WSL — using safety sweep + fs.watchFile polling (no recursive watch)\n`);
    const polledSweep = createPolledSweep({
      root,
      ingestOne,
      scheduleIngest,
      polledFiles: resources.polledFiles,
      pruneConsumed: fileIngest.prune,
      log,
    });
    resources.intervals.push(setInterval(polledSweep, SAFETY_POLL_MS));
  }

  // Runtime readiness includes the first active-transcript sweep. Without this
  // barrier a lazy-started memory process can answer recall before the current
  // session's persisted rows exist, causing automatic compaction to fail during
  // the former three-second startup window.
  await safetySweep();

  return { stop: () => disposeWatchResources({ ...resources, clearConsumed: fileIngest.clear }) };
}
