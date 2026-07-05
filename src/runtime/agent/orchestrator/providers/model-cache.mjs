import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';

// Shared model-catalog disk-cache CRUD, parameterized over the small bits each
// provider varies: cache file name, TTL, an optional schema-version gate, and an
// optional onSave hook (used to refresh an in-memory mirror after a write).
export function makeModelCache({ fileName, ttlMs, version = null, onSave = null }) {
    function path() {
        return join(getPluginData(), fileName);
    }

    function loadSync() {
        const p = path();
        if (!existsSync(p)) return null;
        try {
            const raw = JSON.parse(readFileSync(p, 'utf-8'));
            if (version != null && raw?.version !== version) return null;
            if (!raw?.fetchedAt || !Array.isArray(raw.models)) return null;
            if (Date.now() - raw.fetchedAt > ttlMs) return null;
            return raw.models;
        } catch { return null; }
    }

    function save(models) {
        try {
            writeJsonAtomicSync(path(), {
                ...(version != null ? { version } : {}),
                fetchedAt: Date.now(),
                models,
            }, { lock: true, fsyncDir: true });
            if (onSave) onSave(models);
        } catch { /* best-effort */ }
    }

    return { path, loadSync, save };
}
