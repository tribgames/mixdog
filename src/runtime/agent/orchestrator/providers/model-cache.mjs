import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from '../config.mjs';
import { updateJsonAtomic, writeJsonAtomicAsync } from '../../../shared/atomic-file.mjs';

// Disk writes never block the event loop: they run on the async atomic-file
// primitives, one at a time per cache file, in the order they were requested
// (a later write is never overtaken by an earlier one finishing late). Every
// instance of one file shares these module-level tables, since several
// instances and several providers can address the same path.
const writeTails = new Map(); // path → tail of that file's write chain
// path → JSON text of the newest save() whose write has not finished. Sync
// readers see it, so a save is visible at once although its disk write is not.
const unsettledSaves = new Map();

function enqueueWrite(p, task) {
  const run = (writeTails.get(p) ?? Promise.resolve()).then(task);
  writeTails.set(p, run);
  run.then(() => {
    if (writeTails.get(p) === run) writeTails.delete(p);
  });
  return run;
}

/** Resolves once every cache write requested so far has settled (shutdown, tests). */
export async function flushModelCacheWrites() {
  while (writeTails.size) await Promise.all([...writeTails.values()]);
}

// Shared model-catalog disk-cache CRUD, parameterized over the small bits each
// provider varies: cache file name, TTL, an optional schema-version gate, and an
// optional onSave hook (used to refresh an in-memory mirror after a write).
export function makeModelCache({ fileName, ttlMs, version = null, onSave = null }) {
  function path() {
    return join(getPluginData(), fileName);
  }

  // The whole cache record (models plus what save() recorded beside them).
  // allowStale skips the TTL only; the schema-version gate still applies.
  function loadEntrySync({ allowStale = false } = {}) {
    const p = path();
    const unsettled = unsettledSaves.get(p);
    if (unsettled === undefined && !existsSync(p)) return null;
    try {
      const raw = JSON.parse(unsettled ?? readFileSync(p, 'utf-8'));
      if (version != null && raw?.version !== version) return null;
      if (!raw?.fetchedAt || !Array.isArray(raw.models)) return null;
      if (!allowStale && Date.now() - raw.fetchedAt > ttlMs) return null;
      return raw;
    } catch {
      return null;
    }
  }

  function loadSync(options) {
    return loadEntrySync(options)?.models ?? null;
  }

  // The in-memory state (sync readers, onSave mirror) updates at once; the
  // returned promise settles, never rejecting, when the disk write has.
  function save(models, extra = {}) {
    const p = path();
    // The value as of this call: later mutation of `models` must not change
    // what lands on disk (the old synchronous write captured it the same way).
    let text;
    let record;
    try {
      text = JSON.stringify({
        ...extra,
        ...(version != null ? { version } : {}),
        fetchedAt: Date.now(),
        models,
      });
      record = JSON.parse(text);
      unsettledSaves.set(p, text);
    } catch {
      return Promise.resolve();
    }
    try {
      if (onSave) onSave(models);
    } catch {
      /* best-effort */
    }
    return enqueueWrite(p, async () => {
      try {
        await writeJsonAtomicAsync(p, record, { lock: true, fsyncDir: true });
      } catch {
        /* best-effort */
      } finally {
        if (text !== undefined && unsettledSaves.get(p) === text) unsettledSaves.delete(p);
      }
    });
  }

  // A discovery request claims a generation when it starts. Its roster is
  // written only if no newer request started meanwhile — in this process
  // (generation) or another one (`requestedAt` checked under the file lock) —
  // and `isCurrent()` (the credential it was fetched with is still active) holds.
  // The returned publish() resolves, never rejecting, to whether the roster was
  // written; the cross-process check runs under the file lock, so the answer
  // is only known once the queued write has run.
  let generation = 0;
  function beginSave(isCurrent) {
    const claimed = ++generation;
    const requestedAt = Date.now();
    const stillWanted = () => claimed === generation && isCurrent();
    return (models, extra = {}) => {
      if (!stillWanted()) return Promise.resolve(false);
      const p = path();
      // The roster as of this call, not as mutated while the write waits.
      let snapshot;
      try {
        snapshot = JSON.parse(JSON.stringify({ extra, models }));
      } catch {
        return Promise.resolve(false);
      }
      return enqueueWrite(p, async () => {
        // A newer request may have started while this write waited its turn.
        if (!stillWanted()) return false;
        let written = false;
        try {
          await updateJsonAtomic(
            p,
            (cur) => {
              if (Number(cur?.requestedAt) > requestedAt) return undefined;
              // The lock wait is asynchronous: a newer request or a credential
              // change may have landed since the checks above. Re-decide now,
              // right before accepting the data.
              if (!stillWanted()) return undefined;
              written = true;
              return {
                ...snapshot.extra,
                ...(version != null ? { version } : {}),
                fetchedAt: Date.now(),
                requestedAt,
                models: snapshot.models,
              };
            },
            { fsyncDir: true }
          );
        } catch {
          /* best-effort */
        }
        try {
          if (written && onSave) onSave(models);
        } catch {
          /* best-effort */
        }
        return written;
      });
    };
  }

  return { path, loadEntrySync, loadSync, save, beginSave };
}
