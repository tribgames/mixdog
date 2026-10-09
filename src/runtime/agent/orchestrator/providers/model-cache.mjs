import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';

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

  return { path, loadEntrySync, loadSync, save };
}
