// Post-edit advisory marks: one-shot sidecar on the next read after a write.
import { _normalizeAbs } from './util.mjs';

// sessionId -> Map<absPath, { ts, toolName }>
const _postEditBySession = new Map();

/**
 * Mark `path` as just-edited for `sessionId`. Caller invokes this after a
 * successful write/edit/apply_patch so the next read on the same path can
 * receive a one-shot advisory sidecar.
 */
export function markPostEdit({ sessionId, path, cwd, toolName }) {
    if (!sessionId) return;
    const abs = _normalizeAbs(path, cwd);
    if (!abs) return;
    let m = _postEditBySession.get(sessionId);
    if (!m) { m = new Map(); _postEditBySession.set(sessionId, m); }
    m.set(abs, { ts: Date.now(), toolName: String(toolName || 'edit') });
}

/**
 * One-shot read of a post-edit mark for `sessionId`+`path`. Returns the
 * mark info on hit and removes it (so the advisory only fires once per
 * edit). Returns null on miss.
 */
export function consumePostEditMark({ sessionId, path, cwd }) {
    if (!sessionId) return null;
    const abs = _normalizeAbs(path, cwd);
    if (!abs) return null;
    const m = _postEditBySession.get(sessionId);
    if (!m) return null;
    const entry = m.get(abs);
    if (!entry) return null;
    m.delete(abs);
    return entry;
}

/** Drop all post-edit marks for a session on close. */
export function clearPostEditMarks(sessionId) {
    if (!sessionId) return;
    _postEditBySession.delete(sessionId);
}
