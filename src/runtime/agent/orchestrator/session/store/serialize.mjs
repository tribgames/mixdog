import { readFileSync } from 'fs';
import { join } from 'path';
import { renameWithRetrySync } from '../../../../shared/atomic-file.mjs';
import { sanitizeContentForStoredHistory } from '../../providers/media-normalization.mjs';
import { readTopLevelLifecycleRecord, isLifecycleUnreadable } from '../lifecycle-scan.mjs';

// Inline legacy media is replaced with placeholders on disk. New prompt media
// already arrives as durable content-addressed refs, so session JSON stays small
// while provider lowering can still resolve it across turns.
// Per-message disk projection shared by _sessionForDisk and the save-worker
// delta path (tail-only projection). Returns the SAME array reference when no
// message changed. Idempotent: already-sanitized content passes through
// unchanged, so projecting a projected message is a no-op.
export function _messagesForDisk(messages) {
    let changed = false;
    const out = messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        const content = sanitizeContentForStoredHistory(m.content);
        if (content !== m.content) { changed = true; return { ...m, content }; }
        return m;
    });
    return changed ? out : messages;
}

export function _sessionForDisk(session) {
    // Strip transient in-flight aliases askSession sets for the turn duration:
    //  - liveTurnMessages: live working transcript (so contextStatus() can
    //    estimate live context growth) — a duplicate of the working transcript
    //    that must never be serialized (mid-turn saves would bloat the file and
    //    persist a non-canonical message array).
    //  - toolApprovalHook: the askOpts.onToolApproval callback wired for the
    //    turn — a function that must never be serialized.
    //  - _providerPrefixGuardState: hashes of the live provider projection.
    //    Stored history intentionally omits inline media, so these hashes are
    //    valid only for the current runtime and must not survive a reload.
    const hasTransient = session && typeof session === 'object'
        && (Object.prototype.hasOwnProperty.call(session, 'liveTurnMessages')
            || Object.prototype.hasOwnProperty.call(session, 'toolApprovalHook')
            || Object.prototype.hasOwnProperty.call(session, '_providerPrefixGuardState'));
    const messages = Array.isArray(session?.messages) ? session.messages : null;
    if (!messages || messages.length === 0) {
        if (!hasTransient) return session;
        const {
            liveTurnMessages: _dropLTM,
            toolApprovalHook: _dropTAH,
            _providerPrefixGuardState: _dropPPGS,
            ...rest
        } = session;
        return _withMidTurnContextAnchor(rest, session);
    }
    const out = _messagesForDisk(messages);
    if (out === messages) {
        if (!hasTransient) return session;
        const {
            liveTurnMessages: _dropLTM,
            toolApprovalHook: _dropTAH,
            _providerPrefixGuardState: _dropPPGS,
            ...rest
        } = session;
        return _withMidTurnContextAnchor(rest, session);
    }
    const {
        liveTurnMessages: _dropLTM,
        toolApprovalHook: _dropTAH,
        _providerPrefixGuardState: _dropPPGS,
        ...rest
    } = session;
    return _withMidTurnContextAnchor({ ...rest, messages: out }, session);
}

/**
 * A mid-turn save persists the PRE-TURN transcript (`session.messages` is
 * rewritten only at commit) while the provider baseline was recorded against
 * the live turn array the loop mutates and compacts. The two describe different
 * transcripts, so a cold reader that trusted that anchor — or fell back to
 * estimating the pre-turn copy — reported multiples of the real prompt size
 * (measured: 599K shown against a 500K window while the provider's own prompt
 * was 112K). Persist the snapshot as unanchored instead: readers keep the last
 * actual provider reading, and no cold projection can compact from it.
 */
function _withMidTurnContextAnchor(diskSession, session) {
    const live = session?.liveTurnMessages;
    if (!Array.isArray(live) || live === session?.messages) return diskSession;
    return {
        ...diskSession,
        contextPressureUnanchoredAfterRestart: true,
        contextPressureUnanchoredReason: 'mid_turn_snapshot',
    };
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

/**
 * Sentinel for "the file is THERE and could not be read" (EIO/EACCES/EBUSY…),
 * as opposed to `null` = "read fine, but the record is corrupt/foreign".
 * Callers that own retention (summary scan) must never treat the former as an
 * empty/invalid row.
 */
export const STORED_SESSION_UNREADABLE = Symbol('stored-session-unreadable');

export function _storedSessionFromFile(dir, filename, ensureLifecycle = true) {
    if (!filename.endsWith('.json')) return null;
    const storageId = filename.slice(0, -5);
    if (!storageId || !/^[A-Za-z0-9_-]+$/.test(storageId)) return null;
    let text;
    try {
        text = readFileSync(join(dir, filename), 'utf-8');
    } catch (err) {
        const code = err?.code || 'EUNKNOWN';
        // Only ENOENT/ENOTDIR is absence; everything else is present-but-
        // unreadable and must fail closed for retention decisions.
        return (code === 'ENOENT' || code === 'ENOTDIR') ? null : STORED_SESSION_UNREADABLE;
    }
    try {
        // One strict authority for identity: a plain JSON.parse resolves a
        // duplicate top-level `id` LAST-WINS, so `{"id":"other",…,"id":"me"}`
        // would be listed (and later acted on) as this file's own session.
        // Ambiguous/malformed records are treated exactly like corrupt ones:
        // the caller keeps owning the identity but gets no session object.
        const record = readTopLevelLifecycleRecord(text);
        if (isLifecycleUnreadable(record) || record.id !== storageId) return null;
        const session = record.doc;
        // Older builds persisted this runtime-local snapshot. Discard it at
        // the reload boundary before sanitized history establishes a new
        // provider prefix baseline.
        delete session._providerPrefixGuardState;
        return ensureLifecycle ? _ensureLifecycleFields(session) : session;
    } catch {
        return null;
    }
}
