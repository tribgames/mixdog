import { statSync, existsSync, readFileSync } from 'fs';
import { getPluginData } from '../../config.mjs';

// Recent full-session reads are much hotter than writes while a user hops
// between conversations. Verify the file identity on every access, but reuse
// the parsed object while the atomic file has not changed.
export const SESSION_LOAD_CACHE_LIMIT = 8;
export const _sessionLoadCache = new Map(); // path → { signature, session }
export let _sessionLoadCacheDataDir = null;

export function _readStoredSessionCached(id, path) {
    const dataDir = getPluginData();
    if (_sessionLoadCacheDataDir !== dataDir) {
        _sessionLoadCacheDataDir = dataDir;
        _sessionLoadCache.clear();
    }
    let signature;
    try {
        const info = statSync(path, { bigint: true });
        signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    } catch {
        _sessionLoadCache.delete(path);
        return { exists: existsSync(path), session: null };
    }
    const cached = _sessionLoadCache.get(path);
    if (cached?.signature === signature) {
        _sessionLoadCache.delete(path);
        _sessionLoadCache.set(path, cached);
        return { exists: true, session: cached.session };
    }
    try {
        const stored = JSON.parse(readFileSync(path, 'utf-8'));
        if (stored?.id !== id) {
            _sessionLoadCache.delete(path);
            return { exists: true, session: null };
        }
        _sessionLoadCache.delete(path);
        _sessionLoadCache.set(path, { signature, session: stored });
        while (_sessionLoadCache.size > SESSION_LOAD_CACHE_LIMIT) {
            const oldest = _sessionLoadCache.keys().next().value;
            if (oldest === undefined) break;
            _sessionLoadCache.delete(oldest);
        }
        return { exists: true, session: stored };
    } catch {
        _sessionLoadCache.delete(path);
        return { exists: true, session: null };
    }
}
