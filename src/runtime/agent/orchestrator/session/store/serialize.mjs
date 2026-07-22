import { readFileSync } from 'fs';
import { join } from 'path';
import { renameWithRetrySync } from '../../../../shared/atomic-file.mjs';
import { sanitizeContentForStoredHistory } from '../../providers/media-normalization.mjs';

// The live in-memory session (and every model request)
// retains attached image bytes across turns so multi-turn recognition works.
// The persisted session JSON, however, replaces image content with a short
// text placeholder at serialization time — keeping session files small without
// starving the model of the image mid-conversation. Returns the same object
// reference when nothing changed (no-image sessions pay only a shallow scan).
export function _sessionForDisk(session) {
    // Strip transient in-flight aliases askSession sets for the turn duration:
    //  - liveTurnMessages: live working transcript (so contextStatus() can
    //    estimate live context growth) — a duplicate of the working transcript
    //    that must never be serialized (mid-turn saves would bloat the file and
    //    persist a non-canonical message array).
    //  - toolApprovalHook: the askOpts.onToolApproval callback wired for the
    //    turn — a function that must never be serialized.
    const hasTransient = session && typeof session === 'object'
        && (Object.prototype.hasOwnProperty.call(session, 'liveTurnMessages')
            || Object.prototype.hasOwnProperty.call(session, 'toolApprovalHook'));
    const messages = Array.isArray(session?.messages) ? session.messages : null;
    if (!messages || messages.length === 0) {
        if (!hasTransient) return session;
        const { liveTurnMessages: _dropLTM, toolApprovalHook: _dropTAH, ...rest } = session;
        return rest;
    }
    let changed = false;
    const out = messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        const content = sanitizeContentForStoredHistory(m.content);
        if (content !== m.content) { changed = true; return { ...m, content }; }
        return m;
    });
    if (!changed) {
        if (!hasTransient) return session;
        const { liveTurnMessages: _dropLTM, toolApprovalHook: _dropTAH, ...rest } = session;
        return rest;
    }
    const { liveTurnMessages: _dropLTM, toolApprovalHook: _dropTAH, ...rest } = session;
    return { ...rest, messages: out };
}

export function _renameWithRetrySync(tmp, target) {
    return renameWithRetrySync(tmp, target);
}

/**
 * Ensure generation/closed defaults on every session object.
 * Older persisted sessions predate these fields; we normalise at load and save.
 */
export function _ensureLifecycleFields(session) {
    if (typeof session.generation !== 'number') session.generation = 0;
    if (typeof session.closed !== 'boolean') session.closed = false;
    if (!Array.isArray(session.messages)) session.messages = [];
    if (!Array.isArray(session.tools)) session.tools = [];
    return session;
}

export function _storedSessionFromFile(dir, filename, ensureLifecycle = true) {
    if (!filename.endsWith('.json')) return null;
    const storageId = filename.slice(0, -5);
    if (!storageId || !/^[A-Za-z0-9_-]+$/.test(storageId)) return null;
    try {
        const session = JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
        if (session?.id !== storageId) return null;
        return ensureLifecycle ? _ensureLifecycleFields(session) : session;
    } catch {
        return null;
    }
}
