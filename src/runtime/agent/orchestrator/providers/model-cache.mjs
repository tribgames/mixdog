import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from '../config.mjs';
import { updateJsonAtomicSync, writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';

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
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
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

  function save(models, extra = {}) {
    try {
      writeJsonAtomicSync(
        path(),
        {
          ...extra,
          ...(version != null ? { version } : {}),
          fetchedAt: Date.now(),
          models,
        },
        { lock: true, fsyncDir: true }
      );
      if (onSave) onSave(models);
    } catch {
      /* best-effort */
    }
  }

  // A discovery request claims a generation when it starts. Its roster is
  // written only if no newer request started meanwhile — in this process
  // (generation) or another one (`requestedAt` checked under the file lock) —
  // and `isCurrent()` (the credential it was fetched with is still active) holds.
  let generation = 0;
  function beginSave(isCurrent) {
    const claimed = ++generation;
    const requestedAt = Date.now();
    return (models, extra = {}) => {
      if (claimed !== generation || !isCurrent()) return false;
      let written = false;
      try {
        updateJsonAtomicSync(
          path(),
          (cur) => {
            if (Number(cur?.requestedAt) > requestedAt) return undefined;
            written = true;
            return {
              ...extra,
              ...(version != null ? { version } : {}),
              fetchedAt: Date.now(),
              requestedAt,
              models,
            };
          },
          { fsyncDir: true }
        );
      } catch {
        /* best-effort */
      }
      if (written && onSave) onSave(models);
      return written;
    };
  }

  return { path, loadEntrySync, loadSync, save, beginSave };
}
